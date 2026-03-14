/**
 * Agent Runner (SPEC.md §10.7, §16.5)
 *
 * Wraps workspace + prompt + Codex app-server client.
 * Runs one worker attempt for one issue, streaming events back via callback.
 *
 * The worker itself handles the multi-turn loop (up to max_turns),
 * re-checking issue state between turns.
 */

import { CodexSession } from "./codex-client.js";
import { renderPrompt } from "./prompt.js";
import type { WorkspaceManager } from "../workspace/index.js";
import type { LinearClient } from "../tracker/linear.js";
import type { AgentConfig, CodexConfig } from "../config/index.js";
import type { CodexEvent, Issue, WorkerOutcome } from "../types/index.js";
import type { WorkflowDefinition } from "../types/index.js";
import type { Logger } from "../logging/index.js";

export interface RunAgentAttemptOptions {
  issue: Issue;
  attempt: number | null;
  workspaceManager: WorkspaceManager;
  trackerClient: LinearClient;
  workflow: WorkflowDefinition;
  agentConfig: AgentConfig;
  codexConfig: CodexConfig;
  terminalStates?: string[];
  activeStates: string[];
  onEvent: (issueId: string, event: CodexEvent) => void;
  signal: AbortSignal;
  log: Logger;
}

/**
 * Run one worker attempt. Returns a WorkerOutcome.
 * This function is designed to be run in a regular async task (not a separate process).
 */
export async function runAgentAttempt(
  opts: RunAgentAttemptOptions
): Promise<WorkerOutcome> {
  const {
    issue,
    attempt,
    workspaceManager,
    trackerClient,
    workflow,
    agentConfig,
    codexConfig,
    activeStates,
    onEvent,
    signal,
    log,
  } = opts;

  const startedAt = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  // 1. Create / reuse workspace
  let workspace;
  try {
    workspace = await workspaceManager.createForIssue(issue.identifier);
  } catch (err) {
    return failOutcome(issue, startedAt, inputTokens, outputTokens, totalTokens, `workspace error: ${String(err)}`);
  }

  if (signal.aborted) {
    return failOutcome(issue, startedAt, inputTokens, outputTokens, totalTokens, "cancelled before before_run");
  }

  // 2. before_run hook
  try {
    await workspaceManager.runBeforeRun(workspace.path);
  } catch (err) {
    await workspaceManager.runAfterRun(workspace.path);
    return failOutcome(issue, startedAt, inputTokens, outputTokens, totalTokens, `before_run hook error: ${String(err)}`);
  }

  // 3. Start Codex app-server session
  const eventCb = (ev: CodexEvent) => {
    // Accumulate token counts from absolute thread totals (SPEC §13.5)
    if (ev.usage) {
      if (ev.usage.input_tokens !== undefined) inputTokens = ev.usage.input_tokens;
      if (ev.usage.output_tokens !== undefined) outputTokens = ev.usage.output_tokens;
      if (ev.usage.total_tokens !== undefined) totalTokens = ev.usage.total_tokens;
    }
    onEvent(issue.id, ev);
  };

  const session = new CodexSession(workspace.path, codexConfig, eventCb, log);

  try {
    // 4. Initialize session
    await session.initialize();
    const threadId = await session.startThread();

    onEvent(issue.id, {
      event: "session_started",
      timestamp: new Date(),
      codex_app_server_pid: session.processId,
      thread_id: threadId,
    });

    const maxTurns = agentConfig.max_turns;
    let currentIssue = issue;

    // 5. Multi-turn loop (SPEC §7.1)
    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
      if (signal.aborted) break;

      // Build prompt
      let prompt: string;
      try {
        prompt = await renderPrompt(
          workflow.prompt_template,
          currentIssue,
          attempt,
          turnNumber
        );
      } catch (err) {
        session.stop();
        await workspaceManager.runAfterRun(workspace.path);
        return failOutcome(issue, startedAt, inputTokens, outputTokens, totalTokens, `prompt error: ${String(err)}`);
      }

      // Start turn
      let turnId: string;
      try {
        turnId = await session.startTurn(
          threadId,
          prompt,
          `${issue.identifier}: ${issue.title}`
        );
        onEvent(issue.id, {
          event: "other_message",
          timestamp: new Date(),
          codex_app_server_pid: session.processId,
          turn_id: turnId,
          message: `turn ${turnNumber} started`,
        });
      } catch (err) {
        session.stop();
        await workspaceManager.runAfterRun(workspace.path);
        return failOutcome(issue, startedAt, inputTokens, outputTokens, totalTokens, `turn start error: ${String(err)}`);
      }

      // Await turn completion
      const turnResult = await session.awaitTurnCompletion(signal);
      if (!turnResult.ok) {
        session.stop();
        await workspaceManager.runAfterRun(workspace.path);
        return failOutcome(issue, startedAt, inputTokens, outputTokens, totalTokens, turnResult.error ?? "turn failed");
      }

      // Re-check issue state after each turn (SPEC §7.1)
      let refreshed: Issue[];
      try {
        refreshed = await trackerClient.fetchIssueStatesByIds([issue.id]);
      } catch {
        // If refresh fails, exit worker cleanly (orchestrator will retry)
        break;
      }

      const latest = refreshed.find((i) => i.id === issue.id);
      if (!latest) break;

      currentIssue = latest;
      const stateNorm = latest.state.toLowerCase();
      const isActive = activeStates.some((s) => s.toLowerCase() === stateNorm);
      if (!isActive) break;

      // If we've hit max turns, stop
      if (turnNumber >= maxTurns) break;
    }

    session.stop();
    await workspaceManager.runAfterRun(workspace.path);

    return {
      issue_id: issue.id,
      reason: "normal",
      runtime_seconds: (Date.now() - startedAt) / 1000,
      tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
    };
  } catch (err) {
    session.stop();
    await workspaceManager.runAfterRun(workspace.path);
    return failOutcome(issue, startedAt, inputTokens, outputTokens, totalTokens, String(err));
  }
}

function failOutcome(
  issue: Issue,
  startedAt: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  error: string
): WorkerOutcome {
  return {
    issue_id: issue.id,
    reason: "abnormal",
    error,
    runtime_seconds: (Date.now() - startedAt) / 1000,
    tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
  };
}
