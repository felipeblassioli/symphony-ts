# First-Run Observability Gaps

This note captures operator pain points observed during the first real Symphony smoke run by comparing current runtime surfaces (logs + HTTP state/debug endpoints + dashboard) against the operational intent in `SPEC.md`.

## What was reviewed

- Structured lifecycle logging in orchestrator/runner flows.
- Dashboard output at `/`.
- Runtime state shape from `/api/v1/state` and `/api/v1/<issue_identifier>`.
- SPEC observability expectations (sections 13.3, 13.5, 13.7).

## Gaps and follow-up fixes

| Area | Gap observed | Why it hurts operators | Proposed follow-up fix |
|---|---|---|---|
| Dashboard (`/`) | Running table does not show retry attempt, elapsed age, or stalled indicator; `last_message` is hard-truncated with no expansion. | Hard to distinguish healthy long runs vs stalled ones at a glance. | Add columns for `attempt`, `age_seconds`, `stalled` and provide full-message hover/expand in UI. |
| Per-issue debug (`/api/v1/<id>`) | `recent_events` is always empty; `logs` object is omitted; `tracked` is always `{}`. | The endpoint exists but lacks the high-value breadcrumbs needed for rapid incident triage. | Persist bounded in-memory event ring buffer per issue and expose it in `recent_events`; include codex log file metadata under `logs`; populate `tracked` with counters (dispatches, retries, terminal transitions). |
| Retry visibility | Retry rows only expose `attempt`, `due_at`, `error` and not computed wait duration or backoff class. | Manual mental math required during incidents to understand retry pressure and queue health. | Add `retry_in_seconds` and `backoff_ms` fields to snapshot + dashboard. |
| Session identity in logs | Some error/warn paths log `issue_id` and `issue_identifier` but omit `session_id` even when known in running entry state. | Correlating tracker/orchestrator events with Codex session logs is slower than necessary. | Thread `session_id` into retry, stall-timeout, and abnormal-exit logs whenever available. |
| Startup/reload observability | Workflow reload and startup cleanup logs are mostly success/fail strings without timing or affected-item counts (except terminal cleanup final count). | Hard to know whether regressions are due to configuration churn or slow external dependencies. | Add duration metrics and per-phase counters for startup cleanup, workflow reload, and candidate polling. |
| State transition breadcrumbs | Reconciliation logs describe outcomes, but there is no explicit previous→next issue-state transition log row. | Triage requires reconstructing transitions from sparse events and tracker snapshots. | Emit a dedicated `state_transition` structured log with `from_state`, `to_state`, `source` (poll/reconcile/retry), and timestamps. |

## Suggested implementation order

1. **API correctness first**: enrich `/api/v1/<id>` with `recent_events` and `logs` metadata.
2. **Operator speed second**: add retry timing fields and dashboard stall/age columns.
3. **Correlation quality third**: propagate `session_id` through orchestrator warning/error logs.
4. **Diagnostics depth fourth**: add transition breadcrumbs and startup/reload timing metrics.

## Acceptance criteria for follow-up work

- A single issue page should answer: *what happened recently, what is it waiting on, and where are the raw logs?*
- Dashboard should allow identifying stuck retries/runs in under 30 seconds.
- For any failure log line, operators can pivot to exact Codex session using `session_id`.
