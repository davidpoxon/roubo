import type {
  ListIssuesParams,
  ListIssuesResult,
  ListIssuesWarning,
  NormalizedIssue,
} from "@roubo/plugin-sdk";
import { requirePrimarySource, type GheSource } from "../sources.js";
import { formatExternalId } from "../external-id.js";
import {
  fetchBlockingRelationships,
  fetchIssuesPage,
  fetchProjectItems,
} from "../github-fetchers.js";
import { projectNodeToNormalizedIssue, rawToNormalizedIssue } from "../normalize.js";
import { fetchRepoAlerts, type AlertFlags } from "../alerts-runtime.js";

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

function alertFlagsOf(source: GheSource): AlertFlags {
  return {
    includeCodeQLAlerts: source.includeCodeQLAlerts,
    includeSecretScanningAlerts: source.includeSecretScanningAlerts,
    includeDependabotAlerts: source.includeDependabotAlerts,
  };
}

async function listFromRepo(
  repoFullName: string,
  params: ListIssuesParams,
  source: GheSource,
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

  const result_: ListIssuesResult = {
    items,
    nextCursor: result.hasNextPage ? String(page + 1) : null,
  };

  // Alerts are only fetched on page 1; the shared fetchers walk all alert
  // pages internally so subsequent issue pages would surface duplicates.
  if (page === 1) {
    const alertResult = await fetchRepoAlerts(repoFullName, alertFlagsOf(source));
    if (alertResult.items.length > 0) {
      result_.items = [...items, ...alertResult.items];
    }
    if (alertResult.warnings.length > 0) {
      result_.warnings = alertResult.warnings.map((w) => ({
        ...w,
        sourceExternalId: source.externalId,
      }));
    }
  }

  return result_;
}

async function listFromProject(
  externalId: string,
  params: ListIssuesParams,
  source: GheSource,
): Promise<ListIssuesResult> {
  const pageSize = clampPageSize(params.pageSize);
  const { owner, projectNumber } = parseProjectExternalId(externalId);
  const page = await fetchProjectItems(owner, projectNumber);

  const offset = decodeRepoCursor(params.cursor) - 1;
  const pageNumber = offset + 1;
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

  const result_: ListIssuesResult = {
    items,
    nextCursor: hasMore ? String(offset + 2) : null,
  };

  // Alerts fan out across every distinct repo the project surfaces. Only on
  // page 1; see note in listFromRepo. Walk the full `page.nodes`, not just
  // `slice`, so repos that first appear past the page-1 issue slice still
  // get their alerts pulled. Skipping them would silently hide GHAS warnings
  // for whole repos in a project that spans more than `pageSize` items.
  if (pageNumber === 1) {
    const alertFlags = alertFlagsOf(source);
    const reposForAlerts = new Set<string>();
    for (const node of page.nodes) {
      const content = node.content;
      if (!content || !content.number) continue;
      if (content.__typename && content.__typename !== "Issue") continue;
      reposForAlerts.add(content.repository?.nameWithOwner ?? `${owner}/unknown`);
    }
    const perRepo = await Promise.all(
      Array.from(reposForAlerts).map((r) => fetchRepoAlerts(r, alertFlags)),
    );

    const alertItems: NormalizedIssue[] = [];
    // Dedupe warnings by (code, category, cause) across the repos the project
    // spans. N copies of "GHAS not enabled" for one project source is noise.
    // Include `code` in the key so two different codes for the same category
    // (e.g. one repo missing scope, another with GHAS off) do not collapse.
    const seenWarning = new Set<string>();
    const dedupedWarnings: ListIssuesWarning[] = [];
    for (const r of perRepo) {
      for (const w of r.items) alertItems.push(w);
      for (const w of r.warnings) {
        const key = `${w.code ?? "_"}::${w.category}::${w.cause}`;
        if (seenWarning.has(key)) continue;
        seenWarning.add(key);
        dedupedWarnings.push({ ...w, sourceExternalId: source.externalId });
      }
    }
    if (alertItems.length > 0) {
      result_.items = [...items, ...alertItems];
    }
    if (dedupedWarnings.length > 0) {
      result_.warnings = dedupedWarnings;
    }
  }

  return result_;
}

export async function listIssues(params: ListIssuesParams): Promise<ListIssuesResult> {
  const source = requirePrimarySource(params.sources);
  if (source.kind === "repo") {
    return listFromRepo(source.externalId, params, source);
  }
  return listFromProject(source.externalId, params, source);
}
