/**
 * Minimal Telegram Bot API client for the Moderator's side-effect lane.
 *
 * Three methods only: sendMessage, editMessageText, sendChatAction.
 * Anything fancier (inline keyboards, file uploads, etc.) we add when
 * a feature actually needs it.
 *
 * Why not reuse openclaw's outbound? Openclaw's send path drives the
 * agent reply pipeline, which assumes "one reply per inbound msg".
 * The Moderator sends an immediate placeholder, MAYBE several edits,
 * and possibly a final answer — that doesn't fit cleanly. Direct
 * Telegram Bot API calls keep the contract simple.
 *
 * Rate limits (community-confirmed, not officially published):
 *   - 30 msg/sec global per bot token
 *   - 20 msg/min per group
 *   - 1 msg/sec per chat
 * The caller (moderator service) batches edits to ~every 2s. If we
 * still get 429, Telegram's `Retry-After` is honoured.
 */

const DEFAULT_API_ROOT = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 15_000;

export type TelegramBotConfig = {
  /** The bot token (channels.telegram.botToken from openclaw.json). */
  botToken: string;
  /** API base (default https://api.telegram.org). */
  apiRoot?: string;
  /** fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Per-call request timeout. */
  timeoutMs?: number;
};

export type SendMessageParams = {
  chatId: string | number;
  text: string;
  replyToMessageId?: number;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  /** When set, the message is sent inside this forum topic. */
  messageThreadId?: number;
};

export type EditMessageTextParams = {
  chatId: string | number;
  messageId: number;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
};

export type SendChatActionParams = {
  chatId: string | number;
  action: "typing" | "record_voice" | "upload_document";
  messageThreadId?: number;
};

export type ApiOutcome<T> =
  | { ok: true; result: T; retryAfter?: number }
  | { ok: false; error: string; status?: number; retryAfter?: number };

export class TelegramBotApi {
  private readonly fetchImpl: typeof fetch;
  private readonly apiRoot: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: TelegramBotConfig) {
    if (!cfg.botToken) {throw new Error("[moderator] telegram bot token missing");}
    this.apiRoot = (cfg.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendMessage(params: SendMessageParams): Promise<ApiOutcome<{ messageId: number }>> {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: params.chatId,
      text: params.text,
      ...(params.replyToMessageId ? { reply_to_message_id: params.replyToMessageId } : {}),
      ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
      ...(params.messageThreadId ? { message_thread_id: params.messageThreadId } : {}),
    }).then((o) => (o.ok ? { ok: true as const, result: { messageId: o.result.message_id } } : o));
  }

  async editMessageText(params: EditMessageTextParams): Promise<ApiOutcome<true>> {
    return this.call("editMessageText", {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
      ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
    }).then((o) => (o.ok ? { ok: true as const, result: true } : o));
  }

  async sendChatAction(params: SendChatActionParams): Promise<ApiOutcome<true>> {
    return this.call("sendChatAction", {
      chat_id: params.chatId,
      action: params.action,
      ...(params.messageThreadId ? { message_thread_id: params.messageThreadId } : {}),
    }).then((o) => (o.ok ? { ok: true as const, result: true } : o));
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<ApiOutcome<T>> {
    const url = `${this.apiRoot}/bot${this.cfg.botToken}/${method}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: T;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (json.ok && json.result !== undefined) {
        return { ok: true, result: json.result };
      }
      return {
        ok: false,
        error: json.description ?? `HTTP ${resp.status}`,
        status: resp.status,
        retryAfter: json.parameters?.retry_after,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
