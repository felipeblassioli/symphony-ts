---
tracker:
  kind: linear
  # api_key can be a literal or $VAR_NAME
  api_key: $LINEAR_API_KEY
  project_slug: "your-project-slug"
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony-workspaces

hooks:
  after_create: |
    git clone --depth 1 https://github.com/your-org/your-repo .
  before_run: |
    git fetch origin && git reset --hard origin/main
  timeout_ms: 120000

agent:
  max_concurrent_agents: 5
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

# Optional: enable HTTP dashboard on port 3000
# server:
#   port: 3000
---

You are working on a Linear ticket `{{ issue.identifier }}`.

{% if attempt %}
**Continuation context** (retry attempt #{{ attempt }}):
- Resume from the current workspace state; do not restart from scratch.
- Do not repeat already-completed work unless needed for new changes.
{% endif %}

## Issue Details

- **Identifier**: {{ issue.identifier }}
- **Title**: {{ issue.title }}
- **Status**: {{ issue.state }}
- **Priority**: {{ issue.priority }}
- **Labels**: {{ issue.labels | join: ", " }}
- **URL**: {{ issue.url }}

## Description

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Instructions

1. This is an unattended orchestration session — do not ask for human follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets).
3. Final message must report completed actions and any blockers only.
4. Work only in the provided workspace directory; do not touch any other path.

## Workflow

1. Read the issue description fully before writing any code.
2. Create a branch named `codex/{{ issue.identifier | downcase }}-<short-slug>` from `origin/main`.
3. Implement the required changes with appropriate tests.
4. Ensure tests pass (`npm test` or equivalent).
5. Open a pull request and link it to the Linear issue.
6. Move the issue to `Human Review` once the PR is ready.
