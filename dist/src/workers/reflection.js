/**
 * Reflection worker — agent-active memory consolidation.
 *
 * Borrows the MemGPT/Karpathy "agent's wiki / sleep cycle" idea: once a
 * day, ask an LLM to read the last 24h of conversation chunks for each
 * agent_id and emit:
 *   - a one-paragraph reflection chunk (`kind='reflection'`) that serves
 *     as a high-level "what happened" entry the agent can recall later
 *   - optionally, a refreshed agent profile chunk (`kind='profile'`) that
 *     gets primed into T0 on every subsequent recall
 *
 * Deterministic stages of the ingest pipeline never call LLMs. This is
 * the FIRST LLM call in nextclaw's hot path. Two design choices keep it
 * sane:
 *   - Runs in the background (worker), never in a recall path
 *   - Default cadence is `enabled: false` — opt-in, not auto-on
 *   - Caps input tokens; if there's too much, takes the most recent slice
 *
 * Per-agent isolation: every read + write is `WHERE agent_id = $X` and
 * each agent's reflection is independent. A reflection over `agent:club`
 * never sees `agent:main` chunks.
 */
import { randomUUID, createHash } from "node:crypto";
import pgvector from "pgvector/pg";
import { buildReflectionClientFromConfig } from "../embedding/reflection-client.js";
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MAX_INPUT_CHARS = 8000;
const SYSTEM_PROMPT = `You are a memory-consolidation worker for a long-lived AI assistant.
You receive a chronological dump of recent conversation chunks for ONE agent + ONE user.
Your job is to produce a short, structured summary of what changed in the user's
life, work, projects, or preferences in this window.

Output exactly two sections, separated by a blank line:

REFLECTION:
A 2-4 sentence factual summary in the user's primary language. No prose flourishes.
Focus on durable changes: new facts, decisions, plans, problems-and-resolutions.
Skip greetings, small talk, debugging chatter that won't matter next week.

PROFILE_DELTA:
A flat list of bullets, one per line, of facts that should LIVE in the agent's
profile of this user. Use this format:
- <fact category>: <fact>
Examples:
- preference: 用户偏好简洁的中文回复，不要客套
- project: maintains nextclaw memory plugin (Postgres + pgvector)
- person: child name is Mason, ~8 years old, learning English

Skip PROFILE_DELTA entirely if nothing durable changed.`;
export async function runReflectionForAllAgents(deps) {
    // Find which agents have new material in the lookback window.
    const lookbackHours = deps.cfg.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    const rows = await deps.pool.query(`SELECT agent_id, count(*)::int AS n
       FROM semantic.chunks
      WHERE created_at > now() - ($1 || ' hours')::interval
        AND retention_class IN ('standard', 'pinned')
        AND kind NOT IN ('reflection', 'profile')
      GROUP BY agent_id`, [String(lookbackHours)]);
    const out = [];
    for (const r of rows.rows) {
        out.push(await runReflectionForAgent(deps, r.agent_id, r.n));
    }
    return out;
}
export async function runReflectionForAgent(deps, agentId, expectedChunks) {
    const start = Date.now();
    const lookbackHours = deps.cfg.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    const maxChars = deps.cfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    // Load the most recent N chunks for this agent within the window.
    // ORDER BY created_at DESC + LIMIT so we always grab the freshest if
    // there are too many; the prompt cap is char-based.
    const rows = await deps.pool.query(`SELECT id, text, source, created_at, kind
       FROM semantic.chunks
      WHERE agent_id = $1
        AND created_at > now() - ($2 || ' hours')::interval
        AND retention_class IN ('standard', 'pinned')
        AND kind NOT IN ('reflection', 'profile')
      ORDER BY created_at DESC
      LIMIT 500`, [agentId, String(lookbackHours)]);
    if (rows.rowCount === 0) {
        return {
            agentId,
            ok: true,
            chunksConsidered: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - start,
        };
    }
    // Build a chronological dump (oldest first inside the cap).
    const ordered = rows.rows.toReversed();
    let dump = "";
    let considered = 0;
    for (const c of ordered) {
        const line = `[${c.created_at.toISOString()}] (${c.source}) ${c.text}\n`;
        if (dump.length + line.length > maxChars) {
            break;
        }
        dump += line;
        considered += 1;
    }
    const userPrompt = `Agent id: ${agentId}\nWindow: last ${lookbackHours} hours.\nChunks (chronological):\n\n${dump}`;
    const llmResult = await deps.llm.chat({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxOutputTokens: 800,
        temperature: 0.3,
    });
    if (!llmResult.ok) {
        return {
            agentId,
            ok: false,
            chunksConsidered: considered,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - start,
            error: llmResult.error,
        };
    }
    // Parse the response into REFLECTION + PROFILE_DELTA sections.
    const { reflection, profileBullets } = parseReflectionOutput(llmResult.text);
    if (!reflection) {
        return {
            agentId,
            ok: true,
            chunksConsidered: considered,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
            latencyMs: Date.now() - start,
        };
    }
    // Write the reflection chunk (kind='reflection').
    const reflectionId = await writeChunk(deps, {
        agentId,
        text: reflection,
        kind: "reflection",
        source: "reflection-worker",
        retentionClass: "standard",
        importance: 0.6,
    });
    // Upsert profile chunks (one per bullet). Each becomes a pinned T0
    // resident. Future reflection runs add more or refresh older ones via
    // dedup-on-text-hash (the unique index on (text_hash, source) means
    // identical bullets coalesce naturally).
    let profileWritten = 0;
    for (const bullet of profileBullets) {
        const trimmed = bullet.replace(/^[-*]\s*/, "").trim();
        if (trimmed.length < 8) {
            continue;
        }
        const id = await writeChunk(deps, {
            agentId,
            text: trimmed,
            kind: "profile",
            source: "reflection-worker",
            retentionClass: "pinned",
            importance: 0.9,
        });
        if (id) {
            profileWritten += 1;
        }
    }
    return {
        agentId,
        ok: true,
        reflectionChunkId: reflectionId ?? undefined,
        profileChunksWritten: profileWritten,
        chunksConsidered: considered,
        inputTokens: llmResult.inputTokens,
        outputTokens: llmResult.outputTokens,
        latencyMs: Date.now() - start,
    };
}
function parseReflectionOutput(text) {
    const parts = text.split(/\n\s*PROFILE_DELTA\s*:\s*\n/i);
    const headBody = parts[0] ?? "";
    const tail = parts[1] ?? "";
    // Strip "REFLECTION:" header if present.
    const reflection = headBody.replace(/^\s*REFLECTION\s*:\s*/i, "").trim();
    const profileBullets = tail
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-") || l.startsWith("*"));
    return { reflection, profileBullets };
}
async function writeChunk(deps, params) {
    // Embed; if it fails, skip writing rather than abort the whole reflection.
    const trimmed = params.text.slice(0, 4000);
    const embed = await deps.embedding.embed({ inputs: [trimmed] }).catch(() => null);
    if (!embed || embed.embeddings.length === 0) {
        return null;
    }
    const id = randomUUID();
    const textHash = createHash("sha256").update(trimmed, "utf8").digest();
    try {
        await deps.pool.query(`INSERT INTO semantic.chunks
         (id, source, source_ref, kind, text, text_hash, embedding,
          embedding_model, agent_session_id, agent_id, retention_class,
          importance, created_at)
       VALUES ($1, $2, null, $3, $4, $5, $6::vector,
               $7, null, $8, $9, $10, now())
       ON CONFLICT (text_hash, source) DO UPDATE
         SET importance = GREATEST(semantic.chunks.importance, EXCLUDED.importance),
             retention_class = CASE
                                 WHEN EXCLUDED.retention_class = 'pinned' THEN 'pinned'
                                 ELSE semantic.chunks.retention_class
                               END`, [
            id,
            params.source,
            params.kind,
            trimmed,
            textHash,
            pgvector.toSql(embed.embeddings[0] ?? []),
            embed.model,
            params.agentId,
            params.retentionClass,
            params.importance,
        ]);
        return id;
    }
    catch {
        return null;
    }
}
/* ---------------------- entity-centric reflection ------------------------- */
/**
 * Entity-centric reflection: pick entities that have accumulated enough
 * mentions since their last entity_profile chunk, and have the LLM write
 * a short "what do we know about X" summary. The result is stored as
 * kind='entity_profile' AND indexed via chunk_indexes(kind='entity_ref')
 * so future graph_walk for that entity finds the profile directly.
 *
 * This is the GraphRAG community-summary idea, scoped down to ONE
 * entity at a time (cheap; no Leiden clustering needed). The "提炼"
 * judgement test is satisfied:
 *   raw mentions → one dense reusable profile chunk (importance 0.7,
 *   pinned, T0-eligible) → future questions about this entity skip the
 *   N-chunk dump and hit one paragraph.
 */
const ENTITY_REFLECTION_MIN_MENTIONS = 12;
const ENTITY_REFLECTION_LOOKBACK_DAYS = 30;
const ENTITY_REFLECTION_PROFILE_TTL_DAYS = 7;
const ENTITY_REFLECTION_MAX_PER_RUN = 3;
const ENTITY_REFLECTION_MAX_CHUNKS_PER_ENTITY = 60;
const ENTITY_REFLECTION_MAX_CHARS = 6000;
/** Reflect ONLY on entity types that capture conversational meaning.
 *  Excludes `file` and `repo` which the deterministic extractor collects
 *  liberally from doc/KB ingest (file paths get extracted as entities).
 *  Live test showed: a "repo/ssh/id_ed25519" entity fed Gemini a doc
 *  dump it couldn't summarize, output truncated at 16 tokens. */
const ENTITY_REFLECTION_TYPE_ALLOWLIST = [
    "person", "concept", "project", "topic", "organization", "technology", "tool",
];
const ENTITY_REFLECTION_MIN_SUMMARY_CHARS = 80;
const ENTITY_SYSTEM_PROMPT = "You are summarising what the agent's memory knows about ONE specific " +
    "entity. Read all the mentions (chronological order, oldest first) and " +
    "write a 3-6 sentence factual summary in the user's language. Focus on: " +
    "what this entity IS (one phrase), notable facts, relationships, and any " +
    "preferences / patterns. No greetings, no caveats, no markdown headers. " +
    "Just the summary text.";
export async function runEntityReflectionForAgent(deps, agentId) {
    // 1. Find candidate entities. Three filters stack:
    //    - type in allowlist (drop file-path noise)
    //    - mention count >= threshold (drop one-off mentions)
    //    - no entity_profile chunk written for this entity in TTL window
    const candidates = await deps.pool.query(`SELECT e.id::text, e.canonical_name, e.type,
            count(DISTINCT ci.chunk_id)::int AS mention_count
       FROM structured.entities e
       JOIN semantic.chunk_indexes ci
         ON ci.kind = 'entity_ref' AND ci.value = e.id::text
       JOIN semantic.chunks c ON c.id = ci.chunk_id
      WHERE c.agent_id = $1
        AND c.created_at > now() - ($2 || ' days')::interval
        AND e.deleted_at IS NULL
        AND e.type = ANY($6::text[])
        AND c.kind NOT IN ('entity_profile', 'reflection', 'profile')
        AND NOT EXISTS (
          SELECT 1
            FROM semantic.chunks p
            JOIN semantic.chunk_indexes pi
              ON pi.chunk_id = p.id AND pi.kind = 'entity_ref' AND pi.value = e.id::text
           WHERE p.kind = 'entity_profile'
             AND p.agent_id = $1
             AND p.created_at > now() - ($3 || ' days')::interval
        )
      GROUP BY e.id, e.canonical_name, e.type
      HAVING count(DISTINCT ci.chunk_id) >= $4
      ORDER BY count(DISTINCT ci.chunk_id) DESC
      LIMIT $5`, [
        agentId,
        String(ENTITY_REFLECTION_LOOKBACK_DAYS),
        String(ENTITY_REFLECTION_PROFILE_TTL_DAYS),
        ENTITY_REFLECTION_MIN_MENTIONS,
        ENTITY_REFLECTION_MAX_PER_RUN,
        ENTITY_REFLECTION_TYPE_ALLOWLIST,
    ]);
    const outcomes = [];
    for (const e of candidates.rows) {
        const outcome = await reflectOnEntity(deps, agentId, e);
        outcomes.push(outcome);
    }
    return outcomes;
}
async function reflectOnEntity(deps, agentId, entity) {
    // 2. Gather mention chunks.
    const chunks = await deps.pool.query(`SELECT c.text, c.source, c.created_at
       FROM semantic.chunks c
       JOIN semantic.chunk_indexes ci
         ON ci.chunk_id = c.id AND ci.kind = 'entity_ref' AND ci.value = $2
      WHERE c.agent_id = $1
        AND c.created_at > now() - ($3 || ' days')::interval
        AND c.kind NOT IN ('entity_profile', 'reflection', 'profile')
      ORDER BY c.created_at DESC
      LIMIT $4`, [agentId, entity.id, String(ENTITY_REFLECTION_LOOKBACK_DAYS), ENTITY_REFLECTION_MAX_CHUNKS_PER_ENTITY]);
    if (chunks.rowCount === 0) {
        return {
            entityId: entity.id, entityName: entity.canonical_name,
            ok: false, mentionsConsidered: 0, error: "no-mention-chunks",
        };
    }
    // 3. Chronological dump, oldest first, cap by char count.
    const ordered = chunks.rows.toReversed();
    let dump = "";
    let considered = 0;
    for (const c of ordered) {
        const line = `[${c.created_at.toISOString()}] (${c.source}) ${c.text}\n`;
        if (dump.length + line.length > ENTITY_REFLECTION_MAX_CHARS) {
            break;
        }
        dump += line;
        considered += 1;
    }
    const userPrompt = `Entity: ${entity.canonical_name} (type: ${entity.type})\n` +
        `Mentions (chronological, ${considered}):\n\n${dump}`;
    // 4. LLM call.
    const llmResult = await deps.llm.chat({
        systemPrompt: ENTITY_SYSTEM_PROMPT,
        userPrompt,
        maxOutputTokens: 400,
        temperature: 0.3,
    });
    if (!llmResult.ok) {
        return {
            entityId: entity.id, entityName: entity.canonical_name,
            ok: false, mentionsConsidered: considered, error: llmResult.error,
        };
    }
    const summary = llmResult.text.trim();
    // Min-output guard: caught a real bug live where Gemini truncated to
    // 16 tokens on a noisy entity ("`ssh/id_ed25519` refers to an SSH") and
    // wrote it to cache as a "pinned" T0 chunk — worse than no profile.
    if (summary.length < ENTITY_REFLECTION_MIN_SUMMARY_CHARS) {
        return {
            entityId: entity.id, entityName: entity.canonical_name,
            ok: false, mentionsConsidered: considered, error: `summary-too-short(${summary.length}<${ENTITY_REFLECTION_MIN_SUMMARY_CHARS})`,
            inputTokens: llmResult.inputTokens, outputTokens: llmResult.outputTokens,
        };
    }
    // 5. Write chunk + back-link to the entity via chunk_indexes so future
    // graph_walk for this entity surfaces the profile.
    const chunkId = await writeChunk(deps, {
        agentId,
        text: summary,
        kind: "entity_profile",
        source: `entity-reflection:${entity.canonical_name.slice(0, 60)}`,
        retentionClass: "pinned",
        importance: 0.7,
    });
    if (chunkId) {
        await deps.pool.query(`INSERT INTO semantic.chunk_indexes (chunk_id, kind, value)
         VALUES ($1, 'entity_ref', $2)
       ON CONFLICT DO NOTHING`, [chunkId, entity.id]).catch(() => undefined);
    }
    return {
        entityId: entity.id,
        entityName: entity.canonical_name,
        ok: chunkId !== null,
        mentionsConsidered: considered,
        profileChunkId: chunkId ?? undefined,
        inputTokens: llmResult.inputTokens,
        outputTokens: llmResult.outputTokens,
    };
}
export function startReflectionDaemon(args) {
    let stopped = false;
    const lastRunByAgent = new Map();
    const minGapMs = args.minGapMs ?? Math.max(60 * 60_000, Math.floor(args.intervalMs / 2));
    const runFor = async (agentId, reason) => {
        if (stopped) {
            return;
        }
        const now = Date.now();
        const last = lastRunByAgent.get(agentId) ?? 0;
        if (now - last < minGapMs) {
            // Within throttle window — silent skip; common case after many
            // session_end events fire for one agent in a row.
            return;
        }
        lastRunByAgent.set(agentId, now);
        try {
            const outcome = await runReflectionForAgent(args.deps, agentId);
            if (outcome.ok && ((outcome.reflectionChunkId !== undefined) || (outcome.profileChunksWritten ?? 0) > 0)) {
                args.logger.info(`memory-postgres: reflection (${reason}) agent=${agentId} ` +
                    `${outcome.chunksConsidered}c/${outcome.profileChunksWritten ?? 0}p`);
            }
            else if (!outcome.ok) {
                args.logger.warn(`memory-postgres: reflection (${reason}) agent=${agentId} err=${outcome.error}`);
            }
            // Entity-centric reflection: same trigger; runs alongside time-window
            // reflection. Internally throttled by the 7-day TTL filter in the
            // candidate query, so back-to-back triggers are no-ops.
            const entOutcomes = await runEntityReflectionForAgent(args.deps, agentId);
            const writtenCount = entOutcomes.filter((o) => o.ok && o.profileChunkId).length;
            if (writtenCount > 0) {
                const summary = entOutcomes
                    .filter((o) => o.ok && o.profileChunkId)
                    .map((o) => `${o.entityName}(${o.mentionsConsidered})`)
                    .join(", ");
                args.logger.info(`memory-postgres: entity-reflection (${reason}) agent=${agentId} wrote=${writtenCount} → ${summary}`);
            }
        }
        catch (err) {
            args.logger.warn(`memory-postgres: reflection (${reason}) failed for ${agentId}: ${err.message}`);
        }
    };
    // Periodic safety-net sweep: catches agents whose sessions never cleanly
    // session_end (long-running DM threads, gateway crashes). Effectively a
    // fallback for the event-driven path. Throttle map ensures the periodic
    // tick is a no-op when session_end-driven runs are keeping up.
    const tick = async () => {
        if (stopped) {
            return;
        }
        try {
            const outcomes = await runReflectionForAllAgents(args.deps);
            for (const o of outcomes) {
                if (o.ok && ((o.reflectionChunkId !== undefined) || (o.profileChunksWritten ?? 0) > 0)) {
                    lastRunByAgent.set(o.agentId, Date.now());
                }
            }
            const anyWork = outcomes.some((o) => (o.reflectionChunkId !== undefined) || (o.profileChunksWritten ?? 0) > 0);
            if (anyWork) {
                const summary = outcomes
                    .map((o) => o.ok
                    ? `${o.agentId}:${o.chunksConsidered}c/${o.profileChunksWritten ?? 0}p`
                    : `${o.agentId}:err(${o.error})`)
                    .join(" ");
                args.logger.info(`memory-postgres: reflection sweep — ${summary}`);
            }
        }
        catch (err) {
            args.logger.warn(`memory-postgres: reflection sweep failed: ${err.message}`);
        }
    };
    const timer = setInterval(() => void tick(), args.intervalMs);
    timer.unref?.();
    const initialTimer = setTimeout(() => void tick(), 5 * 60_000);
    initialTimer.unref?.();
    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
            clearTimeout(initialTimer);
        },
        triggerForAgent: runFor,
    };
}
/** Convenience for index.ts: instantiate the LLM client from resolved config. */
export function buildReflectionClient(cfg) {
    return buildReflectionClientFromConfig({
        baseUrl: cfg.model.baseUrl,
        model: cfg.model.model,
        format: cfg.model.format,
        apiKeyEnv: cfg.model.apiKeyEnv,
    });
}
