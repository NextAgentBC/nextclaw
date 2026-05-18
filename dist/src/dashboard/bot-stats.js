/**
 * Bot turn telemetry reader.
 *
 * Streams the agent's `<sessionId>.trajectory.jsonl` file and groups events
 * by `runId` (one per Discord/CLI message turn). For each completed turn,
 * extracts:
 *
 *   - prompt.submitted  → start of the OpenAI gpt-5.5 model call
 *   - model.completed   → end of the model call + token usage
 *   - tool calls         → from trace.artifacts.toolMetas
 *
 * Exposed via /api/bot-stats so the dashboard can show:
 *
 *   - turns / 24h
 *   - p50 / p90 / max model latency (the dominant component)
 *   - tokens fresh vs cacheRead (prompt cache hit rate)
 *   - cold-start signal (first turn after >5min gap = cache miss)
 *
 * No DB required — trajectories live on disk under
 * `~/.openclaw/agents/<agentId>/sessions/`. Reading is best-effort: a missing
 * or unreadable file just returns empty stats.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
const TURN_CAP = 30;
const COLD_GAP_MS = 5 * 60_000; // OpenAI prompt cache TTL.
function parseLine(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
function isoToMs(iso) {
    return new Date(iso).getTime();
}
/**
 * Collect all turns from a single trajectory file. Streaming line read; safe
 * for 15+ MB files (current trajectory hits 14 MB).
 */
async function readTrajectoryTurns(filePath) {
    let raw;
    try {
        raw = await readFile(filePath, "utf8");
    }
    catch {
        return [];
    }
    const byRun = new Map();
    for (const line of raw.split("\n")) {
        if (!line) {
            continue;
        }
        const ev = parseLine(line);
        if (!ev || typeof ev !== "object") {
            continue;
        }
        const e = ev;
        const runId = typeof e["runId"] === "string" ? e["runId"] : undefined;
        if (!runId) {
            continue;
        }
        const t = typeof e["type"] === "string" ? e["type"] : "";
        let bucket = byRun.get(runId);
        if (!bucket) {
            bucket = {};
            byRun.set(runId, bucket);
        }
        bucket[t] = e;
    }
    const turns = [];
    for (const [runId, evs] of byRun) {
        const started = evs["session.started"];
        const ended = evs["session.ended"];
        const submitted = evs["prompt.submitted"];
        const completed = evs["model.completed"];
        const artifacts = evs["trace.artifacts"];
        if (!started || !ended || !submitted || !completed) {
            continue;
        }
        const startedAt = typeof started["ts"] === "string" ? started["ts"] : "";
        const submittedAt = typeof submitted["ts"] === "string" ? submitted["ts"] : "";
        const completedAt = typeof completed["ts"] === "string" ? completed["ts"] : "";
        const endedAt = typeof ended["ts"] === "string" ? ended["ts"] : "";
        const modelLatencyMs = submittedAt && completedAt ? isoToMs(completedAt) - isoToMs(submittedAt) : undefined;
        const totalLatencyMs = startedAt && endedAt ? isoToMs(endedAt) - isoToMs(startedAt) : undefined;
        const data = (completed["data"] ?? {});
        const usage = (data["usage"] ?? {});
        const inputTokens = num(usage["input"]) ?? num(usage["inputTokens"]);
        const outputTokens = num(usage["output"]) ?? num(usage["outputTokens"]);
        const cacheReadTokens = num(usage["cacheRead"]) ?? num(usage["cachedTokens"]);
        const toolMetas = artifacts?.["data"]?.["toolMetas"];
        const toolNames = Array.isArray(toolMetas)
            ? toolMetas
                .map((m) => (m && typeof m === "object" ? m["toolName"] : null))
                .filter((n) => typeof n === "string")
            : [];
        turns.push({
            runId,
            startedAt,
            modelId: typeof completed["modelId"] === "string" ? completed["modelId"] : undefined,
            modelLatencyMs,
            totalLatencyMs,
            outputTokens,
            inputTokens,
            cacheReadTokens,
            toolNames,
            coldStart: false,
        });
    }
    // Sort by time ascending so cold-start gap detection works.
    turns.sort((a, b) => isoToMs(a.startedAt) - isoToMs(b.startedAt));
    for (let i = 0; i < turns.length; i++) {
        const cur = turns[i];
        const prev = turns[i - 1];
        cur.coldStart = !prev || isoToMs(cur.startedAt) - isoToMs(prev.startedAt) > COLD_GAP_MS;
    }
    return turns;
}
function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function pct(arr, q) {
    if (arr.length === 0) {
        return 0;
    }
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
    return sorted[idx];
}
/**
 * Aggregates turns across all trajectory files in a session directory.
 * Returns 24h-windowed stats + the most-recent N turns.
 */
export async function readBotStats(sessionsDir) {
    const empty = {
        windowStart: new Date().toISOString(),
        count: 0,
        p50LatencyMs: 0,
        p90LatencyMs: 0,
        maxLatencyMs: 0,
        meanLatencyMs: 0,
        totalOutputTokens: 0,
        totalInputTokens: 0,
        totalCacheReadTokens: 0,
        coldStartPct: 0,
        recent: [],
    };
    let entries = [];
    try {
        entries = await readdir(sessionsDir);
    }
    catch {
        return empty;
    }
    const trajFiles = entries.filter((f) => f.endsWith(".trajectory.jsonl"));
    // Pick the most recently modified trajectory — typically the live agent.
    const stamped = await Promise.all(trajFiles.map(async (f) => {
        try {
            const s = await stat(path.join(sessionsDir, f));
            return { f, mtime: s.mtimeMs };
        }
        catch {
            return { f, mtime: 0 };
        }
    }));
    stamped.sort((a, b) => b.mtime - a.mtime);
    if (stamped.length === 0) {
        return empty;
    }
    // Read up to 3 newest files so a fresh session doesn't hide last day's data.
    const allTurns = [];
    for (const { f } of stamped.slice(0, 3)) {
        const turns = await readTrajectoryTurns(path.join(sessionsDir, f));
        allTurns.push(...turns);
    }
    allTurns.sort((a, b) => isoToMs(a.startedAt) - isoToMs(b.startedAt));
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const window = allTurns.filter((t) => isoToMs(t.startedAt) >= cutoff);
    if (window.length === 0) {
        return empty;
    }
    const lats = window.map((t) => t.modelLatencyMs ?? 0).filter((n) => n > 0);
    const totalIn = window.reduce((a, t) => a + (t.inputTokens ?? 0), 0);
    const totalOut = window.reduce((a, t) => a + (t.outputTokens ?? 0), 0);
    const totalCache = window.reduce((a, t) => a + (t.cacheReadTokens ?? 0), 0);
    const coldStarts = window.filter((t) => t.coldStart).length;
    const last = window[window.length - 1];
    return {
        windowStart: window[0].startedAt,
        count: window.length,
        p50LatencyMs: pct(lats, 0.5),
        p90LatencyMs: pct(lats, 0.9),
        maxLatencyMs: lats.reduce((a, b) => Math.max(a, b), 0),
        meanLatencyMs: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0,
        totalOutputTokens: totalOut,
        totalInputTokens: totalIn,
        totalCacheReadTokens: totalCache,
        coldStartPct: window.length ? Math.round((coldStarts * 1000) / window.length) / 10 : 0,
        recent: window.slice(-TURN_CAP).reverse(),
        provider: "openai-codex",
        modelId: last.modelId,
    };
}
