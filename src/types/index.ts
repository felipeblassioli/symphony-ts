/**
 * Symphony Domain Model
 * Language-agnostic types derived from SPEC.md §4
 */

// ---------------------------------------------------------------------------
// § 4.1.1 Issue
// ---------------------------------------------------------------------------

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  /** Stable tracker-internal ID */
  id: string;
  /** Human-readable ticket key e.g. ABC-123 */
  identifier: string;
  title: string;
  description: string | null;
  /** Lower = higher priority; null sorts last */
  priority: number | null;
  /** Current tracker state name */
  state: string;
  branch_name: string | null;
  url: string | null;
  /** Normalized to lowercase */
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
}

// ---------------------------------------------------------------------------
// § 4.1.2 WorkflowDefinition
// ---------------------------------------------------------------------------

export interface WorkflowDefinition {
  /** YAML front matter root object */
  config: Record<string, unknown>;
  /** Markdown body after front matter, trimmed */
  prompt_template: string;
}

// ---------------------------------------------------------------------------
// § 4.1.4 Workspace
// ---------------------------------------------------------------------------

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

// ---------------------------------------------------------------------------
// § 4.1.5 RunAttempt
// ---------------------------------------------------------------------------

export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  /** null for first run; >=1 for retries */
  attempt: number | null;
  workspace_path: string;
  started_at: Date;
  status: RunAttemptStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// § 4.1.6 LiveSession (Agent Session Metadata)
// ---------------------------------------------------------------------------

export interface LiveSession {
  /** `<thread_id>-<turn_id>` */
  session_id: string;
  thread_id: string;
  turn_id: string;
  codex_app_server_pid: number | null;
  last_codex_event: string | null;
  last_codex_timestamp: Date | null;
  /** Summarized payload */
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  /** Number of coding-agent turns started within the current worker */
  turn_count: number;
}

// ---------------------------------------------------------------------------
// § 4.1.7 RetryEntry
// ---------------------------------------------------------------------------

export interface RetryEntry {
  issue_id: string;
  /** Best-effort human ID */
  identifier: string;
  /** 1-based */
  attempt: number;
  /** Monotonic-equivalent epoch ms */
  due_at_ms: number;
  /** NodeJS timer handle */
  timer_handle: ReturnType<typeof setTimeout>;
  error: string | null;
}

// ---------------------------------------------------------------------------
// § 4.1.8 Orchestrator Runtime State
// ---------------------------------------------------------------------------

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  session: LiveSession | null;
  codex_app_server_pid: number | null;
  last_codex_message: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: Date | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  retry_attempt: number | null;
  started_at: Date;
  /** Worker abort controller for cancellation */
  abort: AbortController;
}

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  /** Bookkeeping only, not dispatch-gating */
  completed: Set<string>;
  codex_totals: CodexTotals;
  codex_rate_limits: unknown | null;
}

// ---------------------------------------------------------------------------
// Codex App-Server Events (§ 10.4)
// ---------------------------------------------------------------------------

export type CodexEventKind =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"
  | "approval_auto_approved"
  | "unsupported_tool_call"
  | "notification"
  | "other_message"
  | "malformed";

export interface CodexEvent {
  event: CodexEventKind;
  timestamp: Date;
  codex_app_server_pid: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  thread_id?: string;
  turn_id?: string;
  message?: string;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Worker outcome message (§ 16.6)
// ---------------------------------------------------------------------------

export type WorkerExitReason = "normal" | "abnormal";

export interface WorkerOutcome {
  issue_id: string;
  reason: WorkerExitReason;
  error?: string;
  runtime_seconds: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
}
