# Symphony (TypeScript)

A TypeScript implementation of [Symphony](https://github.com/openai/symphony) — a long-running automation service that polls Linear for work, creates isolated per-issue workspaces, and runs Codex coding agents to get that work done.

> Implemented against [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) Draft v1.

---

## What is Symphony?

Symphony turns project work into isolated, autonomous implementation runs. Engineers manage work at a high level (Linear tickets) instead of supervising coding agents directly. Symphony:

- Polls Linear on a fixed cadence for active issues
- Creates a per-issue workspace directory
- Runs a Codex `app-server` session for each issue
- Streams agent events back to the orchestrator
- Retries on failure with exponential backoff
- Watches `WORKFLOW.md` for live config changes without restart

---

## Requirements

- Node.js >= 20
- `codex` CLI installed and authenticated (`codex app-server` must work)
- Linear account with an API key and a project slug

---

## Setup

```bash
npm install
npm run build
```

---

## Configuration

All behavior is driven by a single `WORKFLOW.md` file. Copy the example:

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

Edit the YAML front matter:

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY      # or literal token
  project_slug: "your-project-slug"
  active_states: [Todo, In Progress]
  terminal_states: [Done, Closed, Cancelled, Canceled, Duplicate]

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony-workspaces   # per-issue workspaces go here

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
```

The Markdown body after the front matter is the **prompt template** rendered for each issue. Available variables: `{{ issue.identifier }}`, `{{ issue.title }}`, `{{ issue.description }}`, `{{ issue.state }}`, `{{ issue.labels }}`, `{{ attempt }}`.

### Environment Variables

| Variable | Description |
|---|---|
| `LINEAR_API_KEY` | Linear personal API token |
| `LOG_LEVEL` | Pino log level (`debug`, `info`, `warn`, `error`) |

---

## Running

```bash
# Using the built binary
symphony

# With explicit workflow path
symphony --workflow /path/to/WORKFLOW.md

# With HTTP dashboard on port 3000
symphony --port 3000

# Development mode (ts-node)
npm run dev -- --port 3000
```

---

## HTTP Dashboard (Optional)

Enable with `--port <n>` or `server.port` in `WORKFLOW.md` front matter.

Binds to `127.0.0.1` (loopback) by default.

| Endpoint | Description |
|---|---|
| `GET /` | HTML dashboard (auto-refreshes every 10s) |
| `GET /api/v1/state` | JSON runtime snapshot |
| `GET /api/v1/<identifier>` | Per-issue debug details |
| `POST /api/v1/refresh` | Trigger immediate poll + reconcile |

---

## Architecture

```
src/
├── cli.ts               # CLI entrypoint
├── types/               # Domain model (Issue, LiveSession, OrchestratorState…)
├── workflow/            # WORKFLOW.md loader + front matter parser
├── config/              # Typed config layer with defaults + $VAR resolution
├── tracker/             # Linear GraphQL client (pagination, normalization)
├── workspace/           # Per-issue workspace lifecycle + hooks + safety checks
├── agent/
│   ├── codex-client.ts  # Codex app-server stdio client (JSON-RPC)
│   ├── prompt.ts        # LiquidJS template renderer (strict mode)
│   └── runner.ts        # Worker: workspace → prompt → session → multi-turn loop
├── orchestrator/        # Poll loop, dispatch, reconciliation, retries, state
├── server/              # Optional HTTP server (dashboard + /api/v1/*)
└── logging/             # Pino structured logger with issue/session context
```

### Key flows

**Poll tick** (every `polling.interval_ms`):
1. Reconcile running issues (stall detection + tracker state refresh)
2. Validate dispatch config
3. Fetch candidate issues from Linear
4. Sort by priority → created_at → identifier
5. Dispatch eligible issues (concurrency, per-state limits, blocker checks)

**Worker** (per issue):
1. Create/reuse workspace → run `after_create` hook if new
2. Run `before_run` hook
3. Initialize Codex session (`initialize` → `thread/start`)
4. Multi-turn loop: `turn/start` → await completion → re-check issue state
5. Run `after_run` hook
6. Report outcome to orchestrator

**Retry/backoff**:
- Normal exit → 1 s continuation retry
- Failure → `min(10000 * 2^(attempt-1), max_retry_backoff_ms)` ms

---

## Tests

```bash
npm test
```

Tests cover: workflow parsing, config defaults/validation, $VAR resolution, workspace sanitization/safety, and prompt rendering.

---

## Trust and Safety

This implementation targets **trusted environments** (developers running Codex on their own repositories). It uses `approval_policy: never` by default — Codex may execute shell commands and edit files without per-action confirmation.

**Workspace safety invariants (always enforced):**
- Agent `cwd` = per-issue workspace path
- Workspace path must be inside `workspace.root`
- Workspace directory names are sanitized (`[A-Za-z0-9._-]` only)

For stricter environments, set `approval_policy` and `thread_sandbox` in `WORKFLOW.md` to values appropriate for your setup.

---

## License

Apache 2.0 — same as [openai/symphony](https://github.com/openai/symphony).
