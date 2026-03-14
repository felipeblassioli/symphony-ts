/**
 * Codex App-Server Client (SPEC.md §10)
 *
 * Launches the coding agent as a subprocess over stdio (JSON-RPC-like).
 * Manages the full session lifecycle:
 *   initialize → thread/start → turn/start (loop) → shutdown
 *
 * All events are emitted back to the caller via an async callback.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import type { CodexConfig } from "../config/index.js";
import type { CodexEvent } from "../types/index.js";
import type { Logger } from "../logging/index.js";

const MAX_LINE_BYTES = 10 * 1024 * 1024; // 10 MB (SPEC §10.1)

export interface SessionInfo {
  thread_id: string;
  turn_id: string;
  session_id: string;
  pid: number | null;
}

export interface TurnResult {
  ok: boolean;
  error?: string;
}

export type EventCallback = (event: CodexEvent) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let reqId = 0;
function nextId(): number {
  return ++reqId;
}

function jsonLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

// ---------------------------------------------------------------------------
// CodexSession – one live app-server subprocess
// ---------------------------------------------------------------------------

export class CodexSession {
  private readonly proc: ReturnType<typeof spawn>;
  private readonly rl: readline.Interface;
  private readonly pendingResponses = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  private pid: number | null = null;
  private threadId: string | null = null;

  constructor(
    private readonly workspacePath: string,
    private readonly config: CodexConfig,
    private readonly onEvent: EventCallback,
    private readonly log: Logger
  ) {
    this.proc = spawn("bash", ["-lc", config.command], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.pid = this.proc.pid ?? null;

    this.rl = readline.createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => this.onLine(line));

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().slice(0, 2000);
      this.log.debug({ stderr: text }, "codex: stderr diagnostics");
    });

    this.proc.on("close", (code) => {
      this.closed = true;
      this.log.info({ code }, "codex: process exited");
      // Reject any pending requests
      for (const [, { reject }] of this.pendingResponses) {
        reject(new Error(`Codex process exited with code ${code}`));
      }
      this.pendingResponses.clear();
    });
  }

  // -------------------------------------------------------------------------
  // Line handler
  // -------------------------------------------------------------------------

  private onLine(line: string): void {
    if (line.length > MAX_LINE_BYTES) {
      this.log.warn("codex: line exceeds max size, ignoring");
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emitEvent({
        event: "malformed",
        timestamp: new Date(),
        codex_app_server_pid: this.pid,
        raw: line,
      });
      return;
    }

    // JSON-RPC response (has id + result/error)
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const id = msg.id as number;
      const pending = this.pendingResponses.get(id);
      if (pending) {
        this.pendingResponses.delete(id);
        if ("error" in msg) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification / event
    this.handleNotification(msg);
  }

  // -------------------------------------------------------------------------
  // Notification → CodexEvent mapping (SPEC §10.4)
  // -------------------------------------------------------------------------

  private handleNotification(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    const base = {
      timestamp: new Date(),
      codex_app_server_pid: this.pid,
      raw: msg,
    };

    if (method === "turn/completed") {
      this.emitEvent({ event: "turn_completed", ...base, ...extractUsage(params) });
    } else if (method === "turn/failed") {
      this.emitEvent({ event: "turn_failed", ...base, message: String(params.error ?? "") });
    } else if (method === "turn/cancelled") {
      this.emitEvent({ event: "turn_cancelled", ...base });
    } else if (method === "turn/inputRequired" || method === "item/tool/requestUserInput") {
      this.emitEvent({ event: "turn_input_required", ...base });
    } else if (method === "thread/tokenUsage/updated") {
      // Absolute thread totals — preferred for token accounting (SPEC §13.5)
      this.emitEvent({ event: "other_message", ...base, ...extractThreadTokenUsage(params) });
    } else if (method?.startsWith("item/tool/call")) {
      // Could be an approval request or dynamic tool call
      const toolName = params.name as string | undefined;
      if (toolName === "linear_graphql") {
        // Handled outside this class (orchestrator routes this back)
        this.emitEvent({ event: "other_message", ...base, message: "linear_graphql tool call" });
      } else {
        this.emitEvent({ event: "unsupported_tool_call", ...base, message: toolName });
      }
    } else if (method === "turn/approvalRequired") {
      // Auto-approval: emit event, caller should respond
      this.emitEvent({ event: "approval_auto_approved", ...base });
    } else if (method === "notification" || method === "$/notification") {
      const text = params.message ?? params.text ?? params.content;
      this.emitEvent({
        event: "notification",
        ...base,
        message: typeof text === "string" ? text : JSON.stringify(text ?? ""),
      });
    } else {
      this.emitEvent({ event: "other_message", ...base, message: method });
    }
  }

  private emitEvent(event: CodexEvent): void {
    this.onEvent(event);
  }

  // -------------------------------------------------------------------------
  // RPC request/response
  // -------------------------------------------------------------------------

  private request<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Codex process is closed"));
        return;
      }
      const id = nextId();
      this.pendingResponses.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      const msg = jsonLine({ jsonrpc: "2.0", id, method, params });
      this.proc.stdin!.write(msg);

      // read_timeout_ms for synchronous request
      setTimeout(() => {
        if (this.pendingResponses.has(id)) {
          this.pendingResponses.delete(id);
          reject(new Error(`Request timed out: ${method}`));
        }
      }, this.config.read_timeout_ms);
    });
  }

  private notify(method: string, params: unknown): void {
    const msg = jsonLine({ jsonrpc: "2.0", method, params });
    this.proc.stdin!.write(msg);
  }

  // -------------------------------------------------------------------------
  // Session startup handshake (SPEC §10.2)
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.request<unknown>("initialize", {
      clientInfo: { name: "symphony", version: "1.0" },
      capabilities: {},
    });
    this.notify("initialized", {});
  }

  async startThread(): Promise<string> {
    const result = await this.request<{ thread: { id: string } }>(
      "thread/start",
      {
        approvalPolicy: this.config.approval_policy ?? "never",
        sandbox: this.config.thread_sandbox ?? "workspace-write",
        cwd: this.workspacePath,
      }
    );
    this.threadId = result.thread.id;
    return this.threadId;
  }

  async startTurn(
    threadId: string,
    prompt: string,
    issueTitle: string
  ): Promise<string> {
    const result = await this.request<{ turn: { id: string } }>(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: this.workspacePath,
        title: issueTitle,
        approvalPolicy: this.config.approval_policy ?? "never",
        sandboxPolicy: this.config.turn_sandbox_policy ?? { type: "workspace-write" },
      }
    );
    return result.turn.id;
  }

  /** Send an auto-approval response (SPEC §10.5) */
  respondApproval(approvalId: string, approved: boolean): void {
    const msg = jsonLine({
      id: approvalId,
      result: { approved },
    });
    this.proc.stdin!.write(msg);
  }

  /** Respond to unsupported tool call with failure (SPEC §10.5) */
  respondUnsupportedTool(toolCallId: string): void {
    const msg = jsonLine({
      id: toolCallId,
      result: { success: false, error: "unsupported_tool_call" },
    });
    this.proc.stdin!.write(msg);
  }

  /** Respond to linear_graphql tool call */
  respondToolResult(
    toolCallId: string,
    result: { success: boolean; data?: unknown; errors?: unknown }
  ): void {
    const msg = jsonLine({ id: toolCallId, result });
    this.proc.stdin!.write(msg);
  }

  /**
   * Wait for the current turn to complete (or timeout).
   * Returns a TurnResult with ok/error.
   *
   * SPEC §10.3 — completion conditions:
   *   turn/completed | turn/failed | turn/cancelled | turn_timeout | process exit
   */
  async awaitTurnCompletion(signal: AbortSignal): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      const cleanup = () => {
        this.rl.removeListener("line", onLine);
      };

      const onLine = (line: string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }

        const method = msg.method as string | undefined;
        if (method === "turn/completed") {
          cleanup();
          resolve({ ok: true });
        } else if (method === "turn/failed" || method === "turn/cancelled") {
          cleanup();
          resolve({ ok: false, error: method });
        } else if (method === "turn/inputRequired" || method === "item/tool/requestUserInput") {
          // Hard failure on user input requirement (SPEC §10.5)
          cleanup();
          this.stop();
          resolve({ ok: false, error: "turn_input_required" });
        }
      };

      this.rl.on("line", onLine);

      // turn_timeout_ms
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ ok: false, error: "turn_timeout" });
      }, this.config.turn_timeout_ms);

      // Abort signal
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        cleanup();
        resolve({ ok: false, error: "cancelled_by_reconciliation" });
      });

      // Process exit
      this.proc.once("close", () => {
        clearTimeout(timeout);
        cleanup();
        if (!signal.aborted) {
          resolve({ ok: false, error: "process_exit" });
        }
      });
    });
  }

  /** Gracefully stop the app-server process */
  stop(): void {
    if (!this.closed) {
      try {
        this.proc.stdin!.end();
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  get processId(): number | null {
    return this.pid;
  }

  get isAlive(): boolean {
    return !this.closed;
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }
}

// ---------------------------------------------------------------------------
// Token extraction helpers (SPEC §13.5)
// ---------------------------------------------------------------------------

function extractUsage(params: Record<string, unknown>): Partial<CodexEvent> {
  const usage = params.usage as Record<string, unknown> | undefined;
  if (!usage) return {};
  return {
    usage: {
      input_tokens: toNum(usage.inputTokens ?? usage.input_tokens),
      output_tokens: toNum(usage.outputTokens ?? usage.output_tokens),
      total_tokens: toNum(usage.totalTokens ?? usage.total_tokens),
    },
  };
}

function extractThreadTokenUsage(params: Record<string, unknown>): Partial<CodexEvent> {
  // Prefer absolute thread totals from thread/tokenUsage/updated
  const tu = params.totalTokenUsage ?? params.total_token_usage ?? params.usage;
  if (!tu || typeof tu !== "object") return {};
  const t = tu as Record<string, unknown>;
  return {
    usage: {
      input_tokens: toNum(t.inputTokens ?? t.input_tokens),
      output_tokens: toNum(t.outputTokens ?? t.output_tokens),
      total_tokens: toNum(t.totalTokens ?? t.total_tokens),
    },
  };
}

function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  return undefined;
}
