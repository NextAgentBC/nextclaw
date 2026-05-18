/**
 * Minimal OpenAI-compat chat client.
 *
 * Used by the shadow comparator worker to replay each gpt-5.5 turn against
 * an OpenAI-compatible chat endpoint (e.g. Qwen / vLLM / Ollama
 * "chat"). Reuses the embedding client's path-concat URL pattern so
 * the standard `/v1/chat/completions` path works.
 *
 * Stays tiny on purpose:
 *   - Only POST /chat/completions (no streaming, no tools — shadow runs are
 *     non-streaming so we get the full reply for diff analysis).
 *   - llama.cpp serves a `chat_template_kwargs.enable_thinking=false` flag
 *     to suppress reasoning_content; we always send it because the user's
 *     compare is on the actual answer, not the thinking trace.
 */
function trimSlash(s) {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}
export function buildChatClient(cfg) {
    const endpoint = `${trimSlash(cfg.baseUrl)}/v1/chat/completions`;
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    const timeoutMs = cfg.timeoutMs ?? 60_000;
    const disableThinking = cfg.disableThinking !== false;
    return {
        model: cfg.model,
        endpoint,
        async chat(req) {
            const t0 = Date.now();
            const body = {
                model: cfg.model,
                messages: req.messages,
                max_tokens: req.maxTokens ?? 400,
            };
            if (typeof req.temperature === "number") {
                body["temperature"] = req.temperature;
            }
            if (disableThinking) {
                body["chat_template_kwargs"] = { enable_thinking: false };
            }
            const headers = { "Content-Type": "application/json" };
            if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`;
            }
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), timeoutMs);
            try {
                const r = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: ctl.signal,
                });
                if (!r.ok) {
                    const text = await r.text().catch(() => "");
                    return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}`, wallMs: Date.now() - t0 };
                }
                const j = (await r.json());
                const choice = j.choices?.[0] ?? {};
                const msg = choice.message ?? {};
                const usage = j.usage ?? {};
                return {
                    ok: true,
                    content: msg.content ?? "",
                    reasoningChars: (msg.reasoning_content ?? "").length,
                    inputTokens: usage.prompt_tokens ?? 0,
                    outputTokens: usage.completion_tokens ?? 0,
                    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
                    finishReason: choice.finish_reason ?? "",
                    wallMs: Date.now() - t0,
                };
            }
            catch (err) {
                return { ok: false, error: err.message, wallMs: Date.now() - t0 };
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
