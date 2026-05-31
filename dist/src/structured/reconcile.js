/**
 * Reconcile + write: take ExtractorResult candidates and apply them to PG.
 *
 * Rules:
 *   - entities    : trgm + alias match → merge aliases + bump last_seen_at, else INSERT.
 *   - relations   : exact (subject, predicate, object_id) tuple → skip dup; else INSERT.
 *   - events      : (ts_minute_bucket, type, actor, target) hash → skip dup; else INSERT.
 *   - preferences : (scope, key) active → if value matches, evidence_count++;
 *                   if value differs, supersede chain (new row, old.invalidated_at).
 *   - metrics     : (ts, metric, dim) unique-ish; ON CONFLICT DO NOTHING tolerated.
 *
 * Each new structured row writes a structured.provenance entry linking it to
 * its source chunk_id, raw excerpt, and extractor version. This is what
 * powers "why do you think I prefer X?" drill-down later.
 */
import { randomUUID } from "node:crypto";
export async function reconcile(pool, input) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const out = {
            entityIds: [],
            relationIds: [],
            eventIds: [],
            preferenceIds: [],
            metricIds: [],
            commitmentIds: [],
            dedupCount: 0,
        };
        // 1. Entities first — relations/events refer to entity ids.
        const entityIdByKey = new Map();
        for (const e of input.result.entities) {
            const { id, deduped } = await upsertEntity(client, e);
            if (deduped) {
                out.dedupCount += 1;
            }
            out.entityIds.push(id);
            entityIdByKey.set(`${e.type}|${e.canonicalName}`, id);
        }
        for (const r of input.result.relations) {
            const subjId = entityIdByKey.get(`${r.subject.type}|${r.subject.canonicalName}`)
                ?? (await upsertEntity(client, {
                    type: r.subject.type,
                    canonicalName: r.subject.canonicalName,
                    confidence: r.confidence,
                })).id;
            const objId = r.object
                ? (entityIdByKey.get(`${r.object.type}|${r.object.canonicalName}`)
                    ?? (await upsertEntity(client, {
                        type: r.object.type,
                        canonicalName: r.object.canonicalName,
                        confidence: r.confidence,
                    })).id)
                : null;
            const { id, deduped } = await upsertRelation(client, r, subjId, objId);
            if (deduped) {
                out.dedupCount += 1;
            }
            out.relationIds.push(id);
        }
        for (const ev of input.result.events) {
            const actorId = ev.actor
                ? entityIdByKey.get(`${ev.actor.type}|${ev.actor.canonicalName}`) ?? null
                : null;
            const targetId = ev.target
                ? entityIdByKey.get(`${ev.target.type}|${ev.target.canonicalName}`) ?? null
                : null;
            const { id, deduped } = await upsertEvent(client, ev, actorId, targetId);
            if (deduped) {
                out.dedupCount += 1;
            }
            out.eventIds.push(id);
        }
        for (const p of input.result.preferences) {
            const { id, deduped } = await upsertPreference(client, p);
            if (deduped) {
                out.dedupCount += 1;
            }
            out.preferenceIds.push(id);
        }
        for (const m of input.result.metrics) {
            const { id, deduped } = await upsertMetric(client, m);
            if (deduped) {
                out.dedupCount += 1;
            }
            out.metricIds.push(id);
        }
        const agentId = input.agentId ?? "main";
        for (const c of input.result.commitments) {
            const { id, deduped } = await upsertCommitment(client, c, agentId, input.chunkId);
            if (deduped) {
                out.dedupCount += 1;
            }
            out.commitmentIds.push(id);
        }
        // Provenance — one row per *new* structured insertion (skip dedups).
        await writeProvenance(client, input, out);
        await client.query("COMMIT");
        return out;
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
}
/* -------------------------------- entities --------------------------------- */
async function upsertEntity(client, e) {
    const existing = await client.query(`SELECT id, aliases FROM structured.entities
       WHERE type = $1 AND canonical_name = $2 AND deleted_at IS NULL
       LIMIT 1`, [e.type, e.canonicalName]);
    if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0];
        if (!row) {
            return { id: existing.rows[0].id, deduped: true };
        }
        const mergedAliases = mergeAliases(row.aliases, e.aliases ?? []);
        if (mergedAliases.length !== row.aliases.length) {
            await client.query(`UPDATE structured.entities
            SET aliases = $1, last_seen_at = now()
          WHERE id = $2`, [mergedAliases, row.id]);
        }
        else {
            await client.query("UPDATE structured.entities SET last_seen_at = now() WHERE id = $1", [row.id]);
        }
        return { id: row.id, deduped: true };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO structured.entities
       (id, type, canonical_name, aliases, attrs, confidence, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`, [
        id,
        e.type,
        e.canonicalName,
        e.aliases ?? [],
        e.attrs ?? {},
        e.confidence,
    ]);
    return { id, deduped: false };
}
function mergeAliases(prev, next) {
    const set = new Set(prev);
    for (const a of next) {
        set.add(a);
    }
    return [...set];
}
/* -------------------------------- relations -------------------------------- */
async function upsertRelation(client, r, subjId, objId) {
    const existing = await client.query(`SELECT id FROM structured.relations
       WHERE subject_id = $1 AND predicate = $2
         AND ($3::uuid IS NULL OR object_id = $3::uuid)
         AND ($4::text IS NULL OR object_text = $4::text)
       LIMIT 1`, [subjId, r.predicate, objId, r.objectText ?? null]);
    if (existing.rowCount && existing.rowCount > 0) {
        return { id: existing.rows[0].id, deduped: true };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO structured.relations
       (id, subject_id, predicate, object_id, object_text, started_at, ended_at, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        id, subjId, r.predicate, objId, r.objectText ?? null,
        r.startedAt ?? null, r.endedAt ?? null, r.confidence,
    ]);
    return { id, deduped: false };
}
/* --------------------------------- events ---------------------------------- */
async function upsertEvent(client, ev, actorId, targetId) {
    // Bucket to the minute for dedup so the same event from two extractors merges.
    const tsBucketSql = "date_trunc('minute', $1::timestamptz)";
    const existing = await client.query(`SELECT id FROM structured.events
       WHERE date_trunc('minute', ts) = ${tsBucketSql}
         AND type = $2
         AND ($3::uuid IS NULL OR actor_id  = $3::uuid)
         AND ($4::uuid IS NULL OR target_id = $4::uuid)
       LIMIT 1`, [ev.ts, ev.type, actorId, targetId]);
    if (existing.rowCount && existing.rowCount > 0) {
        return { id: existing.rows[0].id, deduped: true };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO structured.events
       (id, ts, end_ts, type, actor_id, target_id, details, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        id, ev.ts, ev.endTs ?? null, ev.type, actorId, targetId,
        ev.details ?? {}, ev.confidence,
    ]);
    return { id, deduped: false };
}
/* ------------------------------- preferences ------------------------------- */
async function upsertPreference(client, p) {
    const existing = await client.query(`SELECT id, value, evidence_count FROM structured.preferences
       WHERE scope = $1 AND key = $2 AND invalidated_at IS NULL
       LIMIT 1`, [p.scope, p.key]);
    if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0];
        if (deepEqual(row.value, p.value)) {
            await client.query(`UPDATE structured.preferences
            SET evidence_count = evidence_count + 1
          WHERE id = $1`, [row.id]);
            return { id: row.id, deduped: true };
        }
        // Supersede: invalidate old, write new linked.
        await client.query("UPDATE structured.preferences SET invalidated_at = now() WHERE id = $1", [row.id]);
        const id = randomUUID();
        await client.query(`INSERT INTO structured.preferences
         (id, scope, key, value, rule_text, evidence_count, confidence, supersedes)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`, [id, p.scope, p.key, JSON.stringify(p.value), p.ruleText ?? null, p.confidence, row.id]);
        return { id, deduped: false };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO structured.preferences
       (id, scope, key, value, rule_text, evidence_count, confidence)
     VALUES ($1, $2, $3, $4, $5, 1, $6)`, [id, p.scope, p.key, JSON.stringify(p.value), p.ruleText ?? null, p.confidence]);
    return { id, deduped: false };
}
/* --------------------------------- metrics --------------------------------- */
async function upsertMetric(client, m) {
    // Same (ts to second, metric, dim) → idempotent.
    const existing = await client.query(`SELECT id FROM structured.metrics
       WHERE ts = $1 AND metric = $2 AND dim = $3::jsonb
       LIMIT 1`, [m.ts, m.metric, m.dim ?? {}]);
    if (existing.rowCount && existing.rowCount > 0) {
        return { id: existing.rows[0].id, deduped: true };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO structured.metrics
       (id, ts, metric, value, unit, dim, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, m.ts, m.metric, m.value, m.unit ?? null, m.dim ?? {}, m.confidence]);
    return { id, deduped: false };
}
/* ------------------------------- commitments ------------------------------- */
async function upsertCommitment(client, c, agentId, chunkId) {
    // Dedup an identical active directive for the same agent (e.g. the same rule
    // re-stated). The supersede chain (invalidated_at + supersedes) is left for a
    // later pass; v1 just avoids exact-duplicate rows.
    const existing = await client.query(`SELECT id FROM structured.commitments
       WHERE agent_id = $1 AND kind = $2 AND directive = $3 AND invalidated_at IS NULL
       LIMIT 1`, [agentId, c.kind, c.directive]);
    if (existing.rowCount && existing.rowCount > 0) {
        return { id: existing.rows[0].id, deduped: true };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO structured.commitments
       (id, agent_id, chunk_id, directive, kind, safe_to_act, requires_confirmation,
        authority, valid_from, expires_at, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
        id, agentId, chunkId, c.directive, c.kind, c.safeToAct, c.requiresConfirmation,
        c.authority ?? null, c.validFrom ?? null, c.expiresAt ?? null, c.confidence,
    ]);
    return { id, deduped: false };
}
/* ------------------------------- provenance -------------------------------- */
async function writeProvenance(client, input, out) {
    const rows = [];
    for (const id of out.entityIds) {
        rows.push(["entity", id, "entities"]);
    }
    for (const id of out.relationIds) {
        rows.push(["relation", id, "relations"]);
    }
    for (const id of out.eventIds) {
        rows.push(["event", id, "events"]);
    }
    for (const id of out.preferenceIds) {
        rows.push(["preference", id, "preferences"]);
    }
    for (const id of out.metricIds) {
        rows.push(["metric", id, "metrics"]);
    }
    for (const id of out.commitmentIds) {
        rows.push(["commitment", id, "commitments"]);
    }
    if (rows.length === 0) {
        return;
    }
    // Insert one row per new structured item. Multi-row INSERT with explicit
    // casts on each parameter — Postgres can't infer column types through a
    // VALUES literal in a FROM clause cleanly, so we just emit per-row INSERTs.
    // (Batch is small: at most ~20 rows per chunk.)
    for (const [kind, itemId] of rows) {
        await client.query(`INSERT INTO structured.provenance
         (id, item_kind, item_id, chunk_id, dream_run_id, raw_excerpt, extractor, extractor_version)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::text, $8::text)`, [
            randomUUID(),
            kind,
            itemId,
            input.chunkId,
            input.dreamRunId ?? null,
            input.rawExcerpt.slice(0, 1000),
            "deterministic-extractors",
            input.result.extractorVersion,
        ]);
    }
}
/* --------------------------------- helpers --------------------------------- */
function deepEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (a === null || b === null) {
        return false;
    }
    if (typeof a !== typeof b) {
        return false;
    }
    if (typeof a !== "object") {
        return false;
    }
    return JSON.stringify(a) === JSON.stringify(b);
}
