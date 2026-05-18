/**
 * T0 — In-process working set per session.
 *
 * Tiny LRU map of recently-recalled / recently-promoted chunks. Hits are
 * sub-millisecond and never touch PG. Phase 5 wires this in front of the
 * tier-walk recall router.
 *
 * Eviction: capped at cfg.tiers.t0SizeLimit; LRU on access.
 */
export class WorkingSet {
    maxSize;
    entries = new Map();
    /**
     * One-shot guard: profile primer only runs once per WorkingSet instance.
     * Profile chunks land in T0 the first time the session asks for anything;
     * subsequent recalls just see them as already-resident high-warmth entries.
     */
    profilesPrimed = false;
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    size() {
        return this.entries.size;
    }
    hasProfilesPrimed() { return this.profilesPrimed; }
    markProfilesPrimed() { this.profilesPrimed = true; }
    /** Insert / refresh an entry. */
    add(c) {
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
            if (oldest !== undefined) {
                this.entries.delete(oldest);
            }
        }
    }
    /** Tag a chunk as accessed (LRU bump + hit counter). */
    touch(chunkId) {
        const e = this.entries.get(chunkId);
        if (!e) {
            return undefined;
        }
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
    search(query, limit) {
        const q = query.toLowerCase();
        const out = [];
        for (const e of this.entries.values()) {
            const text = e.candidate.text.toLowerCase();
            if (text.includes(q)) {
                out.push({ entry: e, rel: 1.0 });
            }
            else {
                const overlap = jaccardOverlap(q, text);
                if (overlap > 0.2) {
                    out.push({ entry: e, rel: overlap });
                }
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
    evict(chunkId) {
        this.entries.delete(chunkId);
    }
    /** Snapshot entries for status / dashboard. */
    snapshot() {
        return [...this.entries.values()].map((e) => ({
            chunkId: e.candidate.chunkId,
            hits: e.hits,
            added: e.added,
        }));
    }
}
function tokenize(s) {
    return new Set(s.split(/\s+|[,.，。!?;:、]/u).filter((t) => t.length >= 2));
}
function jaccardOverlap(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    if (A.size === 0 || B.size === 0) {
        return 0;
    }
    let inter = 0;
    for (const x of A) {
        if (B.has(x)) {
            inter += 1;
        }
    }
    return inter / (A.size + B.size - inter);
}
/**
 * Per-session WorkingSet registry. Phase 5 router pulls/pushes candidates
 * here keyed by `agentSessionId` (or "default" when absent).
 */
const REGISTRY = new Map();
/**
 * Working set is keyed by `<agentId>::<sessionId>::<viewerUserId>` so
 * isolation holds even when sessionId is missing. Three layered concerns:
 *
 *   - agentId prefix prevents two different agents (main/club) without a
 *     session from sharing the same WS (caught during isolation testing).
 *   - sessionId scopes per chat / channel pairing — different DMs get
 *     different sets.
 *   - viewerUserId scopes per HUMAN inside a group chat. Without this,
 *     a group chat (one sessionId, many students) would let student-A's
 *     pinned profile chunks surface in student-B's T0 lookups. With it,
 *     each student gets their own warm-cache view of the group.
 *
 * `viewerUserId` defaults to "default" so DM-only callers keep their
 * current behavior unchanged (sessionId already distinguishes peers).
 */
export function workingSetFor(sessionId, maxSize, agentId = "main", viewerUserId = "default") {
    const key = `${agentId ?? "main"}::${sessionId ?? "default"}::${viewerUserId ?? "default"}`;
    let set = REGISTRY.get(key);
    if (!set) {
        set = new WorkingSet(maxSize);
        REGISTRY.set(key, set);
    }
    return set;
}
export function clearAllWorkingSets() {
    REGISTRY.clear();
}
/**
 * Profile chunks (`kind='profile'`) are the "core memory" pattern borrowed
 * from MemGPT/Letta: per-agent (and optionally per-entity) summaries that
 * stay resident in T0 across every recall, instead of being one of many
 * chunks competing for top-k slots.
 *
 * Called lazily on the first recall in a session. Cheap: O(<profile count>)
 * which for a well-curated agent is typically <20 chunks. Idempotent via
 * the `profilesPrimed` flag on the WorkingSet.
 */
export async function primeWorkingSetWithProfiles(pool, agentId, ws, cap) {
    if (ws.hasProfilesPrimed()) {
        return 0;
    }
    ws.markProfilesPrimed();
    const rows = await pool
        .query(`SELECT id, source, source_ref, text, importance
         FROM semantic.chunks
        WHERE agent_id = $1
          AND kind = 'profile'
          AND retention_class != 'trash'
          AND retention_class != 'tombstone'
        ORDER BY importance DESC, last_recalled_at DESC NULLS LAST, created_at DESC
        LIMIT $2`, [agentId, Math.max(1, Math.floor(cap / 2))])
        .catch(() => ({ rows: [] }));
    let added = 0;
    for (const r of rows.rows) {
        ws.add({
            chunkId: r.id,
            source: r.source,
            sourceRef: r.source_ref,
            text: r.text,
            rawScore: r.importance,
            normScore: 1.0,
            hits: ["entity_ref"], // tag as a "profile" hit via the closest semantic
            combinedScore: 1.0 + r.importance,
        });
        added += 1;
    }
    return added;
}
