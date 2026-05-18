/**
 * Moderator types — Phase C.
 *
 * The Moderator is the orchestrator-worker pattern from Anthropic's
 * "Building effective agents" article, persistent per
 * (agent_id, scope_key). It receives every inbound message in its
 * scope, runs ONE LLM call against gpt-5.5, parses a structured
 * JSON decision, and dispatches.
 *
 * Decisions are split into:
 *   1. `action` — coarse routing label, drives the rest of the shape
 *   2. `memoryWrites` — facts to persist regardless of whether we answer
 *   3. `answerTasks` — workers to spawn (may be empty)
 *   4. `telegramActions` — placeholders / edits to send to chat
 *   5. `escalation` — optional ping to the bot owner
 *
 * The state stored in PG is whatever the Moderator needs to remember
 * across messages: recent conversation, active workers, current topic,
 * pending tasks, last self-review timestamp.
 */
export function newModeratorState(scopeKey, scopeKind, chatId, ownerUserId) {
    return {
        scopeKey,
        scopeKind,
        chatId,
        ownerUserId,
        recentMessages: [],
        activeStudents: [],
        activeWorkers: [],
        debounceBuffer: [],
        notes: [],
        messagesSinceLastReview: 0,
        version: 1,
    };
}
/* ----------------------------- helpers / guards ---------------------------- */
const ALLOWED_ACTIONS = new Set([
    "ignore",
    "write-only",
    "answer-direct",
    "answer-decompose",
    "clarify",
    "escalate",
]);
/**
 * Defensive parser. The LLM is supposed to emit a `ModeratorDecision`-shaped
 * JSON object; this normalizes shapes, drops malformed sub-objects, and
 * always returns a valid Decision (default = `ignore` if everything fails).
 */
export function parseDecision(raw) {
    const errors = [];
    const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    if (!isObj(raw)) {
        errors.push("decision must be an object");
        return {
            decision: { action: "ignore", rationale: "parse-failed: not-object" },
            errors,
        };
    }
    const action = raw.action;
    if (typeof action !== "string" || !ALLOWED_ACTIONS.has(action)) {
        errors.push(`unknown action: ${JSON.stringify(action)}`);
        return {
            decision: { action: "ignore", rationale: `parse-failed: bad action ${action}` },
            errors,
        };
    }
    const decision = {
        action: action,
        rationale: typeof raw.rationale === "string" ? raw.rationale.slice(0, 500) : "",
    };
    if (Array.isArray(raw.memoryWrites)) {
        decision.memoryWrites = raw.memoryWrites
            .filter(isObj)
            .map((m) => {
            const text = typeof m.text === "string" ? m.text : null;
            const scope = m.scope === "user" || m.scope === "chat" || m.scope === "global" ? m.scope : null;
            if (!text || !scope) {
                return null;
            }
            const w = { text, scope };
            if (typeof m.topic === "string") {
                w.topic = m.topic;
            }
            if (typeof m.importance === "number" && m.importance >= 0 && m.importance <= 1) {
                w.importance = m.importance;
            }
            if (m.visibility === "public" || m.visibility === "private") {
                w.visibility = m.visibility;
            }
            return w;
        })
            .filter((w) => w !== null);
    }
    if (Array.isArray(raw.answerTasks)) {
        decision.answerTasks = raw.answerTasks
            .filter(isObj)
            .map((t) => {
            const taskId = typeof t.taskId === "string" ? t.taskId : null;
            const roleKey = typeof t.roleKey === "string" ? t.roleKey : null;
            const taskPrompt = typeof t.taskPrompt === "string" ? t.taskPrompt : null;
            if (!taskId || !roleKey || !taskPrompt) {
                return null;
            }
            const out = {
                taskId,
                roleKey,
                taskPrompt,
                memoryScope: isObj(t.memoryScope) ? t.memoryScope : undefined,
                canParallel: t.canParallel !== false,
            };
            // Optional inline role spec — model declares a new specialist on the fly.
            // We only accept a usable systemPrompt; everything else is shaped down.
            if (isObj(t.newRoleSpec)) {
                const ns = t.newRoleSpec;
                const sp = typeof ns.systemPrompt === "string" ? ns.systemPrompt.trim() : "";
                if (sp.length >= 20 && sp.length <= 4000) {
                    out.newRoleSpec = {
                        systemPrompt: sp,
                        displayName: typeof ns.displayName === "string" ? ns.displayName.slice(0, 80) : undefined,
                        memoryScope: isObj(ns.memoryScope)
                            ? {
                                topic: typeof ns.memoryScope.topic === "string" ? ns.memoryScope.topic : undefined,
                                kind: typeof ns.memoryScope.kind === "string" ? ns.memoryScope.kind : undefined,
                            }
                            : undefined,
                        tools: Array.isArray(ns.tools)
                            ? ns.tools.filter((t) => typeof t === "string").slice(0, 8)
                            : undefined,
                    };
                }
            }
            return out;
        })
            .filter((t) => t !== null);
    }
    if (Array.isArray(raw.telegramActions)) {
        decision.telegramActions = raw.telegramActions
            .filter(isObj)
            .filter((a) => {
            if (a.kind === "placeholder" && typeof a.text === "string") {
                return true;
            }
            if (a.kind === "edit_placeholder" && typeof a.taskId === "string") {
                return true;
            }
            if (a.kind === "send_message" && typeof a.text === "string") {
                return true;
            }
            if (a.kind === "send_chat_action" && (a.action === "typing" || a.action === "record_voice")) {
                return true;
            }
            return false;
        });
    }
    if (isObj(raw.escalation)) {
        const e = raw.escalation;
        if (typeof e.reason === "string" && typeof e.summary === "string") {
            decision.escalation = {
                reason: e.reason,
                summary: e.summary,
                pauseScope: e.pauseScope === true,
            };
        }
    }
    if (typeof raw.noteAppend === "string" && raw.noteAppend.length <= 1000) {
        decision.noteAppend = raw.noteAppend;
    }
    return { decision, errors };
}
