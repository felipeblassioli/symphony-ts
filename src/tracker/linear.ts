/**
 * Linear Issue Tracker Client (SPEC.md §11)
 *
 * Implements the three required tracker adapter operations:
 *   1. fetchCandidateIssues()
 *   2. fetchIssuesByStates(state_names)
 *   3. fetchIssueStatesByIds(issue_ids)
 *
 * All payloads are normalized to the Issue domain model (SPEC §4.1.1).
 */

import { fetch } from "undici";
import type { Issue, BlockerRef } from "../types/index.js";
import type { TrackerConfig } from "../config/index.js";
import type { Logger } from "../logging/index.js";

const PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type TrackerErrorKind =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor";

export class TrackerError extends Error {
  constructor(
    public readonly kind: TrackerErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "TrackerError";
  }
}

// ---------------------------------------------------------------------------
// GraphQL fragments and queries
// ---------------------------------------------------------------------------

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  relations(filter: { type: { eq: "blocks" } }) {
    nodes {
      relatedIssue {
        id
        identifier
        state { name }
      }
    }
  }
`;

const CANDIDATE_ISSUES_QUERY = `
  query CandidateIssues($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: ${PAGE_SIZE}
      after: $after
    ) {
      nodes {
        ${ISSUE_FRAGMENT}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUES_BY_STATES_QUERY = `
  query IssuesByStates($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: ${PAGE_SIZE}
      after: $after
    ) {
      nodes {
        id
        identifier
        state { name }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }) {
      nodes {
        id
        identifier
        priority
        state { name }
        createdAt
        labels { nodes { name } }
        relations(filter: { type: { eq: "blocks" } }) {
          nodes {
            relatedIssue {
              id
              identifier
              state { name }
            }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

interface RawIssueNode {
  id: string;
  identifier: string;
  title?: string;
  description?: string | null;
  priority?: number | null;
  branchName?: string | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  state?: { name: string } | null;
  labels?: { nodes: Array<{ name: string }> };
  relations?: {
    nodes: Array<{
      relatedIssue: { id: string; identifier: string; state?: { name: string } | null } | null;
    }>;
  };
}

function normalizeIssue(node: RawIssueNode): Issue {
  const blockers: BlockerRef[] = (node.relations?.nodes ?? [])
    .map((rel) => rel.relatedIssue)
    .filter((ri): ri is NonNullable<typeof ri> => ri !== null)
    .map((ri) => ({
      id: ri.id ?? null,
      identifier: ri.identifier ?? null,
      state: ri.state?.name ?? null,
    }));

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? "",
    description: node.description ?? null,
    priority:
      typeof node.priority === "number" && !isNaN(node.priority)
        ? node.priority
        : null,
    state: node.state?.name ?? "",
    branch_name: node.branchName ?? null,
    url: node.url ?? null,
    labels: (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase()),
    blocked_by: blockers,
    created_at: node.createdAt ? new Date(node.createdAt) : null,
    updated_at: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

// ---------------------------------------------------------------------------
// LinearClient
// ---------------------------------------------------------------------------

export class LinearClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string;

  constructor(config: TrackerConfig, private readonly log: Logger) {
    if (config.kind !== "linear") {
      throw new TrackerError(
        "unsupported_tracker_kind",
        `Unsupported tracker kind: ${config.kind}`
      );
    }
    if (!config.api_key) {
      throw new TrackerError(
        "missing_tracker_api_key",
        "tracker.api_key is missing or empty"
      );
    }
    if (!config.project_slug) {
      throw new TrackerError(
        "missing_tracker_project_slug",
        "tracker.project_slug is required for Linear"
      );
    }

    this.endpoint = config.endpoint;
    this.apiKey = config.api_key;
    this.projectSlug = config.project_slug;
  }

  /** Execute a single GraphQL request (SPEC §11.2) */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TrackerError(
        "linear_api_request",
        `Linear API request failed: ${String(err)}`,
        err
      );
    }

    if (!response.ok) {
      throw new TrackerError(
        "linear_api_status",
        `Linear API returned HTTP ${response.status}`
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new TrackerError(
        "linear_unknown_payload",
        `Failed to parse Linear JSON response: ${String(err)}`,
        err
      );
    }

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("data" in body)
    ) {
      throw new TrackerError(
        "linear_unknown_payload",
        "Linear response does not have a 'data' field"
      );
    }

    if ("errors" in body && Array.isArray((body as Record<string,unknown>).errors)) {
      throw new TrackerError(
        "linear_graphql_errors",
        `Linear GraphQL errors: ${JSON.stringify((body as Record<string,unknown>).errors)}`
      );
    }

    return (body as { data: T }).data;
  }

  // -------------------------------------------------------------------------
  // 1. fetchCandidateIssues()
  // -------------------------------------------------------------------------

  /**
   * Fetch all issues in active states for the configured project.
   * Handles pagination (SPEC §11.2).
   */
  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const all: Issue[] = [];
    let cursor: string | null = null;

    for (;;) {
      const data = await this.graphql<{
        issues: {
          nodes: RawIssueNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(CANDIDATE_ISSUES_QUERY, {
        projectSlug: this.projectSlug,
        states: activeStates,
        after: cursor,
      });

      const nodes: RawIssueNode[] = data.issues.nodes;
      const pageInfo: { hasNextPage: boolean; endCursor: string | null } = data.issues.pageInfo;
      for (const node of nodes) {
        all.push(normalizeIssue(node));
      }

      if (!pageInfo.hasNextPage) break;

      if (!pageInfo.endCursor) {
        throw new TrackerError(
          "linear_missing_end_cursor",
          "Linear returned hasNextPage=true but no endCursor"
        );
      }
      cursor = pageInfo.endCursor;
    }

    this.log.debug(
      { count: all.length },
      "linear: fetchCandidateIssues completed"
    );
    return all;
  }

  // -------------------------------------------------------------------------
  // 2. fetchIssuesByStates()  — startup terminal cleanup
  // -------------------------------------------------------------------------

  async fetchIssuesByStates(
    stateNames: string[]
  ): Promise<Array<{ id: string; identifier: string; state: string }>> {
    if (stateNames.length === 0) return [];

    const all: Array<{ id: string; identifier: string; state: string }> = [];
    let cursor: string | null = null;

    for (;;) {
      const data = await this.graphql<{
        issues: {
          nodes: Array<{ id: string; identifier: string; state: { name: string } | null }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(ISSUES_BY_STATES_QUERY, {
        projectSlug: this.projectSlug,
        states: stateNames,
        after: cursor,
      });

      const byStateNodes: Array<{ id: string; identifier: string; state: { name: string } | null }> = data.issues.nodes;
      const byStatePageInfo: { hasNextPage: boolean; endCursor: string | null } = data.issues.pageInfo;
      for (const n of byStateNodes) {
        all.push({ id: n.id, identifier: n.identifier, state: n.state?.name ?? "" });
      }

      if (!byStatePageInfo.hasNextPage) break;
      if (!byStatePageInfo.endCursor) {
        throw new TrackerError(
          "linear_missing_end_cursor",
          "Linear returned hasNextPage=true but no endCursor in fetchIssuesByStates"
        );
      }
      cursor = byStatePageInfo.endCursor;
    }

    return all;
  }

  // -------------------------------------------------------------------------
  // 3. fetchIssueStatesByIds()  — reconciliation
  // -------------------------------------------------------------------------

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];

    const data = await this.graphql<{
      issues: { nodes: RawIssueNode[] };
    }>(ISSUE_STATES_BY_IDS_QUERY, { ids: issueIds });

    return data.issues.nodes.map(normalizeIssue);
  }

  // -------------------------------------------------------------------------
  // Optional linear_graphql tool (SPEC §10.5)
  // -------------------------------------------------------------------------

  /**
   * Execute a raw GraphQL operation on behalf of the coding agent.
   * Used for the optional `linear_graphql` client-side tool extension.
   */
  async executeRawGraphQL(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ success: boolean; data?: unknown; errors?: unknown }> {
    if (!query || typeof query !== "string") {
      return { success: false, errors: { message: "query must be a non-empty string" } };
    }

    // Reject multiple operations
    const opCount = (query.match(/\b(query|mutation|subscription)\b/gi) ?? []).length;
    if (opCount > 1) {
      return { success: false, errors: { message: "query must contain exactly one GraphQL operation" } };
    }

    try {
      const data = await this.graphql<unknown>(query, variables ?? {});
      return { success: true, data };
    } catch (err) {
      if (err instanceof TrackerError && err.kind === "linear_graphql_errors") {
        return { success: false, errors: err.message };
      }
      return { success: false, errors: String(err) };
    }
  }
}
