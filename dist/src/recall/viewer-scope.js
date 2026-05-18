/**
 * Viewer-scoped privacy filter — the three-tier memory model in SQL.
 *
 * Model
 * -----
 * Every chunk MAY carry these anchors (set at ingest time via chunk_indexes):
 *   - anchor_sender_id   the human who said it (e.g. telegram user id)
 *   - anchor_chat_id     the chat it was said in (telegram chat id; for DMs
 *                        this can be omitted or equal the sender)
 *   - anchor_visibility  'public' (default if absent) | 'private'
 *
 * A recall call carries a *viewer*: who is asking, in what chat.
 *
 *   viewer = { userId: <8064984663>, chatId: <-1001234567890> | undefined }
 *
 * VISIBLE iff one of:
 *   T0  no `anchor_sender_id` AND no `anchor_chat_id`
 *                                              (truly agent-global / system —
 *                                              e.g. plugin policy, smoke ingest;
 *                                              a chunk tagged only with chat_id
 *                                              is chat-scoped and falls under
 *                                              TC, NOT under T0)
 *   TA  anchor_sender_id == viewer.userId     (about the asker — DM or group)
 *   TC  anchor_chat_id == viewer.chatId       AND visibility != 'private'
 *                                              (group-public — other speakers
 *                                              in the same chat are OK to see
 *                                              because they were physically
 *                                              co-present)
 *
 * BLOCKED iff:
 *   – `anchor_sender_id` exists AND != viewer.userId AND no `anchor_chat_id`
 *     matching viewer.chatId
 *   – OR `anchor_visibility = 'private'` AND `anchor_sender_id != viewer.userId`
 *
 * Two corollaries worth stating:
 *   - In a DM (viewer.chatId == undefined), TC never fires; you only see
 *     your own (TA) + system (T0) facts. Other students' DM facts stay
 *     invisible.
 *   - The agent's *own* outputs (kind='assistant_reply') get tagged with
 *     the SAME anchors as the inbound message they responded to, so they
 *     route through the same filter without special casing.
 *
 * Why this lives in SQL, not in the agent prompt:
 *   The Anthropic addressee-recognition benchmark (arxiv 2501.16643)
 *   shows even GPT-4o is barely-above-chance at judging privacy/scope
 *   in multi-party chat. We do not trust the LLM with the boundary.
 *   Every route in `routes.ts` applies this fragment as a hard SQL filter.
 */
/**
 * Batch-mode visibility check. Given an array of chunk ids and a viewer
 * scope, return the subset that the viewer is allowed to see under the
 * three-tier rules. Used by the recall router as a post-merge filter so
 * each route can stay simple while privacy still gets enforced once
 * before results leave the recall path.
 *
 * One round-trip via pg, primary-key-indexed: typical 10-candidate
 * filtered call is sub-millisecond.
 */
export async function filterVisibleChunkIds(pool, viewer, chunkIds) {
    if (chunkIds.length === 0) {
        return new Set();
    }
    if (!viewer || (!viewer.userId && !viewer.chatId)) {
        // No viewer = pre-existing single-user behaviour; everything passes.
        return new Set(chunkIds);
    }
    const viewerUser = viewer.userId ?? "__no_user__";
    const viewerChat = viewer.chatId ?? "__no_chat__";
    const rows = await pool.query(`SELECT c.id
       FROM semantic.chunks c
      WHERE c.id = ANY($1::uuid[])
        AND (
          -- T0: truly agent-global facts — NO sender AND NO chat anchor.
          --     A chunk tagged only with anchor_chat_id is chat-scoped,
          --     not global; it falls under TC below.
          (
            NOT EXISTS (
              SELECT 1 FROM semantic.chunk_indexes vci
               WHERE vci.chunk_id = c.id
                 AND vci.kind = 'anchor_sender_id'
            )
            AND NOT EXISTS (
              SELECT 1 FROM semantic.chunk_indexes vci
               WHERE vci.chunk_id = c.id
                 AND vci.kind = 'anchor_chat_id'
            )
          )
          OR
          -- TA: about the viewer (their own facts; cross-chat-visible)
          EXISTS (
            SELECT 1 FROM semantic.chunk_indexes vci
             WHERE vci.chunk_id = c.id
               AND vci.kind = 'anchor_sender_id'
               AND vci.value = $2
          )
          OR
          -- TC: spoken in viewer's current chat AND not marked private
          (
            EXISTS (
              SELECT 1 FROM semantic.chunk_indexes vci
               WHERE vci.chunk_id = c.id
                 AND vci.kind = 'anchor_chat_id'
                 AND vci.value = $3
            )
            AND NOT EXISTS (
              SELECT 1 FROM semantic.chunk_indexes vci
               WHERE vci.chunk_id = c.id
                 AND vci.kind = 'anchor_visibility'
                 AND vci.value = 'private'
            )
          )
        )
        AND NOT EXISTS (
          -- BLOCK: explicitly private chunks owned by someone other than viewer
          SELECT 1 FROM semantic.chunk_indexes ci_priv
           WHERE ci_priv.chunk_id = c.id
             AND ci_priv.kind = 'anchor_visibility'
             AND ci_priv.value = 'private'
             AND NOT EXISTS (
               SELECT 1 FROM semantic.chunk_indexes ci_owner
                WHERE ci_owner.chunk_id = c.id
                  AND ci_owner.kind = 'anchor_sender_id'
                  AND ci_owner.value = $2
             )
        )`, [chunkIds, viewerUser, viewerChat]);
    return new Set(rows.rows.map((r) => r.id));
}
/**
 * Build the SQL fragment + bind values implementing the visibility rules above.
 *
 * `paramStartIndex` is the next available $N (1-based). Returns
 * `{ whereSql, params, paramCount }` so the caller can splice the fragment
 * into a larger query at the right position.
 *
 * If `viewer` is omitted or empty, returns a no-op (`whereSql = "TRUE"`).
 * This preserves backward compatibility with single-user / DM-only callers
 * who haven't migrated to the viewer model yet.
 */
export function buildViewerScopeFilter(viewer, paramStartIndex) {
    if (!viewer || (!viewer.userId && !viewer.chatId)) {
        return { whereSql: "TRUE", params: [], paramCount: 0 };
    }
    const params = [];
    let p = paramStartIndex;
    // We always need viewerUserId in scope; if absent, treat as a magic sentinel
    // that never matches any sender, which means TA never fires and only T0 / TC
    // visibility remains. Useful for system-side calls.
    const viewerUserParam = `$${p}`;
    params.push(viewer.userId ?? "__no_user__");
    p += 1;
    const viewerChatParam = `$${p}`;
    params.push(viewer.chatId ?? "__no_chat__");
    p += 1;
    const whereSql = `
    (
      -- T0: truly agent-global (NO sender AND NO chat anchor)
      (
        NOT EXISTS (
          SELECT 1 FROM semantic.chunk_indexes vci
           WHERE vci.chunk_id = c.id
             AND vci.kind = 'anchor_sender_id'
        )
        AND NOT EXISTS (
          SELECT 1 FROM semantic.chunk_indexes vci
           WHERE vci.chunk_id = c.id
             AND vci.kind = 'anchor_chat_id'
        )
      )
      OR
      -- TA: about the viewer (their own facts; cross-chat-visible)
      EXISTS (
        SELECT 1 FROM semantic.chunk_indexes vci
         WHERE vci.chunk_id = c.id
           AND vci.kind = 'anchor_sender_id'
           AND vci.value = ${viewerUserParam}
      )
      OR
      -- TC: spoken in viewer's current chat AND not marked private
      (
        EXISTS (
          SELECT 1 FROM semantic.chunk_indexes vci
           WHERE vci.chunk_id = c.id
             AND vci.kind = 'anchor_chat_id'
             AND vci.value = ${viewerChatParam}
        )
        AND NOT EXISTS (
          SELECT 1 FROM semantic.chunk_indexes vci
           WHERE vci.chunk_id = c.id
             AND vci.kind = 'anchor_visibility'
             AND vci.value = 'private'
        )
      )
    )
    AND
    -- BLOCK: explicitly private chunks owned by someone other than viewer
    NOT EXISTS (
      SELECT 1 FROM semantic.chunk_indexes ci_priv
       WHERE ci_priv.chunk_id = c.id
         AND ci_priv.kind = 'anchor_visibility'
         AND ci_priv.value = 'private'
         AND NOT EXISTS (
           SELECT 1 FROM semantic.chunk_indexes ci_owner
            WHERE ci_owner.chunk_id = c.id
              AND ci_owner.kind = 'anchor_sender_id'
              AND ci_owner.value = ${viewerUserParam}
         )
    )
  `;
    return { whereSql, params, paramCount: p - paramStartIndex };
}
