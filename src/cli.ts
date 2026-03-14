#!/usr/bin/env node
/**
 * Symphony CLI entrypoint
 *
 * Usage:
 *   symphony [--workflow <path>] [--port <n>]
 *
 * SPEC §13.7 — CLI --port enables the optional HTTP server.
 */

import { Orchestrator } from "./orchestrator/index.js";
import { SymphonyHttpServer } from "./server/index.js";
import { logger } from "./logging/index.js";

// ---------------------------------------------------------------------------
// Parse minimal CLI args (no external dep)
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): { workflow?: string; port?: number } {
  const result: { workflow?: string; port?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--workflow" || args[i] === "-w") && args[i + 1]) {
      result.workflow = args[++i];
    } else if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (!isNaN(n)) result.port = n;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: symphony [--workflow <path>] [--port <n>]

Options:
  --workflow, -w  Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --port, -p      Enable HTTP server on this port (0 = ephemeral)
  --help, -h      Show this help message
`);
      process.exit(0);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { workflow, port } = parseArgs(process.argv.slice(2));

  const orchestrator = new Orchestrator({ workflowPath: workflow, serverPort: port });

  // Graceful shutdown
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.info({ signal }, "symphony: shutting down gracefully");
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: String(err) }, "symphony: uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: String(reason) }, "symphony: unhandled rejection");
  });

  // Start orchestrator
  await orchestrator.start();

  // Start HTTP server if port is configured (SPEC §13.7)
  const serverPort = orchestrator.serverConfig.port;
  if (serverPort !== null) {
    const httpServer = new SymphonyHttpServer(orchestrator);
    await httpServer.listen(serverPort);
  }
}

main().catch((err) => {
  logger.fatal({ error: String(err) }, "symphony: fatal startup error");
  process.exit(1);
});
