/**
 * T0 — In-process working set per session.
 *
 * Tiny LRU map of recently-recalled / recently-promoted chunks. Hits are
 * sub-millisecond and never touch PG. Phase 5 wires this in front of the
 * tier-walk recall router.
 *
 * Eviction: capped at cfg.tiers.t0SizeLimit; LRU on access.
 */

import type { MergedCandidate } from "./routes.js";

export type WorkingSetEntry = {
  candidate: MergedCandidate;
  added: number;
  hits: number;
};

export class WorkingSet {
  private readonly entries = new Map<string, WorkingSetEntry>();
  constructor(private readonly maxSize: number) {}

  size(): number {
    return this.entries.size;
  }

  /** Insert / refresh an entry. */
  add(c: MergedCandidate): void {
    const existing = this.entries.get(c.chunkId);
    if (existing) {
      existing.candidate = c;
      this.entries.delete(c.chunkId);
      this.entries.set(c.chunkId, existing);
      return;
    }
    this.entries.set(c.chunkId, { candidate: c, added: Date.now(), hits: 0 });
    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {this.entries.delete(oldest);}
    }
  }

  /** Tag a chunk as accessed (LRU bump + hit counter). */
  touch(chunkId: string): WorkingSetEntry | undefined {
    const e = this.entries.get(chunkId);
    if (!e) {return undefined;}
    e.hits += 1;
    this.entries.delete(chunkId);
    this.entries.set(chunkId, e);
    return e;
  }

  /**
   * Naive substring match against the working set as a quick sanity check.
   * Used to short-circuit recall when the user explicitly says "as I said
   * just now" type queries that should obviously hit the working set.
   */
  search(query: string, limit: number): MergedCandidate[] {
    const q = query.toLowerCase();
    const out: Array<{ entry: WorkingSetEntry; rel: number }> = [];
    for (const e of this.entries.values()) {
      const text = e.candidate.text.toLowerCase();
      if (text.includes(q)) {
        out.push({ entry: e, rel: 1.0 });
      } else {
        const overlap = jaccardOverlap(q, text);
        if (overlap > 0.2) {out.push({ entry: e, rel: overlap });}
      }
    }
    return out
      .toSorted((a, b) => b.rel - a.rel)
      .slice(0, limit)
      .map(({ entry, rel }) => {
        const out = entry.candidate;
        out.combinedScore = Math.min(1, entry.candidate.combinedScore + rel * 0.2);
        return out;
      });
  }

  /** Remove a chunk (for invalidation). */
  evict(chunkId: string): void {
    this.entries.delete(chunkId);
  }

  /** Snapshot entries for status / dashboard. */
  snapshot(): Array<{ chunkId: string; hits: number; added: number }> {
    return [...this.entries.values()].map((e) => ({
      chunkId: e.candidate.chunkId,
      hits: e.hits,
      added: e.added,
    }));
  }
}

function tokenize(s: string): Set<string> {
  return new Set(s.split(/\s+|[,.，。!?;:、]/u).filter((t) => t.length >= 2));
}
function jaccardOverlap(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) {return 0;}
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) {inter += 1;}
  }
  return inter / (A.size + B.size - inter);
}

/**
 * Per-session WorkingSet registry. Phase 5 router pulls/pushes candidates
 * here keyed by `agentSessionId` (or "default" when absent).
 */
const REGISTRY = new Map<string, WorkingSet>();

/**
 * Working set is keyed by `<agentId>::<sessionId>` so isolation holds even
 * when sessionId is missing — without the agent prefix, two different
 * agents (main/club) without a session would share the same working set
 * and one could pull the other's recently-promoted chunks (real leak path
 * caught during isolation testing).
 */
export function workingSetFor(
  sessionId: string | undefined,
  maxSize: number,
  agentId: string | undefined = "main",
): WorkingSet {
  const key = `${agentId ?? "main"}::${sessionId ?? "default"}`;
  let set = REGISTRY.get(key);
  if (!set) {
    set = new WorkingSet(maxSize);
    REGISTRY.set(key, set);
  }
  return set;
}

export function clearAllWorkingSets(): void {
  REGISTRY.clear();
}
