/**
 * Workspace Manager (SPEC.md §9)
 *
 * Per-issue workspace lifecycle:
 *  - create_for_issue (§9.2) with safety invariants (§9.5)
 *  - run_hook (§9.4)
 *  - remove_workspace (cleanup)
 */

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Workspace } from "../types/index.js";
import type { HooksConfig, WorkspaceConfig } from "../config/index.js";
import type { Logger } from "../logging/index.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Workspace key sanitization (§4.2)
// ---------------------------------------------------------------------------

/** Replace any character outside [A-Za-z0-9._-] with underscore */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// Safety invariants (§9.5)
// ---------------------------------------------------------------------------

/**
 * Validates that workspacePath is strictly inside workspaceRoot.
 * Throws if not (prevents path traversal).
 */
export function assertWorkspaceSafety(
  workspacePath: string,
  workspaceRoot: string
): void {
  const normalRoot = path.resolve(workspaceRoot);
  const normalWs = path.resolve(workspacePath);

  // Must start with root + separator to avoid prefix-only match (e.g. /tmp/foo vs /tmp/foobar)
  if (!normalWs.startsWith(normalRoot + path.sep) && normalWs !== normalRoot) {
    throw new Error(
      `Safety invariant violation: workspace path '${normalWs}' is outside root '${normalRoot}'`
    );
  }
}

// ---------------------------------------------------------------------------
// Hook runner (§9.4)
// ---------------------------------------------------------------------------

type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

async function runHook(
  hookScript: string,
  workspacePath: string,
  timeoutMs: number,
  hookName: HookName,
  log: Logger
): Promise<{ ok: boolean; error?: string }> {
  log.info({ hook: hookName, cwd: workspacePath }, `hook: running ${hookName}`);
  try {
    const { stdout, stderr } = await execAsync(`bash -lc ${JSON.stringify(hookScript)}`, {
      cwd: workspacePath,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1 MB
    });
    if (stdout) log.debug({ hook: hookName, output: stdout.slice(0, 2000) }, "hook stdout");
    if (stderr) log.debug({ hook: hookName, output: stderr.slice(0, 2000) }, "hook stderr");
    log.info({ hook: hookName }, `hook: ${hookName} completed`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ hook: hookName, error: msg }, `hook: ${hookName} failed`);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  constructor(
    private readonly wsCfg: WorkspaceConfig,
    private readonly hooksCfg: HooksConfig,
    private readonly log: Logger
  ) {}

  /**
   * Create or reuse the workspace for `issueIdentifier`.
   * Runs `after_create` hook if the directory is newly created.
   *
   * SPEC §9.2
   */
  async createForIssue(issueIdentifier: string): Promise<Workspace> {
    const workspace_key = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.join(this.wsCfg.root, workspace_key);

    // Safety check before any filesystem ops
    assertWorkspaceSafety(workspacePath, this.wsCfg.root);

    // Ensure workspace root exists
    fs.mkdirSync(this.wsCfg.root, { recursive: true });

    let created_now = false;
    const exists = fs.existsSync(workspacePath);

    if (!exists) {
      this.log.info(
        { workspace: workspacePath },
        "workspace: creating new directory"
      );
      fs.mkdirSync(workspacePath, { recursive: true });
      created_now = true;
    } else {
      this.log.info(
        { workspace: workspacePath },
        "workspace: reusing existing directory"
      );
    }

    const workspace: Workspace = {
      path: workspacePath,
      workspace_key,
      created_now,
    };

    if (created_now && this.hooksCfg.after_create) {
      const result = await runHook(
        this.hooksCfg.after_create,
        workspacePath,
        this.hooksCfg.timeout_ms,
        "after_create",
        this.log
      );
      if (!result.ok) {
        // after_create failure is fatal — remove the partial workspace
        try {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        } catch {
          // best effort cleanup
        }
        throw new Error(`after_create hook failed: ${result.error}`);
      }
    }

    return workspace;
  }

  /**
   * Run the `before_run` hook. Failure is fatal to the current attempt.
   */
  async runBeforeRun(workspacePath: string): Promise<void> {
    if (!this.hooksCfg.before_run) return;
    const result = await runHook(
      this.hooksCfg.before_run,
      workspacePath,
      this.hooksCfg.timeout_ms,
      "before_run",
      this.log
    );
    if (!result.ok) {
      throw new Error(`before_run hook failed: ${result.error}`);
    }
  }

  /**
   * Run the `after_run` hook. Failure is logged and ignored.
   */
  async runAfterRun(workspacePath: string): Promise<void> {
    if (!this.hooksCfg.after_run) return;
    await runHook(
      this.hooksCfg.after_run,
      workspacePath,
      this.hooksCfg.timeout_ms,
      "after_run",
      this.log
    );
  }

  /**
   * Remove the workspace for `issueIdentifier`. Runs `before_remove` hook first.
   */
  async removeWorkspace(issueIdentifier: string): Promise<void> {
    const workspace_key = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.join(this.wsCfg.root, workspace_key);

    assertWorkspaceSafety(workspacePath, this.wsCfg.root);

    if (!fs.existsSync(workspacePath)) {
      return;
    }

    if (this.hooksCfg.before_remove) {
      await runHook(
        this.hooksCfg.before_remove,
        workspacePath,
        this.hooksCfg.timeout_ms,
        "before_remove",
        this.log
      );
      // before_remove failures are ignored per spec
    }

    this.log.info({ workspace: workspacePath }, "workspace: removing directory");
    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch (err) {
      this.log.warn(
        { workspace: workspacePath, error: String(err) },
        "workspace: removal failed (ignored)"
      );
    }
  }

  /** Workspace path for the given issue identifier (read-only lookup) */
  workspacePath(issueIdentifier: string): string {
    return path.join(this.wsCfg.root, sanitizeWorkspaceKey(issueIdentifier));
  }
}
