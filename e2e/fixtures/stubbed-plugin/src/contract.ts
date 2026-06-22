import type {
  ConnectionStatus,
  CurrentUser,
  FilterFacet,
  FilterFacetOption,
  GetFacetOptionsParams,
  GetSourceOptionsParams,
  IssueTypeOption,
  ListIssueTypesParams,
  ListIssuesParams,
  ListIssuesResult,
  ListLabelsParams,
  NormalizedComment,
  NormalizedIssue,
  PluginContract,
  ProbeAlertCategoriesResult,
  SetActiveConfigResult,
  SortField,
  SourceCandidateItem,
  SourceCandidatesResponse,
  SourceOptionsResult,
  ValidateConfigResult,
} from "@roubo/plugin-sdk";
import type { Clock } from "./clock.js";
import type { Journal } from "./journal.js";
import type { Scenario, ScenarioIssue } from "./scenario.js";

interface BuildContractDeps {
  scenario: Scenario;
  clock: Clock;
  journal: Journal;
}

// TC-032 (#708): the host's hard start-gate refuses a unit while its
// `blockedBy` is non-empty. The real GitHub plugin only ever lists *open*
// blockers (a closed/resolved blocker drops out of the graph), so a blocker
// whose tracker issue has closed no longer gates the dependent. We mirror that
// here: a scenario blocker whose journal transition has moved it into a
// done/closed state is filtered out of the projected `blockedBy`. This lets a
// single scenario model the "WU-040's gate transitions to passed (its tracker
// issue closes), so WU-051 unblocks" journey without restarting the stub.
const DONE_TRANSITION_NAMES = new Set(["closed", "done", "archived", "cancelled"]);

function projectIssue(issue: ScenarioIssue, journal: Journal): NormalizedIssue {
  const { added, removed } = journal.assigneesFor(issue.externalId);
  const transition = journal.transitionFor(issue.externalId);

  const assignees = [
    ...issue.assignees.filter((a) => !removed.includes(a.externalId)),
    ...added
      .filter((id) => !issue.assignees.some((a) => a.externalId === id))
      .map((id) => ({ externalId: id, displayName: id })),
  ].sort((a, b) => a.externalId.localeCompare(b.externalId));

  // Drop any blocker that the journal has since resolved (transitioned into a
  // done/closed state), so the host's start-gate sees an unblocked unit once
  // its upstream gate tracker closes.
  const blockedBy = issue.blockedBy.filter((blockerId) => {
    const blockerTransition = journal.transitionFor(blockerId);
    return !(
      blockerTransition !== undefined && DONE_TRANSITION_NAMES.has(blockerTransition.toLowerCase())
    );
  });

  const projected: ScenarioIssue = {
    ...issue,
    assignees,
    blockedBy,
    currentState: transition ?? issue.currentState,
  };
  // Strip the fixture-only category so the returned issue matches the real
  // NormalizedIssue shape (the production plugin excludes server-side, so the
  // host never sees a status category).
  delete projected.statusCategory;
  return projected;
}

function findIssue(scenario: Scenario, externalId: string): ScenarioIssue {
  const issue = scenario.issues.find((i) => i.externalId === externalId);
  if (!issue) {
    throw new Error(`Unknown externalId "${externalId}" in scenario "${scenario.pluginId}".`);
  }
  return issue;
}

/**
 * Source-side cut-list ordering for the stub (CLI-FR-010, #584). Sorts the kept
 * set by the requested field before pagination so the order is stable across
 * pages and a sort change visibly reorders the list (TC-032 S004). Supported
 * keys: `title` and `updated`. An unrecognised / absent field returns the input
 * order untouched (the natural externalId order the pagination spec relies on).
 */
function sortKept(
  issues: ScenarioIssue[],
  sortBy: string | undefined,
  sortDir: "asc" | "desc" | undefined,
): ScenarioIssue[] {
  if (sortBy !== "title" && sortBy !== "updated") return issues;
  const dir = sortDir === "desc" ? -1 : 1;
  const keyOf = (issue: ScenarioIssue): string =>
    sortBy === "title" ? issue.title : issue.updatedAt;
  // Stable sort over a copy so the caller's array is never mutated.
  return [...issues].sort((a, b) => dir * keyOf(a).localeCompare(keyOf(b)));
}

export function buildContract({ scenario, clock, journal }: BuildContractDeps): PluginContract {
  const listSourceCandidates = (): SourceCandidatesResponse => scenario.sourceCandidates;

  // WU-069: TC-180 needs listIssues to surface a 401 warning on the first
  // pull, then return Dependabot alert rows on the next. Mirror the
  // connection-status sequence walk below (clamp at the final entry) so a
  // single scenario can model that transition without restarting the stub.
  const listIssuesSeq = scenario.listIssuesSequence;
  let listIssuesIndex = 0;
  const listIssues = (params: ListIssuesParams): ListIssuesResult => {
    if (listIssuesSeq && listIssuesSeq.length > 0) {
      const index = Math.min(listIssuesIndex, listIssuesSeq.length - 1);
      listIssuesIndex += 1;
      const step = listIssuesSeq[index];
      return {
        items: step.items.map((issue) => projectIssue(issue, journal)),
        nextCursor: null,
        ...(step.warnings && step.warnings.length > 0 ? { warnings: step.warnings } : {}),
      };
    }
    // TC-024/TC-025 (#358): mirror the real plugin's in-query status exclusion
    // (FR-009/FR-010). The host resolves the effective excluded set from the
    // three-layer merge and passes it in; we drop issues whose fixture
    // `statusCategory` is excluded (or whose `currentState` is in the
    // name-based fallback set) and report how many were filtered out.
    const excludedCategories = new Set(params.excludedStatusCategories ?? []);
    const excludedStatuses = new Set(params.excludedStatuses ?? []);
    const isExcluded = (issue: ScenarioIssue): boolean =>
      (issue.statusCategory !== undefined && excludedCategories.has(issue.statusCategory)) ||
      excludedStatuses.has(issue.currentState);
    const keptUnsorted = scenario.issues.filter((issue) => !isExcluded(issue));
    // CLI-FR-010 (#584): when the scenario declares sort fields and the host
    // passes a `sortBy` matching one, order the kept set source-side BEFORE
    // pagination so the order is stable across pages and the picker visibly
    // reorders the list (TC-032 S004). `title` and `updated` are the supported
    // keys; an unrecognised field falls through to the natural externalId order
    // (the default the existing pagination spec relies on).
    const kept = sortKept(keptUnsorted, params.sortBy, params.sortDir);
    // #569: cursor pagination over the kept set so the cut-list Prev/Next
    // journey (FR-007/FR-008, TC-032) is exercised end to end. The host passes
    // an opaque `cursor` and a `pageSize` (the project's integration pageSize,
    // default 50); we treat the cursor as a numeric offset (same scheme as
    // `getSourceOptions` below) and advance `nextCursor` until the set is
    // exhausted. A malformed or missing cursor is the first page, so a bad
    // token never throws inside the stub. Scenarios that fit in one page (the
    // TC-024/TC-025 exclusion fixtures at the default pageSize) keep
    // `nextCursor: null`, so the existing cut-list specs are unaffected.
    const pageSize =
      Number.isInteger(params.pageSize) && params.pageSize > 0 ? params.pageSize : 50;
    const offset =
      params.cursor != null && Number.isInteger(Number(params.cursor))
        ? Math.max(0, Number(params.cursor))
        : 0;
    const pageItems = kept.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    return {
      items: pageItems.map((issue) => projectIssue(issue, journal)),
      nextCursor: nextOffset < kept.length ? String(nextOffset) : null,
      // The excluded count is a property of the whole query, not a single
      // page, so report it on every page (matching the real plugin, which
      // excludes in-query regardless of which page is requested).
      excludedCount: scenario.issues.length - kept.length,
      ...(scenario.listIssuesWarnings && scenario.listIssuesWarnings.length > 0
        ? { warnings: scenario.listIssuesWarnings }
        : {}),
    };
  };

  const getIssue = (params: { externalId: string }): NormalizedIssue =>
    projectIssue(findIssue(scenario, params.externalId), journal);

  const getComments = (params: { externalId: string }): NormalizedComment[] => {
    findIssue(scenario, params.externalId);
    return scenario.commentsByExternalId[params.externalId] ?? [];
  };

  const getCurrentUser = (): CurrentUser => scenario.currentUser;

  const validateConfig = (params: { config: Record<string, unknown> }): ValidateConfigResult => {
    if (!params.config || typeof params.config !== "object") {
      return { ok: false, errors: [{ message: "config must be an object" }] };
    }
    return { ok: true };
  };

  const setActiveConfig = (_params: {
    config: Record<string, unknown>;
  }): SetActiveConfigResult => ({ ok: true });

  const applyTransition = (params: {
    externalId: string;
    transition?: string;
    transitionName?: string;
  }): void => {
    // The host's bench-view route (`POST /projects/:id/issues/:externalId/
    // transitions`) sends `transitionName`; the SDK type exposes `transition`.
    // Accept both for forward-compatibility, matching the real
    // jira-self-hosted plugin (plugins/jira-self-hosted/src/plugin.ts:265-274).
    const name = params.transition ?? params.transitionName;
    const issue = findIssue(scenario, params.externalId);
    if (typeof name !== "string" || !issue.allowedTransitions.includes(name)) {
      throw new Error(`Transition "${name}" not allowed on "${params.externalId}".`);
    }
    journal.recordTransition(params.externalId, name);
  };

  const getAvailableTransitions = (params: { externalId: string }): string[] =>
    [...findIssue(scenario, params.externalId).allowedTransitions].sort();

  const assignIssue = (params: { externalId: string; assigneeExternalId: string }): void => {
    findIssue(scenario, params.externalId);
    journal.recordAssign(params.externalId, params.assigneeExternalId);
  };

  const unassignIssue = (params: { externalId: string; assigneeExternalId: string }): void => {
    findIssue(scenario, params.externalId);
    journal.recordUnassign(params.externalId, params.assigneeExternalId);
  };

  const listIssueTypes = (_params: ListIssueTypesParams): IssueTypeOption[] =>
    [...scenario.issueTypes].sort((a, b) => a.id.localeCompare(b.id));

  const listLabels = (_params: ListLabelsParams): string[] => [...scenario.labels].sort();

  // WU-064: if the scenario declares a sequence, walk through it on each
  // call (clamping at the final entry) so TC-169 can model a token expiring
  // mid-session. Otherwise fall back to the single static `connectionStatus`.
  const sequence = scenario.connectionStatusSequence;
  let sequenceIndex = 0;
  const getConnectionStatus = (): ConnectionStatus => {
    if (sequence && sequence.length > 0) {
      const index = Math.min(sequenceIndex, sequence.length - 1);
      sequenceIndex += 1;
      return {
        ...sequence[index],
        checkedAt: clock.nowIso(),
      };
    }
    return {
      ...scenario.connectionStatus,
      checkedAt: clock.nowIso(),
    };
  };

  // TC-167: walk `probeAlertCategoriesSequence` on each call (clamp at the
  // last entry) so a single scenario can model the Test-connection strip
  // surfacing scope-missing on the first probe and ok after OAuth re-consent
  // refreshes the token. When no sequence is declared, return an empty
  // `reports` array — the host's `runCategoryProbes` then surfaces a
  // deterministic error row for any enabled category, which is loud enough to
  // catch a scenario that forgot to set the sequence.
  const probeSequence = scenario.probeAlertCategoriesSequence;
  let probeIndex = 0;
  const probeAlertCategories = (): ProbeAlertCategoriesResult => {
    if (probeSequence && probeSequence.length > 0) {
      const index = Math.min(probeIndex, probeSequence.length - 1);
      probeIndex += 1;
      return probeSequence[index];
    }
    return { reports: [] };
  };

  // WU-007 (TC-019..TC-029): the scoped, paginated source-option search behind
  // the searchable project-first picker. Project options are returned whole;
  // board / filter / epic options are confined to `scope.project` (an empty
  // page when no project is in scope, matching the host's project-first gate
  // and the real jira-self-hosted plugin). `search` narrows by label substring.
  // The internal `project` marker is stripped so the host sees only a
  // SourceCandidateItem.
  //
  // WU-008 (TC-022): page the matched set with a `PAGE_SIZE` window so the
  // searchable picker's "Load more" affordance and result-count readout are
  // exercised end-to-end. `cursor` is an opaque integer offset; `nextCursor`
  // advances by `PAGE_SIZE` until the set is exhausted (then null). Result sets
  // that fit in one page (every WU-007 scenario) keep `nextCursor: null`, so the
  // picker-area specs are unaffected.
  const SCOPED_CATEGORIES = new Set(["board", "filter", "epic"]);
  const PAGE_SIZE = 10;
  const getSourceOptions = (params: GetSourceOptionsParams): SourceOptionsResult => {
    const all = scenario.sourceOptions?.[params.category] ?? [];
    const scopeProjects = params.scope?.project ?? [];
    const scoped = !SCOPED_CATEGORIES.has(params.category)
      ? all
      : scopeProjects.length === 0
        ? []
        : all.filter((opt) => opt.project !== undefined && scopeProjects.includes(opt.project));
    const needle = params.search?.toLowerCase();
    const matched = needle
      ? scoped.filter((opt) => opt.label.toLowerCase().includes(needle))
      : scoped;
    // Parse the opaque cursor as a numeric offset; treat a missing or malformed
    // cursor as the first page so a bad token never throws inside the stub.
    const offset =
      params.cursor != null && Number.isInteger(Number(params.cursor))
        ? Math.max(0, Number(params.cursor))
        : 0;
    const page = matched.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    const items: SourceCandidateItem[] = page.map((opt) => ({
      externalId: opt.externalId,
      label: opt.label,
      ...(opt.sublabel !== undefined ? { sublabel: opt.sublabel } : {}),
      ...(opt.icon !== undefined ? { icon: opt.icon } : {}),
    }));
    return { items, nextCursor: nextOffset < matched.length ? String(nextOffset) : null };
  };

  const filterFacets = (): FilterFacet[] => scenario.facets;

  const getSortFields = (): SortField[] => scenario.sortFields ?? [];

  const getFacetOptions = (params: GetFacetOptionsParams): FilterFacetOption[] => {
    const options = scenario.facetOptions[params.facetId] ?? [];
    if (!params.search) return options;
    const needle = params.search.toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
    );
  };

  const contract: PluginContract = {
    listSourceCandidates,
    getSourceOptions,
    listIssues,
    getIssue,
    getComments,
    getCurrentUser,
    validateConfig,
    setActiveConfig,
    applyTransition,
    getAvailableTransitions,
    assignIssue,
    unassignIssue,
    listIssueTypes,
    listLabels,
    getConnectionStatus,
    probeAlertCategories,
  };

  // WU-067 (TC-175): when the scenario sets `omitFilterFacets`, leave both
  // methods off the contract so the host RPC layer rejects with
  // MethodNotFound. `plugin-filter-facets.ts` already maps that to the fixed
  // `COMMON_FACET_FALLBACK` set. Models a plugin built against host-API 1.0.0.
  if (!scenario.omitFilterFacets) {
    contract.filterFacets = filterFacets;
    contract.getFacetOptions = getFacetOptions;
  }

  // CLI-FR-009/CLI-FR-011 (#584): only register `getSortFields` when the
  // scenario declares sort fields. A scenario without them leaves the method
  // off the contract, so the host RPC layer rejects with MethodNotFound and
  // `plugin-sort-fields.ts` maps it to an empty list (no sort picker). Models a
  // plugin built against host-API 1.0.0 / 1.1.0.
  if (scenario.sortFields && scenario.sortFields.length > 0) {
    contract.getSortFields = getSortFields;
  }

  return contract;
}
