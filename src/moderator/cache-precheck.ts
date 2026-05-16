/**
 * Pre-Moderator cache lookup — L0 (in-process LRU) + L1 (PG exact-hash) +
 * L2 (PG semantic HNSW). When a hit lands, we send the cached answer
 * directly and SKIP the Moderator + worker entirely → 0 Gemini tokens,
 * ~50ms latency instead of ~6s.
 *
 * Why an in-process L0 in front of L1 (PG):
 *   - True hot-path ("same question 3 times in 30 sec, e.g. a student
 *     spam-clicking send") gets sub-millisecond response.
 *   - Saves PG round-trips on the burstiest cases.
 *   - LRU bounded; memory cost negligible (~50KB at 200 entries).
 *
 * Why not Redis:
 *   - PG cache.qa already does the durable cross-restart cache.
 *   - L0 covers the only path where Redis would beat PG (sub-ms).
 *   - One fewer service to operate.
 */

import type { Pool } from "pg";
import type { EmbeddingClient } from "../embedding/client.js";
import {
  lookupCachedAnswerExact,
  lookupCachedAnswerSemantic,
  recordCacheHit,
  type CacheHit,
} from "../cache/qa.js";
import type { ViewerScope } from "../recall/viewer-scope.js";

/* ----------------------------- L0 in-process ------------------------------ */

type L0Entry = { hit: CacheHit; cachedAt: number; key: string };
const L0_CAP = 200;
const L0_TTL_MS = 5 * 60 * 1000; // 5 minutes
const L0: Map<string, L0Entry> = new Map(); // scope-aware Map<key, L0Entry>

function l0Key(scopeKey: string, questionTextNormalized: string, viewerUserId?: string): string {
  return `${scopeKey}|${viewerUserId ?? ""}|${questionTextNormalized}`;
}

/**
 * Strip Telegram bot mentions + collapse whitespace before hashing/embedding.
 *
 * Why this matters: a user message in a group looks like
 *   "@Yao_zhua_bot 1/3 + 1/4 等于多少"
 * but the cached row was stored as
 *   "1/3 + 1/4 等于多少"
 * Without stripping, the cosine similarity drops from 0.88 → 0.76 because the
 * @-handle dominates a quarter of the token budget on short questions.
 *
 * We strip ALL @-mentions (not just the bot's own) because:
 *   - addressing a peer (`@alice ...`) shouldn't change the cache key
 *   - we don't know the bot's username at this layer without plumbing config
 *     (telegram-api.ts has botToken, not username)
 */
function cleanQuestionText(text: string): string {
  return text
    .replace(/@[A-Za-z0-9_]{3,32}/g, " ") // Telegram username spec: 5-32 chars, but be lenient
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuestion(text: string): string {
  return cleanQuestionText(text).toLowerCase();
}

function l0Get(key: string): CacheHit | null {
  const entry = L0.get(key);
  if (!entry) {return null;}
  if (Date.now() - entry.cachedAt > L0_TTL_MS) {
    L0.delete(key);
    return null;
  }
  // LRU bump — re-insert moves to MRU position in JS Map iteration order
  L0.delete(key);
  L0.set(key, entry);
  return entry.hit;
}

function l0Set(key: string, hit: CacheHit): void {
  if (L0.size >= L0_CAP) {
    // Evict LRU (first key in iteration order)
    const oldest = L0.keys().next().value;
    if (oldest !== undefined) {L0.delete(oldest);}
  }
  L0.set(key, { hit, cachedAt: Date.now(), key });
}

export function clearL0Cache(): void {
  L0.clear();
}

export function l0Stats(): { size: number; capacity: number } {
  return { size: L0.size, capacity: L0_CAP };
}

/* ------------------------------ public API -------------------------------- */

export type CachePrecheckDeps = {
  pool: Pool;
  embedding: EmbeddingClient;
  agentId: string;
  minSimilarity?: number;
};

export type CachePrecheckParams = {
  /** Scope (`tg:chat:<chat_id>` / `tg:dm:<user_id>`). */
  scopeKey: string;
  /** The user's message text (raw — we normalise internally). */
  questionText: string;
  /** Viewer for the 3-tier scope filter (so other-user private cache
   *  rows stay hidden even if a question text matches). */
  viewer?: ViewerScope;
  /** Optional caller topic hint to narrow lookup. */
  topicTag?: string;
};

export type CachePrecheckResult =
  | { hit: true; hitKind: "L0" | "L1-exact" | "L2-semantic"; answer: string; cacheId: string; similarity: number; latencyMs: number }
  | { hit: false; latencyMs: number };

/**
 * Walks L0 → L1 (exact) → L2 (semantic) in order. First hit wins. On hit:
 *  - L0 returns straight away
 *  - L1/L2 hits get warmed into L0 for next time
 *  - cache.qa.use_count gets bumped (async, fire-and-forget)
 *
 * Returns { hit: false } on miss. Caller continues to Moderator.
 */
export async function tryCachePrecheck(
  deps: CachePrecheckDeps,
  params: CachePrecheckParams,
): Promise<CachePrecheckResult> {
  const startedAt = Date.now();
  // Cleaned form (mention-stripped, single-spaced). Used for L0 key, L1 hash,
  // and L2 embedding. Original questionText is kept ONLY for logging /
  // cache-write of NEW rows (so we don't lose the verbatim input there).
  const cleaned = cleanQuestionText(params.questionText);
  const norm = cleaned.toLowerCase();
  if (norm.length < 4) {
    return { hit: false, latencyMs: 0 };
  }

  const key = l0Key(params.scopeKey, norm, params.viewer?.userId);

  // L0 — in-process LRU
  const fromL0 = l0Get(key);
  if (fromL0) {
    void recordCacheHit(deps.pool, fromL0.id).catch(() => undefined);
    return {
      hit: true,
      hitKind: "L0",
      answer: fromL0.answerText,
      cacheId: fromL0.id,
      similarity: 1.0,
      latencyMs: Date.now() - startedAt,
    };
  }

  // L1 — PG cache.qa exact-hash (uses the cleaned form so "@bot foo" and
  // "foo" hash to the same bucket)
  const exact = await lookupCachedAnswerExact(deps.pool, {
    agentId: deps.agentId,
    questionText: cleaned,
    viewer: params.viewer,
    topicTag: params.topicTag,
  });
  if (exact) {
    l0Set(key, exact);
    return {
      hit: true,
      hitKind: "L1-exact",
      answer: exact.answerText,
      cacheId: exact.id,
      similarity: 1.0,
      latencyMs: Date.now() - startedAt,
    };
  }

  // L2 — PG cache.qa semantic (HNSW). Needs the embedding first.
  // Worth the ~100ms embed call because we'll skip a ~6s Gemini call on hit.
  let questionEmbedding: number[] | undefined;
  try {
    const embedRes = await deps.embedding.embed({
      inputs: [cleaned],
      taskPrefix: "query",
    });
    questionEmbedding = embedRes.embeddings[0];
  } catch {
    // Embedding broke — fall through to miss; the Moderator path handles
    // the question without cache assistance.
    return { hit: false, latencyMs: Date.now() - startedAt };
  }
  const semantic = await lookupCachedAnswerSemantic(deps.pool, {
    agentId: deps.agentId,
    questionText: cleaned,
    questionEmbedding,
    viewer: params.viewer,
    minSimilarity: deps.minSimilarity ?? 0.85,
    topicTag: params.topicTag,
  });
  if (semantic) {
    l0Set(key, semantic);
    return {
      hit: true,
      hitKind: "L2-semantic",
      answer: semantic.answerText,
      cacheId: semantic.id,
      similarity: semantic.similarity,
      latencyMs: Date.now() - startedAt,
    };
  }

  return { hit: false, latencyMs: Date.now() - startedAt };
}
