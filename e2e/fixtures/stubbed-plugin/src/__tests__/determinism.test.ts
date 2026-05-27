import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "@roubo/plugin-sdk";
import { createClock } from "../clock.js";
import { buildContract } from "../contract.js";
import { createJournal } from "../journal.js";
import { loadScenario } from "../scenario.js";

/**
 * Spin up an in-process JSON-RPC pair around the stub contract — same shape
 * as plugin-sdk's own SDK tests. Returns a `host` connection that drives the
 * stub over the wire, and a `dispose` to tear it all down.
 */
function startStub(scenarioName: string, nowIso: string) {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();

  const hostConnection = createMessageConnection(
    new StreamMessageReader(pluginToHost),
    new StreamMessageWriter(hostToPlugin),
  );
  hostConnection.listen();

  const scenario = loadScenario(scenarioName);
  const clock = createClock(new Date(nowIso));
  const journal = createJournal();

  const handle = definePlugin(buildContract({ scenario, clock, journal }), {
    streams: { input: hostToPlugin, output: pluginToHost },
  });

  return {
    host: hostConnection,
    handle,
    dispose: () => {
      try {
        handle.dispose();
      } catch {
        /* ignore */
      }
      try {
        hostConnection.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

type RpcCall = {
  method: string;
  params?: Record<string, unknown>;
  /** When set, the RPC is a notification-style fire-and-forget (still uses request semantics for ordering). */
  ignoreResult?: boolean;
};

const CANNED_SEQUENCE: RpcCall[] = [
  { method: "validateConfig", params: { config: { sources: [] } } },
  { method: "setActiveConfig", params: { config: { instance: "stub" } } },
  { method: "getCurrentUser" },
  { method: "listSourceCandidates" },
  { method: "listIssueTypes", params: { sources: [] } },
  { method: "listLabels", params: { sources: [] } },
  { method: "filterFacets" },
  {
    method: "getFacetOptions",
    params: { facetId: "assignee", sources: [], search: "ali" },
  },
  { method: "getConnectionStatus" },
  {
    method: "probeAlertCategories",
    params: { sources: [], enabledCategories: ["dependabot"] },
  },
  { method: "listIssues", params: { sources: [], cursor: null, pageSize: 25 } },
  { method: "getIssue", params: { externalId: "acme/widgets#1" } },
  { method: "getComments", params: { externalId: "acme/widgets#1" } },
  { method: "getAvailableTransitions", params: { externalId: "acme/widgets#1" } },
  {
    method: "assignIssue",
    params: { externalId: "acme/widgets#1", assigneeExternalId: "bob" },
  },
  {
    method: "applyTransition",
    params: { externalId: "acme/widgets#1", transition: "In progress" },
  },
  // Re-read after mutations to confirm the journal flushed.
  { method: "getIssue", params: { externalId: "acme/widgets#1" } },
  {
    method: "unassignIssue",
    params: { externalId: "acme/widgets#1", assigneeExternalId: "alice" },
  },
  { method: "getIssue", params: { externalId: "acme/widgets#1" } },
];

async function replay(host: MessageConnection): Promise<string> {
  const transcript: Array<{ method: string; result: unknown }> = [];
  for (const call of CANNED_SEQUENCE) {
    const result = await host.sendRequest<unknown>(call.method, call.params);
    transcript.push({ method: call.method, result: result ?? null });
  }
  return JSON.stringify(transcript);
}

let toDispose: Array<() => void> = [];
afterEach(() => {
  for (const d of toDispose) d();
  toDispose = [];
});

describe("stubbed plugin determinism (TC-176)", () => {
  it("produces byte-identical transcripts across two runs with the same --scenario + --now", async () => {
    const first = startStub("default", "2026-03-15T12:00:00.000Z");
    toDispose.push(first.dispose);
    const transcriptA = await replay(first.host);

    const second = startStub("default", "2026-03-15T12:00:00.000Z");
    toDispose.push(second.dispose);
    const transcriptB = await replay(second.host);

    expect(transcriptB).toBe(transcriptA);
  });

  it("flows --now through getConnectionStatus.checkedAt", async () => {
    const pinned = "2026-07-04T09:30:00.000Z";
    const { host, dispose } = startStub("default", pinned);
    toDispose.push(dispose);

    const status = await host.sendRequest<{ checkedAt: string }>("getConnectionStatus", undefined);
    expect(status.checkedAt).toBe(pinned);
  });

  it("changes the transcript when --now changes (proves --now is wired)", async () => {
    const a = startStub("default", "2026-01-01T00:00:00.000Z");
    toDispose.push(a.dispose);
    const transcriptA = await replay(a.host);

    const b = startStub("default", "2026-02-02T00:00:00.000Z");
    toDispose.push(b.dispose);
    const transcriptB = await replay(b.host);

    expect(transcriptB).not.toBe(transcriptA);
  });
});
