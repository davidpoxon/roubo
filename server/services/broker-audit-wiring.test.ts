import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AuditEntry, BrokerContext, BrokerPermissionCategory } from "@roubo/shared";
import {
  registerBrokerHandlers,
  type DockerLike,
  type ProcessManagerLike,
} from "./component-broker.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";
import * as pluginManager from "./plugin-manager.js";
import * as benchManager from "./bench-manager.js";

// End-to-end wiring for issue #677: a privileged broker call made over a
// component plugin's live connection must accumulate an AuditEntry into the
// per-bench AuditLog so GET .../audit-log (queryAuditLog) returns it, including
// permission-denied calls. This exercises the real chain the production wiring
// uses: the broker's per-call BrokerContextResolver -> the plugin-manager
// registry -> bench-manager's recordAuditEntry sink -> queryAuditLog. It uses a
// fake JSON-RPC connection (no spawned plugin) so the test is hermetic.

function makeConnection(): JsonRpcConnection & {
  handlers: Map<string, (params: unknown) => unknown>;
} {
  const handlers = new Map<string, (params: unknown) => unknown>();
  return {
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
    onRequest: vi.fn((method: string, handler: (params: unknown) => unknown) => {
      handlers.set(method, handler);
    }),
    onNotification: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    dispose: vi.fn(),
    handlers,
  } as unknown as JsonRpcConnection & { handlers: Map<string, (params: unknown) => unknown> };
}

const PROJECT = "wiring-project";
const PLUGIN = "component-db";

// Fake host delegates so a successful privileged call does not try to spawn a
// real process or talk to Docker; the audit recording (the #677 concern) happens
// in the broker before any delegation.
function fakeProcessManager(): ProcessManagerLike {
  return {
    startProcess: async () => ({ pid: 1234 }),
    runProcess: async () => ({ exitCode: 0, timedOut: false }),
    stopProcess: async () => undefined,
    getProcessStatus: () => ({ alive: true, exitCode: null }),
    getProcessLogs: () => [],
  };
}

function fakeDocker(): DockerLike {
  return {
    composeUp: async () => ({ success: true, stdout: "", stderr: "" }),
    waitForHealthy: async () => true,
    composeRunInit: async () => ({ success: true, stdout: "", stderr: "" }),
    composeStop: async () => undefined,
    composeDown: async () => undefined,
    getContainerId: async () => "container-1",
  };
}

function register(connection: JsonRpcConnection): void {
  registerBrokerHandlers(
    connection,
    (benchId) => pluginManager.__test.resolveBrokerContext(PLUGIN, benchId),
    {
      processManager: fakeProcessManager(),
      docker: fakeDocker(),
    },
  );
}

function buildBenchContext(benchId: number, allowed: Set<BrokerPermissionCategory>): BrokerContext {
  // Mirrors registerBrokerContextForBench in bench-manager: recordAudit is wired
  // to the per-bench AuditLog, hasPermission reflects the plugin's declared
  // broker categories.
  return {
    pluginId: PLUGIN,
    benchId,
    ports: { web: 4000 + benchId },
    reportStatus: () => {},
    reportLog: () => {},
    hasPermission: (category) => allowed.has(category),
    recordAudit: (entry: AuditEntry) => benchManager.recordAuditEntry(PROJECT, benchId, entry),
  };
}

describe("HostComponentBroker live wiring accumulates audit entries (#677)", () => {
  beforeEach(() => {
    pluginManager.__test.reset();
    benchManager._resetAuditLogsForTest();
  });

  it("a privileged call over the connection lands in the bench's audit log", async () => {
    const connection = makeConnection();
    // Register broker handlers ONCE on the connection, backed by the registry
    // resolver, exactly as spawnPlugin does for a component plugin.
    register(connection);
    // Provision a bench: bench-manager would call registerBrokerContext here.
    pluginManager.registerBrokerContext(
      PLUGIN,
      1,
      buildBenchContext(1, new Set<BrokerPermissionCategory>(["process"])),
    );

    const params = { benchId: 1, id: "db", command: "node", args: ["x.js"], env: {}, cwd: "/w" };
    await connection.handlers.get("host.process.start")?.(params);

    const log = benchManager.queryAuditLog(PROJECT, 1);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      pluginId: PLUGIN,
      benchId: 1,
      method: "host.process.start",
      params,
      outcome: "allowed",
    });
  });

  it("records a permission-denied call with outcome 'denied'", async () => {
    const connection = makeConnection();
    register(connection);
    // Bench declares no docker category, so a docker broker call is denied.
    pluginManager.registerBrokerContext(
      PLUGIN,
      1,
      buildBenchContext(1, new Set<BrokerPermissionCategory>(["process"])),
    );

    await expect(
      connection.handlers.get("host.docker.composeDown")?.({
        benchId: 1,
        projectName: "p",
        composeFile: "c.yml",
        cwd: "/w",
      }),
    ).rejects.toMatchObject({ code: -32001 });

    const log = benchManager.queryAuditLog(PROJECT, 1);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ method: "host.docker.composeDown", outcome: "denied" });
  });

  it("routes each bench's calls to its own audit log by the param benchId over the shared connection (#685)", async () => {
    const connection = makeConnection();
    register(connection);
    // Both benches bind to the same plugin connection concurrently.
    pluginManager.registerBrokerContext(
      PLUGIN,
      1,
      buildBenchContext(1, new Set<BrokerPermissionCategory>(["process"])),
    );
    pluginManager.registerBrokerContext(
      PLUGIN,
      2,
      buildBenchContext(2, new Set<BrokerPermissionCategory>(["process"])),
    );

    // A call naming bench 1 audits to bench 1's log even though bench 2 was
    // registered later: routing is by the param benchId, not registration order.
    await connection.handlers.get("host.process.stop")?.({ benchId: 1, id: "a" });
    await connection.handlers.get("host.process.stop")?.({ benchId: 2, id: "b" });

    expect(benchManager.queryAuditLog(PROJECT, 1)).toHaveLength(1);
    expect(benchManager.queryAuditLog(PROJECT, 1)[0].benchId).toBe(1);
    expect(benchManager.queryAuditLog(PROJECT, 2)).toHaveLength(1);
    expect(benchManager.queryAuditLog(PROJECT, 2)[0].benchId).toBe(2);
  });

  it("dropping the context on teardown stops the connection from auditing the bench", async () => {
    const connection = makeConnection();
    register(connection);
    pluginManager.registerBrokerContext(
      PLUGIN,
      1,
      buildBenchContext(1, new Set<BrokerPermissionCategory>(["process"])),
    );
    pluginManager.unregisterBrokerContext(PLUGIN, 1);

    // With no context bound, a privileged call fails internal-error rather than
    // crashing the host, and nothing is recorded.
    await expect(
      connection.handlers.get("host.process.stop")?.({ benchId: 1, id: "a" }),
    ).rejects.toMatchObject({
      code: -32603,
    });
    expect(benchManager.queryAuditLog(PROJECT, 1)).toEqual([]);
  });
});
