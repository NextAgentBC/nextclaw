import { ReflectionClient } from "../embedding/reflection-client.js";
function emptyResult() {
    return { entities: [], events: [], preferences: [], metrics: [], relations: [], commitments: [], extractorVersion: "vresidual-1" };
}
const SYSTEM_PROMPT = `You extract durable PREFERENCES from a single chat message into JSON.
A preference is a lasting like, dislike, choice, or rule the user expressed or clearly implied
("switched to dark mode", "can't stand meetings before noon", "always books aisle seats").
Do NOT extract one-off facts, events, questions, or anything you have to guess at.

Output ONLY this JSON object, no prose, no code fences:
{"preferences":[{"key":"<short snake_case topic>","value":"<the preference, concise>","confidence":<0..1>}]}
Use an empty array when nothing qualifies. confidence reflects how clearly it was stated.`;
/** Parse the model's JSON into PreferenceCandidates, tolerating fences/prose. */
export function parseResidualPreferences(text) {
    let obj;
    try {
        const m = text.match(/\{[\s\S]*\}/); // first {...} block
        if (!m) {
            return [];
        }
        obj = JSON.parse(m[0]);
    }
    catch {
        return [];
    }
    const out = [];
    for (const p of obj.preferences ?? []) {
        if (typeof p?.key !== "string" || !p.key.trim()) {
            continue;
        }
        const v = p.value;
        if (v == null || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) {
            continue;
        }
        const conf = typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0.6;
        out.push({ scope: "global", key: p.key.trim().toLowerCase().slice(0, 64), value: v, confidence: conf });
    }
    return out.slice(0, 8);
}
// In-process requests-per-minute guard (free-tier RPM safety).
let rpmWindowStart = 0;
let rpmCount = 0;
function withinRpm(maxRpm, nowMs) {
    if (nowMs - rpmWindowStart >= 60_000) {
        rpmWindowStart = nowMs;
        rpmCount = 0;
    }
    if (rpmCount >= maxRpm) {
        return false;
    }
    rpmCount += 1;
    return true;
}
/**
 * Build the residual extractor, or `undefined` when disabled/unconfigured (the
 * pipeline then runs deterministic-only, unchanged). `clientOverride` is for
 * tests. Wire the result into `IngestDeps.llmResidual`.
 */
export function buildResidualExtractor(cfg, clientOverride) {
    const r = cfg.residual;
    if (!r.enabled || !r.model.baseUrl) {
        return undefined;
    }
    const client = clientOverride ?? new ReflectionClient({
        baseUrl: r.model.baseUrl,
        model: r.model.model,
        format: r.model.format,
        apiKey: r.model.apiKeyEnv ? process.env[r.model.apiKeyEnv] : undefined,
    });
    return async (text) => {
        if (!withinRpm(r.maxRpm, Date.now())) {
            return { result: emptyResult(), tokensUsed: 0 };
        }
        const resp = await client.chat({ systemPrompt: SYSTEM_PROMPT, userPrompt: text, maxOutputTokens: 400, temperature: 0.1 });
        if (!resp.ok) {
            return { result: emptyResult(), tokensUsed: 0 };
        } // fail-soft: 429 / timeout / error
        const preferences = parseResidualPreferences(resp.text);
        return { result: { ...emptyResult(), preferences }, tokensUsed: resp.inputTokens + resp.outputTokens };
    };
}
