/**
 * Worker-side LLM client with tool-call support.
 *
 * Separate from `llm-client.ts` (which wraps the Moderator's single-shot
 * decision call) because tool-call semantics need a different request
 * shape and a multi-turn `history` parameter. We keep them decoupled so
 * Moderator decision calls never accidentally pick up tool defs.
 *
 * Backend: Gemini's `:generateContent` API only for the MVP. OpenAI is
 * TODO — same idea (tools, tool_choice, tool_calls in response, then a
 * follow-up call with `tool` role messages), but the request shape is
 * different enough that we don't share code.
 *
 * Reuses the IPv4-only fetch from telegram-api.ts is NOT needed here —
 * gemini hits go via the credbroker on Tailscale, IPv6 path works.
 */

import type { ToolCall, ToolDefinition, ToolResult } from "./worker-tools.js";

export type WorkerLlmFormat = "gemini" | "openai";

export type WorkerLlmConfig = {
  format: WorkerLlmFormat;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
};

/**
 * One "turn" of conversation. The history list lets us send back the
 * model's prior tool calls + the tool results, then ask for the final
 * answer.
 */
export type WorkerLlmTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolName: string; content: string };

export type WorkerLlmRequest = {
  systemPrompt: string;
  /** Conversation so far. For the first call, just `[{role:"user", text:...}]`. */
  history: WorkerLlmTurn[];
  /** Tool defs (omit or pass [] to disable tool calling). */
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
};

export type WorkerLlmResponse =
  | {
      ok: true;
      text: string;
      toolCalls?: ToolCall[];
      inputTokens?: number;
      outputTokens?: number;
      latencyMs?: number;
      model?: string;
    }
  | { ok: false; error: string; latencyMs?: number };

const DEFAULT_TIMEOUT_MS = 30_000;

export class WorkerLlmClient {
  private readonly apiKey?: string;
  constructor(private readonly cfg: WorkerLlmConfig) {
    if (cfg.format !== "gemini" && cfg.format !== "openai") {
      throw new Error(`[worker-llm] format must be gemini|openai, got ${cfg.format}`);
    }
    if (cfg.format === "openai") {
      // Lazy: just throw at call time. Tool support not implemented yet.
    }
    this.apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  }

  async chat(req: WorkerLlmRequest): Promise<WorkerLlmResponse> {
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    try {
      if (this.cfg.format === "gemini") {
        return await this.chatGemini(req, ctrl.signal, start);
      }
      // OpenAI path: single-shot only (tools TODO). When tools are
      // requested on this format we just ignore them so the worker can
      // still answer with text — the model's choice gets logged so the
      // operator can see this branch fired.
      return await this.chatOpenAiSingleShot(req, ctrl.signal, start);
    } catch (e) {
      return { ok: false, error: (e as Error).message, latencyMs: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------- Gemini ----------------------------------*/

  private async chatGemini(
    req: WorkerLlmRequest,
    signal: AbortSignal,
    start: number,
  ): Promise<WorkerLlmResponse> {
    const baseTrimmed = this.cfg.baseUrl.replace(/\/+$/, "");
    const url = `${baseTrimmed}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent`;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: req.history.map(turnToGeminiContent),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens ?? 800,
        temperature: req.temperature ?? 0.4,
      },
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    const resp = await fetch(
      this.apiKey ? `${url}?key=${encodeURIComponent(this.apiKey)}` : url,
      { method: "POST", headers, signal, body: JSON.stringify(body) },
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${resp.status}: ${txt.slice(0, 300)}`,
        latencyMs: Date.now() - start,
      };
    }
    const json = (await resp.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim();
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall?.name)
      .map((p) => ({
        name: p.functionCall!.name!,
        args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }));
    return {
      ok: true,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      inputTokens: json.usageMetadata?.promptTokenCount,
      outputTokens: json.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - start,
      model: this.cfg.model,
    };
  }

  /* ------------------------------- OpenAI ----------------------------------*/

  /**
   * Single-shot OpenAI-compat path. Multi-turn + tool-calling on OpenAI is
   * deferred (separate request shape) — for now, we flatten the history
   * into a single user prompt and forward. Anything that needs tools must
   * be on the gemini transport.
   */
  private async chatOpenAiSingleShot(
    req: WorkerLlmRequest,
    signal: AbortSignal,
    start: number,
  ): Promise<WorkerLlmResponse> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
    const userText = req.history
      .filter((t) => t.role === "user")
      .map((t) => (t.role === "user" ? t.text : ""))
      .join("\n\n");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {headers.authorization = `Bearer ${this.apiKey}`;}
    const resp = await fetch(url, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: userText },
        ],
        max_tokens: req.maxOutputTokens ?? 800,
        temperature: req.temperature ?? 0.4,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 300)}`, latencyMs: Date.now() - start };
    }
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      ok: true,
      text: (json.choices?.[0]?.message?.content ?? "").trim(),
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      latencyMs: Date.now() - start,
      model: this.cfg.model,
    };
  }
}

/**
 * Map our turn shape to Gemini's `contents` entry. The role mapping:
 *   - user   → role:"user"   parts:[{text}]
 *   - assistant text → role:"model" parts:[{text}]
 *   - assistant toolCalls → role:"model" parts:[{functionCall:{...}}]
 *   - tool result → role:"user" parts:[{functionResponse:{name, response:{result}}}]
 *
 * Gemini doesn't have a separate "tool" role — function responses go
 * back as user-role content with a `functionResponse` part. The model
 * recognizes them by structure.
 */
function turnToGeminiContent(turn: WorkerLlmTurn): {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
} {
  if (turn.role === "user") {
    return { role: "user", parts: [{ text: turn.text }] };
  }
  if (turn.role === "assistant") {
    const parts: Array<Record<string, unknown>> = [];
    if (turn.text) {parts.push({ text: turn.text });}
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.args } });
      }
    }
    return { role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] };
  }
  // tool
  // Try to parse the tool content as JSON for the response field; fall
  // back to a string wrapper so Gemini's validator doesn't reject it.
  let parsed: unknown;
  try {
    parsed = JSON.parse(turn.content);
  } catch {
    parsed = { result: turn.content };
  }
  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          name: turn.toolName,
          response: typeof parsed === "object" && parsed !== null ? parsed : { result: parsed },
        },
      },
    ],
  };
}

export function buildWorkerLlmFromConfig(cfg: WorkerLlmConfig): WorkerLlmClient {
  return new WorkerLlmClient(cfg);
}

/* --------- thin helper: single-shot text-only (no tools, no history) ------ */
/**
 * Convenience wrapper for the non-tool path. Lets dispatchWorker keep
 * the single-call shape it had pre-tools without rewriting it.
 */
export async function chatSingle(
  client: WorkerLlmClient,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens?: number,
): Promise<WorkerLlmResponse> {
  return client.chat({
    systemPrompt,
    history: [{ role: "user", text: userPrompt }],
    maxOutputTokens,
  });
}

export function exportToolResultsAsHistory(
  assistantToolCalls: ToolCall[],
  results: ToolResult[],
): WorkerLlmTurn[] {
  return [
    { role: "assistant", toolCalls: assistantToolCalls },
    ...results.map<WorkerLlmTurn>((r) => ({
      role: "tool",
      toolName: r.name,
      content: r.content,
    })),
  ];
}
