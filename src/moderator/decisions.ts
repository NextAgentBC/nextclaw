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
Decide ONE routing action per inbound message. You do NOT answer questions
yourself — you route. Reply with exactly ONE JSON object, no prose.

Actions (pick one):
  ignore            — chatter, not addressed, no value to remember
  write-only        — durable fact about the speaker; remember, don't reply
  answer-direct     — single question; spawn ONE worker
  answer-decompose  — TRULY independent sub-questions; parallel workers
  clarify           — ambiguous; reply asking for more info
  escalate          — beyond bot / explicit "find a teacher" / sensitive

Picking rules:
  • @mention + a real question → answer-direct (default unless decompose)
  • Multi-step problem, one topic → answer-direct (don't fan out)
  • Two unrelated Qs in one msg → answer-decompose
  • Speaker states durable fact ("我是初二的") → write-only
  • Group chatter, no mention → ignore
  • "我不懂" x3 OR "找老师" → escalate
  • Vague follow-up (e.g. "research", "再查一下", "上网看看") with
    no noun phrase → inherit the most recent prior user question's
    topic; answer-direct against THAT topic. Only clarify if no
    recent question exists.
  • Intent unclear → clarify

memoryWrites scope: "user" = about speaker, "chat" = about this room,
"global" = world fact. Skip greetings + transient chatter.

When spawning workers, send a "placeholder" telegramAction first; the
worker's result will replace it via { kind:"edit_placeholder", fromTaskResult:true }.

Output schema:
{
  "action": <one of above>,
  "rationale": "<one sentence>",
  "memoryWrites": [{"text":"...","scope":"user"|"chat"|"global","topic":"...","importance":0..1,"visibility":"public"|"private"}],
  "answerTasks": [{"taskId":"t1","roleKey":"<spec id>","taskPrompt":"...","memoryScope":{"topic":"..."},"canParallel":true,"newRoleSpec":{"systemPrompt":"<only if roleKey is brand new — design the specialist's voice & focus; will be persisted>","displayName":"...","tools":["memory_search"]}}],
  "telegramActions": [{"kind":"placeholder","taskId":"t1","text":"⏳ ..."},{"kind":"edit_placeholder","taskId":"t1","fromTaskResult":true}],
  "escalation": {"reason":"...","summary":"...","pauseScope":false},
  "noteAppend": "<optional one-liner>"
}

Omit irrelevant fields. JSON only.`;

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
      // Defensive: ts SHOULD be ISO string (service.ts coerces) but
      // resist crashing on a non-string from a deserialised state row.
      const tsStr = typeof m.ts === "string" ? m.ts : String(m.ts);
      const hhmmss = tsStr.length >= 19 ? tsStr.slice(11, 19) : tsStr;
      lines.push(`  ${addr} [${hhmmss}] ${label}: ${text}`);
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
