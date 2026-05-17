/**
 * Plugin-internal transcript watcher.
 *
 * Polls OpenClaw session transcript files (`~/.openclaw/agents/<agentId>/
 * sessions/<sessionId>.jsonl`) and ingests every new user / assistant message
 * line into memory. Bypasses the agent entirely — what the user says and what
 * the agent replies *all* lands in memory deterministically. The Stage 1
 * trash filter drops boilerplate so we don't drown in "ok thanks" lines.
 *
 * Persistence: per-file byte offset is stored in `audit.plugin_meta`, keyed
 * by sessionId, so restart resumes from where it left off without re-ingest.
 *
 * Why polling and not fs.watch: fs.watch on networked / overlay mounts is
 * fragile and has different semantics across platforms. A 10-second poll is
 * cheap (just a stat + tail-read) and predictable.
 */

import { stat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

import type {
  ResolvedMemoryPostgresConfig,
  ResolvedTranscriptWatcher,
} from "../config.js";
import type { EmbeddingClient } from "../embedding/client.js";
import { ingestOne, type IngestInput, type IngestOutcome } from "../ingest/pipeline.js";

/* --------------------------------- types --------------------------------- */

type MessageEntry = {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    /** "openai-codex-responses" / etc; lets us label the source */
    api?: string;
    provider?: string;
    model?: string;
  };
};

export type TranscriptWatcherDeps = {
  cfg: ResolvedMemoryPostgresConfig;
  pool: Pool;
  embedding: EmbeddingClient;
  watcher: ResolvedTranscriptWatcher;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
};

export type TranscriptOutcome = {
  watcherId: string;
  filesScanned: number;
  bytesRead: number;
  messagesSeen: number;
  ingestsAccepted: number;
  ingestsMerged: number;
  ingestsRejected: number;
  errors: string[];
};

/* --------------------------------- helpers -------------------------------- */

const META_KEY = (watcherId: string, sessionId: string): string =>
  `transcript_watcher.${watcherId}.${sessionId}.offset`;

async function readOffset(pool: Pool, watcherId: string, sessionId: string): Promise<number> {
  const rows = await pool.query<{ value: { offset?: number } }>(
    "SELECT value FROM audit.plugin_meta WHERE key = $1",
    [META_KEY(watcherId, sessionId)],
  );
  const v = rows.rows[0]?.value?.offset;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

async function writeOffset(
  pool: Pool,
  watcherId: string,
  sessionId: string,
  offset: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit.plugin_meta (key, value, updated_at)
       VALUES ($1, jsonb_build_object('offset', $2::int), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [META_KEY(watcherId, sessionId), offset],
  );
}

/**
 * "Pure question" detector — a single short clause that's clearly a query
 * with no surrounding statement or fact. We use it to skip messages like
 * "X 是什么?" or "is the gateway running?" that pollute memory without
 * adding durable signal. Multi-line / mixed messages with statement+question
 * still pass through (they often share useful context).
 */
export function isPureQuestion(text: string): boolean {
  const trimmed = text.trim();
  // Multi-line / multi-sentence → keep, likely has facts mixed in.
  if (trimmed.includes("\n")) {return false;}
  if (trimmed.length > 200) {return false;}
  const sentenceSplit = trimmed.split(/[.。!?！？]/u).filter((s) => s.trim().length > 0);
  if (sentenceSplit.length > 1) {return false;}

  // CJK question particles (吗/呢/嘛) at the very end.
  if (/(?:吗|呢|嘛|吗\?|呢\?)\s*[?？]?\s*$/u.test(trimmed)) {return true;}
  // Latin question mark.
  if (/[?？]\s*$/u.test(trimmed)) {return true;}
  // Common interrogative leads with no period later. `\b` is ASCII-only in
  // JS, so split CJK alternates (no boundary needed since CJK is bare-match)
  // and ASCII alternates (use word-boundary).
  const cjkLead = /^(?:怎么|为何|为什么|为啥|是不是|有没有|能不能)/u;
  const asciiLead = /^(?:what|why|how|when|where|who|is|are|do|does|did|can|could|should)\b/iu;
  if (cjkLead.test(trimmed) || asciiLead.test(trimmed)) {
    if (!/[.。]/u.test(trimmed)) {return true;}
  }
  return false;
}

/** Extract a single human-readable text from a message entry. */
export function extractMessageText(entry: MessageEntry): string | null {
  if (entry.type !== "message") {return null;}
  const role = entry.message?.role;
  if (role !== "user" && role !== "assistant") {return null;}
  const parts = entry.message?.content ?? [];
  const texts: string[] = [];
  for (const p of parts) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
      texts.push(p.text.trim());
    }
  }
  if (texts.length === 0) {return null;}
  return texts.join("\n").trim();
}

/* --------------------------------- discover ------------------------------- */

async function listSessionFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    // Only the canonical .jsonl, not .trajectory.jsonl (machine-detail dump).
    .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl") && !name.includes(".bak"))
    .map((name) => path.join(dir, name));
}

/* --------------------------------- per-file ------------------------------- */

async function processFile(
  filePath: string,
  deps: TranscriptWatcherDeps,
): Promise<{ bytes: number; seen: number; accepted: number; merged: number; rejected: number; errors: string[] }> {
  const sessionId = path.basename(filePath, ".jsonl");
  const errors: string[] = [];
  let bytes = 0;
  let seen = 0;
  let accepted = 0;
  let merged = 0;
  let rejected = 0;

  let prevOffset = 0;
  let isFirstRun = false;
  try {
    const stored = await readOffset(deps.pool, deps.watcher.id, sessionId);
    if (stored === 0) {
      isFirstRun = true;
    } else {
      prevOffset = stored;
    }
  } catch (err) {
    errors.push(`offset read failed: ${(err as Error).message}`);
    return { bytes, seen, accepted, merged, rejected, errors };
  }

  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(filePath);
  } catch (err) {
    errors.push(`stat failed: ${(err as Error).message}`);
    return { bytes, seen, accepted, merged, rejected, errors };
  }

  // First-run handling: jump close to file end so we don't flood memory with
  // the whole transcript history. Configurable via firstRunBackfillBytes.
  // 0 => skip backfill entirely; only catch messages going forward.
  if (isFirstRun) {
    const backfill = deps.watcher.firstRunBackfillBytes;
    if (backfill === 0) {
      prevOffset = st.size;
    } else if (st.size > backfill) {
      // Snap to a newline boundary so we don't start mid-line.
      const tentative = st.size - backfill;
      const fh0 = await open(filePath, "r");
      try {
        // Read a tiny window forward from `tentative` to find the next newline.
        const probeBuf = Buffer.alloc(8 * 1024);
        const probeRead = await fh0.read(probeBuf, 0, probeBuf.length, tentative);
        const probeText = probeBuf.subarray(0, probeRead.bytesRead).toString("utf8");
        const nlIdx = probeText.indexOf("\n");
        prevOffset = nlIdx >= 0 ? tentative + nlIdx + 1 : tentative;
      } finally {
        await fh0.close();
      }
    }
    // Persist the chosen starting offset so future restarts resume cleanly
    // even if no new data has arrived yet.
    try {
      await writeOffset(deps.pool, deps.watcher.id, sessionId, prevOffset);
    } catch {
      /* swallow — will retry on next tick */
    }
  }
  if (st.size <= prevOffset) {
    return { bytes: 0, seen, accepted, merged, rejected, errors };
  }

  // Read only the new tail. Cap so a runaway log doesn't OOM.
  const maxBytes = deps.watcher.maxBytesPerTick;
  const start = prevOffset;
  const end = Math.min(st.size, start + maxBytes);
  const fh = await open(filePath, "r");
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(end - start);
    await fh.read(chunk, 0, chunk.length, start);
  } finally {
    await fh.close();
  }
  bytes = chunk.length;

  // Parse line-by-line. The last line may be partial (file still being
  // written) — only commit the offset up to the last complete newline.
  const text = chunk.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) {
    // No complete line yet — nothing to do; don't advance offset.
    return { bytes: 0, seen, accepted, merged, rejected, errors };
  }
  const completePortion = text.slice(0, lastNl);
  const newOffset = start + Buffer.byteLength(completePortion, "utf8") + 1; // +1 for the newline

  const lines = completePortion.split("\n");
  for (const line of lines) {
    if (line.length === 0) {continue;}
    let entry: MessageEntry;
    try {
      entry = JSON.parse(line) as MessageEntry;
    } catch {
      continue; // skip malformed
    }
    const messageText = extractMessageText(entry);
    if (!messageText) {continue;}
    seen += 1;

    const role = entry.message?.role ?? "user";

    // Drop "pure question" user messages — they tell us what user was
    // curious about but rarely yield durable facts. Compactor would
    // demote them anyway; cheaper to skip up-front.
    if (deps.watcher.dropPureQuestions && role === "user" && isPureQuestion(messageText)) {
      continue;
    }

    const sourceLabel = `${deps.watcher.source}:${role}`;
    const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
    const idHint = entry.id ?? `${sessionId}:${seen}`;

    const input: IngestInput = {
      text: messageText,
      source: sourceLabel,
      sourceRef: `${sessionId}:${idHint}`,
      kind: role === "user" ? "user_msg" : "assistant_reply",
      agentSessionId: sessionId,
      agentId: deps.watcher.agentId,
      // Lower default importance so transcript ingests don't crowd genuinely
      // important manual / structured writes. Recall feedback bumps warmth on
      // hits, so anything truly useful gets promoted naturally.
      importance: deps.watcher.defaultImportance,
      anchors: {
        cwd: deps.watcher.anchors?.cwd,
        branch: deps.watcher.anchors?.branch,
      },
      now: Number.isNaN(ts.getTime()) ? new Date() : ts,
    };

    try {
      const outcome: IngestOutcome = await ingestOne(deps, input);
      if (outcome.decision === "accepted") {accepted += 1;}
      else if (outcome.decision === "merged") {merged += 1;}
      else if (outcome.decision === "rejected") {rejected += 1;}
    } catch (err) {
      errors.push(`${idHint}: ${(err as Error).message}`);
    }
  }

  try {
    await writeOffset(deps.pool, deps.watcher.id, sessionId, newOffset);
  } catch (err) {
    errors.push(`offset write failed: ${(err as Error).message}`);
  }
  return { bytes, seen, accepted, merged, rejected, errors };
}

/* --------------------------------- public --------------------------------- */

export async function pollTranscriptWatcher(
  deps: TranscriptWatcherDeps,
): Promise<TranscriptOutcome> {
  const files = await listSessionFiles(deps.watcher.dir);
  const out: TranscriptOutcome = {
    watcherId: deps.watcher.id,
    filesScanned: files.length,
    bytesRead: 0,
    messagesSeen: 0,
    ingestsAccepted: 0,
    ingestsMerged: 0,
    ingestsRejected: 0,
    errors: [],
  };
  for (const file of files) {
    const r = await processFile(file, deps);
    out.bytesRead += r.bytes;
    out.messagesSeen += r.seen;
    out.ingestsAccepted += r.accepted;
    out.ingestsMerged += r.merged;
    out.ingestsRejected += r.rejected;
    if (r.errors.length > 0) {
      out.errors.push(...r.errors.map((e) => `${path.basename(file)}: ${e}`));
    }
  }
  return out;
}

export type TranscriptWatcherHandle = {
  watcherId: string;
  agentId: string;
  stop: () => void;
  /**
   * Trigger an immediate poll instead of waiting for the next interval
   * tick. Used by `session_end` / `after_compaction` hooks to ingest the
   * just-finalised JSONL with sub-second latency instead of ~10s. Safe to
   * call concurrently with the scheduled tick (poll has its own offset
   * cursor; double-firing is a no-op for already-seen lines).
   */
  flushNow: () => Promise<void>;
};

export function startTranscriptWatcherDaemon(
  deps: TranscriptWatcherDeps,
): TranscriptWatcherHandle {
  const log = deps.logger ?? { info: () => undefined, warn: () => undefined };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) {return;}
    try {
      const result = await pollTranscriptWatcher(deps);
      if (result.ingestsAccepted > 0 || result.ingestsMerged > 0) {
        log.info(
          `transcript-watcher[${deps.watcher.id}]: scanned=${result.filesScanned} `
            + `seen=${result.messagesSeen} accepted=${result.ingestsAccepted} `
            + `merged=${result.ingestsMerged} rejected=${result.ingestsRejected}`,
        );
      }
      if (result.errors.length > 0) {
        log.warn(`transcript-watcher[${deps.watcher.id}] errors: ${result.errors.slice(0, 3).join("; ")}`);
      }
    } catch (err) {
      log.warn(`transcript-watcher[${deps.watcher.id}] tick failed: ${(err as Error).message}`);
    }
  };

  // First tick almost immediately so the dashboard fills quickly.
  setTimeout(() => void tick(), 5_000);
  timer = setInterval(() => void tick(), Math.max(5_000, deps.watcher.intervalMs));

  return {
    watcherId: deps.watcher.id,
    agentId: deps.watcher.agentId,
    stop() {
      stopped = true;
      if (timer) {clearInterval(timer);}
      timer = null;
    },
    async flushNow() {
      if (stopped) {return;}
      await tick();
    },
  };
}
