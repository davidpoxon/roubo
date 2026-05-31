import { jiraFetch, type JiraRequestContext } from "./jira-client.js";
import { mapWithConcurrency } from "./concurrency.js";

// Cap on concurrent board-configuration lookups. Each board resolves its
// backing filter via a separate HTTP call; an instance with many boards would
// otherwise burst one request per board at once.
const BOARD_RESOLVE_CONCURRENCY = 5;

/**
 * Build the `categorized-multi-list` payload Roubo's source picker
 * renders. Three categories (Boards, Epics, Filters), each one fetched
 * independently. We surface partial results: a 4xx on one endpoint
 * leaves that category empty rather than failing the whole call.
 */

export interface SourceCandidateItem {
  externalId: string;
  label: string;
  sublabel?: string;
  icon?: "board" | "epic" | "filter";
}

export interface SourceCandidateCategory {
  id: string;
  label: string;
  items: SourceCandidateItem[];
}

export interface SourceCandidatesResponse {
  shape: "categorized-multi-list";
  categories: SourceCandidateCategory[];
}

interface BoardListResponse {
  values?: Array<{ id?: number | string; name?: string; filter?: { id?: number | string } }>;
}

interface FilterListResponse {
  values?: Array<{ id?: number | string; name?: string; description?: string }>;
}

interface IssueSearchResponse {
  issues?: Array<{
    key?: string;
    fields?: { summary?: string };
  }>;
}

interface BoardConfigResponse {
  filter?: { id?: number | string };
}

export async function listSourceCandidates(
  ctx: JiraRequestContext,
): Promise<SourceCandidatesResponse> {
  const [boards, epics, filters] = await Promise.all([
    fetchBoards(ctx),
    fetchEpics(ctx),
    fetchFilters(ctx),
  ]);

  return {
    shape: "categorized-multi-list",
    categories: [
      { id: "boards", label: "Boards", items: boards },
      { id: "epics", label: "Epics", items: epics },
      { id: "filters", label: "Filters", items: filters },
    ],
  };
}

async function fetchBoards(ctx: JiraRequestContext): Promise<SourceCandidateItem[]> {
  try {
    const data = await jiraFetch<BoardListResponse>(ctx, "/rest/agile/1.0/board");
    const boards = data.values ?? [];

    // Boards select issues via their backing filter; resolve filter ids
    // so `listIssues` can JQL `filter = <id>` without per-source dispatch.
    // Bounded fan-out so a large board list does not burst the instance.
    const resolved: Array<SourceCandidateItem | null> = await mapWithConcurrency(
      boards,
      BOARD_RESOLVE_CONCURRENCY,
      async (board) => {
        const filterId = await resolveBoardFilterId(ctx, board.id);
        if (filterId === null) return null;
        return {
          externalId: String(filterId),
          label: String(board.name ?? `Board ${board.id}`),
          icon: "board",
        };
      },
    );
    return resolved.filter((item): item is SourceCandidateItem => item !== null);
  } catch {
    return [];
  }
}

async function resolveBoardFilterId(
  ctx: JiraRequestContext,
  boardId: number | string | undefined,
): Promise<number | string | null> {
  if (boardId === undefined) return null;
  try {
    const config = await jiraFetch<BoardConfigResponse>(
      ctx,
      `/rest/agile/1.0/board/${boardId}/configuration`,
    );
    return config.filter?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchEpics(ctx: JiraRequestContext): Promise<SourceCandidateItem[]> {
  const raw = await fetchEpicIssues(ctx);
  return raw.map((issue) => ({
    externalId: issue.key,
    label: issue.fields?.summary ?? issue.key,
    sublabel: issue.key,
    icon: "epic" as const,
  }));
}

/**
 * Shared fetcher for unresolved Epics. Used by both the source picker
 * (mapping into category items) and `getFacetOptions("epic")` (mapping
 * into `FilterFacetOption[]`). Returns [] on transport / auth failure.
 */
export async function fetchEpicIssues(
  ctx: JiraRequestContext,
): Promise<Array<{ key: string; fields?: { summary?: string } }>> {
  try {
    const data = await jiraFetch<IssueSearchResponse>(ctx, "/rest/api/2/search", {
      query: {
        jql: "issuetype = Epic AND resolution = Unresolved ORDER BY updated DESC",
        fields: "summary",
        maxResults: 50,
      },
    });
    const issues = data.issues ?? [];
    return issues.filter(
      (issue): issue is { key: string; fields?: { summary?: string } } =>
        typeof issue.key === "string",
    );
  } catch {
    return [];
  }
}

async function fetchFilters(ctx: JiraRequestContext): Promise<SourceCandidateItem[]> {
  try {
    const data = await jiraFetch<FilterListResponse>(ctx, "/rest/api/2/filter/favourite");
    const filters = data.values ?? data ?? [];
    const list = Array.isArray(filters)
      ? filters
      : Array.isArray((filters as FilterListResponse).values)
        ? ((filters as FilterListResponse).values ?? [])
        : [];
    return list
      .filter(
        (filter): filter is { id: number | string; name?: string; description?: string } =>
          filter !== null && typeof filter === "object" && filter.id !== undefined,
      )
      .map((filter) => ({
        externalId: String(filter.id),
        label: String(filter.name ?? `Filter ${filter.id}`),
        sublabel: filter.description ? String(filter.description) : undefined,
        icon: "filter" as const,
      }));
  } catch {
    return [];
  }
}
