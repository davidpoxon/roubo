import type { ListIssuesParams, ListIssuesResult, NormalizedIssue } from "@roubo/plugin-sdk";
import { getPrimarySource } from "../active-config.js";
import { formatExternalId } from "../external-id.js";
import {
  fetchBlockingRelationships,
  fetchIssuesPage,
  fetchProjectItems,
} from "../github-fetchers.js";
import { projectNodeToNormalizedIssue, rawToNormalizedIssue } from "../normalize.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function decodeRepoCursor(cursor: string | null): number {
  if (!cursor) return 1;
  const n = Number(cursor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function clampPageSize(size: number | undefined): number {
  if (!size || size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

function parseProjectExternalId(externalId: string): { owner: string; projectNumber: number } {
  const hashIdx = externalId.lastIndexOf("#");
  if (hashIdx === -1) {
    throw new Error(
      `[ghe] project externalId "${externalId}" missing "#<number>". Expected "owner/#1".`,
    );
  }
  const owner = externalId.slice(0, hashIdx).replace(/\/$/, "");
  const projectNumber = Number(externalId.slice(hashIdx + 1));
  if (!owner || !Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error(
      `[ghe] project externalId "${externalId}" not in the expected "owner/#<positive-int>" form.`,
    );
  }
  return { owner, projectNumber };
}

async function listFromRepo(
  repoFullName: string,
  params: ListIssuesParams,
): Promise<ListIssuesResult> {
  const pageSize = clampPageSize(params.pageSize);
  const page = decodeRepoCursor(params.cursor);

  const labels = params.filters?.labels?.join(",");
  const search = params.filters?.search;
  const fetchOpts: { page: number; perPage: number; labels?: string; search?: string } = {
    page,
    perPage: pageSize,
  };
  if (labels) fetchOpts.labels = labels;
  if (search) fetchOpts.search = search;

  const result = await fetchIssuesPage(repoFullName, fetchOpts);
  const issueNumbers = result.items.map((i) => i.number);
  const blocking = await fetchBlockingRelationships(repoFullName, issueNumbers);

  const items: NormalizedIssue[] = result.items.map((raw) =>
    rawToNormalizedIssue(raw, {
      blockedBy: (blocking.blockedBy[raw.number] ?? []).map((b) =>
        formatExternalId(repoFullName, b.number),
      ),
      blocks: (blocking.blocks[raw.number] ?? []).map((b) =>
        formatExternalId(repoFullName, b.number),
      ),
    }),
  );

  // Override externalId to fully-qualified form so cross-method calls (getIssue,
  // getComments) can recover the repo context from the ID alone.
  for (const item of items) {
    item.externalId = formatExternalId(repoFullName, Number(item.externalId));
  }

  return {
    items,
    nextCursor: result.hasNextPage ? String(page + 1) : null,
  };
}

async function listFromProject(
  externalId: string,
  params: ListIssuesParams,
): Promise<ListIssuesResult> {
  const pageSize = clampPageSize(params.pageSize);
  const { owner, projectNumber } = parseProjectExternalId(externalId);
  const page = await fetchProjectItems(owner, projectNumber);

  const offset = decodeRepoCursor(params.cursor) - 1;
  const slice = page.nodes.slice(offset * pageSize, (offset + 1) * pageSize);
  const hasMore = (offset + 1) * pageSize < page.nodes.length;

  const items: NormalizedIssue[] = [];
  for (const node of slice) {
    const normalized = projectNodeToNormalizedIssue(node, `${owner}/unknown`);
    if (!normalized) continue;
    const repoFullName = node.content?.repository?.nameWithOwner ?? `${owner}/unknown`;
    normalized.externalId = formatExternalId(repoFullName, Number(normalized.externalId));
    items.push(normalized);
  }

  return {
    items,
    nextCursor: hasMore ? String(offset + 2) : null,
  };
}

export async function listIssues(params: ListIssuesParams): Promise<ListIssuesResult> {
  const source = getPrimarySource();
  if (source.kind === "repo") {
    return listFromRepo(source.externalId, params);
  }
  return listFromProject(source.externalId, params);
}
