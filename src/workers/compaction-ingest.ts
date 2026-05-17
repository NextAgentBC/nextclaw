/**
 * Capture codex's `after_compaction` summary into long-term memory.
 *
 * When codex compacts a long session (LLM-driven summarization that
 * folds N old messages into one summary), that summary is an
 * already-paid-for distillation of expensive tokens. Instead of letting
 * it live only in the session JSONL, we promote it into
 * `semantic.chunks` with kind='compaction' so recall can find it later.
 *
 * The hook payload gives us `sessionFile + messageCount + tokenCount +
 * compactedCount`. We tail the file looking for the summary marker (or
 * fall back to the most recent assistant message) and write one chunk.
 *
 * Best-effort: any failure is logged, never throws.
 */

import { readFile, stat } from "node:fs/promises";
import { ingestOne, type IngestDeps } from "../ingest/pipeline.js";

const TAIL_LINES = 60;
const MIN_SUMMARY_CHARS = 40;
const MAX_TAIL_BYTES = 256 * 1024;

export type CompactionContext = {
  /** Absolute path to the session JSONL file. */
  sessionFile: string;
  agentId: string;
  agentSessionId?: string;
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
};

export type CompactionIngestOutcome = {
  ok: boolean;
  chunkId?: string;
  summaryChars?: number;
  reason?: string;
};

/**
 * Read the trailing portion of a JSONL file. Files can be very large
 * (~10 MB after months of chat), so we slice the last MAX_TAIL_BYTES
 * before parsing. The first partial line in the slice is discarded
 * (it'll be a fragment).
 */
async function readJsonlTail(path: string): Promise<unknown[]> {
  const st = await stat(path);
  const buf = await readFile(path);
  const start = Math.max(0, buf.length - MAX_TAIL_BYTES);
  const slice = buf.slice(start).toString("utf8");
  const lines = slice.split("\n");
  // If we sliced mid-line, drop the leading fragment.
  if (start > 0 && lines.length > 0) {lines.shift();}
  // Keep only the last TAIL_LINES (defensive cap on parse work).
  const recent = lines.slice(-TAIL_LINES);
  const out: unknown[] = [];
  for (const ln of recent) {
    const trimmed = ln.trim();
    if (!trimmed) {continue;}
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  // Don't return the stat result; just keep behavior tight.
  void st;
  return out;
}

/**
 * Try several shapes to find the compaction summary text. JSONL formats
 * vary across openclaw versions; we walk recent entries and pick the
 * first one that looks like a compaction artifact, falling back to the
 * most recent assistant message if nothing matches.
 */
function extractSummary(entries: unknown[]): string | null {
  let lastAssistant: string | null = null;
  // Walk from newest to oldest.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== "object") {continue;}
    const obj = e as Record<string, unknown>;

    // Shape 1: explicit compaction event with `summary` field
    if (obj.type === "compaction" && typeof obj.summary === "string"
        && obj.summary.length >= MIN_SUMMARY_CHARS) {
      return obj.summary;
    }
    // Shape 2: compaction marker with embedded message
    if (obj.kind === "compaction" && typeof obj.text === "string"
        && obj.text.length >= MIN_SUMMARY_CHARS) {
      return obj.text;
    }
    // Shape 3: assistant message with role + content (string OR array of parts)
    if (obj.type === "message" && obj.role === "assistant") {
      const c = obj.content;
      if (typeof c === "string" && c.length >= MIN_SUMMARY_CHARS) {
        if (!lastAssistant) {lastAssistant = c;}
      } else if (Array.isArray(c)) {
        // Codex sometimes emits content as parts: [{type:"text", text:"..."}]
        const joined = c
          .filter((p) => p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string")
          .map((p) => (p as { text: string }).text)
          .join("\n")
          .trim();
        if (!lastAssistant && joined.length >= MIN_SUMMARY_CHARS) {lastAssistant = joined;}
      }
    }
  }
  return lastAssistant;
}

export async function ingestCompactionSummary(
  deps: IngestDeps & { logger?: { info?: (m: string) => void; warn?: (m: string) => void } },
  ctx: CompactionContext,
): Promise<CompactionIngestOutcome> {
  try {
    const entries = await readJsonlTail(ctx.sessionFile);
    if (entries.length === 0) {
      return { ok: false, reason: "empty-tail" };
    }
    const summary = extractSummary(entries);
    if (!summary || summary.length < MIN_SUMMARY_CHARS) {
      return { ok: false, reason: "no-summary-found" };
    }

    const outcome = await ingestOne(deps as IngestDeps, {
      text: summary,
      source: "compaction_event",
      kind: "compaction",
      agentId: ctx.agentId,
      agentSessionId: ctx.agentSessionId,
      retentionClass: "pinned",       // never decay — earned by token cost
      importance: 0.7,                 // high; this is a distilled artifact
      signals: {
        compaction_messages_folded: ctx.compactedCount,
        compaction_token_count: ctx.tokenCount,
        compaction_session_file: ctx.sessionFile,
      },
    });
    deps.logger?.info?.(
      `compaction-ingest: agent=${ctx.agentId} session=${ctx.agentSessionId ?? "?"} ` +
        `folded=${ctx.compactedCount} chars=${summary.length} outcome=${outcome.decision}`,
    );
    return { ok: outcome.decision === "accepted" || outcome.decision === "merged", chunkId: outcome.chunkId, summaryChars: summary.length };
  } catch (e) {
    const msg = (e as Error).message;
    deps.logger?.warn?.(`compaction-ingest: failed for ${ctx.sessionFile}: ${msg}`);
    return { ok: false, reason: msg };
  }
}
