/**
 * Memory operation scoring.
 *
 * Every ingest and recall event runs through these pure functions to produce
 * a 0-100 composite score. Audit tables persist the score; the dashboard
 * consumes it; the self-tuning loop alerts on score regressions.
 *
 * Keep this module pure (no I/O). Tests assert formula stability.
 */

import type { ResolvedMemoryPostgresConfig } from "./config.js";

const clamp01 = (v: number): number => (v < 0 ? 0 : Math.min(1, v));

/* ----------------------------------- ingest ---------------------------------- */

export type IngestPath = "deterministic" | "sidecar" | "cache" | "llm_residual";
export type IngestDecision = "accepted" | "rejected" | "merged" | "quarantined";

export type IngestScoreInput = {
  decision: IngestDecision;
  path: IngestPath;
  llmTokensUsed: number;
  latencyMs: number;
  /**
   * Average extractor confidence for accepted/merged/quarantined cases (0-1).
   * Pass undefined for rejected — it falls back to a fixed reject sub-score.
   */
  extractorConfidenceAvg?: number;
};

const PATH_EFFICIENCY: Record<IngestPath, number> = {
  deterministic: 1.0,
  cache: 0.95,
  sidecar: 0.85,
  llm_residual: 0.4,
};

function ingestQualitySignal(input: IngestScoreInput): number {
  if (input.decision === "accepted") {return clamp01(input.extractorConfidenceAvg ?? 0.7);}
  if (input.decision === "merged") {return 0.7;}
  if (input.decision === "quarantined") {return 0.3;}
  return 0.0; // rejected — quality 0; reject quality measured separately
}

export function computeIngestScore(
  input: IngestScoreInput,
  cfg: ResolvedMemoryPostgresConfig["scoring"]["ingest"],
): number {
  const tokenEff = clamp01(1 - input.llmTokensUsed / Math.max(1, cfg.tokenBudgetCeiling));
  const latencyEff = clamp01(1 - input.latencyMs / Math.max(1, cfg.latencyBudgetMs));
  const quality = ingestQualitySignal(input);
  const pathEff = PATH_EFFICIENCY[input.path];
  const w = cfg.weights;
  const score =
    w.token * tokenEff +
    w.latency * latencyEff +
    w.quality * quality +
    w.path * pathEff;
  return Math.round(100 * score * 100) / 100;
}

/* ----------------------------------- recall ---------------------------------- */

export type RecallTier =
  | "t0"
  | "t1"
  | "t2_anchor"
  | "t2_hybrid"
  | "t2_full"
  | "t3";

export type RecallScoreInput = {
  hitTier: RecallTier;
  llmTokensUsed: number;
  latencyMs: number;
  /**
   * 0-1 follow-up estimate; pass 0.5 (neutral) when unknown so the partial
   * score is reasonable; the worker fills the real value within the
   * relevanceFollowupWindowMs.
   */
  relevanceEstimate?: number;
};

const TIER_EFFICIENCY: Record<RecallTier, number> = {
  t0: 1.0,
  t1: 0.9,
  t2_anchor: 0.75,
  t2_hybrid: 0.55,
  t2_full: 0.35,
  t3: 0.2,
};

export function computeRecallScore(
  input: RecallScoreInput,
  cfg: ResolvedMemoryPostgresConfig["scoring"]["recall"],
): number {
  const tokenEff = clamp01(1 - input.llmTokensUsed / Math.max(1, cfg.tokenBudgetCeiling));
  const latencyEff = clamp01(1 - input.latencyMs / Math.max(1, cfg.latencyBudgetMs));
  const tierEff = TIER_EFFICIENCY[input.hitTier];
  const relevance = clamp01(input.relevanceEstimate ?? 0.5);
  const w = cfg.weights;
  const score =
    w.token * tokenEff +
    w.latency * latencyEff +
    w.tier * tierEff +
    w.relevance * relevance;
  return Math.round(100 * score * 100) / 100;
}

/* --------------------------------- exports ---------------------------------- */

export const _internal = {
  PATH_EFFICIENCY,
  TIER_EFFICIENCY,
  ingestQualitySignal,
};
