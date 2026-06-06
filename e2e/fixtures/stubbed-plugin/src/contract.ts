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
  SourceCandidateItem,
  SourceCandidatesResponse,
  SourceOptionsResult,
  ValidateConfigResult,
} from "@roubo/plugin-sdk";
import type { Clock } from "./clock.js";
import type { Journal } from "./journal.js";
import type { Scenario } from "./scenario.js";

interface BuildContractDeps {
  scenario: Scenario;
  clock: Clock;
  journal: Journal;
}

function projectIssue(issue: NormalizedIssue, journal: Journal): NormalizedIssue {
  const { added, removed } = journal.assigneesFor(issue.externalId);
  const transition = journal.transitionFor(issue.externalId);

  const assignees = [
    ...issue.assignees.filter((a) => !removed.includes(a.externalId)),
    ...added
      .filter((id) => !issue.assignees.some((a) => a.externalId === id))
      .map((id) => ({ externalId: id, displayName: id })),
  ].sort((a, b) => a.externalId.localeCompare(b.externalId));

  return {
    ...issue,
    assignees,
    currentState: transition ?? issue.currentState,
  };
}

function findIssue(scenario: Scenario, externalId: string): NormalizedIssue {
  const issue = scenario.issues.find((i) => i.externalId === externalId);
  if (!issue) {
    throw new Error(`Unknown externalId "${externalId}" in scenario "${scenario.pluginId}".`);
  }
  return issue;
}

export function buildContract({ scenario, clock, journal }: BuildContractDeps): PluginContract {
  const listSourceCandidates = (): SourceCandidatesResponse => scenario.sourceCandidates;

  // WU-069: TC-180 needs listIssues to surface a 401 warning on the first
  // pull, then return Dependabot alert rows on the next. Mirror the
  // connection-status sequence walk below (clamp at the final entry) so a
  // single scenario can model that transition without restarting the stub.
  const listIssuesSeq = scenario.listIssuesSequence;
  let listIssuesIndex = 0;
  const listIssues = (_params: ListIssuesParams): ListIssuesResult => {
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
    return {
      items: scenario.issues.map((issue) => projectIssue(issue, journal)),
      nextCursor: null,
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
  // SourceCandidateItem. A single page is enough for these scenarios, so
  // `nextCursor` is always null (pagination is exercised by TC-022/TC-034).
  const SCOPED_CATEGORIES = new Set(["board", "filter", "epic"]);
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
    const items: SourceCandidateItem[] = matched.map((opt) => ({
      externalId: opt.externalId,
      label: opt.label,
      ...(opt.sublabel !== undefined ? { sublabel: opt.sublabel } : {}),
      ...(opt.icon !== undefined ? { icon: opt.icon } : {}),
    }));
    return { items, nextCursor: null };
  };

  const filterFacets = (): FilterFacet[] => scenario.facets;

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

  return contract;
}
