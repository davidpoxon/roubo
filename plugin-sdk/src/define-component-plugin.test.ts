import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { host } from "./component-host-client.js";
import { defineComponentPlugin } from "./define-component-plugin.js";
import { SUPPORTED_CONTRACT_VERSION } from "./types.js";
import type {
  BenchContext,
  ComponentPluginHandle,
  ComponentStatus,
  ProvisionDescriptor,
} from "./types.js";

/**
 * Build a paired in-memory JSON-RPC connection: one half is the SDK under test
 * (driving `defineComponentPlugin`), the other half plays the host. Mirrors the
 * pattern in define-plugin.test.ts.
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

const benchContext: BenchContext = {
  projectId: "proj-1",
  benchId: 2,
  componentName: "db",
  workspacePath: "/tmp/ws",
  ports: { http: 3000 },
  env: { NODE_ENV: "test" },
};

let handles: ComponentPluginHandle[] = [];
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

describe("defineComponentPlugin", () => {
  it("registers the declarative translate method so the host receives a ProvisionDescriptor (CP-TC-002)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      defineComponentPlugin(
        {
          translate({ config, context }) {
            return {
              schemaVersion: 1,
              kind: "process",
              command: config.command as string,
              cwd: context.workspacePath,
            };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const descriptor = await hostConnection.sendRequest<ProvisionDescriptor>("translate", {
      config: { command: "npm start" },
      context: benchContext,
    });
    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: "process",
      command: "npm start",
      cwd: "/tmp/ws",
    });
  });

  it("does not register imperative hooks for a declarative plugin (CP-TC-002)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      defineComponentPlugin(
        {
          translate() {
            return { schemaVersion: 1, kind: "oneshot", command: "deploy" };
          },
        },
        { streams: pluginStreams },
      ),
    );

    await expect(hostConnection.sendRequest("start", benchContext)).rejects.toMatchObject({
      code: -32601,
    });
  });

  it("registers all imperative hooks so the host can dispatch each one (CP-TC-003)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    const calls: string[] = [];
    handles.push(
      defineComponentPlugin(
        {
          start(ctx) {
            calls.push(`start:${ctx.benchId}`);
          },
          stop(ctx) {
            calls.push(`stop:${ctx.benchId}`);
          },
          health(ctx): ComponentStatus {
            calls.push(`health:${ctx.benchId}`);
            return { status: "running", pid: 123 };
          },
          cleanup(ctx) {
            calls.push(`cleanup:${ctx.benchId}`);
          },
        },
        { streams: pluginStreams },
      ),
    );

    await hostConnection.sendRequest("start", benchContext);
    const status = await hostConnection.sendRequest<ComponentStatus>("health", benchContext);
    await hostConnection.sendRequest("stop", benchContext);
    await hostConnection.sendRequest("cleanup", benchContext);

    expect(status).toEqual({ status: "running", pid: 123 });
    expect(calls).toEqual(["start:2", "health:2", "stop:2", "cleanup:2"]);
  });

  it("rejects a plugin implementing both translate and imperative hooks at validation (CP-TC-015)", () => {
    const { pluginStreams, dispose } = pairedConnection();
    disposes.push(dispose);

    expect(() =>
      defineComponentPlugin(
        {
          // @ts-expect-error: the two-mode union forbids this; assert the runtime guard too.
          translate() {
            return { schemaVersion: 1, kind: "oneshot", command: "x" };
          },
          start() {},
          stop() {},
          health() {
            return { status: "running" };
          },
          cleanup() {},
        },
        { streams: pluginStreams },
      ),
    ).toThrow(/translate OR the imperative hooks/);
  });

  it("rejects an imperative plugin missing a required hook (e.g. stop) at validation, not at stop-time (CP-TC-017)", () => {
    const { pluginStreams, dispose } = pairedConnection();
    disposes.push(dispose);

    expect(() =>
      defineComponentPlugin(
        // @ts-expect-error: imperative mode requires all four hooks.
        {
          start() {},
          health() {
            return { status: "running" };
          },
          cleanup() {},
        },
        { streams: pluginStreams },
      ),
    ).toThrow(/missing stop/);
  });

  it("rejects an empty contract (neither translate nor hooks) at validation", () => {
    const { pluginStreams, dispose } = pairedConnection();
    disposes.push(dispose);

    expect(() =>
      // @ts-expect-error: an empty object satisfies neither contract variant.
      defineComponentPlugin({}, { streams: pluginStreams }),
    ).toThrow(/must implement either translate or the imperative hooks/);
  });

  it("rejects an incompatible contractVersion at validation, not at call time (CP-TC-016 version gate)", () => {
    const { pluginStreams, dispose } = pairedConnection();
    disposes.push(dispose);

    expect(() =>
      defineComponentPlugin(
        {
          translate() {
            return { schemaVersion: 1, kind: "oneshot", command: "x" };
          },
        },
        { contractVersion: SUPPORTED_CONTRACT_VERSION + 1, streams: pluginStreams },
      ),
    ).toThrow(/incompatible with the host/);
  });

  it("routes host.process.start / run / stop / status / logs through the SDK to the host", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    const captured: Record<string, unknown> = {};
    hostConnection.onRequest("host.process.start", (p) => {
      captured.start = p;
      return { pid: 4242 };
    });
    hostConnection.onRequest("host.process.run", (p) => {
      captured.run = p;
      return { exitCode: 0 };
    });
    hostConnection.onRequest("host.process.stop", (p) => {
      captured.stop = p;
      return null;
    });
    hostConnection.onRequest("host.process.status", (p) => {
      captured.status = p;
      return { alive: true, exitCode: undefined };
    });
    hostConnection.onRequest("host.process.logs", (p) => {
      captured.logs = p;
      return ["line-1", "line-2"];
    });

    handles.push(
      defineComponentPlugin(
        {
          async start() {
            const { pid } = await host.process.start({
              id: "p1",
              command: "node",
              args: ["server.js"],
              env: { A: "1" },
              cwd: "/ws",
            });
            const run = await host.process.run({
              id: "p2",
              command: "deploy",
              env: {},
              cwd: "/ws",
              timeoutMs: 5000,
            });
            const status = await host.process.status({ id: "p1" });
            const logs = await host.process.logs({ id: "p1" });
            await host.process.stop({ id: "p1" });
            host.component.reportStatus({ status: "running", pid });
            captured.observed = { pid, run, status, logs };
          },
          stop() {},
          health(): ComponentStatus {
            return { status: "running" };
          },
          cleanup() {},
        },
        { streams: pluginStreams },
      ),
    );

    await hostConnection.sendRequest("start", benchContext);

    // The SDK stamps the in-flight lifecycle call's benchId onto every host.*
    // request, so the host can route it to the right bench (#685). benchContext
    // here carries benchId: 2.
    expect(captured.start).toEqual({
      benchId: 2,
      id: "p1",
      command: "node",
      args: ["server.js"],
      env: { A: "1" },
      cwd: "/ws",
    });
    expect(captured.run).toEqual({
      benchId: 2,
      id: "p2",
      command: "deploy",
      env: {},
      cwd: "/ws",
      timeoutMs: 5000,
    });
    expect(captured.observed).toEqual({
      pid: 4242,
      run: { exitCode: 0 },
      status: { alive: true },
      logs: ["line-1", "line-2"],
    });
  });

  it("routes host.docker.* through the SDK to the host", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    const seen: string[] = [];
    hostConnection.onRequest("host.docker.composeUp", () => {
      seen.push("composeUp");
      return { containerId: "c-1" };
    });
    hostConnection.onRequest("host.docker.waitForHealthy", () => {
      seen.push("waitForHealthy");
      return { healthy: true };
    });
    hostConnection.onRequest("host.docker.composeRunInit", () => {
      seen.push("composeRunInit");
      return null;
    });
    hostConnection.onRequest("host.docker.composeStop", () => {
      seen.push("composeStop");
      return null;
    });
    hostConnection.onRequest("host.docker.composeDown", () => {
      seen.push("composeDown");
      return null;
    });
    hostConnection.onRequest("host.docker.assignContainer", () => {
      seen.push("assignContainer");
      return null;
    });

    let result: { containerId: string; healthy: boolean } | null = null;
    handles.push(
      defineComponentPlugin(
        {
          async start() {
            await host.docker.composeRunInit({
              projectName: "p",
              composeFile: "c.yml",
              cwd: "/ws",
              initService: "init",
            });
            const up = await host.docker.composeUp({
              projectName: "p",
              composeFile: "c.yml",
              cwd: "/ws",
              service: "db",
              env: {},
            });
            const health = await host.docker.waitForHealthy({
              projectName: "p",
              service: "db",
              timeoutMs: 1000,
            });
            await host.docker.assignContainer({ componentName: "db", containerId: up.containerId });
            await host.docker.composeStop({ projectName: "p", composeFile: "c.yml", cwd: "/ws" });
            await host.docker.composeDown({ projectName: "p", composeFile: "c.yml", cwd: "/ws" });
            result = { containerId: up.containerId, healthy: health.healthy };
          },
          stop() {},
          health(): ComponentStatus {
            return { status: "running" };
          },
          cleanup() {},
        },
        { streams: pluginStreams },
      ),
    );

    await hostConnection.sendRequest("start", benchContext);

    expect(result).toEqual({ containerId: "c-1", healthy: true });
    expect(seen).toEqual([
      "composeRunInit",
      "composeUp",
      "waitForHealthy",
      "assignContainer",
      "composeStop",
      "composeDown",
    ]);
  });

  it("routes host.ports.get and host.capability.query through the SDK to the host", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    hostConnection.onRequest("host.ports.get", (p: { componentName: string }) =>
      p.componentName === "db" ? 5432 : 0,
    );
    hostConnection.onRequest("host.capability.query", (p: { method: string }) => ({
      available: p.method === "host.process.run",
      introducedIn: "1.0.0",
    }));

    let observed: { port: number; cap: { available: boolean } } | null = null;
    handles.push(
      defineComponentPlugin(
        {
          async start() {
            const port = await host.ports.get({ componentName: "db" });
            const cap = await host.capability.query({ method: "host.process.run" });
            observed = { port, cap };
          },
          stop() {},
          health(): ComponentStatus {
            return { status: "running" };
          },
          cleanup() {},
        },
        { streams: pluginStreams },
      ),
    );

    await hostConnection.sendRequest("start", benchContext);
    expect(observed).toEqual({
      port: 5432,
      cap: { available: true, introducedIn: "1.0.0" },
    });
  });

  it("delivers host.component.reportStatus and reportLog notifications to the host (CP-TC-018 completed terminal state)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    const events: Array<{ method: string; payload: unknown }> = [];
    hostConnection.onNotification("host.component.reportStatus", (payload) => {
      events.push({ method: "reportStatus", payload });
    });
    hostConnection.onNotification("host.component.reportLog", (payload) => {
      events.push({ method: "reportLog", payload });
    });

    handles.push(
      defineComponentPlugin(
        {
          async start() {
            host.component.reportLog({ source: "stdout", text: "deploying", ts: 1000 });
            host.component.reportStatus({ status: "completed" });
          },
          stop() {},
          health(): ComponentStatus {
            return { status: "completed" };
          },
          cleanup() {},
        },
        { streams: pluginStreams },
      ),
    );

    await hostConnection.sendRequest("start", benchContext);
    // Notifications race the response; give the reader a tick.
    await new Promise((r) => setTimeout(r, 10));

    // The SDK stamps the in-flight lifecycle call's routing onto both
    // notifications (#685): benchId on each, and componentName on reportLog so a
    // bench with two components routes each component's logs to its own sink.
    // benchContext here carries benchId: 2 and componentName: "db".
    expect(events).toEqual([
      {
        method: "reportLog",
        payload: {
          source: "stdout",
          text: "deploying",
          ts: 1000,
          benchId: 2,
          componentName: "db",
        },
      },
      { method: "reportStatus", payload: { status: "completed", benchId: 2 } },
    ]);
  });

  it("throws a helpful error when host.* is called before defineComponentPlugin", async () => {
    for (const h of handles) h.dispose();
    handles = [];
    await expect(host.ports.get({ componentName: "db" })).rejects.toThrow(
      /host\.\* called before defineComponentPlugin/,
    );
  });

  it("throws when a bench-routed host.* call is made outside a lifecycle handler (no routing context, #685)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    hostConnection.onRequest("host.ports.get", () => 5432);

    // Capture the host client from a defined plugin, then call a bench-routed
    // method directly (not from inside a lifecycle handler). With a live
    // connection but no ambient routing context, the SDK cannot route the call,
    // so it throws rather than mis-attributing it to a bench.
    handles.push(
      defineComponentPlugin(
        {
          start() {},
          stop() {},
          health(): ComponentStatus {
            return { status: "running" };
          },
          cleanup() {},
        },
        { streams: pluginStreams },
      ),
    );

    await expect(host.ports.get({ componentName: "db" })).rejects.toThrow(
      /outside a lifecycle handler/,
    );
  });
});
