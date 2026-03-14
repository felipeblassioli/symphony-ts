/**
 * Tests: Workspace Manager — sanitization + safety invariants (SPEC §9, §17.2)
 */

import { describe, it, expect } from "vitest";
import { sanitizeWorkspaceKey, assertWorkspaceSafety } from "../src/workspace/index.js";

describe("sanitizeWorkspaceKey", () => {
  it("preserves alphanumeric and ._- characters", () => {
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("my.project_1")).toBe("my.project_1");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeWorkspaceKey("AB C/123")).toBe("AB_C_123");
    expect(sanitizeWorkspaceKey("feat:login@v2")).toBe("feat_login_v2");
  });

  it("handles empty string", () => {
    expect(sanitizeWorkspaceKey("")).toBe("");
  });
});

describe("assertWorkspaceSafety", () => {
  it("accepts path inside root", () => {
    expect(() =>
      assertWorkspaceSafety("/tmp/symphony/ABC-1", "/tmp/symphony")
    ).not.toThrow();
  });

  it("throws for path traversal above root", () => {
    expect(() =>
      assertWorkspaceSafety("/tmp/other/ABC-1", "/tmp/symphony")
    ).toThrow(/Safety invariant/);
  });

  it("throws for prefix-only match (no separator)", () => {
    // /tmp/symphony123 should not be accepted when root is /tmp/symphony
    expect(() =>
      assertWorkspaceSafety("/tmp/symphony123", "/tmp/symphony")
    ).toThrow(/Safety invariant/);
  });

  it("accepts path that equals root itself", () => {
    expect(() =>
      assertWorkspaceSafety("/tmp/symphony", "/tmp/symphony")
    ).not.toThrow();
  });
});
