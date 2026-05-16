/**
 * Moderator state persistence — load + save + append-only decision log.
 *
 * One JSONB row per (agent_id, scope_key) in `moderator.state`. Cheap
 * single-row upsert on every cycle; the structured stuff lives in the
 * `recentMessages` / `activeWorkers` arrays inside the JSONB and gets
 * trimmed by the runner so the row stays bounded (cap ~50 messages /
 * ~10 active workers).
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { newModeratorState, type ModeratorDecision, type ModeratorState, type ScopeKey } from "./types.js";

export async function loadModeratorState(
  pool: Pool,
  agentId: string,
  scopeKey: ScopeKey,
): Promise<ModeratorState> {
  const r = await pool.query<{ state: ModeratorState; status: string }>(
    `SELECT state, status FROM moderator.state WHERE agent_id = $1 AND scope_key = $2`,
    [agentId, scopeKey],
  );
  if (r.rowCount === 0) {
    return newModeratorState(scopeKey, scopeKey.startsWith("tg:chat:") ? "group" : "dm");
  }
  return migrateState(r.rows[0].state);
}

export type SaveOptions = {
  status?: "live" | "paused" | "archived";
  pausedBy?: string;
  pausedReason?: string;
  bumpMessageCount?: number;
  bumpDecisionCount?: number;
  lastMessageAt?: Date;
  lastReviewAt?: Date;
};

export async function saveModeratorState(
  pool: Pool,
  agentId: string,
  scopeKey: ScopeKey,
  state: ModeratorState,
  opts: SaveOptions = {},
): Promise<void> {
  // Trim arrays to bounded caps before persisting (defense in depth).
  const trimmed: ModeratorState = {
    ...state,
    recentMessages: state.recentMessages.slice(-50),
    activeWorkers: state.activeWorkers.slice(-10),
    debounceBuffer: state.debounceBuffer.slice(-5),
    notes: state.notes.slice(-20),
  };

  await pool.query(
    `INSERT INTO moderator.state (
       agent_id, scope_key, state, status,
       message_count, decision_count,
       last_message_at, last_review_at,
       paused_by, paused_reason,
       updated_at
     )
     VALUES ($1, $2, $3::jsonb, COALESCE($4, 'live'), $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (agent_id, scope_key) DO UPDATE
       SET state           = EXCLUDED.state,
           status          = COALESCE($4, moderator.state.status),
           message_count   = moderator.state.message_count  + $5,
           decision_count  = moderator.state.decision_count + $6,
           last_message_at = COALESCE($7, moderator.state.last_message_at),
           last_review_at  = COALESCE($8, moderator.state.last_review_at),
           paused_by       = COALESCE($9, moderator.state.paused_by),
           paused_reason   = COALESCE($10, moderator.state.paused_reason),
           updated_at      = now()`,
    [
      agentId,
      scopeKey,
      JSON.stringify(trimmed),
      opts.status ?? null,
      opts.bumpMessageCount ?? 0,
      opts.bumpDecisionCount ?? 0,
      opts.lastMessageAt ?? null,
      opts.lastReviewAt ?? null,
      opts.pausedBy ?? null,
      opts.pausedReason ?? null,
    ],
  );
}

/**
 * Append-only log entry for one LLM decision call. Used by the dashboard
 * "what's the bot thinking" view and by the tuning loop later.
 */
export async function logDecision(
  pool: Pool,
  params: {
    agentId: string;
    scopeKey: ScopeKey;
    triggerKind: "message" | "cron" | "worker-result";
    triggerUserId?: string;
    triggerText?: string;
    decision: ModeratorDecision;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    workersSpawned?: number;
    errors?: string[];
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO moderator.decisions (
       id, agent_id, scope_key,
       trigger_kind, trigger_user_id, trigger_text,
       action, rationale, decision_json,
       model, input_tokens, output_tokens, latency_ms,
       workers_spawned, errors
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
       $10, $11, $12, $13, $14, $15
     )`,
    [
      id,
      params.agentId,
      params.scopeKey,
      params.triggerKind,
      params.triggerUserId ?? null,
      params.triggerText ? params.triggerText.slice(0, 1000) : null,
      params.decision.action,
      params.decision.rationale.slice(0, 500),
      JSON.stringify(params.decision),
      params.model ?? null,
      params.inputTokens ?? null,
      params.outputTokens ?? null,
      params.latencyMs ?? null,
      params.workersSpawned ?? 0,
      params.errors && params.errors.length > 0 ? params.errors : null,
    ],
  );
  return id;
}

/**
 * Forward-compatible JSONB shape migration. Today this only enforces the
 * version field; tomorrow's schema changes can land here without a
 * destructive DDL.
 */
function migrateState(raw: ModeratorState | null | undefined): ModeratorState {
  if (!raw || typeof raw !== "object") {
    return newModeratorState("unknown", "dm");
  }
  const s: ModeratorState = {
    scopeKey: raw.scopeKey ?? "unknown",
    scopeKind: raw.scopeKind === "group" ? "group" : "dm",
    chatId: raw.chatId,
    ownerUserId: raw.ownerUserId,
    recentMessages: Array.isArray(raw.recentMessages) ? raw.recentMessages.slice(-50) : [],
    activeTopic: raw.activeTopic,
    activeStudents: Array.isArray(raw.activeStudents) ? raw.activeStudents.slice(-50) : [],
    activeWorkers: Array.isArray(raw.activeWorkers) ? raw.activeWorkers.slice(-10) : [],
    debounceBuffer: Array.isArray(raw.debounceBuffer) ? raw.debounceBuffer.slice(-5) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.slice(-20) : [],
    lastReviewAt: raw.lastReviewAt,
    messagesSinceLastReview: typeof raw.messagesSinceLastReview === "number" ? raw.messagesSinceLastReview : 0,
    version: 1,
  };
  return s;
}
