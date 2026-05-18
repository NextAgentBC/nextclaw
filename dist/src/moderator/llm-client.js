/**
 * Moderator LLM adapter.
 *
 * Wraps the existing `ReflectionClient` (src/embedding/reflection-client.ts)
 * — same OpenAI-compat + native-Gemini transport pair — and exposes the
 * `ModeratorLlm` interface that `runOneCycle` expects.
 *
 * Why reuse: the reflection worker already has a battle-tested chat
 * client with both transports (OpenAI compat for gpt-5.5 / OpenAI /
 * vLLM / Ollama-chat, and native Gemini for credbroker-proxied
 * google models). The Moderator doesn't need anything new on the wire.
 *
 * Config: `cfg.moderator.model` mirrors `cfg.reflection.model`. Default
 * format=openai, model=gpt-5.5, baseUrl=https://api.openai.com,
 * apiKeyEnv=OPENAI_API_KEY (the user's existing openclaw OAuth handles
 * the codex-side gpt-5.5; for non-codex paths an explicit key is needed).
 */
import { buildReflectionClientFromConfig, } from "../embedding/reflection-client.js";
export function buildModeratorLlm(cfg) {
    const client = buildReflectionClientFromConfig({
        format: cfg.format,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKeyEnv: cfg.apiKeyEnv,
    });
    return {
        async call({ systemPrompt, userPrompt, maxTokens, temperature }) {
            const r = await client.chat({
                systemPrompt,
                userPrompt,
                maxOutputTokens: maxTokens ?? 1200,
                temperature: temperature ?? 0.3,
            });
            if (!r.ok) {
                // Convert the error path into a defensible LLM output: the
                // Moderator's parseDecision will see this as garbage and fall
                // back to `ignore`, so a network blip costs us one routing
                // round but never crashes the service.
                return {
                    text: JSON.stringify({
                        action: "ignore",
                        rationale: `llm-call-failed: ${r.error.slice(0, 200)}`,
                    }),
                    inputTokens: 0,
                    outputTokens: 0,
                    model: cfg.model,
                    latencyMs: r.latencyMs,
                };
            }
            return {
                text: r.text,
                inputTokens: r.inputTokens,
                outputTokens: r.outputTokens,
                model: cfg.model,
                latencyMs: r.latencyMs,
            };
        },
    };
}
