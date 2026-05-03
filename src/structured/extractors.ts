/**
 * Deterministic extractors. Phase 2 ships a regex/heuristic pass that covers
 * common patterns without LLM calls; Phase 3 augments with sidecar JSON +
 * (residual) LLM extraction. Each extractor returns extra candidates merged
 * into a single ExtractorResult.
 *
 * Style: pure functions, no I/O, no logging. Tests assert byte-for-byte
 * deterministic output.
 */

import {
  emptyResult,
  type EntityCandidate,
  type EventCandidate,
  type ExtractorContext,
  type ExtractorResult,
  type ExtractorVersion,
  type MetricCandidate,
  type PreferenceCandidate,
  type RelationCandidate,
} from "./types.js";

export const EXTRACTOR_VERSION: ExtractorVersion = "v1.0.0";

/* --------------------------------- helpers --------------------------------- */

const TIME_RELATIVE: Record<string, number> = {
  今天: 0, 今日: 0, today: 0,
  昨天: -1, 昨日: -1, yesterday: -1,
  前天: -2, "day before yesterday": -2,
  明天: 1, tomorrow: 1,
  上周: -7, "last week": -7,
  本周: 0, "this week": 0,
  下周: 7, "next week": 7,
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/** ISO YYYY-MM-DD on its own gives us a precise event ts at 00:00:00. */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/** Find the first time anchor in text and return as a Date. */
function detectEventTs(text: string, now: Date): Date {
  const iso = ISO_DATE.exec(text);
  if (iso) {return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);}
  for (const [phrase, deltaDays] of Object.entries(TIME_RELATIVE)) {
    if (text.includes(phrase)) {
      const d = startOfDay(now);
      d.setUTCDate(d.getUTCDate() + deltaDays);
      return d;
    }
  }
  return now;
}

/**
 * Numeric + unit detector — matches "1800 卡", "1800 cal", "120ml", "60kg" etc.
 *
 * `\b` is ASCII-only in JS, so Chinese unit suffixes can't use it. Instead we
 * use a negative lookahead for an alphanumeric continuation, which matches
 * latin-letter end correctly and also allows CJK unit terminators.
 */
const NUM_UNIT = /(?<![\w.])(\d+(?:\.\d+)?)\s*(大卡|千卡|公斤|毫升|公里|tokens?|kcal|cal|kg|ml|km|卡|g|克|l|升|次|步|m|米)(?![A-Za-z0-9])/giu;

/** Map of unit → canonical metric name (some units map to multiple — pick first). */
const UNIT_METRIC: Record<string, { metric: string; unit: string }> = {
  卡: { metric: "calories", unit: "kcal" },
  大卡: { metric: "calories", unit: "kcal" },
  千卡: { metric: "calories", unit: "kcal" },
  cal: { metric: "calories", unit: "kcal" },
  kcal: { metric: "calories", unit: "kcal" },
  kg: { metric: "mass", unit: "kg" },
  公斤: { metric: "mass", unit: "kg" },
  g: { metric: "mass", unit: "g" },
  克: { metric: "mass", unit: "g" },
  ml: { metric: "volume", unit: "ml" },
  毫升: { metric: "volume", unit: "ml" },
  l: { metric: "volume", unit: "l" },
  升: { metric: "volume", unit: "l" },
  token: { metric: "tokens", unit: "tokens" },
  tokens: { metric: "tokens", unit: "tokens" },
  次: { metric: "count", unit: "count" },
  步: { metric: "steps", unit: "steps" },
  km: { metric: "distance", unit: "km" },
  公里: { metric: "distance", unit: "km" },
  m: { metric: "distance", unit: "m" },
  米: { metric: "distance", unit: "m" },
};

/* ------------------------------- entity hints ------------------------------ */

/**
 * Entity extraction is deliberately conservative: only ALL-CAPS-ish
 * project/repo names, file paths, and explicit @mentions. Phase 3's sidecar
 * JSON is the right place to recognise free-form entities the LLM already
 * called out — we do not want to invent personhood from regex.
 */
const REPO_HINT = /\b([A-Za-z][A-Za-z0-9_-]{1,40})\/([A-Za-z][A-Za-z0-9_.-]{1,60})(?:[\s,.;:)]|$)/g;
/**
 * Match path-like file refs ending in a known extension. Allows the path
 * portion to include `/` so `src/foo/bar.ts` captures the whole path, not
 * just the basename.
 */
const FILE_HINT = /(?<![\w/])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|sql|md|json))(?![\w/])/g;
const MENTION   = /@([A-Za-z][\w-]{1,30})/g;

function extractEntitiesFrom(ctx: ExtractorContext): EntityCandidate[] {
  const out: EntityCandidate[] = [];
  for (const m of ctx.text.matchAll(REPO_HINT)) {
    const owner = m[1] ?? "";
    const name  = m[2] ?? "";
    if (!owner || !name) {continue;}
    out.push({
      type: "repo",
      canonicalName: `${owner}/${name}`,
      confidence: 0.7,
    });
  }
  for (const m of ctx.text.matchAll(FILE_HINT)) {
    const path = m[1] ?? "";
    if (!path) {continue;}
    out.push({
      type: "file",
      canonicalName: path,
      confidence: 0.6,
    });
  }
  for (const m of ctx.text.matchAll(MENTION)) {
    const handle = m[1] ?? "";
    if (!handle) {continue;}
    out.push({
      type: "person",
      canonicalName: handle.toLowerCase(),
      aliases: [handle],
      confidence: 0.65,
    });
  }
  // Dedup by (type, canonicalName) preserving best confidence.
  const seen = new Map<string, EntityCandidate>();
  for (const e of out) {
    const k = `${e.type}|${e.canonicalName}`;
    const prev = seen.get(k);
    if (!prev || prev.confidence < e.confidence) {seen.set(k, e);}
  }
  return [...seen.values()];
}

/* --------------------------------- metrics --------------------------------- */

function extractMetrics(ctx: ExtractorContext): MetricCandidate[] {
  const out: MetricCandidate[] = [];
  const ts = detectEventTs(ctx.text, ctx.now);
  for (const m of ctx.text.matchAll(NUM_UNIT)) {
    const numStr = m[1] ?? "";
    const unitRaw = (m[2] ?? "").toLowerCase();
    const value = Number(numStr);
    if (!Number.isFinite(value)) {continue;}
    const map = UNIT_METRIC[unitRaw];
    if (!map) {continue;}
    out.push({
      ts,
      metric: map.metric,
      value,
      unit: map.unit,
      confidence: 0.85,
    });
  }
  return out;
}

/* --------------------------------- events ---------------------------------- */

const TOOL_EVENT_HINT = /\b(?:Edit|Write|Bash|Read|Grep|Glob|TodoWrite)\b/;

function extractEvents(ctx: ExtractorContext): EventCandidate[] {
  const out: EventCandidate[] = [];
  // From signals.toolCall (set by Stage 0 in Phase 3).
  const sig = ctx.signals ?? {};
  const tool = (sig as { toolCall?: { name?: string; input?: Record<string, unknown> } }).toolCall;
  if (tool?.name) {
    out.push({
      ts: ctx.now,
      type: `tool_call:${tool.name.toLowerCase()}`,
      details: tool.input ?? {},
      confidence: 1.0,
    });
  }
  // Heuristic: "改了 PR #1234" → pr_change event.
  const prMatch = /\bPR\s*#?(\d+)\b/i.exec(ctx.text);
  if (prMatch) {
    out.push({
      ts: detectEventTs(ctx.text, ctx.now),
      type: "pr_change",
      details: { prNumber: Number(prMatch[1]) },
      confidence: 0.7,
    });
  }
  // Mentioning common meal verbs alongside a calorie metric → meal event.
  // (Use a fresh non-stateful regex; NUM_UNIT has /g and would mutate lastIndex.)
  const MEAL_HINT = /(?:午饭|午餐|晚饭|晚餐|早饭|早餐|\b(?:breakfast|lunch|dinner)\b)/;
  const HAS_NUM_UNIT = /\d+(?:\.\d+)?\s*(?:大卡|千卡|公斤|毫升|公里|tokens?|kcal|cal|kg|ml|km|卡|g|克|l|升|次|步|m|米)/i;
  if (MEAL_HINT.test(ctx.text) && HAS_NUM_UNIT.test(ctx.text)) {
    out.push({
      ts: detectEventTs(ctx.text, ctx.now),
      type: "meal",
      details: {},
      confidence: 0.6,
    });
  }
  // Avoid inventing an event purely because the text contains a tool name.
  // If we have *no* events and *no* metrics yet, stop here.
  if (out.length === 0 && TOOL_EVENT_HINT.test(ctx.text)) {
    out.push({
      ts: ctx.now,
      type: "narrative",
      confidence: 0.3,
    });
  }
  return out;
}

/* ------------------------------- preferences ------------------------------- */

function extractPreferences(ctx: ExtractorContext): PreferenceCandidate[] {
  const out: PreferenceCandidate[] = [];
  // "以后 X 用 Y" / "记住 X 是 Y" / "from now on use ..." style.
  // `\b` would fail for CJK, so use word-boundary only for the latin alternates
  // and bare-match the CJK ones.
  const REMEMBER = /(?:以后|从现在起|从此|记住|\b(?:remember|from now on|always)\b)/i;
  if (REMEMBER.test(ctx.text)) {
    out.push({
      scope: "global",
      key: "user_rule",
      value: { text: ctx.text },
      ruleText: ctx.text,
      confidence: 0.65,
    });
  }
  return out;
}

/* -------------------------------- relations -------------------------------- */

// `\b` is ASCII-only, so we use bare alternates for CJK and word-boundary for latin verbs.
const COLLAB_VERBS = /(?:和|与|跟|\bwith\b)\s+(@?[A-Za-z][\w-]{1,30})\s*[\s\S]{0,40}?(?:改了?|写了?|做了?|完成|\b(?:review|build|ship|merge|push)\b)/u;

function extractRelations(ctx: ExtractorContext): RelationCandidate[] {
  const out: RelationCandidate[] = [];
  const m = COLLAB_VERBS.exec(ctx.text);
  if (m) {
    const handle = (m[1] ?? "").replace(/^@/, "").toLowerCase();
    if (handle) {
      out.push({
        subject: { type: "person", canonicalName: "user" },
        predicate: "works_with",
        object: { type: "person", canonicalName: handle },
        confidence: 0.6,
      });
    }
  }
  return out;
}

/* --------------------------------- combine --------------------------------- */

export function extractAll(ctx: ExtractorContext): ExtractorResult {
  const result = emptyResult(EXTRACTOR_VERSION);
  result.entities = extractEntitiesFrom(ctx);
  result.metrics  = extractMetrics(ctx);
  result.events   = extractEvents(ctx);
  result.preferences = extractPreferences(ctx);
  result.relations   = extractRelations(ctx);
  return result;
}
