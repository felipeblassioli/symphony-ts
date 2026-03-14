/**
 * Tests: Workflow loader + Config layer (SPEC §5, §6, §17.1)
 */

import { describe, it, expect } from "vitest";
import { parseWorkflowContent, WorkflowError } from "../src/workflow/loader.js";
import { buildConfig, validateDispatchConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Workflow parsing
// ---------------------------------------------------------------------------

describe("parseWorkflowContent", () => {
  it("parses front matter + body", () => {
    const raw = `---
tracker:
  kind: linear
  project_slug: test-slug
---
You are working on {{ issue.identifier }}.
`;
    const wf = parseWorkflowContent(raw);
    expect(wf.config).toMatchObject({ tracker: { kind: "linear", project_slug: "test-slug" } });
    expect(wf.prompt_template).toBe("You are working on {{ issue.identifier }}.");
  });

  it("treats entire file as prompt when no front matter", () => {
    const raw = "You are a coding agent.";
    const wf = parseWorkflowContent(raw);
    expect(wf.config).toEqual({});
    expect(wf.prompt_template).toBe("You are a coding agent.");
  });

  it("returns empty config and trimmed body for empty front matter", () => {
    const raw = `---
---
Some prompt body.
`;
    const wf = parseWorkflowContent(raw);
    expect(wf.config).toEqual({});
    expect(wf.prompt_template).toBe("Some prompt body.");
  });

  it("throws missing_workflow_file equivalent for bad YAML", () => {
    const raw = `---
: [invalid yaml
---
body
`;
    expect(() => parseWorkflowContent(raw)).toThrow(WorkflowError);
  });

  it("throws workflow_front_matter_not_a_map for array front matter", () => {
    const raw = `---
- item1
- item2
---
body
`;
    let threw: WorkflowError | null = null;
    try { parseWorkflowContent(raw); } catch (e) { threw = e as WorkflowError; }
    expect(threw).not.toBeNull();
    expect(threw?.kind).toBe("workflow_front_matter_not_a_map");
  });
});

// ---------------------------------------------------------------------------
// Config layer
// ---------------------------------------------------------------------------

describe("buildConfig", () => {
  it("applies defaults for missing optional fields", () => {
    const wf = parseWorkflowContent("---\ntracker:\n  kind: linear\n---\nbody");
    const cfg = buildConfig(wf);

    expect(cfg.polling.interval_ms).toBe(30000);
    expect(cfg.agent.max_concurrent_agents).toBe(10);
    expect(cfg.agent.max_turns).toBe(20);
    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.codex.turn_timeout_ms).toBe(3600000);
    expect(cfg.hooks.timeout_ms).toBe(60000);
    expect(cfg.tracker.active_states).toEqual(["Todo", "In Progress"]);
  });

  it("resolves $VAR env indirection for api_key", () => {
    process.env._TEST_KEY = "test-linear-key";
    const wf = parseWorkflowContent(`---
tracker:
  kind: linear
  api_key: $_TEST_KEY
---
body`);
    const cfg = buildConfig(wf);
    expect(cfg.tracker.api_key).toBe("test-linear-key");
    delete process.env._TEST_KEY;
  });

  it("returns null api_key when env var is missing", () => {
    delete process.env._NO_SUCH_VAR;
    const wf = parseWorkflowContent(`---
tracker:
  kind: linear
  api_key: $_NO_SUCH_VAR
---
body`);
    const cfg = buildConfig(wf);
    expect(cfg.tracker.api_key).toBeNull();
  });

  it("normalizes max_concurrent_agents_by_state keys to lowercase", () => {
    const wf = parseWorkflowContent(`---
agent:
  max_concurrent_agents_by_state:
    In Progress: 2
    TODO: 1
---
body`);
    const cfg = buildConfig(wf);
    expect(cfg.agent.max_concurrent_agents_by_state["in progress"]).toBe(2);
    expect(cfg.agent.max_concurrent_agents_by_state["todo"]).toBe(1);
  });

  it("ignores non-positive values in max_concurrent_agents_by_state", () => {
    const wf = parseWorkflowContent(`---
agent:
  max_concurrent_agents_by_state:
    Todo: -1
    Review: 0
    Active: 3
---
body`);
    const cfg = buildConfig(wf);
    expect(cfg.agent.max_concurrent_agents_by_state["todo"]).toBeUndefined();
    expect(cfg.agent.max_concurrent_agents_by_state["review"]).toBeUndefined();
    expect(cfg.agent.max_concurrent_agents_by_state["active"]).toBe(3);
  });
});

describe("validateDispatchConfig", () => {
  it("returns ok for valid config", () => {
    const wf = parseWorkflowContent(`---
tracker:
  kind: linear
  api_key: test-key
  project_slug: test-slug
---
body`);
    const cfg = buildConfig(wf);
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(true);
  });

  it("fails if tracker.kind is missing", () => {
    const wf = parseWorkflowContent("---\ntracker:\n  project_slug: test\n---\nbody");
    const cfg = buildConfig(wf);
    cfg.tracker.api_key = "key";
    cfg.tracker.project_slug = "slug";
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("tracker.kind"))).toBe(true);
  });

  it("fails if api_key is null", () => {
    const wf = parseWorkflowContent(`---
tracker:
  kind: linear
  project_slug: test
---
body`);
    const cfg = buildConfig(wf);
    expect(validateDispatchConfig(cfg).ok).toBe(false);
  });

  it("fails if project_slug is missing for linear", () => {
    const wf = parseWorkflowContent(`---
tracker:
  kind: linear
  api_key: test-key
---
body`);
    const cfg = buildConfig(wf);
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("project_slug"))).toBe(true);
  });
});
