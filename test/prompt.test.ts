/**
 * Tests: Prompt construction (SPEC §12, §17.1)
 */

import { describe, it, expect } from "vitest";
import { renderPrompt, PromptError } from "../src/agent/prompt.js";
import type { Issue } from "../src/types/index.js";

const baseIssue: Issue = {
  id: "test-id",
  identifier: "TEST-42",
  title: "Fix the bug",
  description: "A nasty bug",
  priority: 1,
  state: "In Progress",
  branch_name: null,
  url: "https://linear.app/test/issue/TEST-42",
  labels: ["bug", "critical"],
  blocked_by: [],
  created_at: new Date("2025-01-01"),
  updated_at: new Date("2025-01-02"),
};

describe("renderPrompt", () => {
  it("renders issue fields into template", async () => {
    const template = "Working on {{ issue.identifier }}: {{ issue.title }}";
    const result = await renderPrompt(template, baseIssue, null, 1);
    expect(result).toBe("Working on TEST-42: Fix the bug");
  });

  it("renders attempt variable as null on first run", async () => {
    const template = "attempt={{ attempt }}";
    const result = await renderPrompt(template, baseIssue, null, 1);
    expect(result).toBe("attempt=");
  });

  it("renders attempt variable on retry", async () => {
    const template = "attempt={{ attempt }}";
    const result = await renderPrompt(template, baseIssue, 2, 1);
    expect(result).toBe("attempt=2");
  });

  it("returns continuation guidance for turn > 1", async () => {
    const template = "Working on {{ issue.identifier }}";
    const result = await renderPrompt(template, baseIssue, null, 2);
    expect(result).toContain("continuing work");
  });

  it("throws template_render_error for unknown variables (strict mode)", async () => {
    const template = "{{ unknown_var }} does not exist";
    await expect(renderPrompt(template, baseIssue, null, 1)).rejects.toThrow(
      PromptError
    );
  });

  it("uses fallback prompt for empty template", async () => {
    const result = await renderPrompt("", baseIssue, null, 1);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("renders issue.labels array", async () => {
    const template = "{% for l in issue.labels %}{{ l }} {% endfor %}";
    const result = await renderPrompt(template, baseIssue, null, 1);
    expect(result.trim()).toBe("bug critical");
  });
});
