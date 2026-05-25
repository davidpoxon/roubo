import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { definePlugin } from "./define-plugin.js";
import { host } from "./host-client.js";
import type { ConnectionStatus, FilterFacet, ListIssuesResult, PluginHandle } from "./types.js";

/**
 * Build a paired in-memory JSON-RPC connection: one half is the SDK
 * under test (driving `definePlugin`), the other half plays the host.
 */
function pairedConnection(): {
  pluginStreams: { input: PassThrough; output: PassThrough };
  hostConnection: MessageConnection;
  dispose: () => void;
} {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();

  const hostReader = new StreamMessageReader(pluginToHost);
  const hostWriter = new StreamMessageWriter(hostToPlugin);
  const hostConnection = createMessageConnection(hostReader, hostWriter);
  hostConnection.listen();

  return {
    pluginStreams: { input: hostToPlugin, output: pluginToHost },
    hostConnection,
    dispose: () => {
      try {
        hostConnection.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

let handles: PluginHandle[] = [];
let disposes: Array<() => void> = [];

afterEach(() => {
  for (const h of handles) {
    try {
      h.dispose();
    } catch {
      /* ignore */
    }
  }
  for (const d of disposes) d();
  handles = [];
  disposes = [];
});

describe("definePlugin (TC-035)", () => {
  it("registers contract methods so the host can call them by name", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      definePlugin(
        {
          async getCurrentUser() {
            return { externalId: "u-1", displayName: "Test User" };
          },
          async listIssues({ cursor, pageSize }) {
            return {
              items: [],
              nextCursor: cursor === null ? `next-${pageSize}` : null,
            };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const user = await hostConnection.sendRequest<{ externalId: string }>(
      "getCurrentUser",
      undefined,
    );
    expect(user).toEqual({ externalId: "u-1", displayName: "Test User" });

    const page = await hostConnection.sendRequest<{ nextCursor: string | null }>("listIssues", {
      cursor: null,
      pageSize: 25,
    });
    expect(page.nextCursor).toBe("next-25");
  });

  it("returns MethodNotFound for contract methods the plugin did not implement", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      definePlugin(
        {
          async getCurrentUser() {
            return { externalId: "u-1", displayName: "u" };
          },
        },
        { streams: pluginStreams },
      ),
    );

    await expect(
      hostConnection.sendRequest("listIssues", { cursor: null, pageSize: 10 }),
    ).rejects.toMatchObject({ code: -32601 });
  });

  it("makes host.credentials.get reachable inside a contract method", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    hostConnection.onRequest("host.credentials.get", (params: { slot: string }) => {
      return params.slot === "api-token" ? "secret-xyz" : null;
    });

    handles.push(
      definePlugin(
        {
          async getCurrentUser() {
            const token = await host.credentials.get("api-token");
            return { externalId: token ?? "anon", displayName: token ? "ok" : "missing" };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const user = await hostConnection.sendRequest<{ externalId: string }>(
      "getCurrentUser",
      undefined,
    );
    expect(user.externalId).toBe("secret-xyz");
  });

  it("routes host.fetch through the SDK to the host with the declared shape", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    let captured: { url: string; init: unknown } | null = null;
    hostConnection.onRequest("host.fetch", (params: { url: string; init: unknown }) => {
      captured = params;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      };
    });

    handles.push(
      definePlugin(
        {
          async validateConfig() {
            const res = await host.fetch("https://api.example.com/ping", {
              method: "GET",
              headers: { authorization: "Bearer t" },
            });
            return { ok: res.status === 200 };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const result = await hostConnection.sendRequest<{ ok: boolean }>("validateConfig", {
      config: {},
    });
    expect(result.ok).toBe(true);
    expect(captured).toEqual({
      url: "https://api.example.com/ping",
      init: { method: "GET", headers: { authorization: "Bearer t" } },
    });
  });

  it("delivers host.logger.* notifications to the host", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    const lines: Array<{ method: string; payload: unknown }> = [];
    for (const method of ["host.logger.info", "host.logger.warn", "host.logger.error"] as const) {
      hostConnection.onNotification(method, (payload) => {
        lines.push({ method, payload });
      });
    }

    handles.push(
      definePlugin(
        {
          async validateConfig() {
            host.logger.info("starting validate");
            host.logger.warn({ message: "soft issue", data: { field: "x" } });
            host.logger.error("boom");
            return { ok: true };
          },
        },
        { streams: pluginStreams },
      ),
    );

    await hostConnection.sendRequest("validateConfig", { config: {} });
    // Notifications race the response; give the reader a tick.
    await new Promise((r) => setTimeout(r, 10));

    expect(lines.map((l) => l.method)).toEqual([
      "host.logger.info",
      "host.logger.warn",
      "host.logger.error",
    ]);
    expect(lines[0].payload).toEqual({ message: "starting validate" });
    expect(lines[1].payload).toEqual({ message: "soft issue", data: { field: "x" } });
    expect(lines[2].payload).toEqual({ message: "boom" });
  });

  it("propagates contract method exceptions as JSON-RPC errors", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      definePlugin(
        {
          async getCurrentUser() {
            throw new Error("auth failed");
          },
        },
        { streams: pluginStreams },
      ),
    );

    await expect(hostConnection.sendRequest("getCurrentUser", undefined)).rejects.toMatchObject({
      message: expect.stringContaining("auth failed"),
    });
  });

  it("throws a helpful error when host.* is called before definePlugin", async () => {
    // dispose any active connection so host is unbound
    for (const h of handles) h.dispose();
    handles = [];
    await expect(host.credentials.get("anything")).rejects.toThrow(
      /host\.\* called before definePlugin/,
    );
  });

  it("round-trips getConnectionStatus shape (host-API 1.1.0)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    const checkedAt = "2026-05-25T12:00:00.000Z";
    handles.push(
      definePlugin(
        {
          async getConnectionStatus() {
            return { state: "connected", checkedAt };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const status = await hostConnection.sendRequest<ConnectionStatus>(
      "getConnectionStatus",
      undefined,
    );
    expect(status).toEqual({ state: "connected", checkedAt });
  });

  it("returns MethodNotFound when getConnectionStatus is omitted (TC-113 contract level)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(definePlugin({}, { streams: pluginStreams }));

    await expect(
      hostConnection.sendRequest("getConnectionStatus", undefined),
    ).rejects.toMatchObject({ code: -32601 });
  });

  it("round-trips filterFacets descriptors (host-API 1.1.0)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      definePlugin(
        {
          async filterFacets() {
            return [
              { id: "status", label: "Status", type: "enum", options: ["open", "closed"] },
              { id: "milestone", label: "Milestone", type: "enum-async" },
            ];
          },
        },
        { streams: pluginStreams },
      ),
    );

    const facets = await hostConnection.sendRequest<FilterFacet[]>("filterFacets", undefined);
    expect(facets).toEqual([
      { id: "status", label: "Status", type: "enum", options: ["open", "closed"] },
      { id: "milestone", label: "Milestone", type: "enum-async" },
    ]);
  });

  it("returns MethodNotFound when filterFacets is omitted", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(definePlugin({}, { streams: pluginStreams }));

    await expect(hostConnection.sendRequest("filterFacets", undefined)).rejects.toMatchObject({
      code: -32601,
    });
  });

  it("preserves NormalizedIssue.facetValues across the RPC boundary (TC-127)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      definePlugin(
        {
          async listIssues() {
            return {
              items: [
                {
                  integrationId: "example",
                  externalId: "1",
                  externalUrl: "https://example.com/1",
                  title: "with facets",
                  body: null,
                  currentState: "open",
                  allowedTransitions: [],
                  assignees: [],
                  labels: [],
                  issueType: null,
                  blocks: [],
                  blockedBy: [],
                  updatedAt: "2026-05-25T00:00:00.000Z",
                  raw: null,
                  facetValues: { milestone: "v1.2", labels: ["bug", "p0"] },
                },
                {
                  integrationId: "example",
                  externalId: "2",
                  externalUrl: "https://example.com/2",
                  title: "without facets",
                  body: null,
                  currentState: "open",
                  allowedTransitions: [],
                  assignees: [],
                  labels: [],
                  issueType: null,
                  blocks: [],
                  blockedBy: [],
                  updatedAt: "2026-05-25T00:00:00.000Z",
                  raw: null,
                },
              ],
              nextCursor: null,
            };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const page = await hostConnection.sendRequest<ListIssuesResult>("listIssues", {
      sources: [],
      cursor: null,
      pageSize: 10,
    });
    expect(page.items[0].facetValues).toEqual({ milestone: "v1.2", labels: ["bug", "p0"] });
    expect(page.items[1].facetValues).toBeUndefined();
  });
});
