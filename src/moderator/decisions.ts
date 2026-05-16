/**
 * Moderator decision prompt builder.
 *
 * Constructs the gpt-5.5 prompt that drives one Moderator cycle. The
 * prompt has three sections:
 *
 *   1. System: role definition + the action enum + JSON-only output rule
 *      + scaling rules (Anthropic "Building effective agents" — agents
 *        can't self-judge effort, so we encode the heuristics in-prompt)
 *
 *   2. State context: condensed snapshot of ModeratorState — recent
 *      messages (last 30), active topic, active workers, active students,
 *      Moderator's own notes
 *
 *   3. The trigger: the new inbound message OR a cron-tick / worker-result
 *
 * The expected response is ONE JSON object conforming to ModeratorDecision
 * (see types.ts → parseDecision for the defensive parser).
 */

import type { ModeratorState, RecentMessage } from "./types.js";

const SYSTEM_PROMPT = `You are the MODERATOR for a Telegram tutoring / customer-service bot.
You receive a new message in a Telegram scope (group or DM) and must decide
ONE action. You do NOT answer the question yourself — you decide what
should happen and what specialist workers to spawn. You always reply with
exactly ONE JSON object conforming to the schema below.

## Available actions

  "ignore"            — chatter / not addressed to bot / no value to remember
  "write-only"        — useful info but no reply needed (e.g. "I dislike
                         verbose explanations" — remember, don't reply)
  "answer-direct"     — ONE worker spawned to answer one question
  "answer-decompose"  — multiple INDEPENDENT sub-questions; spawn workers
                         in parallel; only use when truly orthogonal
  "clarify"           — question is ambiguous; reply asking, no worker
  "escalate"          — beyond bot's competence / user explicitly asks
                         for a human / sensitive content; ping the owner

## Scaling rules (you cannot self-judge effort — apply these)

  - Simple factual / definitional question → answer-direct, 1 worker
  - Multi-step problem with one topic → answer-direct (worker decomposes
    internally; don't fan out)
  - Two CLEARLY independent questions in one message ("how to add fractions
    AND what time is class?") → answer-decompose with 2 parallel workers
  - User states a durable fact about themselves ("我是初二学生") →
    write-only, memoryWrites=[{ scope: "user", ... }]
  - User asks in chat but not @mentioning the bot, and topic is small-talk
    → ignore (no memory, no reply)
  - User says "我搞不懂" 3+ times on the same topic, or "找老师" / "I want
    a real teacher" → escalate
  - You don't know what they're asking, or grammar makes intent unclear
    → clarify (one short reply)

## Memory writes

When the user states a durable fact, decision, preference, or measurable
metric, add a memoryWrites entry:
  scope: "user"   → about the speaker (telegram user) personally
  scope: "chat"   → about this group / DM context
  scope: "global" → about the world / curriculum / shared resource

Do NOT write greetings, debug requests, or transient chatter.
Do NOT write the user's question itself — workers handle Q&A separately.

## Telegram actions

When you spawn a worker, send a "placeholder" first ("⏳ 让我想想...")
so the user sees acknowledgment. Use kind="edit_placeholder" with
fromTaskResult=true to splice the worker's output back into that
placeholder once it completes.

## Output schema (you MUST emit exactly this shape)

{
  "action": "ignore" | "write-only" | "answer-direct" | "answer-decompose" | "clarify" | "escalate",
  "rationale": "one sentence why",
  "memoryWrites": [ { "text": "...", "scope": "user"|"chat"|"global", "topic": "...", "importance": 0.0..1.0, "visibility": "public"|"private" } ],
  "answerTasks": [
    {
      "taskId": "t1",
      "roleKey": "math_tutor_grade5",
      "taskPrompt": "Student asks ... Explain step by step.",
      "memoryScope": { "topic": "math.fractions" },
      "canParallel": true
    }
  ],
  "telegramActions": [
    { "kind": "placeholder", "taskId": "t1", "text": "⏳ 让我想想..." },
    { "kind": "edit_placeholder", "taskId": "t1", "fromTaskResult": true }
  ],
  "escalation": { "reason": "...", "summary": "...", "pauseScope": false },
  "noteAppend": "optional one-liner to save into Moderator's own notes for next cycle"
}

Omit fields that aren't relevant to the chosen action. Always emit
"action" and "rationale". No prose around the JSON — JSON only.`;

const MAX_RECENT_MESSAGES_IN_PROMPT = 30;
const MAX_MESSAGE_TEXT_LEN = 500;

export type DecisionPromptInput = {
  state: ModeratorState;
  trigger:
    | { kind: "message"; message: RecentMessage }
    | { kind: "cron"; reason: "self-review" | "stale-worker-sweep" }
    | { kind: "worker-result"; taskId: string; result: string; success: boolean };
  /** Optional list of currently-registered worker roles (helps the
   *  Moderator pick from existing specialists vs creating new ones). */
  knownRoles?: string[];
};

export function buildDecisionPrompt(input: DecisionPromptInput): {
  system: string;
  user: string;
} {
  const ctx = serialiseStateForPrompt(input.state, input.knownRoles ?? []);
  const trigger = serialiseTrigger(input.trigger);
  return {
    system: SYSTEM_PROMPT,
    user: `## Scope\n${ctx}\n\n## Trigger\n${trigger}\n\nRespond with one JSON object only.`,
  };
}

function serialiseStateForPrompt(state: ModeratorState, knownRoles: string[]): string {
  const lines: string[] = [];
  lines.push(`scopeKind: ${state.scopeKind}`);
  if (state.chatId) {lines.push(`chatId: ${state.chatId}`);}
  if (state.activeTopic) {lines.push(`activeTopic: ${state.activeTopic}`);}

  if (state.activeStudents.length > 0) {
    lines.push("activeStudents:");
    for (const s of state.activeStudents.slice(-10)) {
      lines.push(`  - ${s.userId}${s.label ? ` (${s.label})` : ""}${s.currentTopic ? ` topic=${s.currentTopic}` : ""}`);
    }
  }

  if (state.activeWorkers.length > 0) {
    lines.push("activeWorkers (in-flight):");
    for (const w of state.activeWorkers) {
      lines.push(`  - task=${w.taskId} role=${w.roleKey} status=${w.status}${w.placeholderMessageId ? ` placeholder=${w.placeholderMessageId}` : ""}`);
    }
  }

  if (knownRoles.length > 0) {
    lines.push(`knownRoles: ${knownRoles.slice(0, 30).join(", ")}`);
  }

  if (state.notes.length > 0) {
    lines.push("notes:");
    for (const n of state.notes.slice(-10)) {lines.push(`  - ${n}`);}
  }

  if (state.recentMessages.length > 0) {
    lines.push(`recentMessages (last ${Math.min(MAX_RECENT_MESSAGES_IN_PROMPT, state.recentMessages.length)}):`);
    for (const m of state.recentMessages.slice(-MAX_RECENT_MESSAGES_IN_PROMPT)) {
      const text = m.text.length > MAX_MESSAGE_TEXT_LEN ? `${m.text.slice(0, MAX_MESSAGE_TEXT_LEN)}…` : m.text;
      const addr = m.isAddressed ? "@" : " ";
      const label = m.fromLabel ? `${m.fromUserId}/${m.fromLabel}` : m.fromUserId;
      lines.push(`  ${addr} [${m.ts.slice(11, 19)}] ${label}: ${text}`);
    }
  }

  return lines.join("\n");
}

function serialiseTrigger(trigger: DecisionPromptInput["trigger"]): string {
  if (trigger.kind === "message") {
    const m = trigger.message;
    const text = m.text.length > MAX_MESSAGE_TEXT_LEN ? `${m.text.slice(0, MAX_MESSAGE_TEXT_LEN)}…` : m.text;
    const addr = m.isAddressed ? "@bot-mention" : "no-mention";
    return `new message (${addr})\n  from: ${m.fromUserId}${m.fromLabel ? ` (${m.fromLabel})` : ""}\n  at:   ${m.ts}\n  text: ${text}`;
  }
  if (trigger.kind === "cron") {
    return `cron tick: ${trigger.reason}`;
  }
  return `worker result: task=${trigger.taskId} success=${trigger.success}\n  result: ${trigger.result.slice(0, 800)}`;
}
