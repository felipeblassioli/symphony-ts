/**
 * Logging (SPEC.md §13.1–13.2)
 *
 * Structured logger wrapping pino. Provides issue/session context helpers.
 */

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;

/** Return a child logger pre-scoped with issue context (SPEC §13.1) */
export function issueLogger(
  base: Logger,
  issue_id: string,
  issue_identifier: string
): Logger {
  return base.child({ issue_id, issue_identifier });
}

/** Return a child logger pre-scoped with session context (SPEC §13.1) */
export function sessionLogger(
  base: Logger,
  issue_id: string,
  issue_identifier: string,
  session_id: string
): Logger {
  return base.child({ issue_id, issue_identifier, session_id });
}
