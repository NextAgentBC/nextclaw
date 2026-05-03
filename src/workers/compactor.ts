/**
 * Cold-gist compactor (Phase 6).
 *
 * Finds chunks that haven't been recalled in `minAgeDays` days, are not
 * pinned, and groups them into topical clusters by shared concept_tag /
 * entity_ref. For each cluster of size ≥ minClusterSize, emits a single
 * cold.gists row that summarises the span. The summary is computed by a
 * pluggable summarizer (deterministic concat fallback when no LLM bound).
 *
 * Side effects:
 *   - cold.gists insert
 *   - source chunks marked retention_class='ephemeral' (still queryable but
 *     excluded from hot indexes); chunks remain referenced by source_chunk_ids
 *     so audit / drill-down still works.
 */

import { randomUUID } from "node:crypto";
import pgvector from "pgvector/pg";
import type { Pool } from "pg";

import type { EmbeddingClient } from "../embedding/client.js";

export type CompactorOptions = {
  /** Only chunks older than this are eligible. */
  minAgeDays?: number;
  /** Don't compact unless we have at least this many cluster members. */
  minClusterSize?: number;
  /** Cap clusters processed per pass. */
  maxClusters?: number;
  /**
   * Optional LLM summarizer. If absent, we deterministically concat first
   * sentences. Either way, the summary text is embedded for HNSW lookup.
   */
  summarizer?: (texts: string[]) => Promise<string>;
};

export type CompactorOutcome = {
  clustersFound: number;
  gistsWritten: number;
  chunksDemoted: number;
};

export async function compactCold(
  pool: Pool,
  embedding: EmbeddingClient,
  opts: CompactorOptions = {},
): Promise<CompactorOutcome> {
  const minAgeDays = opts.minAgeDays ?? 90;
  const minClusterSize = opts.minClusterSize ?? 3;
  const maxClusters = opts.maxClusters ?? 25;

  // Cluster stale chunks by their dominant concept_tag.
  const clusters = await pool.query<{ topic: string; chunk_ids: string[] }>(
    `WITH stale AS (
       SELECT id
         FROM semantic.chunks
         WHERE retention_class = 'standard'
           AND (last_recalled_at IS NULL OR last_recalled_at < now() - ($1 || ' days')::interval)
           AND created_at < now() - ($1 || ' days')::interval
     ),
     tagged AS (
       SELECT ci.value AS topic, ci.chunk_id
         FROM semantic.chunk_indexes ci
         JOIN stale s ON s.id = ci.chunk_id
         WHERE ci.kind = 'concept_tag'
     )
     SELECT topic,
            (array_agg(chunk_id))::uuid[] AS chunk_ids
       FROM tagged
       GROUP BY topic
       HAVING count(*) >= $2
       ORDER BY count(*) DESC
       LIMIT $3`,
    [String(minAgeDays), minClusterSize, maxClusters],
  );

  let written = 0;
  let demoted = 0;
  for (const cluster of clusters.rows) {
    const chunks = await pool.query<{
      id: string;
      text: string;
      created_at: Date;
    }>(
      `SELECT id, text, created_at FROM semantic.chunks WHERE id = ANY($1::uuid[])`,
      [cluster.chunk_ids],
    );
    if (chunks.rowCount === 0) {continue;}
    const sortedRows = chunks.rows.toSorted(
      (a, b) => a.created_at.getTime() - b.created_at.getTime(),
    );
    const texts = sortedRows.map((r) => r.text);
    const summary = opts.summarizer
      ? await opts.summarizer(texts)
      : deterministicSummary(texts, cluster.topic);
    const embed = await embedding.embed({ inputs: [summary] });
    const vec = embed.embeddings[0] ?? [];
    if (vec.length === 0) {continue;}

    const id = randomUUID();
    const spanStart = sortedRows[0].created_at;
    const spanEnd = sortedRows[sortedRows.length - 1].created_at;

    await pool.query(
      `INSERT INTO cold.gists
         (id, span_start, span_end, topic, summary_text, embedding, source_chunk_ids, importance)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::uuid[], $8)`,
      [
        id,
        spanStart,
        spanEnd,
        cluster.topic,
        summary,
        pgvector.toSql(vec),
        cluster.chunk_ids,
        Math.min(1, sortedRows.length / 10),
      ],
    );
    written += 1;

    // Demote source chunks so they no longer crowd hot indexes / vector lookup.
    const demoteResult = await pool.query(
      `UPDATE semantic.chunks
          SET retention_class = 'ephemeral'
        WHERE id = ANY($1::uuid[]) AND retention_class = 'standard'`,
      [cluster.chunk_ids],
    );
    demoted += demoteResult.rowCount ?? 0;
  }
  return {
    clustersFound: clusters.rowCount ?? 0,
    gistsWritten: written,
    chunksDemoted: demoted,
  };
}

function deterministicSummary(texts: string[], topic: string): string {
  // First sentences only, capped at 1500 chars. Good enough for embedding +
  // drill-down. Compactor is async so a richer LLM summary can be plugged in
  // later via opts.summarizer.
  const heads = texts.map((t) => firstSentence(t));
  const joined = `[${topic}] ${heads.join(" / ")}`;
  return joined.slice(0, 1500);
}

function firstSentence(text: string): string {
  const m = /^(.{20,200}?[.!?。！？]\s*|.{0,200})/u.exec(text.trim());
  return (m?.[1] ?? text).trim();
}

/* ------------------------------- drill-down -------------------------------- */

export type GistRow = {
  id: string;
  topic: string;
  spanStart: Date;
  spanEnd: Date;
  summary: string;
  importance: number;
  sourceChunkIds: string[];
};

/** Look up chunks whose ids appear in any cold gist. */
export async function findGistsContainingChunk(
  pool: Pool,
  chunkId: string,
): Promise<GistRow[]> {
  const rows = await pool.query<{
    id: string;
    topic: string;
    span_start: Date;
    span_end: Date;
    summary_text: string;
    importance: number;
    source_chunk_ids: string[];
  }>(
    `SELECT id, topic, span_start, span_end, summary_text, importance, source_chunk_ids
       FROM cold.gists
       WHERE $1::uuid = ANY(source_chunk_ids)
       ORDER BY span_end DESC`,
    [chunkId],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    spanStart: r.span_start,
    spanEnd: r.span_end,
    summary: r.summary_text,
    importance: r.importance,
    sourceChunkIds: r.source_chunk_ids,
  }));
}
