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

/* --------------------------- ModeratorState shape -------------------------- */

export type ScopeKey = string; // "tg:chat:<chat_id>" | "tg:dm:<user_id>"

export type RecentMessage = {
  ts: string;            // ISO timestamp
  fromUserId: string;    // telegram user id (or "bot" for bot replies)
  fromLabel?: string;    // display name when known
  text: string;          // user-visible text, truncated to ~500 chars in state
  messageId?: number;    // telegram message id (for edit/reply targeting)
  isAddressed?: boolean; // @mention or reply-to-bot
};

export type ActiveWorker = {
  taskId: string;        // moderator-local id; unique within scope
  roleKey: string;       // references moderator.worker_roles.role_key
  task: string;          // the actual task prompt
  startedAt: string;
  placeholderMessageId?: number;  // the "thinking..." message to edit
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string;       // populated when status=completed
  error?: string;
};

export type ActiveStudent = {
  userId: string;
  label?: string;
  lastSeenAt: string;
  currentTopic?: string;
};

export type ModeratorState = {
  scopeKey: ScopeKey;
  scopeKind: "group" | "dm";
  chatId?: string;       // telegram chat id
  ownerUserId?: string;  // bot owner (for escalation routing)

  /** Most recent N messages (FIFO, cap 50). */
  recentMessages: RecentMessage[];

  /** Distilled "what's going on" — Moderator updates each cycle. */
  activeTopic?: string;
  activeStudents: ActiveStudent[];

  /** Workers in flight; cleared on completion. */
  activeWorkers: ActiveWorker[];

  /** Per-user debounce buffer (1.5s burst → one prompt). */
  debounceBuffer: { userId: string; messages: RecentMessage[]; firstSeenAt: string }[];

  /** Long-lived "self notes" — facts the Moderator decided to keep in
   *  its working context. Distinct from per-user/per-chat memory in
   *  nextclaw chunks — these are the Moderator's own scratchpad. */
  notes: string[];

  /** Self-review bookkeeping. */
  lastReviewAt?: string;
  messagesSinceLastReview: number;

  /** Schema version for forward-compatible migrations of the JSONB. */
  version: 1;
};

export function newModeratorState(scopeKey: ScopeKey, scopeKind: "group" | "dm", chatId?: string, ownerUserId?: string): ModeratorState {
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

/* ----------------------------- Decision schema ----------------------------- */

export type DecisionAction =
  | "ignore"            // chatter; do nothing, don't even write to memory
  | "write-only"        // remember it but don't reply
  | "answer-direct"     // spawn ONE worker with a direct answer task
  | "answer-decompose"  // spawn MULTIPLE workers (independent sub-questions)
  | "clarify"           // reply asking for clarification, no worker
  | "escalate";         // ping the bot owner; optionally also reply in chat

export type MemoryWrite = {
  text: string;
  scope: "user" | "chat" | "global";  // user = anchor_sender_id only;
                                       // chat = anchor_chat_id only;
                                       // global = neither (pure system fact)
  topic?: string;
  importance?: number;                 // 0..1, default 0.5
  visibility?: "public" | "private";   // default depends on scope
};

export type AnswerTask = {
  /** Unique within the decision. Used to correlate workers ↔ placeholder edits. */
  taskId: string;
  /** Role specialist to invoke. Will be auto-spawned if not yet registered. */
  roleKey: string;
  /** Free-form prompt for the worker. Anchors / context will be merged in by the runner. */
  taskPrompt: string;
  /** Memory scope hint for the worker's memory_search calls. */
  memoryScope?: { topic?: string; viewerUserId?: string; chatId?: string };
  /** Whether this task can run in parallel with others in the same decision.
   *  Default true; false means it depends on a prior task's result. */
  canParallel?: boolean;
  /**
   * Optional inline specialist spec. When set AND `roleKey` is not yet
   * registered in `moderator.worker_roles`, the Moderator auto-creates
   * the row before dispatching. Subsequent decisions reusing the same
   * `roleKey` get the persisted spec — so the Moderator's choice of
   * specialist designs accumulates over time, instead of every novel
   * `roleKey` collapsing back to DEFAULT_ROLE.
   *
   * This is the "leverage" hook: stronger Moderator → better specialist
   * designs → richer permanent registry.
   *
   * Operator-seeded rows always win; agent-created rows are first-write-wins.
   */
  newRoleSpec?: {
    systemPrompt: string;
    displayName?: string;
    memoryScope?: { topic?: string; kind?: string };
  };
};

export type TelegramAction =
  | { kind: "placeholder";      taskId?: string;   text: string }
  | { kind: "edit_placeholder"; taskId: string;    fromTaskResult: true }
  | { kind: "edit_placeholder"; taskId: string;    text: string }
  | { kind: "send_message";     text: string;      replyToMessageId?: number }
  | { kind: "send_chat_action"; action: "typing" | "record_voice" };

export type Escalation = {
  reason: string;
  summary: string;
  /** When true, also pause Moderator auto-reply in this scope until human
   *  issues /release. */
  pauseScope?: boolean;
};

export type ModeratorDecision = {
  action: DecisionAction;
  rationale: string;
  memoryWrites?: MemoryWrite[];
  answerTasks?: AnswerTask[];
  telegramActions?: TelegramAction[];
  escalation?: Escalation;
  /** When the Moderator wants to refresh its own state notes for next cycle. */
  noteAppend?: string;
};

/* ----------------------------- helpers / guards ---------------------------- */

const ALLOWED_ACTIONS = new Set<DecisionAction>([
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
export function parseDecision(raw: unknown): { decision: ModeratorDecision; errors: string[] } {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isObj(raw)) {
    errors.push("decision must be an object");
    return {
      decision: { action: "ignore", rationale: "parse-failed: not-object" },
      errors,
    };
  }
  const action = raw.action;
  if (typeof action !== "string" || !ALLOWED_ACTIONS.has(action as DecisionAction)) {
    errors.push(`unknown action: ${JSON.stringify(action)}`);
    return {
      decision: { action: "ignore", rationale: `parse-failed: bad action ${action}` },
      errors,
    };
  }

  const decision: ModeratorDecision = {
    action: action as DecisionAction,
    rationale: typeof raw.rationale === "string" ? raw.rationale.slice(0, 500) : "",
  };

  if (Array.isArray(raw.memoryWrites)) {
    decision.memoryWrites = raw.memoryWrites
      .filter(isObj)
      .map((m): MemoryWrite | null => {
        const text = typeof m.text === "string" ? m.text : null;
        const scope = m.scope === "user" || m.scope === "chat" || m.scope === "global" ? m.scope : null;
        if (!text || !scope) {return null;}
        const w: MemoryWrite = { text, scope };
        if (typeof m.topic === "string") {w.topic = m.topic;}
        if (typeof m.importance === "number" && m.importance >= 0 && m.importance <= 1) {
          w.importance = m.importance;
        }
        if (m.visibility === "public" || m.visibility === "private") {w.visibility = m.visibility;}
        return w;
      })
      .filter((w): w is MemoryWrite => w !== null);
  }

  if (Array.isArray(raw.answerTasks)) {
    decision.answerTasks = raw.answerTasks
      .filter(isObj)
      .map((t): AnswerTask | null => {
        const taskId = typeof t.taskId === "string" ? t.taskId : null;
        const roleKey = typeof t.roleKey === "string" ? t.roleKey : null;
        const taskPrompt = typeof t.taskPrompt === "string" ? t.taskPrompt : null;
        if (!taskId || !roleKey || !taskPrompt) {return null;}
        const out: AnswerTask = {
          taskId,
          roleKey,
          taskPrompt,
          memoryScope: isObj(t.memoryScope) ? (t.memoryScope as AnswerTask["memoryScope"]) : undefined,
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
            };
          }
        }
        return out;
      })
      .filter((t): t is AnswerTask => t !== null);
  }

  if (Array.isArray(raw.telegramActions)) {
    decision.telegramActions = raw.telegramActions
      .filter(isObj)
      .filter((a): a is TelegramAction => {
        if (a.kind === "placeholder" && typeof a.text === "string") {return true;}
        if (a.kind === "edit_placeholder" && typeof a.taskId === "string") {return true;}
        if (a.kind === "send_message" && typeof a.text === "string") {return true;}
        if (a.kind === "send_chat_action" && (a.action === "typing" || a.action === "record_voice")) {return true;}
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
