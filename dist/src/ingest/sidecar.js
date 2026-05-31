/**
 * Sidecar JSON: parse `<mem>{...}</mem>` blocks emitted by the agent at the
 * end of a turn, and decide when to inject the sidecar request prompt.
 *
 * The agent prompt-builder hook (Phase 4 wiring) appends an instruction:
 *   "After your reply, output <mem>{entities,events,prefs,metrics}</mem>"
 *
 * The parser is forgiving — invalid/missing JSON just yields an empty result
 * and the pipeline falls back to deterministic + LLM-residual paths.
 */
export const SIDECAR_VERSION = "v1.0.0";
export const SIDECAR_INSTRUCTION = [
    "After your main reply, output a single line:",
    "<mem>{\"entities\":[...],\"events\":[...],\"preferences\":[...],\"metrics\":[...]}</mem>",
    "Each array item is small, structured. If nothing memorable: <mem>{}</mem>.",
].join("\n");
const SIDECAR_RE = /<mem>\s*([\s\S]*?)\s*<\/mem>/i;
/* ----------------------------- shape coercion ----------------------------- */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function asString(v) {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
        return v;
    }
    if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) {
            return n;
        }
    }
    return undefined;
}
function asDate(v, fallback) {
    if (v instanceof Date) {
        return v;
    }
    if (typeof v === "string") {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) {
            return d;
        }
    }
    if (typeof v === "number" && Number.isFinite(v)) {
        return new Date(v);
    }
    return fallback;
}
const ENTITY_TYPES = new Set([
    "person",
    "project",
    "repo",
    "file",
    "tool",
    "concept",
    "other",
]);
function coerceEntity(v) {
    if (!isObject(v)) {
        return null;
    }
    const typeRaw = asString(v["type"]) ?? "other";
    const type = (ENTITY_TYPES.has(typeRaw) ? typeRaw : "other");
    const name = asString(v["canonicalName"]) ?? asString(v["name"]);
    if (!name) {
        return null;
    }
    const aliasesRaw = v["aliases"];
    const aliases = Array.isArray(aliasesRaw)
        ? aliasesRaw.filter((a) => typeof a === "string" && a.length > 0)
        : [];
    return {
        type,
        canonicalName: name,
        aliases,
        attrs: isObject(v["attrs"]) ? (v["attrs"]) : {},
        confidence: asNumber(v["confidence"]) ?? 0.85,
    };
}
function coerceEvent(v, now) {
    if (!isObject(v)) {
        return null;
    }
    const type = asString(v["type"]);
    if (!type) {
        return null;
    }
    return {
        ts: asDate(v["ts"], now),
        endTs: typeof v["endTs"] === "string" || v["endTs"] instanceof Date
            ? asDate(v["endTs"], now)
            : undefined,
        type,
        details: isObject(v["details"]) ? (v["details"]) : {},
        confidence: asNumber(v["confidence"]) ?? 0.8,
    };
}
function coercePreference(v) {
    if (!isObject(v)) {
        return null;
    }
    const scope = asString(v["scope"]) ?? "global";
    const key = asString(v["key"]);
    if (!key) {
        return null;
    }
    return {
        scope,
        key,
        value: v["value"] ?? null,
        ruleText: asString(v["ruleText"]) ?? asString(v["text"]),
        confidence: asNumber(v["confidence"]) ?? 0.8,
    };
}
function coerceMetric(v, now) {
    if (!isObject(v)) {
        return null;
    }
    const metric = asString(v["metric"]);
    const value = asNumber(v["value"]);
    if (!metric || value === undefined) {
        return null;
    }
    return {
        ts: asDate(v["ts"], now),
        metric,
        value,
        unit: asString(v["unit"]),
        dim: isObject(v["dim"])
            ? v["dim"]
            : undefined,
        confidence: asNumber(v["confidence"]) ?? 0.9,
    };
}
function coerceRelation(v) {
    if (!isObject(v)) {
        return null;
    }
    const subj = isObject(v["subject"]) ? v["subject"] : null;
    const subjName = subj ? asString(subj["canonicalName"]) ?? asString(subj["name"]) : undefined;
    const subjType = subj ? asString(subj["type"]) : undefined;
    const predicate = asString(v["predicate"]);
    if (!subjName || !subjType || !predicate) {
        return null;
    }
    const obj = isObject(v["object"]) ? v["object"] : null;
    const objName = obj ? asString(obj["canonicalName"]) ?? asString(obj["name"]) : undefined;
    const objType = obj ? asString(obj["type"]) : undefined;
    return {
        subject: { type: subjType, canonicalName: subjName },
        predicate,
        object: objName && objType
            ? { type: objType, canonicalName: objName }
            : undefined,
        objectText: asString(v["objectText"]),
        confidence: asNumber(v["confidence"]) ?? 0.8,
    };
}
/* ------------------------------- extract --------------------------------- */
const EMPTY = {
    entities: [],
    relations: [],
    events: [],
    preferences: [],
    metrics: [],
    commitments: [],
    extractorVersion: SIDECAR_VERSION,
};
export function parseSidecar(text, now) {
    const m = SIDECAR_RE.exec(text);
    if (!m) {
        return { found: false, ok: false, result: EMPTY };
    }
    const inner = m[1] ?? "";
    if (inner.trim() === "" || inner.trim() === "{}") {
        return { found: true, ok: true, result: EMPTY };
    }
    let parsed;
    try {
        parsed = JSON.parse(inner);
    }
    catch (err) {
        return { found: true, ok: false, result: EMPTY, error: err.message };
    }
    if (!isObject(parsed)) {
        return { found: true, ok: false, result: EMPTY, error: "sidecar root not an object" };
    }
    const result = {
        entities: Array.isArray(parsed["entities"])
            ? parsed["entities"].map(coerceEntity).filter((e) => e !== null)
            : [],
        relations: Array.isArray(parsed["relations"])
            ? parsed["relations"].map(coerceRelation).filter((r) => r !== null)
            : [],
        events: Array.isArray(parsed["events"])
            ? parsed["events"]
                .map((v) => coerceEvent(v, now))
                .filter((e) => e !== null)
            : [],
        preferences: Array.isArray(parsed["preferences"])
            ? parsed["preferences"]
                .map(coercePreference)
                .filter((p) => p !== null)
            : [],
        metrics: Array.isArray(parsed["metrics"])
            ? parsed["metrics"]
                .map((v) => coerceMetric(v, now))
                .filter((m2) => m2 !== null)
            : [],
        // Commitments are extracted deterministically (extractors.ts); the LLM
        // sidecar prompt doesn't emit them yet, so default to none here.
        commitments: [],
        extractorVersion: SIDECAR_VERSION,
    };
    return { found: true, ok: true, result };
}
/* ------------------------- merge with deterministic ----------------------- */
/**
 * Merge sidecar candidates into deterministic candidates. Sidecar wins on
 * confidence ties (LLM agreed = stronger signal); deterministic backs up the
 * sidecar's coverage with regex-only catches it might have missed.
 */
export function mergeExtractorResults(primary, secondary) {
    return {
        entities: dedupBy([...primary.entities, ...secondary.entities], (e) => `${e.type}|${e.canonicalName}`),
        relations: [...primary.relations, ...secondary.relations],
        events: dedupBy([...primary.events, ...secondary.events], (e) => `${e.ts.toISOString().slice(0, 16)}|${e.type}`),
        preferences: dedupBy([...primary.preferences, ...secondary.preferences], (p) => `${p.scope}|${p.key}`),
        metrics: dedupBy([...primary.metrics, ...secondary.metrics], (m) => `${m.ts.toISOString()}|${m.metric}|${JSON.stringify(m.dim ?? {})}`),
        commitments: dedupBy([...primary.commitments, ...secondary.commitments], (c) => `${c.kind}|${c.directive}`),
        extractorVersion: primary.extractorVersion,
    };
}
function dedupBy(items, keyOf) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const k = keyOf(item);
        if (seen.has(k)) {
            continue;
        }
        seen.add(k);
        out.push(item);
    }
    return out;
}
export function shouldRequestSidecar(signals, cfg) {
    if ((cfg.onExplicitRemember ?? true) && signals.hasExplicitRemember) {
        return true;
    }
    if ((cfg.onNumericMention ?? true) && signals.hasNumericMention) {
        return true;
    }
    if ((cfg.onWriteTools ?? true) && signals.hadWriteToolCall) {
        return true;
    }
    if (signals.userMessageChars >= (cfg.minUserMessageChars ?? 50)) {
        return true;
    }
    return false;
}
