/**
 * Config Layer (SPEC.md §6)
 *
 * Typed getters for all workflow config values.
 * Applies defaults and resolves $VAR_NAME environment variable indirection.
 * Path expansion: ~ and $VAR for path-like fields.
 */

import os from "node:os";
import path from "node:path";
import type { WorkflowDefinition } from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key: string | null;
  project_slug: string | null;
  active_states: string[];
  terminal_states: string[];
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  approval_policy: string | undefined;
  thread_sandbox: string | undefined;
  turn_sandbox_policy: unknown | undefined;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface ServerConfig {
  port: number | null;
}

export interface SymphonyConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  server: ServerConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEnvVar(value: string): string {
  if (value.startsWith("$")) {
    const varName = value.slice(1);
    return process.env[varName] ?? "";
  }
  return value;
}

function resolvePathValue(value: string): string {
  let resolved = value;
  if (resolved.startsWith("$")) {
    const varName = resolved.slice(1);
    // Full path from env
    resolved = process.env[varName] ?? resolved;
  }
  if (resolved.startsWith("~")) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }
  // Bare strings without path separators preserved as-is (relative roots allowed)
  return resolved;
}

function getString(
  obj: Record<string, unknown>,
  key: string,
  defaultValue: string
): string {
  const v = obj[key];
  if (typeof v === "string") return v;
  return defaultValue;
}

function getInt(
  obj: Record<string, unknown>,
  key: string,
  defaultValue: number
): number {
  const v = obj[key];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  return defaultValue;
}

function getStringArray(
  obj: Record<string, unknown>,
  key: string,
  defaultValue: string[]
): string[] {
  const v = obj[key];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  return defaultValue;
}

function getSection(
  config: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const v = config[key];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildConfig(workflow: WorkflowDefinition): SymphonyConfig {
  const cfg = workflow.config;

  const trackerRaw = getSection(cfg, "tracker");
  const pollingRaw = getSection(cfg, "polling");
  const workspaceRaw = getSection(cfg, "workspace");
  const hooksRaw = getSection(cfg, "hooks");
  const agentRaw = getSection(cfg, "agent");
  const codexRaw = getSection(cfg, "codex");
  const serverRaw = getSection(cfg, "server");

  // --- tracker ---
  const trackerKind = getString(trackerRaw, "kind", "");
  const defaultEndpoint =
    trackerKind === "linear" ? "https://api.linear.app/graphql" : "";
  const rawApiKey = getString(trackerRaw, "api_key", "$LINEAR_API_KEY");
  const resolvedApiKey = resolveEnvVar(rawApiKey);

  const tracker: TrackerConfig = {
    kind: trackerKind,
    endpoint: getString(trackerRaw, "endpoint", defaultEndpoint),
    api_key: resolvedApiKey || null,
    project_slug: getString(trackerRaw, "project_slug", "") || null,
    active_states: getStringArray(trackerRaw, "active_states", [
      "Todo",
      "In Progress",
    ]),
    terminal_states: getStringArray(trackerRaw, "terminal_states", [
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]),
  };

  // --- polling ---
  const polling: PollingConfig = {
    interval_ms: getInt(pollingRaw, "interval_ms", 30000),
  };

  // --- workspace ---
  const rawRoot = getString(
    workspaceRaw,
    "root",
    `${os.tmpdir()}/symphony_workspaces`
  );
  const workspace: WorkspaceConfig = {
    root: resolvePathValue(rawRoot),
  };

  // --- hooks ---
  const hooksTimeoutRaw = getInt(hooksRaw, "timeout_ms", 60000);
  const hooksTimeout = hooksTimeoutRaw > 0 ? hooksTimeoutRaw : 60000;
  const hooks: HooksConfig = {
    after_create:
      typeof hooksRaw.after_create === "string"
        ? hooksRaw.after_create
        : null,
    before_run:
      typeof hooksRaw.before_run === "string" ? hooksRaw.before_run : null,
    after_run:
      typeof hooksRaw.after_run === "string" ? hooksRaw.after_run : null,
    before_remove:
      typeof hooksRaw.before_remove === "string"
        ? hooksRaw.before_remove
        : null,
    timeout_ms: hooksTimeout,
  };

  // --- agent ---
  const byStateRaw = agentRaw.max_concurrent_agents_by_state;
  const byState: Record<string, number> = {};
  if (byStateRaw && typeof byStateRaw === "object" && !Array.isArray(byStateRaw)) {
    for (const [k, v] of Object.entries(byStateRaw)) {
      const n =
        typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
      if (Number.isInteger(n) && n > 0) {
        byState[k.toLowerCase()] = n;
      }
    }
  }

  const agent: AgentConfig = {
    max_concurrent_agents: getInt(agentRaw, "max_concurrent_agents", 10),
    max_turns: getInt(agentRaw, "max_turns", 20),
    max_retry_backoff_ms: getInt(agentRaw, "max_retry_backoff_ms", 300000),
    max_concurrent_agents_by_state: byState,
  };

  // --- codex ---
  const codex: CodexConfig = {
    command: getString(codexRaw, "command", "codex app-server"),
    approval_policy:
      typeof codexRaw.approval_policy === "string"
        ? codexRaw.approval_policy
        : undefined,
    thread_sandbox:
      typeof codexRaw.thread_sandbox === "string"
        ? codexRaw.thread_sandbox
        : undefined,
    turn_sandbox_policy:
      codexRaw.turn_sandbox_policy !== undefined
        ? codexRaw.turn_sandbox_policy
        : undefined,
    turn_timeout_ms: getInt(codexRaw, "turn_timeout_ms", 3600000),
    read_timeout_ms: getInt(codexRaw, "read_timeout_ms", 5000),
    stall_timeout_ms: getInt(codexRaw, "stall_timeout_ms", 300000),
  };

  // --- server (extension) ---
  const serverPortRaw = serverRaw.port;
  const serverPort =
    typeof serverPortRaw === "number" && Number.isInteger(serverPortRaw)
      ? serverPortRaw
      : null;
  const server: ServerConfig = {
    port: serverPort,
  };

  return { tracker, polling, workspace, hooks, agent, codex, server };
}

// ---------------------------------------------------------------------------
// Validation (SPEC §6.3)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateDispatchConfig(config: SymphonyConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.tracker.kind) {
    errors.push("tracker.kind is required");
  } else if (config.tracker.kind !== "linear") {
    errors.push(`Unsupported tracker.kind: ${config.tracker.kind}`);
  }

  if (!config.tracker.api_key) {
    errors.push("tracker.api_key is missing or empty after $VAR resolution");
  }

  if (config.tracker.kind === "linear" && !config.tracker.project_slug) {
    errors.push("tracker.project_slug is required for tracker.kind=linear");
  }

  if (!config.codex.command || config.codex.command.trim() === "") {
    errors.push("codex.command must be present and non-empty");
  }

  return { ok: errors.length === 0, errors };
}
