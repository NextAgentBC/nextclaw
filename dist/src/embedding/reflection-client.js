/**
 * Reflection-worker chat client.
 *
 * Supports two wire formats so reflection can run against either:
 *   - `openai`  — `/v1/chat/completions` with `{model, messages, max_tokens}`.
 *                  Works for OpenAI, Together, vLLM, Ollama-chat, anything compat.
 *   - `gemini`  — Google's native `/v1beta/models/<model>:generateContent`.
 *                  Used when calling through a Tailscale credential broker
 *                  that proxies Gemini (no key on caller, automatic rotation).
 *                  No OpenAI compat shim — body shape is different.
 *
 * Minimal: single-shot, non-streaming, no tools. Reflection is a daily
 * SUMMARISATION pass; we just want the text back.
 */
export class ReflectionClient {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
        if (!cfg.baseUrl) {
            throw new Error("[memory-postgres] reflection baseUrl missing");
        }
        if (!cfg.model) {
            throw new Error("[memory-postgres] reflection model missing");
        }
        if (cfg.format !== "openai" && cfg.format !== "gemini") {
            throw new Error(`[memory-postgres] reflection format must be openai|gemini, got ${cfg.format}`);
        }
    }
    async chat(req) {
        const fetchImpl = this.cfg.fetchImpl ?? globalThis.fetch;
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
        const start = Date.now();
        try {
            if (this.cfg.format === "gemini") {
                return await this.#chatGemini(fetchImpl, ctrl.signal, req, start);
            }
            return await this.#chatOpenAi(fetchImpl, ctrl.signal, req, start);
        }
        catch (err) {
            return { ok: false, error: err.message, latencyMs: Date.now() - start };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async #chatOpenAi(fetchImpl, signal, req, start) {
        const baseTrimmed = this.cfg.baseUrl.replace(/\/+$/, "");
        const url = `${baseTrimmed}/v1/chat/completions`;
        const headers = { "content-type": "application/json" };
        if (this.cfg.apiKey) {
            headers["authorization"] = `Bearer ${this.cfg.apiKey}`;
        }
        const resp = await fetchImpl(url, {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({
                model: this.cfg.model,
                messages: [
                    { role: "system", content: req.systemPrompt },
                    { role: "user", content: req.userPrompt },
                ],
                max_tokens: req.maxOutputTokens ?? 800,
                temperature: req.temperature ?? 0.3,
            }),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}`, latencyMs: Date.now() - start };
        }
        const json = (await resp.json());
        const text = json.choices?.[0]?.message?.content ?? "";
        return {
            ok: true,
            text,
            inputTokens: json.usage?.prompt_tokens ?? 0,
            outputTokens: json.usage?.completion_tokens ?? 0,
            latencyMs: Date.now() - start,
        };
    }
    async #chatGemini(fetchImpl, signal, req, start) {
        // Google's native generateContent endpoint. Credbroker proxies it as
        // /v1/proxy/gemini/v1beta/models/<model>:generateContent and injects
        // the ?key= server-side, so caller doesn't need an apiKey.
        const baseTrimmed = this.cfg.baseUrl.replace(/\/+$/, "");
        const url = `${baseTrimmed}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent`;
        const headers = { "content-type": "application/json" };
        if (this.cfg.apiKey) {
            // Direct Gemini API takes ?key=; when calling that path bypassing the
            // broker, expose apiKey via query-string. The broker path ignores
            // user-supplied keys.
            // (We keep this for the rare case someone points us at api.google.com directly.)
        }
        const resp = await fetchImpl(this.cfg.apiKey ? `${url}?key=${encodeURIComponent(this.cfg.apiKey)}` : url, {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: req.systemPrompt }] },
                contents: [{ role: "user", parts: [{ text: req.userPrompt }] }],
                generationConfig: {
                    maxOutputTokens: req.maxOutputTokens ?? 800,
                    temperature: req.temperature ?? 0.3,
                },
            }),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}`, latencyMs: Date.now() - start };
        }
        const json = (await resp.json());
        const text = (json.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("");
        return {
            ok: true,
            text,
            inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
            latencyMs: Date.now() - start,
        };
    }
}
export function buildReflectionClientFromConfig(cfg) {
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    return new ReflectionClient({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        format: cfg.format,
        apiKey,
    });
}
