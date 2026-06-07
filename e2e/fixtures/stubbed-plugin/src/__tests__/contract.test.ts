import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type ContractMethodName, type PluginHandle } from "@roubo/plugin-sdk";
import { createClock } from "../clock.js";
import { buildContract } from "../contract.js";
import { createJournal } from "../journal.js";
import { loadScenario } from "../scenario.js";
import { parseArgs } from "../args.js";

const ALL_METHODS: readonly ContractMethodName[] = [
  "listSourceCandidates",
  "listIssues",
  "getIssue",
  "getComments",
  "getCurrentUser",
  "validateConfig",
  "setActiveConfig",
  "applyTransition",
  "assignIssue",
  "unassignIssue",
  "getAvailableTransitions",
  "listIssueTypes",
  "listLabels",
  "getConnectionStatus",
  "probeAlertCategories",
  "filterFacets",
  "getFacetOptions",
];

const PARAMS_FOR: Record<ContractMethodName, Record<string, unknown> | undefined> = {
  listSourceCandidates: undefined,
  listIssues: { sources: [], cursor: null, pageSize: 10 },
  getIssue: { externalId: "acme/widgets#1" },
  getComments: { externalId: "acme/widgets#1" },
  getCurrentUser: undefined,
  validateConfig: { config: { sources: [] } },
  setActiveConfig: { config: {} },
  applyTransition: { externalId: "acme/widgets#1", transition: "Close" },
  assignIssue: { externalId: "acme/widgets#1", assigneeExternalId: "bob" },
  unassignIssue: { externalId: "acme/widgets#1", assigneeExternalId: "alice" },
  getAvailableTransitions: { externalId: "acme/widgets#1" },
  listIssueTypes: { sources: [] },
  listLabels: { sources: [] },
  getConnectionStatus: undefined,
  probeAlertCategories: { sources: [], enabledCategories: ["dependabot"] },
  filterFacets: undefined,
  getFacetOptions: { facetId: "assignee", sources: [] },
};

function startStub(): { host: MessageConnection; dispose: () => void; handle: PluginHandle } {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();
  const host = createMessageConnection(
    new StreamMessageReader(pluginToHost),
    new StreamMessageWriter(hostToPlugin),
  );
  host.listen();

  const scenario = loadScenario("default");
  const clock = createClock(new Date("2026-01-01T00:00:00.000Z"));
  const journal = createJournal();
  const handle = definePlugin(buildContract({ scenario, clock, journal }), {
    streams: { input: hostToPlugin, output: pluginToHost },
  });

  return {
    host,
    handle,
    dispose: () => {
      try {
        handle.dispose();
      } catch {
        /* ignore */
      }
      try {
        host.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

let toDispose: Array<() => void> = [];
afterEach(() => {
  for (const d of toDispose) d();
  toDispose = [];
});

describe("stubbed plugin contract coverage", () => {
  it("registers every method in PluginContract (no MethodNotFound)", async () => {
    const { host, dispose } = startStub();
    toDispose.push(dispose);

    for (const method of ALL_METHODS) {
      const params = PARAMS_FOR[method];
      // Throws if the stub returns -32601 MethodNotFound for this method.
      await host.sendRequest(method, params);
    }
  });

  it("loads scenarios/default.json without throwing", () => {
    const scenario = loadScenario("default");
    expect(scenario.pluginId).toBe("e2e-stub");
    expect(scenario.issues.length).toBeGreaterThan(0);
  });
});

describe("connectionStatusSequence", () => {
  it("advances through the sequence on successive calls and clamps at the last entry", () => {
    const baseScenario = loadScenario("status-auth-problem-flip");
    const clock = createClock(new Date("2026-05-22T09:00:00.000Z"));
    const journal = createJournal();
    const contract = buildContract({ scenario: baseScenario, clock, journal });

    const first = contract.getConnectionStatus(undefined as never);
    expect(first.state).toBe("connected");
    expect(first.detail).toBe("auth-problem-flip stub");

    const second = contract.getConnectionStatus(undefined as never);
    expect(second.state).toBe("auth-problem");
    expect(second.detail).toBe("Token expired");

    // Clamp behaviour: every subsequent call sees the final entry.
    const third = contract.getConnectionStatus(undefined as never);
    expect(third.state).toBe("auth-problem");
  });

  it("falls back to the static connectionStatus when no sequence is set", () => {
    const scenario = loadScenario("default");
    const clock = createClock(new Date("2026-05-22T09:00:00.000Z"));
    const journal = createJournal();
    const contract = buildContract({ scenario, clock, journal });

    const first = contract.getConnectionStatus(undefined as never);
    const second = contract.getConnectionStatus(undefined as never);
    expect(first.state).toBe(scenario.connectionStatus.state);
    expect(second.state).toBe(scenario.connectionStatus.state);
  });
});

describe("getSourceOptions (WU-007, TC-019..TC-029)", () => {
  function buildPickerContract() {
    const scenario = loadScenario("jira-sources-scale-picker");
    const clock = createClock(new Date("2026-05-21T13:00:00.000Z"));
    const journal = createJournal();
    const contract = buildContract({ scenario, clock, journal });
    const getSourceOptions = contract.getSourceOptions;
    if (typeof getSourceOptions !== "function") {
      throw new Error("stub did not register getSourceOptions");
    }
    return getSourceOptions;
  }

  it("returns project options whole and strips the internal project marker", () => {
    const getSourceOptions = buildPickerContract();
    const page = getSourceOptions({ category: "project" });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.externalId)).toEqual(["PLAT", "PAY"]);
    // The internal `project` key never leaks to the host-facing item.
    expect(page.items.every((i) => !("project" in i))).toBe(true);
  });

  it("returns an empty page for a scoped category with no project in scope", () => {
    const getSourceOptions = buildPickerContract();
    expect(getSourceOptions({ category: "board" }).items).toEqual([]);
    expect(getSourceOptions({ category: "board", scope: { project: [] } }).items).toEqual([]);
  });

  it("confines scoped categories to scope.project and narrows by search", () => {
    const getSourceOptions = buildPickerContract();
    const inScope = getSourceOptions({ category: "board", scope: { project: ["PLAT"] } });
    expect(inScope.items.map((i) => i.externalId)).toEqual(["482"]);

    // A project not present in the scenario yields nothing.
    const otherScope = getSourceOptions({ category: "board", scope: { project: ["PAY"] } });
    expect(otherScope.items).toEqual([]);

    // Both near-identical filters match the shared fragment (TC-029).
    const both = getSourceOptions({
      category: "filter",
      scope: { project: ["PLAT"] },
      search: "team open bugs",
    });
    expect(both.items.map((i) => i.externalId)).toEqual(["10231", "10999"]);
  });
});

describe("getSourceOptions pagination (WU-008, TC-022)", () => {
  function buildSearchContract() {
    const scenario = loadScenario("jira-sources-scale-search");
    const clock = createClock(new Date("2026-05-21T13:00:00.000Z"));
    const journal = createJournal();
    const contract = buildContract({ scenario, clock, journal });
    const getSourceOptions = contract.getSourceOptions;
    if (typeof getSourceOptions !== "function") {
      throw new Error("stub did not register getSourceOptions");
    }
    return getSourceOptions;
  }

  const SCOPE = { project: ["PLAT"] } as const;

  it("caps the first page and advances the cursor when more results remain", () => {
    const getSourceOptions = buildSearchContract();
    const first = getSourceOptions({ category: "board", scope: { project: [...SCOPE.project] } });
    // The scenario scopes 15 boards to PLAT; the first page is capped at 10.
    expect(first.items).toHaveLength(10);
    expect(first.items[0].externalId).toBe("601");
    expect(first.nextCursor).toBe("10");
  });

  it("returns the remainder and a null cursor when the set is exhausted", () => {
    const getSourceOptions = buildSearchContract();
    const second = getSourceOptions({
      category: "board",
      scope: { project: [...SCOPE.project] },
      cursor: "10",
    });
    expect(second.items.map((i) => i.externalId)).toEqual(["611", "612", "613", "614", "615"]);
    expect(second.nextCursor).toBeNull();
  });

  it("treats a missing or malformed cursor as the first page", () => {
    const getSourceOptions = buildSearchContract();
    const noCursor = getSourceOptions({
      category: "board",
      scope: { project: [...SCOPE.project] },
    });
    const badCursor = getSourceOptions({
      category: "board",
      scope: { project: [...SCOPE.project] },
      cursor: "not-a-number",
    });
    expect(badCursor.items.map((i) => i.externalId)).toEqual(
      noCursor.items.map((i) => i.externalId),
    );
    expect(badCursor.nextCursor).toBe("10");
  });

  it("keeps nextCursor null for a result set that fits in one page", () => {
    const getSourceOptions = buildSearchContract();
    // Two projects fit well under the page cap, so paging never engages.
    const projects = getSourceOptions({ category: "project" });
    expect(projects.items.map((i) => i.externalId)).toEqual(["PLAT", "PAY"]);
    expect(projects.nextCursor).toBeNull();
  });
});

describe("probeAlertCategoriesSequence (TC-167)", () => {
  const PROBE_PARAMS = { sources: [], enabledCategories: ["dependabot"] as const };

  it("advances through the sequence on successive calls and clamps at the last entry", () => {
    const scenario = loadScenario("alerts-test-connection-scope-missing");
    const clock = createClock(new Date("2026-05-27T10:00:00.000Z"));
    const journal = createJournal();
    const contract = buildContract({ scenario, clock, journal });
    const probe = contract.probeAlertCategories;
    if (typeof probe !== "function") throw new Error("stub did not register probeAlertCategories");

    const first = probe({
      ...PROBE_PARAMS,
      enabledCategories: [...PROBE_PARAMS.enabledCategories],
    });
    if (!("reports" in first)) throw new Error("expected probe result to carry reports");
    expect(first.reports).toHaveLength(1);
    expect(first.reports[0]).toMatchObject({ category: "dependabot", status: "scope-missing" });

    const second = probe({
      ...PROBE_PARAMS,
      enabledCategories: [...PROBE_PARAMS.enabledCategories],
    });
    if (!("reports" in second)) throw new Error("expected probe result to carry reports");
    expect(second.reports[0]).toMatchObject({ category: "dependabot", status: "ok" });

    const third = probe({
      ...PROBE_PARAMS,
      enabledCategories: [...PROBE_PARAMS.enabledCategories],
    });
    if (!("reports" in third)) throw new Error("expected probe result to carry reports");
    expect(third.reports[0]).toMatchObject({ category: "dependabot", status: "ok" });
  });

  it("returns an empty reports array when no sequence is declared", () => {
    const scenario = loadScenario("default");
    const clock = createClock(new Date("2026-05-27T10:00:00.000Z"));
    const journal = createJournal();
    const contract = buildContract({ scenario, clock, journal });
    const probe = contract.probeAlertCategories;
    if (typeof probe !== "function") throw new Error("stub did not register probeAlertCategories");

    const result = probe({
      ...PROBE_PARAMS,
      enabledCategories: [...PROBE_PARAMS.enabledCategories],
    });
    if (!("reports" in result)) throw new Error("expected probe result to carry reports");
    expect(result.reports).toEqual([]);
  });
});

describe("listIssues status exclusion (WU-009, TC-024/TC-025)", () => {
  function buildCutListContract() {
    const scenario = loadScenario("jira-sources-scale-cut-list");
    const clock = createClock(new Date("2026-05-21T13:00:00.000Z"));
    const journal = createJournal();
    return buildContract({ scenario, clock, journal });
  }

  const BASE = { sources: [], cursor: null, pageSize: 50 } as const;

  it("drops issues in the excluded status categories and reports the count", () => {
    const contract = buildCutListContract();
    const result = contract.listIssues({ ...BASE, excludedStatusCategories: ["Done"] });
    // To Do / In Progress survive; the three Done-category issues are dropped.
    expect(result.items.map((i) => i.externalId)).toEqual(["acme/widgets#101", "acme/widgets#102"]);
    expect(result.excludedCount).toBe(3);
  });

  it("excludes by category, not status name (a Done-category 'Closed' is dropped)", () => {
    const contract = buildCutListContract();
    const result = contract.listIssues({ ...BASE, excludedStatusCategories: ["Done"] });
    const kept = result.items.map((i) => i.externalId);
    // #104 is named "Closed" and #105 "Resolved", but both are Done-category.
    expect(kept).not.toContain("acme/widgets#104");
    expect(kept).not.toContain("acme/widgets#105");
  });

  it("supports the status-name fallback set", () => {
    const contract = buildCutListContract();
    const result = contract.listIssues({ ...BASE, excludedStatuses: ["In Progress"] });
    expect(result.items.map((i) => i.externalId)).not.toContain("acme/widgets#102");
    expect(result.excludedCount).toBe(1);
  });

  it("returns every issue with a zero count when nothing is excluded", () => {
    const contract = buildCutListContract();
    const result = contract.listIssues({ ...BASE });
    expect(result.items).toHaveLength(5);
    expect(result.excludedCount).toBe(0);
  });

  it("strips the fixture-only statusCategory from returned issues", () => {
    const contract = buildCutListContract();
    const result = contract.listIssues({ ...BASE });
    expect(result.items.every((i) => !("statusCategory" in i))).toBe(true);
  });
});

describe("argv parsing", () => {
  it("defaults to scenario=default and a pinned ISO date when no flags given", () => {
    const { scenario, now } = parseArgs([]);
    expect(scenario).toBe("default");
    expect(now.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("accepts --scenario=<name> and --now=<iso>", () => {
    const { scenario, now } = parseArgs(["--scenario=chip-taxonomy", "--now=2027-06-15T08:00:00Z"]);
    expect(scenario).toBe("chip-taxonomy");
    expect(now.toISOString()).toBe("2027-06-15T08:00:00.000Z");
  });

  it("rejects invalid scenario names", () => {
    expect(() => parseArgs(["--scenario=Bad/Name"])).toThrow(/kebab-case/);
  });

  it("rejects invalid --now ISO strings", () => {
    expect(() => parseArgs(["--now=not-a-date"])).toThrow(/ISO-8601/);
  });
});
