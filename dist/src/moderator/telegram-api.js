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
import { lookup as dnsLookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
const DEFAULT_API_ROOT = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Custom undici Agent: IPv4-only on hosts where IPv6 → api.telegram.org
 * is broken (e.g. our Oracle Cloud setup — same workaround openclaw
 * does for its own Telegram polling via OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY).
 * globalThis.fetch in Node 22 honours autoSelectFamily=true by default,
 * which silently hangs on IPv6-broken hosts. Forcing autoSelectFamily=false
 * + ipv4-only DNS lookup keeps us on the working path.
 */
const ipv4FirstAgent = new Agent({
    connect: {
        autoSelectFamily: false,
        lookup: (hostname, opts, cb) => dnsLookup(hostname, { ...opts, family: 4, all: false }, cb),
    },
});
export class TelegramBotApi {
    cfg;
    fetchImpl;
    apiRoot;
    timeoutMs;
    constructor(cfg) {
        this.cfg = cfg;
        if (!cfg.botToken) {
            throw new Error("[moderator] telegram bot token missing");
        }
        this.apiRoot = (cfg.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, "");
        // Use the IPv4-first undici fetch wrapper for production; fall through
        // to caller-provided override (tests) or globalThis.fetch (other hosts
        // where IPv6 actually works).
        // Cross-cast through `unknown` once: undici's Request type and Node lib's
        // RequestInfo aren't structurally identical (different RequestInit shapes)
        // but at runtime they're the same. Return type also cast back to Response.
        this.fetchImpl = cfg.fetchImpl ?? ((url, init) => undiciFetch(url, { ...init, dispatcher: ipv4FirstAgent }));
        this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    async sendMessage(params) {
        return this.call("sendMessage", {
            chat_id: params.chatId,
            text: params.text,
            ...(params.replyToMessageId ? { reply_to_message_id: params.replyToMessageId } : {}),
            ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
            ...(params.messageThreadId ? { message_thread_id: params.messageThreadId } : {}),
            ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
        }).then((o) => (o.ok ? { ok: true, result: { messageId: o.result.message_id } } : o));
    }
    async editMessageText(params) {
        return this.call("editMessageText", {
            chat_id: params.chatId,
            message_id: params.messageId,
            text: params.text,
            ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
        }).then((o) => (o.ok ? { ok: true, result: true } : o));
    }
    async sendChatAction(params) {
        return this.call("sendChatAction", {
            chat_id: params.chatId,
            action: params.action,
            ...(params.messageThreadId ? { message_thread_id: params.messageThreadId } : {}),
        }).then((o) => (o.ok ? { ok: true, result: true } : o));
    }
    async call(method, body) {
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
            const json = (await resp.json().catch(() => ({})));
            if (json.ok && json.result !== undefined) {
                return { ok: true, result: json.result };
            }
            return {
                ok: false,
                error: json.description ?? `HTTP ${resp.status}`,
                status: resp.status,
                retryAfter: json.parameters?.retry_after,
            };
        }
        catch (err) {
            // `fetch failed` is unhelpful on its own — include the cause chain
            // when available so we can tell DNS / TLS / connect-refused apart
            // from a 4xx body parse.
            const e = err;
            const cause = e.cause ? ` (cause: ${e.cause?.message ?? String(e.cause)})` : "";
            return { ok: false, error: `${e.message}${cause}` };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
