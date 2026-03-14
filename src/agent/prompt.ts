/**
 * Prompt Construction (SPEC.md §12)
 *
 * Renders the workflow prompt template with issue context using LiquidJS.
 * Strict mode: unknown variables and filters fail rendering.
 */

import { Liquid } from "liquidjs";
import type { Issue } from "../types/index.js";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export type PromptErrorKind = "template_parse_error" | "template_render_error";

export class PromptError extends Error {
  constructor(
    public readonly kind: PromptErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PromptError";
  }
}

const CONTINUATION_GUIDANCE = `
You are continuing work on this ticket. The workspace already contains prior progress.
Resume from the current state instead of restarting from scratch.
Do not repeat already-completed investigation or validation unless needed for new changes.
`;

/**
 * Render the prompt template for a given issue and attempt.
 * Returns the final prompt string to send to the agent.
 *
 * SPEC §12 — first turn: full rendered template.
 * Continuation turns: send only continuation guidance.
 */
export async function renderPrompt(
  promptTemplate: string,
  issue: Issue,
  attempt: number | null,
  turnNumber: number
): Promise<string> {
  // Continuation turns (same worker, turn > 1) send only guidance (SPEC §7.1)
  if (turnNumber > 1) {
    return CONTINUATION_GUIDANCE.trim();
  }

  // First turn: render full template
  if (!promptTemplate || promptTemplate.trim() === "") {
    return "You are working on an issue from Linear.";
  }

  // Build template variables (SPEC §5.4)
  const vars: Record<string, unknown> = {
    issue: issueToTemplateVars(issue),
    attempt: attempt ?? null,
  };

  let template;
  try {
    template = engine.parse(promptTemplate);
  } catch (err) {
    throw new PromptError(
      "template_parse_error",
      `Failed to parse prompt template: ${String(err)}`,
      err
    );
  }

  try {
    return await engine.render(template, vars);
  } catch (err) {
    throw new PromptError(
      "template_render_error",
      `Failed to render prompt template: ${String(err)}`,
      err
    );
  }
}

/** Convert Issue to string-keyed template variables */
function issueToTemplateVars(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name ?? "",
    url: issue.url ?? "",
    labels: issue.labels,
    blocked_by: issue.blocked_by.map((b) => ({
      id: b.id ?? "",
      identifier: b.identifier ?? "",
      state: b.state ?? "",
    })),
    created_at: issue.created_at?.toISOString() ?? "",
    updated_at: issue.updated_at?.toISOString() ?? "",
  };
}
