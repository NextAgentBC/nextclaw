/**
 * Telegram Mini App (WebApp) initData verification + per-user session
 * tokens for the dashboard.
 *
 * Why this exists:
 *   When the dashboard is exposed publicly (e.g. via Cloudflare Tunnel)
 *   so a Telegram WebApp button can open it, putting the global
 *   `NEXTCLAW_DASH_TOKEN` in the URL is a security hole — anyone with
 *   the link sees everything. Instead, we let the bot's `/dashboard`
 *   command return a WebApp button pointing at the public URL; when
 *   Telegram opens the WebApp it injects `window.Telegram.WebApp.initData`
 *   which the dashboard JS POSTs here. We HMAC-verify it against the
 *   bot token, check the user is in the owner allowlist, and issue a
 *   short-lived session token the JS uses for subsequent `/api/*` calls.
 *
 * Spec reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Security:
 *   - HMAC-SHA256 with key = HMAC-SHA256("WebAppData", botToken)
 *   - auth_date freshness check (default 24h) to refuse replayed initData
 *   - user.id allowlist (operator config `commands.ownerAllowFrom`)
 *   - session tokens are 192-bit random, in-memory (lost on restart —
 *     fine, user just re-opens the WebApp), 1h TTL, plus single-use
 *     refresh on each successful API hit
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type TelegramAuthConfig = {
  /** Bot token from `channels.telegram.botToken`. Required. */
  botToken: string;
  /** Allowed Telegram numeric user ids, e.g. ["8064984663"].
   *  Typically derived from `commands.ownerAllowFrom` ("telegram:<id>" entries). */
  allowedUserIds: Set<string>;
  /** Reject initData older than this many seconds. Default 86400 (24h). */
  maxAuthAgeSec?: number;
  /** Session token TTL in ms. Default 1h. */
  sessionTtlMs?: number;
};

export type SessionRecord = {
  token: string;
  userId: string;
  expiresAtMs: number;
};

const DEFAULT_MAX_AUTH_AGE_SEC = 24 * 60 * 60;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

export class TelegramWebAppAuth {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxAuthAgeSec: number;
  private readonly sessionTtlMs: number;

  constructor(private readonly cfg: TelegramAuthConfig) {
    if (!cfg.botToken) {
      throw new Error("[dashboard/telegram-auth] botToken required");
    }
    this.maxAuthAgeSec = cfg.maxAuthAgeSec ?? DEFAULT_MAX_AUTH_AGE_SEC;
    this.sessionTtlMs = cfg.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  /**
   * Validate Telegram WebApp `initData` (URL-encoded query string from
   * `window.Telegram.WebApp.initData`) and, on success, mint a session
   * token for the verified user.
   *
   * Returns:
   *   - `{ok: true, token, userId, expiresAtMs}` on success
   *   - `{ok: false, error: ...}` on validation failure (bad hash,
   *     stale, user not in allowlist, etc.)
   */
  verifyAndIssue(initData: string): { ok: true; token: string; userId: string; expiresAtMs: number }
    | { ok: false; error: string } {
    if (typeof initData !== "string" || initData.length === 0) {
      return { ok: false, error: "missing-initData" };
    }
    // 1. Parse initData (URL-encoded; preserve raw values for hashing).
    const params = new URLSearchParams(initData);
    const providedHash = params.get("hash");
    if (!providedHash) {return { ok: false, error: "missing-hash" };}

    // 2. Build data_check_string per Telegram spec:
    //    all params except `hash`, sorted by key alphabetically,
    //    each as `key=value`, joined with \n.
    const entries: Array<[string, string]> = [];
    params.forEach((v, k) => {
      if (k !== "hash") {entries.push([k, v]);}
    });
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    // 3. secret_key = HMAC-SHA256("WebAppData", botToken)
    const secretKey = createHmac("sha256", "WebAppData").update(this.cfg.botToken).digest();
    const computed = createHmac("sha256", secretKey).update(dataCheckString).digest();

    // 4. Constant-time compare.
    const providedBuf = Buffer.from(providedHash, "hex");
    if (providedBuf.length !== computed.length || !timingSafeEqual(providedBuf, computed)) {
      return { ok: false, error: "bad-hash" };
    }

    // 5. auth_date freshness.
    const authDateStr = params.get("auth_date");
    if (!authDateStr) {return { ok: false, error: "missing-auth_date" };}
    const authDate = Number.parseInt(authDateStr, 10);
    if (!Number.isFinite(authDate)) {return { ok: false, error: "bad-auth_date" };}
    const ageSec = Math.floor(Date.now() / 1000) - authDate;
    if (ageSec > this.maxAuthAgeSec) {
      return { ok: false, error: `stale(${ageSec}s)` };
    }

    // 6. Parse `user` (JSON-encoded inside initData) and pull `user.id`.
    const userJson = params.get("user");
    if (!userJson) {return { ok: false, error: "missing-user" };}
    let userObj: { id?: number | string; username?: string };
    try {
      userObj = JSON.parse(userJson);
    } catch {
      return { ok: false, error: "bad-user-json" };
    }
    const userIdRaw = userObj?.id;
    if (userIdRaw === undefined || userIdRaw === null) {return { ok: false, error: "missing-user-id" };}
    const userId = String(userIdRaw);

    // 7. Allowlist check.
    if (!this.cfg.allowedUserIds.has(userId)) {
      return { ok: false, error: `user-not-allowed(${userId})` };
    }

    // 8. Mint session token.
    const token = randomBytes(24).toString("base64url");
    const expiresAtMs = Date.now() + this.sessionTtlMs;
    this.sessions.set(token, { token, userId, expiresAtMs });
    return { ok: true, token, userId, expiresAtMs };
  }

  /**
   * Validate a session token. Returns the userId on success; null on
   * miss/expired. Refreshes TTL on hit (sliding-window expiration).
   */
  consume(token: string): string | null {
    if (!token) {return null;}
    const rec = this.sessions.get(token);
    if (!rec) {return null;}
    if (Date.now() > rec.expiresAtMs) {
      this.sessions.delete(token);
      return null;
    }
    // Sliding-window refresh.
    rec.expiresAtMs = Date.now() + this.sessionTtlMs;
    return rec.userId;
  }

  /** Sweep expired entries. Called opportunistically; not load-bearing. */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (now > v.expiresAtMs) {this.sessions.delete(k);}
    }
  }

  stats(): { activeSessions: number } {
    this.sweep();
    return { activeSessions: this.sessions.size };
  }
}
