/**
 * Orchestrator (SPEC.md §7, §8, §16)
 *
 * Owns the poll loop, in-memory runtime state, dispatch, reconciliation,
 * and retry logic. Single-authority state mutator — no concurrent mutations.
 */

import chokidar from "chokidar";
import path from "node:path";
import type { Issue, OrchestratorState, RunningEntry, RetryEntry, CodexEvent } from "../types/index.js";
import type { SymphonyConfig } from "../config/index.js";
import type { WorkflowDefinition } from "../types/index.js";
import { buildConfig, validateDispatchConfig } from "../config/index.js";
import { loadWorkflow, parseWorkflowContent } from "../workflow/loader.js";
import { LinearClient } from "../tracker/linear.js";
import { WorkspaceManager } from "../workspace/index.js";
import { runAgentAttempt } from "../agent/runner.js";
import { logger, issueLogger } from "../logging/index.js";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Backoff formula (SPEC §8.4)
// ---------------------------------------------------------------------------

const CONTINUATION_RETRY_DELAY_MS = 1000;

function computeRetryDelay(attempt: number, maxBackoffMs: number): number {
  const delay = 10000 * Math.pow(2, attempt - 1);
  return Math.min(delay, maxBackoffMs);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  workflowPath?: string;
  /** Override server port (CLI --port) */
  serverPort?: number;
}

export class Orchestrator {
  private state: OrchestratorState;
  private config!: SymphonyConfig;
  private workflow!: WorkflowDefinition;
  private tracker!: LinearClient;
  private workspaceMgr!: WorkspaceManager;
  private watcher?: chokidar.FSWatcher;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly workflowPath: string;
  private readonly cliPort?: number;


  constructor(opts: OrchestratorOptions = {}) {
    this.workflowPath = opts.workflowPath
      ? path.resolve(opts.workflowPath)
      : path.resolve(process.cwd(), "WORKFLOW.md");
    this.cliPort = opts.serverPort;

    this.state = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 10,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
    };
  }

  // -------------------------------------------------------------------------
  // Startup (SPEC §16.1)
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    logger.info("symphony: starting up");

    // Load and validate initial workflow + config
    this.workflow = loadWorkflow(this.workflowPath);
    this.config = buildConfig(this.workflow);

    // Apply CLI port override
    if (this.cliPort !== undefined) {
      this.config.server.port = this.cliPort;
    }

    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      logger.error({ errors: validation.errors }, "symphony: startup validation failed");
      throw new Error(`Config validation failed: ${validation.errors.join("; ")}`);
    }

    this.applyConfigToState();
    this.buildComponents();

    // Watch WORKFLOW.md for changes (SPEC §6.2)
    this.watchWorkflow();

    // Startup terminal workspace cleanup (SPEC §8.6)
    await this.startupTerminalCleanup();

    // Schedule immediate first tick
    this.scheduleTick(0);

    logger.info("symphony: startup complete, polling loop active");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.watcher) await this.watcher.close();

    // Cancel all running workers
    for (const [, entry] of this.state.running) {
      entry.abort.abort();
    }

    // Clear retry timers
    for (const [, retry] of this.state.retry_attempts) {
      clearTimeout(retry.timer_handle);
    }

    logger.info("symphony: stopped");
  }

  // -------------------------------------------------------------------------
  // Component builders
  // -------------------------------------------------------------------------

  private buildComponents(): void {
    this.tracker = new LinearClient(this.config.tracker, logger);
    this.workspaceMgr = new WorkspaceManager(
      this.config.workspace,
      this.config.hooks,
      logger
    );
  }

  private applyConfigToState(): void {
    this.state.poll_interval_ms = this.config.polling.interval_ms;
    this.state.max_concurrent_agents = this.config.agent.max_concurrent_agents;
  }

  // -------------------------------------------------------------------------
  // Workflow watch + hot reload (SPEC §6.2)
  // -------------------------------------------------------------------------

  private watchWorkflow(): void {
    this.watcher = chokidar.watch(this.workflowPath, { ignoreInitial: true });
    this.watcher.on("change", () => {
      logger.info({ path: this.workflowPath }, "symphony: WORKFLOW.md changed, reloading");
      this.reloadWorkflow();
    });
  }

  private reloadWorkflow(): void {
    try {
      const raw = fs.readFileSync(this.workflowPath, "utf8");
      const newWorkflow = parseWorkflowContent(raw);
      const newConfig = buildConfig(newWorkflow);

      this.workflow = newWorkflow;
      this.config = newConfig;

      // Apply CLI port override again after reload
      if (this.cliPort !== undefined) {
        this.config.server.port = this.cliPort;
      }

      this.applyConfigToState();
      // Rebuild tracker/workspace with new config
      this.buildComponents();
      logger.info("symphony: workflow reloaded successfully");
    } catch (err) {
      logger.error(
        { error: String(err) },
        "symphony: workflow reload failed, keeping last known good config"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Poll tick (SPEC §8.1, §16.2)
  // -------------------------------------------------------------------------

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.tickTimer = setTimeout(() => this.onTick(), delayMs);
  }

  private async onTick(): Promise<void> {
    if (this.stopped) return;

    // 1. Reconcile running issues (SPEC §8.5)
    await this.reconcileRunning();

    // 2. Dispatch preflight validation (SPEC §6.3)
    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      logger.warn({ errors: validation.errors }, "symphony: dispatch validation failed, skipping dispatch this tick");
      this.scheduleTick(this.state.poll_interval_ms);
      return;
    }

    // 3. Fetch candidate issues
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues(
        this.config.tracker.active_states
      );
    } catch (err) {
      logger.warn({ error: String(err) }, "symphony: failed to fetch candidates, skipping dispatch");
      this.scheduleTick(this.state.poll_interval_ms);
      return;
    }

    // 4. Sort by priority (SPEC §8.2)
    const sorted = sortForDispatch(candidates);

    // 5. Dispatch eligible issues
    for (const issue of sorted) {
      if (!this.hasAvailableSlots()) break;
      if (this.shouldDispatch(issue)) {
        this.dispatchIssue(issue, null);
      }
    }

    this.scheduleTick(this.state.poll_interval_ms);
  }

  // -------------------------------------------------------------------------
  // Candidate eligibility (SPEC §8.2)
  // -------------------------------------------------------------------------

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

    const stateNorm = issue.state.toLowerCase();
    const isActive = this.config.tracker.active_states.some(
      (s) => s.toLowerCase() === stateNorm
    );
    const isTerminal = this.config.tracker.terminal_states.some(
      (s) => s.toLowerCase() === stateNorm
    );

    if (!isActive || isTerminal) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;

    // Global slot check
    if (!this.hasAvailableSlots()) return false;

    // Per-state slot check
    if (!this.hasPerStateSlot(issue.state)) return false;

    // Blocker rule for Todo (SPEC §8.2)
    if (stateNorm === "todo") {
      const hasNonTerminalBlocker = issue.blocked_by.some((b) => {
        if (!b.state) return false;
        return !this.config.tracker.terminal_states.some(
          (ts) => ts.toLowerCase() === b.state!.toLowerCase()
        );
      });
      if (hasNonTerminalBlocker) return false;
    }

    return true;
  }

  private hasAvailableSlots(): boolean {
    return this.state.running.size < this.state.max_concurrent_agents;
  }

  private hasPerStateSlot(state: string): boolean {
    const stateKey = state.toLowerCase();
    const limit = this.config.agent.max_concurrent_agents_by_state[stateKey];
    if (limit === undefined) return true;

    const count = Array.from(this.state.running.values()).filter(
      (e) => e.issue.state.toLowerCase() === stateKey
    ).length;
    return count < limit;
  }

  // -------------------------------------------------------------------------
  // Dispatch one issue (SPEC §16.4)
  // -------------------------------------------------------------------------

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abort = new AbortController();

    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      session: null,
      codex_app_server_pid: null,
      last_codex_message: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      retry_attempt: attempt,
      started_at: new Date(),
      abort,
    };

    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retry_attempts.delete(issue.id);

    logger.info(
      { issue_id: issue.id, issue_identifier: issue.identifier, attempt },
      "symphony: dispatching issue"
    );

    // Launch worker as async task
    runAgentAttempt({
      issue,
      attempt,
      workspaceManager: this.workspaceMgr,
      trackerClient: this.tracker,
      workflow: this.workflow,
      agentConfig: this.config.agent,
      codexConfig: this.config.codex,
      terminalStates: this.config.tracker.terminal_states, // optional, kept for future use
      activeStates: this.config.tracker.active_states,
      onEvent: (issueId, event) => this.onCodexEvent(issueId, event),
      signal: abort.signal,
      log: issueLogger(logger, issue.id, issue.identifier),
    })
      .then((outcome) => this.onWorkerExit(issue.id, outcome))
      .catch((err) => {
        logger.error(
          { issue_id: issue.id, error: String(err) },
          "symphony: unexpected worker error"
        );
        this.onWorkerExit(issue.id, {
          issue_id: issue.id,
          reason: "abnormal",
          error: String(err),
          runtime_seconds: 0,
          tokens: { input: 0, output: 0, total: 0 },
        });
      });
  }

  // -------------------------------------------------------------------------
  // Codex event handler (SPEC §10.4)
  // -------------------------------------------------------------------------

  private onCodexEvent(issueId: string, event: CodexEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    entry.last_codex_event = event.event;
    entry.last_codex_timestamp = event.timestamp;

    if (event.message) {
      entry.last_codex_message = event.message.slice(0, 500);
    }

    if (event.codex_app_server_pid) {
      entry.codex_app_server_pid = event.codex_app_server_pid;
    }

    // Token accounting — prefer absolute thread totals (SPEC §13.5)
    if (event.event === "other_message" && event.usage) {
      this.updateTokenDeltas(entry, event.usage);
    }

    if (event.event === "turn_completed" && event.usage) {
      this.updateTokenDeltas(entry, event.usage);
    }

    // Session ID from session_started
    if (event.event === "session_started" && event.thread_id) {
      if (!entry.session) {
        entry.session = {
          session_id: event.thread_id + "-0",
          thread_id: event.thread_id,
          turn_id: "0",
          codex_app_server_pid: event.codex_app_server_pid,
          last_codex_event: event.event,
          last_codex_timestamp: event.timestamp,
          last_codex_message: null,
          codex_input_tokens: 0,
          codex_output_tokens: 0,
          codex_total_tokens: 0,
          last_reported_input_tokens: 0,
          last_reported_output_tokens: 0,
          last_reported_total_tokens: 0,
          turn_count: 0,
        };
      }
    }
  }

  private updateTokenDeltas(
    entry: RunningEntry,
    usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  ): void {
    if (usage.input_tokens !== undefined) {
      const delta = usage.input_tokens - entry.last_reported_input_tokens;
      if (delta > 0) {
        entry.codex_input_tokens += delta;
        this.state.codex_totals.input_tokens += delta;
        entry.last_reported_input_tokens = usage.input_tokens;
      }
    }
    if (usage.output_tokens !== undefined) {
      const delta = usage.output_tokens - entry.last_reported_output_tokens;
      if (delta > 0) {
        entry.codex_output_tokens += delta;
        this.state.codex_totals.output_tokens += delta;
        entry.last_reported_output_tokens = usage.output_tokens;
      }
    }
    if (usage.total_tokens !== undefined) {
      const delta = usage.total_tokens - entry.last_reported_total_tokens;
      if (delta > 0) {
        entry.codex_total_tokens += delta;
        this.state.codex_totals.total_tokens += delta;
        entry.last_reported_total_tokens = usage.total_tokens;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Worker exit handler (SPEC §16.6)
  // -------------------------------------------------------------------------

  private onWorkerExit(
    issueId: string,
    outcome: {
      issue_id: string;
      reason: "normal" | "abnormal";
      error?: string;
      runtime_seconds: number;
      tokens: { input: number; output: number; total: number };
    }
  ): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    this.state.running.delete(issueId);
    this.state.codex_totals.seconds_running += outcome.runtime_seconds;

    const nextAttempt = (entry.retry_attempt ?? 0) + 1;

    if (outcome.reason === "normal") {
      this.state.completed.add(issueId);
      logger.info(
        { issue_id: issueId, issue_identifier: entry.identifier },
        "symphony: worker exited normally, scheduling continuation retry"
      );
      // Schedule short continuation retry (SPEC §7.3)
      this.scheduleRetry(issueId, 1, entry.identifier, CONTINUATION_RETRY_DELAY_MS, null);
    } else {
      const delay = computeRetryDelay(
        nextAttempt,
        this.config.agent.max_retry_backoff_ms
      );
      logger.warn(
        { issue_id: issueId, issue_identifier: entry.identifier, error: outcome.error, attempt: nextAttempt },
        "symphony: worker exited abnormally, scheduling retry"
      );
      this.scheduleRetry(issueId, nextAttempt, entry.identifier, delay, outcome.error ?? null);
    }
  }

  // -------------------------------------------------------------------------
  // Retry scheduling (SPEC §8.4)
  // -------------------------------------------------------------------------

  private scheduleRetry(
    issueId: string,
    attempt: number,
    identifier: string,
    delayMs: number,
    error: string | null
  ): void {
    // Cancel existing retry timer
    const existing = this.state.retry_attempts.get(issueId);
    if (existing) {
      clearTimeout(existing.timer_handle);
    }

    const timer = setTimeout(() => this.onRetryTimer(issueId), delayMs);

    const entry: RetryEntry = {
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: Date.now() + delayMs,
      timer_handle: timer,
      error,
    };

    this.state.retry_attempts.set(issueId, entry);
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.state.retry_attempts.get(issueId);
    if (!retryEntry) return;
    this.state.retry_attempts.delete(issueId);

    logger.debug(
      { issue_id: issueId, attempt: retryEntry.attempt },
      "symphony: retry timer fired"
    );

    // Fetch active candidates (SPEC §8.4 retry handling)
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues(
        this.config.tracker.active_states
      );
    } catch (err) {
      logger.warn({ error: String(err) }, "symphony: retry poll failed, requeueing");
      this.scheduleRetry(
        issueId,
        retryEntry.attempt + 1,
        retryEntry.identifier,
        computeRetryDelay(retryEntry.attempt + 1, this.config.agent.max_retry_backoff_ms),
        "retry poll failed"
      );
      return;
    }

    const issue = candidates.find((c) => c.id === issueId);

    if (!issue) {
      // Issue not in active candidates — release claim
      this.state.claimed.delete(issueId);
      logger.info(
        { issue_id: issueId, issue_identifier: retryEntry.identifier },
        "symphony: issue no longer active, releasing claim"
      );
      return;
    }

    const stateNorm = issue.state.toLowerCase();
    const isActive = this.config.tracker.active_states.some(
      (s) => s.toLowerCase() === stateNorm
    );

    if (!isActive) {
      this.state.claimed.delete(issueId);
      return;
    }

    if (!this.hasAvailableSlots()) {
      this.scheduleRetry(
        issueId,
        retryEntry.attempt + 1,
        issue.identifier,
        computeRetryDelay(retryEntry.attempt + 1, this.config.agent.max_retry_backoff_ms),
        "no available orchestrator slots"
      );
      return;
    }

    this.dispatchIssue(issue, retryEntry.attempt);
  }

  // -------------------------------------------------------------------------
  // Reconciliation (SPEC §8.5, §16.3)
  // -------------------------------------------------------------------------

  private async reconcileRunning(): Promise<void> {
    // Part A: stall detection
    if (this.config.codex.stall_timeout_ms > 0) {
      this.reconcileStalls();
    }

    // Part B: tracker state refresh
    if (this.state.running.size === 0) return;

    const runningIds = Array.from(this.state.running.keys());
    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      logger.debug({ error: String(err) }, "symphony: reconciliation state refresh failed, keeping workers");
      return;
    }

    for (const issue of refreshed) {
      if (!this.state.running.has(issue.id)) continue;

      const stateNorm = issue.state.toLowerCase();
      const isTerminal = this.config.tracker.terminal_states.some(
        (s) => s.toLowerCase() === stateNorm
      );
      const isActive = this.config.tracker.active_states.some(
        (s) => s.toLowerCase() === stateNorm
      );

      if (isTerminal) {
        logger.info(
          { issue_id: issue.id, issue_identifier: issue.identifier },
          "symphony: reconciliation — issue terminal, stopping worker and cleaning workspace"
        );
        this.terminateRunningIssue(issue.id, true);
      } else if (isActive) {
        // Update in-memory snapshot
        const entry = this.state.running.get(issue.id);
        if (entry) entry.issue = issue;
      } else {
        logger.info(
          { issue_id: issue.id, issue_identifier: issue.identifier },
          "symphony: reconciliation — issue no longer active, stopping worker (no cleanup)"
        );
        this.terminateRunningIssue(issue.id, false);
      }
    }
  }

  private reconcileStalls(): void {
    const now = Date.now();
    for (const [issueId, entry] of this.state.running) {
      const lastTs = entry.last_codex_timestamp?.getTime() ?? entry.started_at.getTime();
      const elapsedMs = now - lastTs;

      if (elapsedMs > this.config.codex.stall_timeout_ms) {
        logger.warn(
          { issue_id: issueId, issue_identifier: entry.identifier, elapsed_ms: elapsedMs },
          "symphony: stall timeout reached, terminating worker"
        );
        this.terminateRunningIssue(issueId, false);
        // The worker exit will trigger a retry
      }
    }
  }

  private terminateRunningIssue(issueId: string, cleanWorkspace: boolean): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    entry.abort.abort();
    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);

    if (cleanWorkspace) {
      this.workspaceMgr
        .removeWorkspace(entry.identifier)
        .catch((err) =>
          logger.warn({ error: String(err) }, "symphony: workspace removal failed")
        );
    }
  }

  // -------------------------------------------------------------------------
  // Startup terminal workspace cleanup (SPEC §8.6)
  // -------------------------------------------------------------------------

  private async startupTerminalCleanup(): Promise<void> {
    logger.info("symphony: running startup terminal workspace cleanup");
    let terminalIssues: Array<{ id: string; identifier: string; state: string }>;
    try {
      terminalIssues = await this.tracker.fetchIssuesByStates(
        this.config.tracker.terminal_states
      );
    } catch (err) {
      logger.warn({ error: String(err) }, "symphony: startup terminal cleanup fetch failed, continuing");
      return;
    }

    for (const issue of terminalIssues) {
      await this.workspaceMgr.removeWorkspace(issue.identifier).catch((err) =>
        logger.warn(
          { issue_identifier: issue.identifier, error: String(err) },
          "symphony: startup workspace removal failed (ignored)"
        )
      );
    }

    logger.info(
      { count: terminalIssues.length },
      "symphony: startup terminal cleanup complete"
    );
  }

  // -------------------------------------------------------------------------
  // Snapshot (for HTTP server / observability, SPEC §13.3)
  // -------------------------------------------------------------------------

  getSnapshot() {
    const now = new Date();

    const running = Array.from(this.state.running.entries()).map(([issueId, e]) => ({
      issue_id: issueId,
      issue_identifier: e.identifier,
      state: e.issue.state,
      session_id: e.session?.session_id ?? null,
      turn_count: e.session?.turn_count ?? 0,
      last_event: e.last_codex_event,
      last_message: e.last_codex_message ?? "",
      started_at: e.started_at.toISOString(),
      last_event_at: e.last_codex_timestamp?.toISOString() ?? null,
      tokens: {
        input_tokens: e.codex_input_tokens,
        output_tokens: e.codex_output_tokens,
        total_tokens: e.codex_total_tokens,
      },
    }));

    const retrying = Array.from(this.state.retry_attempts.entries()).map(([issueId, r]) => ({
      issue_id: issueId,
      issue_identifier: r.identifier,
      attempt: r.attempt,
      due_at: new Date(r.due_at_ms).toISOString(),
      error: r.error,
    }));

    // Live seconds_running: cumulative + active session time
    let activeSeconds = 0;
    for (const [, e] of this.state.running) {
      activeSeconds += (now.getTime() - e.started_at.getTime()) / 1000;
    }

    return {
      generated_at: now.toISOString(),
      counts: {
        running: running.length,
        retrying: retrying.length,
      },
      running,
      retrying,
      codex_totals: {
        ...this.state.codex_totals,
        seconds_running: this.state.codex_totals.seconds_running + activeSeconds,
      },
      rate_limits: this.state.codex_rate_limits,
    };
  }

  /** Get per-issue debug details (SPEC §13.7.2) */
  getIssueDebug(issueIdentifier: string) {
    const runEntry = Array.from(this.state.running.entries()).find(
      ([, e]) => e.identifier === issueIdentifier
    );
    const retryEntry = Array.from(this.state.retry_attempts.entries()).find(
      ([, r]) => r.identifier === issueIdentifier
    );

    if (!runEntry && !retryEntry) return null;

    const ws = this.workspaceMgr.workspacePath(issueIdentifier);

    if (runEntry) {
      const [issueId, e] = runEntry;
      return {
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: "running",
        workspace: { path: ws },
        attempts: { restart_count: 0, current_retry_attempt: e.retry_attempt ?? 0 },
        running: {
          session_id: e.session?.session_id ?? null,
          turn_count: e.session?.turn_count ?? 0,
          state: e.issue.state,
          started_at: e.started_at.toISOString(),
          last_event: e.last_codex_event,
          last_message: e.last_codex_message ?? "",
          last_event_at: e.last_codex_timestamp?.toISOString() ?? null,
          tokens: {
            input_tokens: e.codex_input_tokens,
            output_tokens: e.codex_output_tokens,
            total_tokens: e.codex_total_tokens,
          },
        },
        retry: null,
        recent_events: [],
        last_error: null,
        tracked: {},
      };
    }

    if (retryEntry) {
      const [issueId, r] = retryEntry;
      return {
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: "retrying",
        workspace: { path: ws },
        attempts: { restart_count: 0, current_retry_attempt: r.attempt },
        running: null,
        retry: {
          attempt: r.attempt,
          due_at: new Date(r.due_at_ms).toISOString(),
          error: r.error,
        },
        recent_events: [],
        last_error: r.error,
        tracked: {},
      };
    }

    return null;
  }

  /** Trigger an immediate poll tick (for /api/v1/refresh) */
  triggerImmediateRefresh(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.scheduleTick(0);
  }

  get serverConfig() {
    return this.config.server;
  }
}

// ---------------------------------------------------------------------------
// Dispatch sorting (SPEC §8.2)
// ---------------------------------------------------------------------------

function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    // 1. Priority ascending (null sorts last)
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;

    // 2. created_at oldest first (null sorts last)
    const ta = a.created_at?.getTime() ?? Infinity;
    const tb = b.created_at?.getTime() ?? Infinity;
    if (ta !== tb) return ta - tb;

    // 3. identifier lexicographic
    return a.identifier.localeCompare(b.identifier);
  });
}
