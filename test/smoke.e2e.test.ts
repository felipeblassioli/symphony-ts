process.env.NODE_ENV = "production";

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

interface MockLinearServer {
  url: string;
  close: () => Promise<void>;
  getCandidateCalls: () => number;
  getTerminalCalls: () => number;
}

async function startMockLinearServer(): Promise<MockLinearServer> {
  let candidateCalls = 0;
  let terminalCalls = 0;
  const dispatchableIssue = {
    id: "issue-1",
    identifier: "SMOKE-1",
    title: "Dispatchable smoke issue",
    description: "Validate dispatch path",
    priority: 2,
    branchName: "smoke/dispatchable-issue",
    url: "https://linear.app/smoke/issue/SMOKE-1",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    state: { name: "Todo" },
    labels: { nodes: [{ name: "smoke" }] },
    relations: { nodes: [] },
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        query?: string;
      };
      const query = payload.query ?? "";

      // Startup cleanup query.
      if (query.includes("query IssuesByStates")) {
        terminalCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              issues: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          })
        );
        return;
      }

      // Poll + refresh query.
      if (query.includes("query CandidateIssues")) {
        candidateCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              issues: {
                nodes: candidateCalls === 1 ? [dispatchableIssue] : [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          })
        );
        return;
      }

      // Reconcile query for running issue state refresh.
      if (query.includes("query IssueStatesByIds")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { issues: { nodes: [] } } }));
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected query" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock linear server failed to bind");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
    getCandidateCalls: () => candidateCalls,
    getTerminalCalls: () => terminalCalls,
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("smoke e2e", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop();
      if (fn) await fn();
    }
  });

  it("starts orchestrator, serves dashboard API, and handles refresh", async () => {
    const linear = await startMockLinearServer();
    cleanupFns.push(() => linear.close());

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-smoke-"));
    cleanupFns.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: smoke
  endpoint: ${linear.url}
polling:
  interval_ms: 60000
workspace:
  root: ${tmpDir}/workspaces
codex:
  command: true
  read_timeout_ms: 100
---
Work on {{ issue.identifier }}.
`,
      "utf8"
    );

    const { Orchestrator } = await import("../src/orchestrator/index.js");
    const { SymphonyHttpServer } = await import("../src/server/index.js");

    const orchestrator = new Orchestrator({ workflowPath });
    cleanupFns.push(() => orchestrator.stop());

    await orchestrator.start();
    await waitFor(() => linear.getTerminalCalls() >= 1);
    await waitFor(() => linear.getCandidateCalls() >= 1);

    const server = new SymphonyHttpServer(orchestrator);
    cleanupFns.push(() => server.close());
    const { port } = await server.listen(0);

    const workspacePath = path.join(tmpDir, "workspaces", "SMOKE-1");
    await waitFor(async () => {
      try {
        await fs.stat(workspacePath);
        return true;
      } catch {
        return false;
      }
    });

    const stateRes = await fetch(`http://127.0.0.1:${port}/api/v1/state`);
    expect(stateRes.status).toBe(200);
    const stateJson = (await stateRes.json()) as { counts: { running: number; retrying: number } };
    expect(stateJson.counts.running + stateJson.counts.retrying).toBeGreaterThanOrEqual(1);

    const dashboardRes = await fetch(`http://127.0.0.1:${port}/`);
    expect(dashboardRes.status).toBe(200);
    expect(await dashboardRes.text()).toContain("Symphony");

    const refreshRes = await fetch(`http://127.0.0.1:${port}/api/v1/refresh`, { method: "POST" });
    expect(refreshRes.status).toBe(202);

    await waitFor(() => linear.getCandidateCalls() >= 2);
  });
});
