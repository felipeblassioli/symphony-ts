/**
 * Workflow Loader (SPEC.md §5)
 *
 * Reads WORKFLOW.md, parses YAML front matter, returns WorkflowDefinition.
 * Error classes: missing_workflow_file | workflow_parse_error |
 *               workflow_front_matter_not_a_map
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { WorkflowDefinition } from "../types/index.js";

export type WorkflowErrorKind =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

export class WorkflowError extends Error {
  constructor(
    public readonly kind: WorkflowErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

// Matches: ---\n<optional content>\n---\n<optional body>
const FRONT_MATTER_RE = /^---\r?\n((?:[\s\S]*?)(?:\r?\n)?)---(?:\r?\n([\s\S]*))?$/s;

/**
 * Load and parse a WORKFLOW.md file.
 *
 * Path precedence (SPEC §5.1):
 * 1. `explicitPath` if provided
 * 2. `WORKFLOW.md` in the current process working directory
 */
export function loadWorkflow(explicitPath?: string): WorkflowDefinition {
  const filePath = explicitPath
    ? path.resolve(explicitPath)
    : path.resolve(process.cwd(), "WORKFLOW.md");

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new WorkflowError(
      "missing_workflow_file",
      `Could not read workflow file: ${filePath}`,
      err
    );
  }

  return parseWorkflowContent(raw);
}

/**
 * Parse raw WORKFLOW.md text content.
 * Exported so tests and config-reload can reuse without hitting filesystem.
 */
export function parseWorkflowContent(raw: string): WorkflowDefinition {
  if (!raw.startsWith("---")) {
    // No front matter — entire file is prompt body
    return {
      config: {},
      prompt_template: raw.trim(),
    };
  }

  const match = FRONT_MATTER_RE.exec(raw);
  if (!match) {
    throw new WorkflowError(
      "workflow_parse_error",
      "Workflow file starts with '---' but front matter block is malformed (missing closing '---')"
    );
  }

  const [, frontMatterStr, bodyStr = ""] = match;

  let parsed: unknown;
  try {
    parsed = yaml.load(frontMatterStr);
  } catch (err) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Failed to parse YAML front matter: ${String(err)}`,
      err
    );
  }

  if (parsed === null || parsed === undefined) {
    // Empty front matter → treat as empty config
    return {
      config: {},
      prompt_template: bodyStr.trim(),
    };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "WORKFLOW.md front matter must be a YAML map/object"
    );
  }

  return {
    config: parsed as Record<string, unknown>,
    prompt_template: bodyStr.trim(),
  };
}
