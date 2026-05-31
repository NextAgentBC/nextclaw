/**
 * Shared types for the structured extractor + reconcile + API layer.
 *
 * Each extractor produces zero or more candidate rows from a piece of text
 * plus deterministic signals (tool call metadata, sidecar JSON, regex hits).
 * The reconcile layer dedups/supersedes against existing structured.* rows.
 * The API layer exposes typed read operations to the rest of the plugin
 * (and, via the SDK barrel, to other plugins).
 */

export type ExtractorVersion = `v${string}`;

export type EntityType =
  | "person"
  | "project"
  | "repo"
  | "file"
  | "tool"
  | "concept"
  | "other";

export type EntityCandidate = {
  type: EntityType;
  canonicalName: string;
  aliases?: string[];
  attrs?: Record<string, unknown>;
  confidence: number;            // 0-1
};

export type RelationCandidate = {
  subject: { type: EntityType; canonicalName: string };
  predicate: string;
  object?: { type: EntityType; canonicalName: string };
  objectText?: string;
  startedAt?: Date;
  endedAt?: Date;
  confidence: number;
};

export type EventCandidate = {
  ts: Date;
  endTs?: Date;
  type: string;
  actor?: { type: EntityType; canonicalName: string };
  target?: { type: EntityType; canonicalName: string };
  details?: Record<string, unknown>;
  confidence: number;
};

export type PreferenceCandidate = {
  scope: string;                 // 'global' | 'project:<id>' | 'agent:<id>'
  key: string;
  value: unknown;
  ruleText?: string;
  confidence: number;
};

export type MetricCandidate = {
  ts: Date;
  metric: string;
  value: number;
  unit?: string;
  dim?: Record<string, string | number | boolean>;
  confidence: number;
};

export type CommitmentKind =
  | "task"           // a side-effecting directive aimed at the agent (cancel/send/delete/…)
  | "authorization"  // the user granting the agent permission to act
  | "appointment"    // a scheduled real-world commitment
  | "reminder"       // a request to be reminded (setting it is safe)
  | "other";

/**
 * An action-sensitive directive lifted out of a memory. The point is to tag
 * memories the agent might *act* on so a stale or low-authority remark can't
 * trigger a real-world side effect without a check. Conservative by default:
 * side-effecting directives are safeToAct=false + requiresConfirmation=true.
 */
export type CommitmentCandidate = {
  directive: string;
  kind: CommitmentKind;
  safeToAct: boolean;
  requiresConfirmation: boolean;
  authority?: "user_direct" | "overheard" | "inferred" | "system";
  validFrom?: Date;
  expiresAt?: Date;
  confidence: number;
};

export type ExtractorContext = {
  /** Raw chunk text. */
  text: string;
  /** Source kind: 'tool_call' | 'sidecar' | 'regex' | 'manual' | 'session' | 'dream'. */
  source: string;
  /** Optional structured signal carried from earlier stages. */
  signals?: Record<string, unknown>;
  /** Current time for temporal extractors. Tests pass a fixed Date for determinism. */
  now: Date;
};

export type ExtractorResult = {
  entities: EntityCandidate[];
  relations: RelationCandidate[];
  events: EventCandidate[];
  preferences: PreferenceCandidate[];
  metrics: MetricCandidate[];
  commitments: CommitmentCandidate[];
  /**
   * Per-extractor module version. Stored in structured.provenance.extractor_version
   * so tuning / audit can replay specific extractor cohorts.
   */
  extractorVersion: ExtractorVersion;
};

export const emptyResult = (extractorVersion: ExtractorVersion): ExtractorResult => ({
  entities: [],
  relations: [],
  events: [],
  preferences: [],
  metrics: [],
  commitments: [],
  extractorVersion,
});
