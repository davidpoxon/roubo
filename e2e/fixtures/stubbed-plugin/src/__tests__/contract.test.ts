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
