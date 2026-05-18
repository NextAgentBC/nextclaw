/**
 * Moderator runner — pure function that takes (state, trigger, llm) and
 * returns (updatedState, decision). The actual SIDE EFFECTS (sending
 * Telegram messages, spawning workers, writing to nextclaw memory) are
 * the caller's responsibility — keeping them out of this function makes
 * the runner unit-testable without any of those moving parts.
 *
 * The wiring layer (Phase C+) wraps this with:
 *   1. loadModeratorState(pool, agentId, scopeKey)
 *   2. runOneCycle(state, trigger, llmClient)
 *   3. saveModeratorState(pool, ..., updatedState)
 *   4. logDecision(pool, ..., decision)
 *   5. execute side effects implied by decision.telegramActions /
 *      answerTasks / memoryWrites / escalation
 *   6. when worker completes, feed result back via a new runOneCycle
 *      call with trigger.kind = "worker-result"
 */
import { buildDecisionPrompt } from "./decisions.js";
import { parseDecision } from "./types.js";
const RECENT_MESSAGES_CAP = 50;
const ACTIVE_WORKERS_CAP = 10;
const NOTES_CAP = 20;
export async function runOneCycle(state, trigger, llm, knownRoles = []) {
    const { system, user } = buildDecisionPrompt({ state, trigger, knownRoles });
    const llmResponse = await llm.call({
        systemPrompt: system,
        userPrompt: user,
        maxTokens: 1200,
        temperature: 0.3,
    });
    const rawText = llmResponse.text.trim();
    // The LLM should reply with one JSON object. Tolerate `\`\`\`json` fences.
    const cleaned = rawText
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
    let parsed;
    try {
        const obj = JSON.parse(cleaned);
        parsed = parseDecision(obj);
    }
    catch (err) {
        parsed = {
            decision: {
                action: "ignore",
                rationale: `parse-failed: ${err.message.slice(0, 200)}`,
            },
            errors: [`json-parse: ${err.message}`],
        };
    }
    const updated = applyDecisionToState(state, trigger, parsed.decision);
    return {
        decision: parsed.decision,
        parseErrors: parsed.errors,
        state: updated,
        llm: {
            model: llmResponse.model,
            inputTokens: llmResponse.inputTokens,
            outputTokens: llmResponse.outputTokens,
            latencyMs: llmResponse.latencyMs,
            rawText,
        },
    };
}
/**
 * Pure state transition: apply the trigger + decision and return a new
 * state. Does NOT do side effects (no DB writes, no Telegram).
 *
 * What it updates:
 *   - recentMessages: append the new trigger message (when trigger is
 *     a message)
 *   - activeWorkers: append new entries for decision.answerTasks; mark
 *     completed/failed when trigger is a worker-result
 *   - notes: append decision.noteAppend
 *   - messagesSinceLastReview: increment on message trigger
 *   - activeStudents: bump lastSeenAt for the trigger sender
 */
export function applyDecisionToState(state, trigger, decision) {
    const recentMessages = [...state.recentMessages];
    const activeWorkers = [...state.activeWorkers];
    const notes = [...state.notes];
    const activeStudents = [...state.activeStudents];
    let messagesSinceLastReview = state.messagesSinceLastReview;
    if (trigger.kind === "message") {
        const m = trigger.message;
        recentMessages.push(m);
        while (recentMessages.length > RECENT_MESSAGES_CAP) {
            recentMessages.shift();
        }
        messagesSinceLastReview += 1;
        // Bump activeStudents
        const idx = activeStudents.findIndex((s) => s.userId === m.fromUserId);
        if (idx >= 0) {
            activeStudents[idx] = { ...activeStudents[idx], lastSeenAt: m.ts };
        }
        else {
            activeStudents.push({
                userId: m.fromUserId,
                label: m.fromLabel,
                lastSeenAt: m.ts,
            });
        }
    }
    // Spawn workers declared in this decision.
    if (decision.answerTasks && decision.answerTasks.length > 0) {
        const now = new Date().toISOString();
        for (const t of decision.answerTasks) {
            const exists = activeWorkers.some((w) => w.taskId === t.taskId);
            if (exists) {
                continue;
            }
            activeWorkers.push({
                taskId: t.taskId,
                roleKey: t.roleKey,
                task: t.taskPrompt,
                startedAt: now,
                status: "running",
            });
        }
        while (activeWorkers.length > ACTIVE_WORKERS_CAP) {
            activeWorkers.shift();
        }
    }
    // Worker result trigger updates the corresponding active worker.
    if (trigger.kind === "worker-result") {
        const idx = activeWorkers.findIndex((w) => w.taskId === trigger.taskId);
        if (idx >= 0) {
            activeWorkers[idx] = {
                ...activeWorkers[idx],
                status: trigger.success ? "completed" : "failed",
                result: trigger.success ? trigger.result : undefined,
                error: trigger.success ? undefined : trigger.result,
            };
        }
    }
    if (decision.noteAppend) {
        notes.push(decision.noteAppend);
        while (notes.length > NOTES_CAP) {
            notes.shift();
        }
    }
    return {
        ...state,
        recentMessages,
        activeWorkers,
        activeStudents,
        notes,
        messagesSinceLastReview,
    };
}
