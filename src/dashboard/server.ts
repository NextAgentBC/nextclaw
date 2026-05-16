/**
 * Memory dashboard HTTP server (Phase 7).
 *
 * Listens on 127.0.0.1:port (configurable, defaults to 8765). Serves a small
 * SPA-less HTML+JS dashboard plus a few JSON endpoints. Real-time event
 * streaming uses Server-Sent Events backed by `LISTEN audit_events` on a
 * dedicated pg client.
 *
 * Security:
 *   - Default bind 127.0.0.1, never 0.0.0.0.
 *   - When dashboard.tokenEnv is set, every request must carry the matching
 *     X-Token header (or ?token= query). Otherwise 401.
 *   - Secrets are never read from query strings; logs scrub tokens.
 *
 * No third-party HTTP framework — node:http keeps the dependency surface tiny.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import type { ResolvedMemoryPostgresConfig } from "../config.js";
import { buildEmbeddingClientFromConfig } from "../embedding/client.js";
import { ingestOne, type IngestInput } from "../ingest/pipeline.js";
import { recall as recallFn, type RecallInput } from "../recall/router.js";
import { readBotStats } from "./bot-stats.js";
import { homedir } from "node:os";

const ASSETS_DIR = fileURLToPath(new URL("./assets/", import.meta.url));

export type DashboardServer = {
  url: string;
  close(): Promise<void>;
};

type AuditEventPayload = {
  table: "ingest_decisions" | "recall_decisions";
  op: string;
  id: string;
  ts: string;
  decision?: string;
  ingest_path?: string;
  hit_tier?: string;
  returned?: number;
  score?: number;
};

type SseListener = (event: AuditEventPayload) => void;

const sseListeners = new Set<SseListener>();
let listenClient: PoolClient | null = null;

async function ensureListener(pool: Pool): Promise<void> {
  if (listenClient) {return;}
  listenClient = await pool.connect();
  listenClient.on("notification", (msg) => {
    if (msg.channel !== "audit_events" || !msg.payload) {return;}
    try {
      const payload = JSON.parse(msg.payload) as AuditEventPayload;
      for (const fn of sseListeners) {fn(payload);}
    } catch {
      /* ignore malformed payloads */
    }
  });
  await listenClient.query("LISTEN audit_events");
}

function tokenOk(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) {return true;}
  const headerTok = req.headers["x-token"];
  if (typeof headerTok === "string" && headerTok === expected) {return true;}
  const url = new URL(req.url ?? "/", "http://x");
  return url.searchParams.get("token") === expected;
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

async function handleStaticAsset(res: ServerResponse, name: string): Promise<void> {
  try {
    const safe = path.basename(name);
    const file = await readFile(path.join(ASSETS_DIR, safe), "utf8");
    const type = safe.endsWith(".html") ? "text/html; charset=utf-8"
      : safe.endsWith(".js") ? "application/javascript; charset=utf-8"
      : safe.endsWith(".css") ? "text/css; charset=utf-8"
      : "text/plain; charset=utf-8";
    send(res, 200, file, type);
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

/**
 * Read a small JSON body from the incoming request. 64 KiB cap — ingest
 * payloads are facts/preferences/commits, not blobs.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = 64 * 1024;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) {
      throw new Error(`request body exceeds ${limit} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {return null;}
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`, { cause: err });
  }
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Universal ingest gateway. Token-gated. Lets any cron / skill / external
 * script POST a memory-worthy chunk and have it run through the same Stage
 * 0–6 pipeline as in-process writes. Idempotent: pass `sourceRef` (e.g. a
 * commit sha, ticket id, message id) and the same content posted twice
 * dedup-merges via the existing text_hash unique index.
 */
async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool,
  cfg: ResolvedMemoryPostgresConfig,
): Promise<void> {
  if (req.method !== "POST") {
    send(res, 405, "method not allowed", "text/plain");
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: (err as Error).message });
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: "body must be a JSON object" });
    return;
  }
  const b = body as Record<string, unknown>;
  const text = asStr(b["text"]);
  const source = asStr(b["source"]);
  if (!text || !source) {
    sendJson(res, 400, {
      ok: false,
      error: "text and source are required strings",
    });
    return;
  }
  const anchorsRaw = (typeof b["anchors"] === "object" && b["anchors"] !== null && !Array.isArray(b["anchors"]))
    ? (b["anchors"] as Record<string, unknown>)
    : {};
  const input: IngestInput = {
    text,
    source,
    sourceRef: asStr(b["sourceRef"]),
    kind: asStr(b["kind"]),
    agentSessionId: asStr(b["agentSessionId"]),
    agentId: asStr(b["agentId"]) ?? "main",
    importance: asNum(b["importance"]),
    retentionClass: (() => {
      const r = asStr(b["retentionClass"]);
      if (r === "ephemeral" || r === "standard" || r === "pinned") {return r;}
      return asBool(b["pinned"]) ? "pinned" : undefined;
    })(),
    anchors: {
      cwd: asStr(anchorsRaw["cwd"]),
      branch: asStr(anchorsRaw["branch"]),
      pr: asStr(anchorsRaw["pr"]),
      file: asStr(anchorsRaw["file"]),
      channel: asStr(anchorsRaw["channel"]),
      chat_id: asStr(anchorsRaw["chat_id"]),
      sender_id: asStr(anchorsRaw["sender_id"]),
      sender_label: asStr(anchorsRaw["sender_label"]),
      scope: asStr(anchorsRaw["scope"]),
      visibility: asStr(anchorsRaw["visibility"]),
    },
    sidecarText: asStr(b["sidecarText"]),
  };

  const embedding = buildEmbeddingClientFromConfig({
    baseUrl: cfg.embedding.baseUrl,
    model: cfg.embedding.model,
    apiKeyEnv: cfg.embedding.apiKeyEnv,
    format: cfg.embedding.format,
    path: cfg.embedding.path,
  });

  try {
    const outcome = await ingestOne({ cfg, pool, embedding }, input);
    sendJson(res, 200, { ok: true, outcome });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: (err as Error).message,
    });
  }
}

/**
 * Read-only recall probe. Lets test harnesses + external skills issue a recall
 * through the same tier-walk pipeline as in-process callers, without bringing
 * up an agent runtime. Token-gated like every other /api/* endpoint.
 */
async function handleRecall(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool,
  cfg: ResolvedMemoryPostgresConfig,
): Promise<void> {
  if (req.method !== "POST") {
    send(res, 405, "method not allowed", "text/plain");
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: (err as Error).message });
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: "body must be a JSON object" });
    return;
  }
  const b = body as Record<string, unknown>;
  const query = asStr(b["query"]);
  if (!query) {
    sendJson(res, 400, { ok: false, error: "query is required" });
    return;
  }
  const anchorsRaw = (typeof b["anchors"] === "object" && b["anchors"] !== null && !Array.isArray(b["anchors"]))
    ? (b["anchors"] as Record<string, unknown>)
    : {};
  const viewerRaw = typeof b["viewer"] === "object" && b["viewer"] !== null && !Array.isArray(b["viewer"])
    ? (b["viewer"] as Record<string, unknown>)
    : {};
  const viewerUserId = asStr(viewerRaw["userId"]);
  const viewerChatId = asStr(viewerRaw["chatId"]);
  const input: RecallInput = {
    query,
    maxResults: asNum(b["k"]) ?? asNum(b["maxResults"]),
    agentSessionId: asStr(b["agentSessionId"]),
    agentId: asStr(b["agentId"]) ?? "main",
    anchors: {
      cwd: asStr(anchorsRaw["cwd"]),
      branch: asStr(anchorsRaw["branch"]),
      pr: asStr(anchorsRaw["pr"]),
      file: asStr(anchorsRaw["file"]),
      session: asStr(anchorsRaw["session"]),
      channel: asStr(anchorsRaw["channel"]),
      chat_id: asStr(anchorsRaw["chat_id"]),
      sender_id: asStr(anchorsRaw["sender_id"]),
      scope: asStr(anchorsRaw["scope"]),
    },
    timeBucket: asStr(b["timeBucket"]),
    viewer: viewerUserId || viewerChatId
      ? { userId: viewerUserId, chatId: viewerChatId }
      : undefined,
  };
  const embedding = buildEmbeddingClientFromConfig({
    baseUrl: cfg.embedding.baseUrl,
    model: cfg.embedding.model,
    apiKeyEnv: cfg.embedding.apiKeyEnv,
    format: cfg.embedding.format,
    path: cfg.embedding.path,
  });
  try {
    const out = await recallFn({ cfg, pool, embedding }, input);
    sendJson(res, 200, { ok: true, output: out });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err as Error).message });
  }
}

/**
 * Bot turn telemetry — reads OpenAI gpt-5.5 usage per turn from the agent
 * trajectory file. Lets the dashboard show "is the bot slow because of cold
 * start, or because of OpenAI latency, or because of memory ingest?".
 *
 * Looks under `~/.openclaw/agents/<agentId>/sessions/`. Defaults to "main"
 * but honors OPENCLAW_AGENT_ID for non-default deployments.
 */
/**
 * Side-by-side model comparison data. Reads `audit.model_comparisons`
 * populated by the shadow-comparator worker. Returns aggregate stats per
 * challenger model + the recent N turns for the dashboard panel.
 */
async function handleModelCompare(res: ServerResponse, pool: Pool): Promise<void> {
  // Aggregates per challenger model, last 24h.
  const agg = await pool.query(
    `SELECT
        ch_model,
        ch_endpoint,
        count(*)::text AS n,
        count(*) FILTER (WHERE ch_error IS NULL)::text AS ok_n,
        count(*) FILTER (WHERE ch_error IS NOT NULL)::text AS err_n,
        round(avg(base_latency_ms)::numeric, 0)::text AS base_avg_ms,
        round(avg(ch_latency_ms)::numeric, 0)::text AS ch_avg_ms,
        round(avg(speed_ratio)::numeric, 2)::text AS speed_ratio_avg,
        sum(base_in_tokens)::text  AS base_in_sum,
        sum(base_out_tokens)::text AS base_out_sum,
        sum(ch_in_tokens)::text    AS ch_in_sum,
        sum(ch_out_tokens)::text   AS ch_out_sum,
        max(ts)::text              AS latest_ts
       FROM audit.model_comparisons
      WHERE ts > now() - interval '24 hours'
      GROUP BY ch_model, ch_endpoint
      ORDER BY n DESC`,
  );
  // Recent rows for the table.
  const recent = await pool.query(
    `SELECT id, ts, trajectory_run_id, agent_session_id,
            user_message,
            base_model, base_latency_ms, base_in_tokens, base_out_tokens,
            base_cache_read, base_tool_count, base_output,
            ch_model, ch_latency_ms, ch_in_tokens, ch_out_tokens, ch_output, ch_error,
            speed_ratio, out_len_ratio
       FROM audit.model_comparisons
      ORDER BY ts DESC LIMIT 60`,
  );
  sendJson(res, 200, { aggregates: agg.rows, recent: recent.rows });
}

async function handleBotStats(res: ServerResponse): Promise<void> {
  const agentId = process.env["OPENCLAW_AGENT_ID"] ?? "main";
  const sessionsDir = `${homedir()}/.openclaw/agents/${agentId}/sessions`;
  try {
    const stats = await readBotStats(sessionsDir);
    sendJson(res, 200, { ok: true, stats });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err as Error).message });
  }
}

async function handleStats(res: ServerResponse, pool: Pool): Promise<void> {
  const stats = await pool.query<{
    op: string;
    path: string;
    avg_score: number;
    avg_tokens: number;
    avg_latency_ms: number;
    n: string;
  }>(
    `SELECT op, path, avg_score, avg_tokens, avg_latency_ms, n::text
       FROM audit.scores_hourly
       WHERE hour > now() - interval '24 hours'
       ORDER BY hour DESC, op, path
       LIMIT 200`,
  );
  const counts = await pool.query<{
    accepted: string; rejected: string; merged: string; quarantined: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE decision = 'accepted')::text     AS accepted,
       count(*) FILTER (WHERE decision = 'rejected')::text     AS rejected,
       count(*) FILTER (WHERE decision = 'merged')::text       AS merged,
       count(*) FILTER (WHERE decision = 'quarantined')::text  AS quarantined
       FROM audit.ingest_decisions
       WHERE ts > now() - interval '24 hours'`,
  );
  const tiers = await pool.query<{ hit_tier: string; n: string }>(
    `SELECT hit_tier, count(*)::text AS n FROM audit.recall_decisions
       WHERE ts > now() - interval '24 hours'
       GROUP BY hit_tier ORDER BY n DESC`,
  );
  // Category distribution across all stored chunks. Cheap because chunk_indexes
  // is fully-indexed on (kind, value).
  const categories = await pool.query<{ category: string; n: string; pinned: string }>(
    `SELECT ci.value AS category,
            count(*)::text AS n,
            count(*) FILTER (WHERE c.retention_class='pinned')::text AS pinned
       FROM semantic.chunk_indexes ci
       JOIN semantic.chunks c ON c.id = ci.chunk_id
      WHERE ci.kind = 'category'
      GROUP BY ci.value
      ORDER BY count(*) DESC`,
  );
  sendJson(res, 200, {
    hourly: stats.rows,
    categories: categories.rows,
    ingestCounts: counts.rows[0] ?? null,
    recallTiers: tiers.rows,
  });
}

async function handleRecent(res: ServerResponse, pool: Pool): Promise<void> {
  // Privacy: dashboard renders alongside the user's screen. Health/medical
  // chunks are categorized at ingest; we redact their excerpt at read time
  // and let the UI offer a click-to-reveal action only on the local-bound
  // tab. Dashboard is local-only (127.0.0.1) by default; this is belt+
  // suspenders for the case where the operator tunnels it through Cloudflare or similar.
  const ingests = await pool.query(
    `SELECT i.id, i.ts, i.source, i.decision, i.reject_reason, i.ingest_path,
            i.llm_tokens_used, i.latency_ms, i.score, i.text_excerpt,
            COALESCE(
              (SELECT array_agg(ci.value ORDER BY ci.value)
                 FROM semantic.chunks c
                 JOIN semantic.chunk_indexes ci ON ci.chunk_id = c.id
                WHERE c.text_hash = i.text_hash AND c.source = i.source
                  AND ci.kind = 'category'),
              ARRAY[]::text[]
            ) AS categories
       FROM audit.ingest_decisions i
       ORDER BY i.ts DESC LIMIT 50`,
  );
  type IngestRow = {
    id: string; ts: string; source: string; decision: string;
    reject_reason: string | null; ingest_path: string;
    llm_tokens_used: number; latency_ms: number; score: number | null;
    text_excerpt: string; categories: string[];
  };
  const ingestsOut = (ingests.rows as IngestRow[]).map((r) => {
    const sensitive = r.categories.includes("health") || r.categories.includes("medical");
    return sensitive
      ? { ...r, text_excerpt: "[redacted: " + r.categories.join("/") + "]" }
      : r;
  });
  const recalls = await pool.query(
    `SELECT id, ts, query_text, hit_tier, candidates, returned,
            llm_tokens_used, embed_calls, latency_ms, score
       FROM audit.recall_decisions
       ORDER BY ts DESC LIMIT 50`,
  );
  sendJson(res, 200, { ingests: ingestsOut, recalls: recalls.rows });
}

function handleStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  res.write("event: hello\ndata: connected\n\n");
  const listener: SseListener = (event) => {
    res.write(`event: audit\ndata: ${JSON.stringify(event)}\n\n`);
  };
  sseListeners.add(listener);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  req.on("close", () => {
    sseListeners.delete(listener);
    clearInterval(heartbeat);
  });
}

export async function startDashboardServer(
  pool: Pool,
  cfg: ResolvedMemoryPostgresConfig,
): Promise<DashboardServer> {
  await ensureListener(pool);
  const expected = cfg.dashboard.tokenEnv ? process.env[cfg.dashboard.tokenEnv] : undefined;

  // Static assets are public — they hold no user data, just the shell. Only
  // /api/* endpoints (which read audit + chunks data) require the token.
  // This avoids the classic browser pitfall where index.html loads via
  // `?token=...` but subsequent <script src="/dashboard.js"> requests don't
  // inherit the query string and 401, breaking the whole SPA.
  const STATIC_PATHS = new Set([
    "/",
    "/index.html",
    "/dashboard.js",
    "/dashboard.css",
    "/docs",
    "/docs.html",
    "/docs.js",
    "/docs.css",
    "/favicon.ico",
  ]);

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${cfg.dashboard.host}:${cfg.dashboard.port}`);
    const pathname = url.pathname;
    const isStatic = STATIC_PATHS.has(pathname);

    if (!isStatic && !tokenOk(req, expected)) {
      send(res, 401, "unauthorized", "text/plain");
      return;
    }
    try {
      switch (pathname) {
        case "/":
        case "/index.html":
          await handleStaticAsset(res, "index.html");
          return;
        case "/dashboard.js":
          await handleStaticAsset(res, "dashboard.js");
          return;
        case "/dashboard.css":
          await handleStaticAsset(res, "dashboard.css");
          return;
        case "/docs":
        case "/docs.html":
          await handleStaticAsset(res, "docs.html");
          return;
        case "/docs.js":
          await handleStaticAsset(res, "docs.js");
          return;
        case "/docs.css":
          await handleStaticAsset(res, "docs.css");
          return;
        case "/favicon.ico":
          send(res, 204, "", "image/x-icon");
          return;
        case "/api/stats":
          await handleStats(res, pool);
          return;
        case "/api/recent":
          await handleRecent(res, pool);
          return;
        case "/api/stream":
          handleStream(req, res);
          return;
        case "/api/recall":
          await handleRecall(req, res, pool, cfg);
          return;
        case "/api/bot-stats":
          await handleBotStats(res);
          return;
        case "/api/model-compare":
          await handleModelCompare(res, pool);
          return;
        case "/api/ingest":
          await handleIngest(req, res, pool, cfg);
          return;
        default:
          send(res, 404, "not found", "text/plain");
      }
    } catch (err) {
      send(res, 500, `server error: ${(err as Error).message}`, "text/plain");
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(cfg.dashboard.port, cfg.dashboard.host, () => resolve());
  });
  const url = `http://${cfg.dashboard.host}:${cfg.dashboard.port}/`;
  return {
    url,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      if (listenClient) {
        try {
          await listenClient.query("UNLISTEN audit_events");
        } finally {
          listenClient.release();
          listenClient = null;
        }
      }
    },
  };
}

export const _internal = { sseListeners };
