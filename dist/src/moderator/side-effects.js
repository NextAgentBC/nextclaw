/**
 * Side-effect executor for a Moderator decision.
 *
 * Takes a Decision + state + deps (Telegram client, pg pool, the
 * dashboard ingest endpoint, owner DM target) and FIRES all the
 * external work the decision implies:
 *
 *   • telegramActions[kind=placeholder]      → sendMessage, save msg_id
 *                                               into activeWorkers[].placeholderMessageId
 *   • telegramActions[kind=send_message]     → sendMessage
 *   • telegramActions[kind=send_chat_action] → sendChatAction
 *   • telegramActions[kind=edit_placeholder] → editMessageText
 *                                               (fromTaskResult requires the
 *                                                worker result to be present
 *                                                in activeWorkers — caller
 *                                                handles this AFTER worker
 *                                                completes; here we just
 *                                                handle the static-text variant)
 *   • memoryWrites                           → POST /api/ingest with anchors
 *                                               (per-scope: user / chat / global)
 *   • escalation                             → DM the bot owner; optionally
 *                                               set state.status = "paused"
 *
 * Worker dispatch (answerTasks) is INTENTIONALLY not handled here — that's
 * Phase D. For now the placeholder appears, the worker is "logically
 * registered" in state, but no codex run actually fires.
 */
export async function executeDecision(decision, state, deps) {
    const out = {
        placeholders: [],
        messagesSent: 0,
        editsApplied: 0,
        chatActionsSent: 0,
        memoryWritesAccepted: 0,
        escalationSent: false,
        shouldPauseScope: false,
        errors: [],
    };
    // 1. Telegram actions, in declaration order.
    for (const action of decision.telegramActions ?? []) {
        try {
            await applyTelegramAction(action, deps, out);
        }
        catch (err) {
            out.errors.push(`telegram-action: ${err.message}`);
        }
    }
    // 2. Memory writes — each becomes one POST to /api/ingest with anchors.
    for (const w of decision.memoryWrites ?? []) {
        try {
            const anchors = {};
            if (w.scope === "user") {
                if (deps.triggerSenderUserId) {
                    anchors.sender_id = `tg-${deps.triggerSenderUserId}`;
                }
                anchors.visibility = w.visibility ?? "private";
            }
            else if (w.scope === "chat") {
                anchors.chat_id = `tg-${deps.chatId.replace(/^-/, "")}`;
                anchors.visibility = w.visibility ?? "public";
            }
            // "global" scope → no scope anchors
            if (w.topic) {
                anchors.scope = w.topic;
            }
            const r = await fetch(deps.ingestUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "x-token": deps.ingestToken },
                body: JSON.stringify({
                    text: w.text,
                    source: "moderator",
                    kind: "fact",
                    agentId: deps.agentId,
                    importance: typeof w.importance === "number" ? w.importance : 0.5,
                    retentionClass: "standard",
                    anchors,
                }),
            });
            if (r.ok) {
                out.memoryWritesAccepted += 1;
            }
            else {
                out.errors.push(`memory-write: HTTP ${r.status}`);
            }
        }
        catch (err) {
            out.errors.push(`memory-write: ${err.message}`);
        }
    }
    // 3. Escalation — DM the bot owner; optionally request scope pause.
    if (decision.escalation) {
        const e = decision.escalation;
        if (deps.ownerUserId) {
            const body = [
                `🚨 ESCALATION from ${state.scopeKey}`,
                `Reason: ${e.reason}`,
                `Summary: ${e.summary}`,
                e.pauseScope ? "(scope auto-paused — /release to resume)" : "(scope NOT paused; bot continues)",
            ].join("\n");
            try {
                const r = await deps.telegram.sendMessage({
                    chatId: deps.ownerUserId,
                    text: body,
                });
                if (r.ok) {
                    out.escalationSent = true;
                }
                else {
                    out.errors.push(`escalation send: ${r.error}`);
                }
            }
            catch (err) {
                out.errors.push(`escalation send: ${err.message}`);
            }
        }
        else {
            out.errors.push("escalation requested but ownerUserId not configured");
        }
        if (e.pauseScope) {
            out.shouldPauseScope = true;
        }
    }
    return out;
}
async function applyTelegramAction(action, deps, out) {
    if (action.kind === "placeholder") {
        const r = await deps.telegram.sendMessage({
            chatId: deps.chatId,
            text: action.text,
            messageThreadId: deps.messageThreadId,
        });
        if (r.ok) {
            out.messagesSent += 1;
            if (action.taskId) {
                out.placeholders.push({ taskId: action.taskId, messageId: r.result.messageId });
            }
        }
        else {
            out.errors.push(`placeholder: ${r.error}`);
        }
        return;
    }
    if (action.kind === "send_message") {
        const r = await deps.telegram.sendMessage({
            chatId: deps.chatId,
            text: action.text,
            replyToMessageId: action.replyToMessageId,
            messageThreadId: deps.messageThreadId,
        });
        if (r.ok) {
            out.messagesSent += 1;
        }
        else {
            out.errors.push(`send_message: ${r.error}`);
        }
        return;
    }
    if (action.kind === "send_chat_action") {
        const r = await deps.telegram.sendChatAction({
            chatId: deps.chatId,
            action: action.action,
            messageThreadId: deps.messageThreadId,
        });
        if (r.ok) {
            out.chatActionsSent += 1;
        }
        else {
            out.errors.push(`send_chat_action: ${r.error}`);
        }
        return;
    }
    if (action.kind === "edit_placeholder") {
        // Static-text edits we can apply now. fromTaskResult is the caller's
        // responsibility (worker result must be in activeWorkers first).
        if ("text" in action && typeof action.text === "string") {
            const placeholder = out.placeholders.find((p) => p.taskId === action.taskId)
                ?? findActiveWorkerPlaceholder(deps, action.taskId);
            if (!placeholder) {
                out.errors.push(`edit_placeholder: no placeholder for task ${action.taskId}`);
                return;
            }
            const r = await deps.telegram.editMessageText({
                chatId: deps.chatId,
                messageId: placeholder.messageId,
                text: action.text,
            });
            if (r.ok) {
                out.editsApplied += 1;
            }
            else {
                out.errors.push(`edit_placeholder: ${r.error}`);
            }
        }
        // fromTaskResult variant: deferred to the worker-completion path.
    }
}
function findActiveWorkerPlaceholder(_deps, _taskId) {
    // Caller passes the up-to-date state through; this is a placeholder
    // for the worker-completion path in Phase D. For now, only same-cycle
    // placeholders are editable via the static path.
    return null;
}
