/**
 * StructuredMemoryAPI: typed read surface over structured.* tables.
 *
 * Other plugins (and core, eventually) consume these via the SDK barrel
 * (sdk/structured-api.ts). Methods are intentionally narrow — entity lookup,
 * recent events, active preferences, metric aggregates — so the recall router
 * (Phase 4) can compose them without re-deriving SQL each time.
 */

import type { Pool } from "pg";

export type EntityRow = {
  id: string;
  type: string;
  canonicalName: string;
  aliases: string[];
  attrs: Record<string, unknown>;
  confidence: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export type EventRow = {
  id: string;
  ts: Date;
  endTs?: Date;
  type: string;
  actorId?: string;
  targetId?: string;
  details: Record<string, unknown>;
  confidence: number;
};

export type PreferenceRow = {
  id: string;
  scope: string;
  key: string;
  value: unknown;
  ruleText?: string;
  evidenceCount: number;
  confidence: number;
  supersedes?: string;
  createdAt: Date;
};

export type MetricAggregate = {
  metric: string;
  unit?: string;
  total: number;
  count: number;
  min: number;
  max: number;
  avg: number;
};

export class StructuredMemoryAPI {
  constructor(private readonly pool: Pool) {}

  /** Trigram-fuzzy entity lookup by name or alias. */
  async findEntities(params: {
    name: string;
    type?: string;
    limit?: number;
    minSimilarity?: number;
  }): Promise<EntityRow[]> {
    const limit = Math.max(1, params.limit ?? 10);
    const minSim = params.minSimilarity ?? 0.3;
    const rows = await this.pool.query<{
      id: string;
      type: string;
      canonical_name: string;
      aliases: string[];
      attrs: Record<string, unknown>;
      confidence: number;
      first_seen_at: Date;
      last_seen_at: Date;
    }>(
      `SELECT id, type, canonical_name, aliases, attrs, confidence,
              first_seen_at, last_seen_at
         FROM structured.entities
         WHERE deleted_at IS NULL
           AND ($2::text IS NULL OR type = $2::text)
           AND (
             canonical_name ILIKE '%' || $1 || '%'
             OR similarity(canonical_name, $1) >= $4
             OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE '%' || $1 || '%')
           )
         ORDER BY GREATEST(
           similarity(canonical_name, $1),
           COALESCE((SELECT max(similarity(a, $1)) FROM unnest(aliases) a), 0)
         ) DESC
         LIMIT $3`,
      [params.name, params.type ?? null, limit, minSim],
    );
    return rows.rows.map((r) => ({
      id: r.id,
      type: r.type,
      canonicalName: r.canonical_name,
      aliases: r.aliases,
      attrs: r.attrs,
      confidence: r.confidence,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  /** Recent events in a time window, optionally filtered by entity. */
  async listEvents(params: {
    type?: string;
    actorId?: string;
    targetId?: string;
    since?: Date;
    until?: Date;
    limit?: number;
  }): Promise<EventRow[]> {
    const rows = await this.pool.query<{
      id: string;
      ts: Date;
      end_ts: Date | null;
      type: string;
      actor_id: string | null;
      target_id: string | null;
      details: Record<string, unknown>;
      confidence: number;
    }>(
      `SELECT id, ts, end_ts, type, actor_id, target_id, details, confidence
         FROM structured.events
         WHERE ($1::text IS NULL OR type = $1::text)
           AND ($2::uuid IS NULL OR actor_id  = $2::uuid)
           AND ($3::uuid IS NULL OR target_id = $3::uuid)
           AND ($4::timestamptz IS NULL OR ts >= $4)
           AND ($5::timestamptz IS NULL OR ts <  $5)
         ORDER BY ts DESC
         LIMIT $6`,
      [
        params.type ?? null,
        params.actorId ?? null,
        params.targetId ?? null,
        params.since ?? null,
        params.until ?? null,
        Math.max(1, params.limit ?? 20),
      ],
    );
    return rows.rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      endTs: r.end_ts ?? undefined,
      type: r.type,
      actorId: r.actor_id ?? undefined,
      targetId: r.target_id ?? undefined,
      details: r.details,
      confidence: r.confidence,
    }));
  }

  /** Latest active preference for a scope+key (returns null when invalidated/missing). */
  async getPreference(scope: string, key: string): Promise<PreferenceRow | null> {
    const rows = await this.pool.query<{
      id: string;
      scope: string;
      key: string;
      value: unknown;
      rule_text: string | null;
      evidence_count: number;
      confidence: number;
      supersedes: string | null;
      created_at: Date;
    }>(
      `SELECT id, scope, key, value, rule_text, evidence_count,
              confidence, supersedes, created_at
         FROM structured.preferences
         WHERE scope = $1 AND key = $2 AND invalidated_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      [scope, key],
    );
    if (rows.rowCount === 0) {return null;}
    const r = rows.rows[0];
    return {
      id: r.id,
      scope: r.scope,
      key: r.key,
      value: r.value,
      ruleText: r.rule_text ?? undefined,
      evidenceCount: r.evidence_count,
      confidence: r.confidence,
      supersedes: r.supersedes ?? undefined,
      createdAt: r.created_at,
    };
  }

  /** Aggregate a metric over a time window grouped by optional dimension keys. */
  async aggregateMetric(params: {
    metric: string;
    since?: Date;
    until?: Date;
  }): Promise<MetricAggregate | null> {
    const rows = await this.pool.query<{
      total: string;
      count: string;
      min_v: string;
      max_v: string;
      unit: string | null;
    }>(
      `SELECT
         COALESCE(SUM(value), 0)::text AS total,
         COUNT(*)::text                 AS count,
         COALESCE(MIN(value), 0)::text  AS min_v,
         COALESCE(MAX(value), 0)::text  AS max_v,
         (array_agg(unit) FILTER (WHERE unit IS NOT NULL))[1] AS unit
       FROM structured.metrics
       WHERE metric = $1
         AND ($2::timestamptz IS NULL OR ts >= $2)
         AND ($3::timestamptz IS NULL OR ts <  $3)`,
      [params.metric, params.since ?? null, params.until ?? null],
    );
    const r = rows.rows[0];
    if (!r || Number(r.count) === 0) {return null;}
    const count = Number(r.count);
    const total = Number(r.total);
    return {
      metric: params.metric,
      unit: r.unit ?? undefined,
      total,
      count,
      min: Number(r.min_v),
      max: Number(r.max_v),
      avg: total / count,
    };
  }

  /** All chunk_ids whose any provenance entry references a structured item. */
  async findChunksFor(itemKind: string, itemId: string): Promise<string[]> {
    const rows = await this.pool.query<{ chunk_id: string | null }>(
      `SELECT DISTINCT chunk_id FROM structured.provenance
         WHERE item_kind = $1 AND item_id = $2 AND chunk_id IS NOT NULL`,
      [itemKind, itemId],
    );
    return rows.rows.map((r) => r.chunk_id).filter((v): v is string => v !== null);
  }
}
