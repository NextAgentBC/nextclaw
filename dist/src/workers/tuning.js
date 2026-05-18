/**
 * Self-tuning loop (Phase 8).
 *
 * Daily / weekly / monthly cadences run analyzers over audit data and write
 * audit.tuning_proposals rows. Safe-class proposals can auto-apply; the
 * dashboard surfaces review-required and high-risk ones for the operator.
 *
 * Design notes:
 *   - Daily: deterministic SQL only. No LLM. Auto-applies when risk_class='safe_auto'.
 *   - Weekly: still mostly SQL, with optional LLM hooks for sample auditing.
 *   - Monthly: schema evolution / model swaps; always proposal-only.
 *   - Apply/revert: takes a JSON-pointer-shaped config_path so the runtime
 *     config patcher can safely round-trip. Phase 8 ships the proposal store +
 *     analyzer; the actual config patcher lives in OpenClaw core.
 */
import { randomUUID } from "node:crypto";
const PROPOSAL_INSERT = `
  INSERT INTO audit.tuning_proposals
    (id, cadence, scope, proposal_type, current_value, proposed_value,
     evidence, risk_class, status, reason, config_path)
   VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, 'pending', $9, $10)
   RETURNING id`;
async function writeProposal(pool, cadence, payload) {
    const id = randomUUID();
    await pool.query(PROPOSAL_INSERT, [
        id,
        cadence,
        payload.scope,
        payload.proposalType,
        JSON.stringify(payload.currentValue ?? null),
        JSON.stringify(payload.proposedValue),
        JSON.stringify(payload.evidence),
        payload.riskClass,
        payload.reason ?? null,
        payload.configPath ?? null,
    ]);
    return id;
}
/**
 * Daily analyzer: cheap SQL aggregates over the last 24 hours of audit data.
 * Never calls LLM. Emits two kinds of proposals:
 *   - cache TTL adjustments (cache.recall low hit-rate → shorter TTL)
 *   - dead trash regex candidates (none of the rejected events matched any
 *     boilerplate pattern → suggest tightening the deterministic gate)
 */
export async function runDailyAnalyzer(pool) {
    const proposalIds = [];
    const notes = [];
    // 1. Recall cache hit-rate.
    const cacheStat = await pool.query(`SELECT count(*)::text AS total,
            count(*) FILTER (WHERE hit_tier IN ('t0','t1'))::text AS cached
       FROM audit.recall_decisions
       WHERE ts > now() - interval '24 hours'`);
    const total = Number(cacheStat.rows[0]?.total ?? "0");
    const cached = Number(cacheStat.rows[0]?.cached ?? "0");
    if (total >= 30) {
        const rate = cached / total;
        if (rate < 0.30) {
            proposalIds.push(await writeProposal(pool, "daily", {
                scope: "cache.recall.ttl",
                proposalType: "adjust",
                currentValue: null,
                proposedValue: { ttlDelta: -60 },
                evidence: { totalRecalls24h: total, cacheHits24h: cached, rate },
                riskClass: "safe_auto",
                reason: "cache hit-rate < 30%; recommend shorter TTL to reduce stale results",
                configPath: "/plugins/entries/memory-postgres/config/recall/cacheRecallTtlSec",
            }));
        }
        else if (rate > 0.90) {
            proposalIds.push(await writeProposal(pool, "daily", {
                scope: "cache.recall.ttl",
                proposalType: "adjust",
                currentValue: null,
                proposedValue: { ttlDelta: 60 },
                evidence: { totalRecalls24h: total, cacheHits24h: cached, rate },
                riskClass: "safe_auto",
                reason: "cache hit-rate > 90%; safe to raise TTL and amortise more",
                configPath: "/plugins/entries/memory-postgres/config/recall/cacheRecallTtlSec",
            }));
        }
        else {
            notes.push(`cache hit-rate healthy (${(rate * 100).toFixed(1)}%)`);
        }
    }
    // 2. Trash filter coverage check.
    const trashStat = await pool.query(`SELECT count(*)::text AS rejected,
            count(*) FILTER (WHERE reject_reason = 'boilerplate')::text AS boilerplate
       FROM audit.ingest_decisions
       WHERE ts > now() - interval '24 hours' AND decision = 'rejected'`);
    const rejected = Number(trashStat.rows[0]?.rejected ?? "0");
    const boiler = Number(trashStat.rows[0]?.boilerplate ?? "0");
    if (rejected >= 50 && boiler / Math.max(1, rejected) < 0.05) {
        proposalIds.push(await writeProposal(pool, "daily", {
            scope: "trash_regex",
            proposalType: "add",
            currentValue: null,
            proposedValue: { hint: "boilerplate regex coverage looks low; sample below" },
            evidence: { rejected24h: rejected, boilerplate24h: boiler },
            riskClass: "review_required",
            reason: "rejected events exist but few hit the boilerplate regex — coverage gap",
            configPath: "/plugins/entries/memory-postgres/config/gates/trashRegexes",
        }));
    }
    // 3. Score-regression alert: average ingest score in last 24h vs prior 7d.
    const scores = await pool.query(`SELECT
       (SELECT avg(score) FROM audit.ingest_decisions
          WHERE ts > now() - interval '24 hours' AND score IS NOT NULL) AS short_avg,
       (SELECT avg(score) FROM audit.ingest_decisions
          WHERE ts BETWEEN now() - interval '8 days' AND now() - interval '24 hours'
            AND score IS NOT NULL) AS long_avg`);
    const shortAvg = scores.rows[0]?.short_avg ?? null;
    const longAvg = scores.rows[0]?.long_avg ?? null;
    if (shortAvg !== null && longAvg !== null && longAvg > 0) {
        const drop = (longAvg - shortAvg) / longAvg;
        if (drop > 0.20) {
            proposalIds.push(await writeProposal(pool, "daily", {
                scope: "score_regression",
                proposalType: "adjust",
                currentValue: { last7dAvg: longAvg },
                proposedValue: { investigate: true },
                evidence: { last24hAvg: shortAvg, last7dAvg: longAvg, dropFraction: drop },
                riskClass: "review_required",
                reason: "Ingest score dropped > 20% vs prior week",
            }));
        }
        else {
            notes.push(`ingest score stable (24h=${shortAvg.toFixed(1)} vs 7d=${longAvg.toFixed(1)})`);
        }
    }
    return { proposalIds, notes };
}
/**
 * Mark a proposal as auto-applied. The actual config patch is delegated to
 * the caller (ConfigPatcher) so this module stays I/O-pure for testing.
 */
export async function markAutoApplied(pool, proposalId, rollbackValue) {
    await pool.query(`UPDATE audit.tuning_proposals
        SET status = 'auto_applied',
            applied_at = now(),
            rollback_value = $2::jsonb
      WHERE id = $1`, [proposalId, JSON.stringify(rollbackValue)]);
    await pool.query(`INSERT INTO audit.tuning_guards
       (proposal_id, applied_at, baseline_score, baseline_window)
       SELECT $1, now(),
              COALESCE((SELECT avg(score) FROM audit.recall_decisions
                          WHERE ts > now() - interval '24 hours'), 50)::real,
              tstzrange(now() - interval '24 hours', now())
       ON CONFLICT (proposal_id) DO NOTHING`, [proposalId]);
}
export async function markRejected(pool, proposalId, reason) {
    await pool.query(`UPDATE audit.tuning_proposals
        SET status = 'rejected', reason = $2
      WHERE id = $1`, [proposalId, reason]);
}
export async function markApproved(pool, proposalId) {
    await pool.query(`UPDATE audit.tuning_proposals
        SET status = 'approved', applied_at = now()
      WHERE id = $1`, [proposalId]);
}
export async function revertProposal(pool, proposalId, reason) {
    const rows = await pool.query(`UPDATE audit.tuning_proposals
        SET status = 'reverted', reverted_at = now(), reason = $2
      WHERE id = $1
      RETURNING rollback_value`, [proposalId, reason]);
    return rows.rows[0]?.rollback_value ?? null;
}
/**
 * 24-hour auto-revert guard: re-evaluates a previously auto-applied proposal.
 * If the post-application avg recall score dropped > 20% relative to the
 * baseline_score recorded at apply time, automatically revert.
 */
export async function evaluateGuards(pool) {
    const guards = await pool.query(`SELECT proposal_id, baseline_score, applied_at
       FROM audit.tuning_guards
       WHERE decision IS NULL AND applied_at < now() - interval '24 hours'`);
    let reverted = 0;
    const notes = [];
    for (const g of guards.rows) {
        const observed = await pool.query(`SELECT avg(score) AS avg_score FROM audit.recall_decisions
         WHERE ts > $1 AND score IS NOT NULL`, [g.applied_at]);
        const obs = observed.rows[0]?.avg_score;
        let decision = "ok";
        if (obs !== null && obs !== undefined) {
            if (g.baseline_score > 0 && (g.baseline_score - obs) / g.baseline_score > 0.20) {
                decision = "reverted";
                await revertProposal(pool, g.proposal_id, "auto-revert: score regression");
                reverted += 1;
            }
        }
        else {
            decision = "inconclusive";
        }
        await pool.query(`UPDATE audit.tuning_guards
          SET observed_score = $2,
              observed_window = tstzrange($3, now()),
              decision = $4,
              decided_at = now()
        WHERE proposal_id = $1`, [g.proposal_id, obs, g.applied_at, decision]);
        notes.push(`${g.proposal_id} → ${decision}`);
    }
    return { evaluated: guards.rowCount ?? 0, reverted, notes };
}
