/**
 * cache.qa — semantic Q&A cache (GPTCache-style).
 *
 * Two lookup paths and one write path, all viewer-scoped:
 *
 *   - `lookupCachedAnswerExact` — sha256(question_text) match; sub-5ms
 *   - `lookupCachedAnswerSemantic` — HNSW cosine match against
 *     question_embedding; ~50ms with the existing pgvector index
 *   - `storeCachedAnswer` — write a new (Q, A, scope) tuple after a
 *     worker answer or a CSV pre-seed
 *
 * Viewer-scope rules are STRUCTURALLY parallel to the chat-memory
 * viewer-scope filter (src/recall/viewer-scope.ts) but evaluate on
 * the cache.qa columns directly rather than on chunk_indexes joins
 * — the cache table is wider on purpose so a hot-path lookup is one
 * indexed scan with no extra EXISTS subqueries.
 *
 * VISIBILITY:
 *   T0  scope_chat_id IS NULL AND scope_sender_id IS NULL  (global / system)
 *   TA  scope_sender_id == viewer.userId                   (the asker's own)
 *   TC  scope_chat_id   == viewer.chatId AND not private  (group-public)
 *   BLOCK  visibility = 'private' AND scope_sender_id != viewer.userId
 */
import { createHash } from "node:crypto";
import pgvector from "pgvector/pg";
const DEFAULT_MIN_SIMILARITY = 0.85;
const DEFAULT_TTL_DAYS = 90;
function hashQuestion(text) {
    return createHash("sha256").update(text.trim().toLowerCase(), "utf8").digest();
}
/* ---------------------------- viewer-scope WHERE --------------------------- */
function viewerScopeWhere(viewer, paramStart) {
    // Without a viewer, anything-goes (legacy / system caller).
    if (!viewer || (!viewer.userId && !viewer.chatId)) {
        return { whereSql: "TRUE", params: [], count: 0 };
    }
    const viewerUser = viewer.userId ?? "__no_user__";
    const viewerChat = viewer.chatId ?? "__no_chat__";
    const p1 = `$${paramStart}`;
    const p2 = `$${paramStart + 1}`;
    const whereSql = `
    (
      (scope_chat_id IS NULL AND scope_sender_id IS NULL)         -- T0 global
      OR scope_sender_id = ${p1}                                   -- TA viewer's own
      OR (scope_chat_id = ${p2} AND scope_visibility != 'private') -- TC group-public
    )
    AND NOT (
      scope_visibility = 'private' AND scope_sender_id IS DISTINCT FROM ${p1}
    )
  `;
    return { whereSql, params: [viewerUser, viewerChat], count: 2 };
}
/* --------------------------------- lookup --------------------------------- */
export async function lookupCachedAnswerExact(pool, params) {
    const agentId = params.agentId ?? "main";
    const hash = hashQuestion(params.questionText);
    const viewerFrag = viewerScopeWhere(params.viewer, 3);
    const sql = `
    SELECT id, question_text, answer_text, answer_format, topic_tag,
           use_count, upvotes, downvotes,
           scope_chat_id, scope_sender_id, scope_visibility,
           source, source_doc_id
      FROM cache.qa
     WHERE agent_id = $1
       AND question_hash = $2
       AND NOT invalidated
       AND cacheable
       AND expires_at > now()
       ${params.topicTag ? `AND topic_tag = $${3 + viewerFrag.count}` : ""}
       AND ${viewerFrag.whereSql}
     ORDER BY (upvotes - downvotes) DESC, use_count DESC, created_at DESC
     LIMIT 1`;
    const args = [agentId, hash, ...viewerFrag.params];
    if (params.topicTag) {
        args.push(params.topicTag);
    }
    const r = await pool.query(sql, args);
    if (r.rowCount === 0) {
        return null;
    }
    const row = r.rows[0];
    return rowToHit(row, 1.0, "exact");
}
export async function lookupCachedAnswerSemantic(pool, params) {
    if (!params.questionEmbedding || params.questionEmbedding.length === 0) {
        return null;
    }
    const agentId = params.agentId ?? "main";
    const minSim = params.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    const viewerFrag = viewerScopeWhere(params.viewer, 3);
    const sql = `
    SELECT id, question_text, answer_text, answer_format, topic_tag,
           use_count, upvotes, downvotes,
           scope_chat_id, scope_sender_id, scope_visibility,
           source, source_doc_id,
           1 - (question_embedding <=> $2::vector) AS similarity
      FROM cache.qa
     WHERE agent_id = $1
       AND NOT invalidated
       AND cacheable
       AND expires_at > now()
       ${params.topicTag ? `AND topic_tag = $${3 + viewerFrag.count}` : ""}
       AND ${viewerFrag.whereSql}
     ORDER BY question_embedding <=> $2::vector
     LIMIT 5`;
    const args = [agentId, pgvector.toSql(params.questionEmbedding), ...viewerFrag.params];
    if (params.topicTag) {
        args.push(params.topicTag);
    }
    const r = await pool.query(sql, args);
    if (r.rowCount === 0) {
        return null;
    }
    // Take the best hit, but only if it clears the threshold.
    const best = r.rows[0];
    if ((best.similarity ?? 0) < minSim) {
        return null;
    }
    return rowToHit(best, best.similarity, "semantic");
}
export async function lookupCachedAnswer(pool, params) {
    // Try exact first (cheap), fall back to semantic if we have an embedding.
    const exact = await lookupCachedAnswerExact(pool, params);
    if (exact) {
        return exact;
    }
    return lookupCachedAnswerSemantic(pool, params);
}
function rowToHit(row, similarity, kind) {
    return {
        id: String(row.id),
        questionText: String(row.question_text),
        answerText: String(row.answer_text),
        answerFormat: String(row.answer_format ?? "plain"),
        topicTag: row.topic_tag ? String(row.topic_tag) : null,
        similarity,
        hitKind: kind,
        useCount: Number(row.use_count ?? 0),
        upvotes: Number(row.upvotes ?? 0),
        downvotes: Number(row.downvotes ?? 0),
        scopeChatId: row.scope_chat_id ? String(row.scope_chat_id) : null,
        scopeSenderId: row.scope_sender_id ? String(row.scope_sender_id) : null,
        scopeVisibility: String(row.scope_visibility ?? "public"),
        source: String(row.source ?? "agent"),
        sourceDocId: row.source_doc_id ? String(row.source_doc_id) : null,
    };
}
/* ---------------------------------- write --------------------------------- */
export async function storeCachedAnswer(pool, params) {
    const agentId = params.agentId ?? "main";
    const hash = hashQuestion(params.questionText);
    const ttlDays = Math.max(1, params.ttlDays ?? DEFAULT_TTL_DAYS);
    const scope = params.scope ?? {};
    const r = await pool.query(`INSERT INTO cache.qa (
       id, agent_id, question_text, question_hash, question_embedding, embedding_model,
       answer_text, answer_format,
       scope_chat_id, scope_sender_id, scope_visibility, cacheable,
       topic_tag, worker_role_id, source, source_doc_id,
       expires_at
     )
     VALUES (
       gen_random_uuid(), $1, $2, $3, $4::vector, $5,
       $6, $7,
       $8, $9, $10, TRUE,
       $11, $12, $13, $14,
       now() + ($15 || ' days')::interval
     )
     ON CONFLICT DO NOTHING
     RETURNING id`, [
        agentId,
        params.questionText,
        hash,
        pgvector.toSql(params.questionEmbedding),
        params.embeddingModel,
        params.answerText,
        params.answerFormat ?? "plain",
        scope.chatId ?? null,
        scope.senderId ?? null,
        scope.visibility ?? "public",
        params.topicTag ?? null,
        params.workerRoleId ?? null,
        params.source ?? "agent",
        params.sourceDocId ?? null,
        String(ttlDays),
    ]);
    return r.rows[0]?.id ?? "";
}
/* ---------------------------------- ops ----------------------------------- */
export async function recordCacheHit(pool, id) {
    await pool
        .query(`UPDATE cache.qa
         SET use_count = use_count + 1, last_used_at = now()
       WHERE id = $1`, [id])
        .catch(() => undefined);
}
export async function invalidateCachedAnswer(pool, id, reason) {
    await pool.query(`UPDATE cache.qa SET invalidated = true, invalidated_reason = $2 WHERE id = $1`, [id, reason]);
}
/**
 * Invalidate every cached answer derived from a given source chunk/doc. Called
 * from the chunk-invalidation path so a forgotten/rewritten chunk stops serving
 * a stale answer — without this the QA cache's 90-day TTL outlives the fact.
 * Matches on `source_doc_id`, the direct provenance link. Returns the count
 * invalidated.
 */
export async function invalidateCachedAnswersByDoc(pool, sourceDocId, reason) {
    const r = await pool.query(`UPDATE cache.qa SET invalidated = true, invalidated_reason = $2
       WHERE source_doc_id = $1 AND NOT invalidated`, [sourceDocId, reason]);
    return r.rowCount ?? 0;
}
export async function recordCacheFeedback(pool, id, vote) {
    await pool.query(vote === "up"
        ? `UPDATE cache.qa SET upvotes = upvotes + 1 WHERE id = $1`
        : `UPDATE cache.qa SET downvotes = downvotes + 1 WHERE id = $1`, [id]);
    // Auto-invalidate when net feedback goes negative and at least 3 downvotes.
    await pool.query(`UPDATE cache.qa
        SET invalidated = true, invalidated_reason = 'auto: downvotes > upvotes + 3'
      WHERE id = $1
        AND NOT invalidated
        AND downvotes - upvotes > 3`, [id]);
}
export async function cacheStats(pool, agentId = "main") {
    const r = await pool.query(`SELECT topic_tag,
            count(*)::text AS entries,
            sum(use_count)::text AS total_uses,
            avg(upvotes - downvotes)::text AS avg_quality
       FROM cache.qa
      WHERE agent_id = $1 AND NOT invalidated AND cacheable
      GROUP BY topic_tag
      ORDER BY sum(use_count) DESC NULLS LAST
      LIMIT 50`, [agentId]);
    return r.rows.map((row) => ({
        topicTag: row.topic_tag,
        entries: parseInt(row.entries, 10),
        totalUses: parseInt(row.total_uses, 10),
        avgQuality: parseFloat(row.avg_quality ?? "0"),
    }));
}
