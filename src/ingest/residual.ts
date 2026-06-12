/**
 * Stage 4 LLM residual extractor — deep structured extraction for the long tail
 * the deterministic regex extractors miss (implicit, natural-language facts).
 *
 * v1 extracts PREFERENCES only — durable likes/dislikes/choices stated in
 * natural language ("switched to X", "can't stand Y"), which regex can't catch
 * and which power preference recall + the supersede chain. Entities/relations
 * (the graph dimension, needing entity-type allowlist validation) are a v2.
 *
 * Cost safety for a free-tier model behind the credbroker (which rotates keys):
 *   - fail-soft: ANY error (429 / timeout / bad JSON) → empty result; the
 *     ingest falls back to deterministic. Never throws into the ingest path.
 *   - in-process RPM guard: caps requests/minute so a burst (e.g. transcript
 *     replay of hundreds of chunks) can't spam the broker.
 *   The daily token budget guard lives in the pipeline gate (deps.cfg.residual).
 */
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import { ReflectionClient } from "../embedding/reflection-client.js";
import type { ExtractorResult, PreferenceCandidate } from "../structured/types.js";

export type LlmResidual = (
  text: string,
  signals: Record<string, unknown>,
) => Promise<{ result: ExtractorResult; tokensUsed: number }>;

function emptyResult(): ExtractorResult {
  return { entities: [], events: [], preferences: [], metrics: [], relations: [], commitments: [], extractorVersion: "vresidual-1" };
}

const SYSTEM_PROMPT = `You extract durable PREFERENCES from a single chat message into JSON.
A preference is a lasting like, dislike, choice, or rule the user expressed or clearly implied
("switched to dark mode", "can't stand meetings before noon", "always books aisle seats").
Do NOT extract one-off facts, events, questions, or anything you have to guess at.

Output ONLY this JSON object, no prose, no code fences:
{"preferences":[{"key":"<short snake_case topic>","value":"<the preference, concise>","confidence":<0..1>}]}
Use an empty array when nothing qualifies. confidence reflects how clearly it was stated.`;

type RawPref = { key?: unknown; value?: unknown; confidence?: unknown };

/** Parse the model's JSON into PreferenceCandidates, tolerating fences/prose. */
export function parseResidualPreferences(text: string): PreferenceCandidate[] {
  let obj: { preferences?: RawPref[] };
  try {
    const m = text.match(/\{[\s\S]*\}/); // first {...} block
    if (!m) {return [];}
    obj = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const out: PreferenceCandidate[] = [];
  for (const p of obj.preferences ?? []) {
    if (typeof p?.key !== "string" || !p.key.trim()) {continue;}
    const v = p.value;
    if (v == null || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) {continue;}
    const conf = typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0.6;
    out.push({ scope: "global", key: p.key.trim().toLowerCase().slice(0, 64), value: v, confidence: conf });
  }
  return out.slice(0, 8);
}

// In-process requests-per-minute guard (free-tier RPM safety).
let rpmWindowStart = 0;
let rpmCount = 0;
function withinRpm(maxRpm: number, nowMs: number): boolean {
  if (nowMs - rpmWindowStart >= 60_000) {
    rpmWindowStart = nowMs;
    rpmCount = 0;
  }
  if (rpmCount >= maxRpm) {return false;}
  rpmCount += 1;
  return true;
}

/**
 * Build the residual extractor, or `undefined` when disabled/unconfigured (the
 * pipeline then runs deterministic-only, unchanged). `clientOverride` is for
 * tests. Wire the result into `IngestDeps.llmResidual`.
 */
export function buildResidualExtractor(
  cfg: ResolvedMemoryPostgresConfig,
  clientOverride?: Pick<ReflectionClient, "chat">,
): LlmResidual | undefined {
  const r = cfg.residual;
  if (!r.enabled || !r.model.baseUrl) {return undefined;}
  const client = clientOverride ?? new ReflectionClient({
    baseUrl: r.model.baseUrl,
    model: r.model.model,
    format: r.model.format,
    apiKey: r.model.apiKeyEnv ? process.env[r.model.apiKeyEnv] : undefined,
  });
  return async (text) => {
    if (!withinRpm(r.maxRpm, Date.now())) {return { result: emptyResult(), tokensUsed: 0 };}
    const resp = await client.chat({ systemPrompt: SYSTEM_PROMPT, userPrompt: text, maxOutputTokens: 400, temperature: 0.1 });
    if (!resp.ok) {return { result: emptyResult(), tokensUsed: 0 };} // fail-soft: 429 / timeout / error
    const preferences = parseResidualPreferences(resp.text);
    return { result: { ...emptyResult(), preferences }, tokensUsed: resp.inputTokens + resp.outputTokens };
  };
}
