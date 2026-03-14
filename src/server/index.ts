/**
 * Optional HTTP Server Extension (SPEC.md §13.7)
 *
 * Provides:
 *  GET  /                         — Human-readable HTML dashboard
 *  GET  /api/v1/state             — JSON runtime snapshot
 *  GET  /api/v1/:issueIdentifier  — Per-issue debug details
 *  POST /api/v1/refresh           — Trigger immediate poll + reconcile
 *
 * Binds to loopback (127.0.0.1) by default (SPEC §13.7).
 * Uses Node's built-in http module — no extra dependencies.
 */

import http from "node:http";
import type { Orchestrator } from "../orchestrator/index.js";
import { logger } from "../logging/index.js";

// ---------------------------------------------------------------------------
// Dashboard HTML (minimal inline template)
// ---------------------------------------------------------------------------

function renderDashboard(snapshot: ReturnType<Orchestrator["getSnapshot"]>): string {
  const running = snapshot.running
    .map(
      (r) => `
    <tr>
      <td>${r.issue_identifier}</td>
      <td>${r.state}</td>
      <td>${r.turn_count}</td>
      <td>${r.last_event ?? ""}</td>
      <td>${r.last_message.slice(0, 80)}</td>
      <td>${r.tokens.total_tokens}</td>
      <td>${r.started_at}</td>
    </tr>`
    )
    .join("");

  const retrying = snapshot.retrying
    .map(
      (r) => `
    <tr>
      <td>${r.issue_identifier}</td>
      <td>${r.attempt}</td>
      <td>${r.due_at}</td>
      <td>${r.error ?? ""}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Symphony Dashboard</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { font-family: monospace; background: #0d0d0d; color: #e0e0e0; margin: 2rem; }
    h1 { color: #7dd3fc; }
    h2 { color: #a3e635; border-bottom: 1px solid #333; padding-bottom: 0.3rem; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th, td { text-align: left; padding: 0.4rem 0.8rem; border: 1px solid #333; }
    th { background: #1a1a1a; color: #7dd3fc; }
    tr:nth-child(even) { background: #111; }
    .totals { display: flex; gap: 2rem; margin-bottom: 2rem; }
    .stat { background: #1a1a1a; border: 1px solid #333; border-radius: 4px; padding: 0.8rem 1.2rem; }
    .stat-label { font-size: 0.75rem; color: #888; text-transform: uppercase; }
    .stat-value { font-size: 1.5rem; color: #a3e635; }
    .footer { color: #555; font-size: 0.75rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>🎵 Symphony</h1>
  <p>Generated: ${snapshot.generated_at} · Auto-refreshes every 10s</p>

  <div class="totals">
    <div class="stat">
      <div class="stat-label">Running</div>
      <div class="stat-value">${snapshot.counts.running}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Retrying</div>
      <div class="stat-value">${snapshot.counts.retrying}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Tokens</div>
      <div class="stat-value">${snapshot.codex_totals.total_tokens.toLocaleString()}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Runtime (s)</div>
      <div class="stat-value">${snapshot.codex_totals.seconds_running.toFixed(1)}</div>
    </div>
  </div>

  <h2>Running Sessions (${snapshot.counts.running})</h2>
  ${snapshot.counts.running === 0 ? "<p>No active sessions.</p>" : `
  <table>
    <thead>
      <tr>
        <th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th>
        <th>Last Message</th><th>Tokens</th><th>Started At</th>
      </tr>
    </thead>
    <tbody>${running}</tbody>
  </table>`}

  <h2>Retry Queue (${snapshot.counts.retrying})</h2>
  ${snapshot.counts.retrying === 0 ? "<p>No pending retries.</p>" : `
  <table>
    <thead>
      <tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr>
    </thead>
    <tbody>${retrying}</tbody>
  </table>`}

  <div class="footer">
    <a href="/api/v1/state" style="color:#7dd3fc">JSON API</a> ·
    <a href="/api/v1/refresh" style="color:#7dd3fc">POST /refresh</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function errorResponse(res: http.ServerResponse, status: number, code: string, message: string): void {
  jsonResponse(res, status, { error: { code, message } });
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

export class SymphonyHttpServer {
  private server: http.Server;

  constructor(private readonly orchestrator: Orchestrator) {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Dashboard
    if (method === "GET" && (url === "/" || url === "")) {
      const snapshot = this.orchestrator.getSnapshot();
      const html = renderDashboard(snapshot);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // GET /api/v1/state
    if (method === "GET" && url === "/api/v1/state") {
      jsonResponse(res, 200, this.orchestrator.getSnapshot());
      return;
    }

    // POST /api/v1/refresh
    if (method === "POST" && url === "/api/v1/refresh") {
      this.orchestrator.triggerImmediateRefresh();
      jsonResponse(res, 202, {
        queued: true,
        coalesced: false,
        requested_at: new Date().toISOString(),
        operations: ["poll", "reconcile"],
      });
      return;
    }

    // GET /api/v1/:identifier
    const issueMatch = url.match(/^\/api\/v1\/([^/]+)$/);
    if (method === "GET" && issueMatch) {
      const identifier = decodeURIComponent(issueMatch[1]);
      const debug = this.orchestrator.getIssueDebug(identifier);
      if (!debug) {
        errorResponse(res, 404, "issue_not_found", `Issue '${identifier}' not found in runtime state`);
      } else {
        jsonResponse(res, 200, debug);
      }
      return;
    }

    // Method not allowed on known routes
    if (
      ["/api/v1/state", "/api/v1/refresh"].includes(url) ||
      url.startsWith("/api/v1/")
    ) {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "method_not_allowed", message: "Method not allowed" } }));
      return;
    }

    // 404
    errorResponse(res, 404, "not_found", `Not found: ${url}`);
  }

  listen(port: number): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        logger.info({ port: actualPort }, "symphony: HTTP server listening");
        resolve({ port: actualPort });
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
