import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResponseError } from "vscode-jsonrpc/node";
import type {
  AuditEntry,
  BrokerContext,
  BrokerPermissionCategory,
  ComponentStatus,
} from "@roubo/shared";
import {
  registerBrokerHandlers,
  BROKER_API_VERSION,
  BROKER_METHODS,
  type DockerLike,
  type ProcessManagerLike,
} from "./component-broker.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";

function makeConnection(): JsonRpcConnection & {
  handlers: Map<string, (params: unknown) => unknown>;
  notifyHandlers: Map<string, (params: unknown) => unknown>;
  starHandler?: (method: string, params: unknown) => unknown;
} {
  const handlers = new Map<string, (params: unknown) => unknown>();
  const notifyHandlers = new Map<string, (params: unknown) => unknown>();
  const conn = {
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
    onRequest: vi.fn(
      (
        methodOrHandler: string | ((method: string, params: unknown) => unknown),
        handler?: (params: unknown) => unknown,
      ) => {
        // A single function argument is the star/fallback registration
        // (vscode-jsonrpc's connection.onRequest(handler) form): capture it
        // separately so it never lands in the per-method handlers map and the
        // "15 frozen methods" count stays exact (#409).
        if (typeof methodOrHandler === "function") {
          conn.starHandler = methodOrHandler;
          return;
        }
        handlers.set(methodOrHandler, handler as (params: unknown) => unknown);
      },
    ),
    onNotification: vi.fn((method: string, handler: (params: unknown) => unknown) => {
      notifyHandlers.set(method, handler);
    }),
    onError: vi.fn(),
    onClose: vi.fn(),
    dispose: vi.fn(),
    handlers,
    notifyHandlers,
    starHandler: undefined as ((method: string, params: unknown) => unknown) | undefined,
  };
  return conn as unknown as JsonRpcConnection & {
    handlers: Map<string, (params: unknown) => unknown>;
    notifyHandlers: Map<string, (params: unknown) => unknown>;
    starHandler?: (method: string, params: unknown) => unknown;
  };
}

function need<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be registered`);
  return value;
}

function makeProcessManager(): ProcessManagerLike {
  return {
    startProcess: vi.fn(async () => ({ pid: 4242 })),
    runProcess: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
    stopProcess: vi.fn(async () => undefined),
    getProcessStatus: vi.fn(() => ({ alive: true, exitCode: null })),
    getProcessLogs: vi.fn(() => ["line 1", "line 2"]),
  };
}

function makeDocker(): DockerLike {
  return {
    composeUp: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    waitForHealthy: vi.fn(async () => true),
    composeRunInit: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    composeStop: vi.fn(async () => undefined),
    composeDown: vi.fn(async () => undefined),
    getContainerId: vi.fn(async () => "container-abc123"),
  };
}

interface Harness {
  connection: ReturnType<typeof makeConnection>;
  pm: ProcessManagerLike;
  docker: DockerLike;
  ctx: BrokerContext;
  reportStatus: ReturnType<typeof vi.fn>;
  reportLog: ReturnType<typeof vi.fn>;
  assignContainer: ReturnType<typeof vi.fn>;
  hasPermission: ReturnType<typeof vi.fn>;
  recordAudit: ReturnType<typeof vi.fn>;
  recordProcess: ReturnType<typeof vi.fn>;
  audit: AuditEntry[];
  log: ReturnType<typeof vi.fn>;
  call: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
}

function setup(
  opts: {
    ports?: Record<string, number>;
    allow?: boolean;
    deny?: BrokerPermissionCategory[];
    componentName?: string;
    withLedger?: boolean;
  } = {},
): Harness {
  const connection = makeConnection();
  const pm = makeProcessManager();
  const docker = makeDocker();
  const reportStatus = vi.fn();
  const reportLog = vi.fn();
  const assignContainer = vi.fn();
  const recordProcess = vi.fn();
  // `deny` (a set of categories to refuse) takes precedence; otherwise fall
  // back to the blanket `allow` flag (default: every category permitted).
  const denied = new Set(opts.deny ?? []);
  const hasPermission = vi.fn((category: BrokerPermissionCategory) =>
    opts.deny ? !denied.has(category) : (opts.allow ?? true),
  );
  const audit: AuditEntry[] = [];
  const recordAudit = vi.fn((entry: AuditEntry) => {
    audit.push(entry);
  });
  const log = vi.fn();
  const ctx: BrokerContext = {
    pluginId: "plugin-under-test",
    benchId: 7,
    componentName: opts.componentName,
    ports: opts.ports ?? { web: 3001, db: 5433 },
    reportStatus,
    reportLog,
    assignContainer,
    hasPermission,
    recordAudit,
  };
  registerBrokerHandlers(connection, ctx, {
    processManager: pm,
    docker,
    log,
    // Only wire a ledger when the test asks for one, so the ledger-tracking
    // tests can assert recordProcess without every other test doing state I/O.
    ...(opts.withLedger ? { ledger: { recordProcess } } : {}),
  });
  // Wrap in an async function so a handler's synchronous throw (validation
  // errors on the sync handlers) surfaces as a rejected promise, exactly as
  // vscode-jsonrpc converts a thrown ResponseError into a JSON-RPC error reply.
  // Every broker call carries the benchId it acts for in its params (#685); the
  // production SDK stamps it from the in-flight lifecycle call, so the harness
  // stamps the ctx's benchId here for object params unless the test already set
  // one (so a test can pass an explicit/invalid benchId to exercise routing).
  const stampBenchId = (params?: unknown) =>
    params && typeof params === "object" && !Array.isArray(params) && !("benchId" in params)
      ? { benchId: ctx.benchId, ...params }
      : params;
  const call = async (method: string, params?: unknown) =>
    need(connection.handlers.get(method), method)(stampBenchId(params));
  // Dispatch a JSON-RPC NOTIFICATION (no reply), the form the SDK uses for
  // host.component.reportStatus / reportLog (#396).
  const notify = (method: string, params?: unknown) => {
    need(connection.notifyHandlers.get(method), `${method} (notification)`)(stampBenchId(params));
  };
  return {
    connection,
    pm,
    docker,
    ctx,
    reportStatus,
    reportLog,
    assignContainer,
    hasPermission,
    recordAudit,
    recordProcess,
    audit,
    log,
    call,
    notify,
  };
}

describe("component-broker registration", () => {
  it("registers exactly the 15 frozen broker methods", () => {
    const h = setup();
    expect([...h.connection.handlers.keys()].sort()).toEqual(Object.keys(BROKER_METHODS).sort());
    expect(Object.keys(BROKER_METHODS)).toHaveLength(15);
  });
});

describe("host.process.* delegation (CP-TC-038)", () => {
  it("host.process.start delegates to process-manager and returns { pid }", async () => {
    const h = setup();
    const result = await h.call("host.process.start", {
      id: "web",
      command: "node",
      args: ["server.js"],
      env: { PORT: "3001" },
      cwd: "/work",
    });
    expect(h.pm.startProcess).toHaveBeenCalledWith(
      "web",
      "node",
      ["server.js"],
      { PORT: "3001" },
      "/work",
    );
    expect(result).toEqual({ pid: 4242 });
  });

  it("host.process.run is a distinct blocking run-to-completion method returning { exitCode } (CP-TC-123)", async () => {
    const h = setup();
    const result = await h.call("host.process.run", {
      id: "deploy",
      command: "clasp",
      args: ["push"],
      env: {},
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(h.pm.runProcess).toHaveBeenCalledWith("deploy", "clasp", ["push"], {}, "/work", 60_000);
    // run and start are different methods backed by different primitives.
    expect(h.pm.startProcess).not.toHaveBeenCalled();
    expect(result).toEqual({ exitCode: 0 });
  });

  it("host.process.run defaults timeoutMs to 0 when omitted", async () => {
    const h = setup();
    await h.call("host.process.run", { id: "x", command: "echo", env: {}, cwd: "/work" });
    expect(h.pm.runProcess).toHaveBeenCalledWith("x", "echo", [], {}, "/work", 0);
  });

  it("host.process.run rejects with a timeout error naming timeoutMs when timedOut (CP-TC-068)", async () => {
    const h = setup();
    // process-manager force-kills a hung run and reports timedOut; the broker must
    // reject (not silently return exit code 124) with a descriptive, typed error
    // that names the configured budget (#411).
    vi.mocked(h.pm.runProcess).mockResolvedValueOnce({ exitCode: 124, timedOut: true });
    let rejected: unknown;
    try {
      await h.call("host.process.run", {
        id: "hang",
        command: "sleep",
        args: ["999"],
        env: {},
        cwd: "/work",
        timeoutMs: 5_000,
      });
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(ResponseError);
    const err = rejected as ResponseError<{ code: string; timeoutMs: number; exitCode: number }>;
    expect(err.message).toContain("5000ms");
    expect(err.message.toLowerCase()).toContain("timeout");
    expect(err.data).toEqual({ code: "process-timeout", timeoutMs: 5_000, exitCode: 124 });
  });

  it("host.process.stop delegates and returns null", async () => {
    const h = setup();
    const result = await h.call("host.process.stop", { id: "web" });
    expect(h.pm.stopProcess).toHaveBeenCalledWith("web");
    expect(result).toBeNull();
  });

  it("host.process.status maps a live process with no exit code", async () => {
    const h = setup();
    const result = await h.call("host.process.status", { id: "web" });
    expect(result).toEqual({ alive: true });
  });

  it("host.process.status includes exitCode when the process has exited", async () => {
    const h = setup();
    (h.pm.getProcessStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      alive: false,
      exitCode: 137,
    });
    const result = await h.call("host.process.status", { id: "web" });
    expect(result).toEqual({ alive: false, exitCode: 137 });
  });

  it("host.process.logs returns the log lines array", async () => {
    const h = setup();
    const result = await h.call("host.process.logs", { id: "web" });
    expect(result).toEqual(["line 1", "line 2"]);
  });

  it("rejects missing required params with INVALID_PARAMS", async () => {
    const h = setup();
    await expect(
      h.call("host.process.start", { command: "node", env: {}, cwd: "/x" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("wraps a process-manager failure as an INTERNAL_ERROR response", async () => {
    const h = setup();
    (h.pm.startProcess as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("spawn EACCES"));
    await expect(
      h.call("host.process.start", { id: "x", command: "node", env: {}, cwd: "/x" }),
    ).rejects.toMatchObject({ code: -32603, message: "spawn EACCES" });
  });
});

describe("host.docker.* delegation (CP-TC-037)", () => {
  it("composeUp delegates, maps env to portOverrides, and resolves a containerId", async () => {
    const h = setup();
    const result = await h.call("host.docker.composeUp", {
      projectName: "roubo-p-bench-1",
      composeFile: "docker-compose.yml",
      cwd: "/work",
      service: "db",
      env: { HOST_PORT: "5433" },
    });
    expect(h.docker.composeUp).toHaveBeenCalledWith({
      projectName: "roubo-p-bench-1",
      composeFile: "docker-compose.yml",
      cwd: "/work",
      service: "db",
      portOverrides: { HOST_PORT: "5433" },
    });
    expect(h.docker.getContainerId).toHaveBeenCalledWith("roubo-p-bench-1", "db");
    expect(result).toEqual({ containerId: "container-abc123" });
  });

  it("composeUp surfaces a failed compose as an error response", async () => {
    const h = setup();
    (h.docker.composeUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "no such image",
      stdout: "",
      stderr: "no such image",
    });
    await expect(
      h.call("host.docker.composeUp", {
        projectName: "p",
        composeFile: "c.yml",
        cwd: "/w",
        service: "db",
        env: {},
      }),
    ).rejects.toMatchObject({ code: -32603, message: "no such image" });
  });

  it("composeUp errors when no container can be resolved after success", async () => {
    const h = setup();
    (h.docker.getContainerId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      h.call("host.docker.composeUp", {
        projectName: "p",
        composeFile: "c.yml",
        cwd: "/w",
        service: "db",
        env: {},
      }),
    ).rejects.toMatchObject({ code: -32603 });
  });

  it("waitForHealthy delegates and returns { healthy }", async () => {
    const h = setup();
    const result = await h.call("host.docker.waitForHealthy", {
      projectName: "p",
      service: "db",
      timeoutMs: 5000,
    });
    expect(h.docker.waitForHealthy).toHaveBeenCalledWith("p", "db", 5000);
    expect(result).toEqual({ healthy: true });
  });

  it("composeRunInit delegates and throws on failure", async () => {
    const h = setup();
    const ok = await h.call("host.docker.composeRunInit", {
      projectName: "p",
      composeFile: "c.yml",
      cwd: "/w",
      initService: "migrate",
    });
    expect(ok).toBeNull();
    expect(h.docker.composeRunInit).toHaveBeenCalledWith({
      projectName: "p",
      composeFile: "c.yml",
      cwd: "/w",
      initService: "migrate",
      portOverrides: {},
    });
    (h.docker.composeRunInit as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "migration failed",
      stdout: "",
      stderr: "",
    });
    await expect(
      h.call("host.docker.composeRunInit", {
        projectName: "p",
        composeFile: "c.yml",
        cwd: "/w",
        initService: "migrate",
      }),
    ).rejects.toMatchObject({ code: -32603, message: "migration failed" });
  });

  it("composeStop delegates with the service when given, and undefined otherwise", async () => {
    const h = setup();
    await h.call("host.docker.composeStop", {
      projectName: "p",
      composeFile: "c.yml",
      cwd: "/w",
      service: "db",
    });
    expect(h.docker.composeStop).toHaveBeenCalledWith("p", "c.yml", "/w", "db");
    // When no service is given the broker passes undefined so the facade stops
    // the whole project, rather than an empty-string positional arg that docker
    // compose would treat as a service filter matching nothing.
    await h.call("host.docker.composeStop", { projectName: "p", composeFile: "c.yml", cwd: "/w" });
    expect(h.docker.composeStop).toHaveBeenLastCalledWith("p", "c.yml", "/w", undefined);
  });

  it("composeDown delegates and returns null", async () => {
    const h = setup();
    const result = await h.call("host.docker.composeDown", {
      projectName: "p",
      composeFile: "c.yml",
      cwd: "/w",
    });
    expect(h.docker.composeDown).toHaveBeenCalledWith("p", "c.yml", "/w");
    expect(result).toBeNull();
  });
});

describe("host.docker.assignContainer permission gate (CP-TC-026)", () => {
  it("records the assignment through the injected sink", async () => {
    const h = setup();
    const result = await h.call("host.docker.assignContainer", {
      componentName: "db",
      containerId: "ext-999",
    });
    expect(h.assignContainer).toHaveBeenCalledWith("db", "ext-999");
    expect(result).toBeNull();
  });

  it("denies and never assigns when docker permission is not declared", async () => {
    const h = setup({ allow: false });
    await expect(
      h.call("host.docker.assignContainer", { componentName: "db", containerId: "ext-1" }),
    ).rejects.toMatchObject({
      code: -32001,
      data: { code: "permission-denied", category: "docker", reason: "category-not-declared" },
    });
    // enforced: the call is denied, the assignment never happens.
    expect(h.assignContainer).not.toHaveBeenCalled();
    expect(h.hasPermission).toHaveBeenCalledWith("docker");
    expect(h.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("host.docker.assignContainer denied"),
    );
  });

  it("rejects a missing containerId", async () => {
    const h = setup();
    await expect(
      h.call("host.docker.assignContainer", { componentName: "db" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("host.ports.get (CP-TC-058)", () => {
  it("returns the host-allocated port for a component", async () => {
    const h = setup({ ports: { web: 3007 } });
    const result = await h.call("host.ports.get", { componentName: "web" });
    expect(result).toBe(3007);
  });

  it("rejects an unknown component with INVALID_PARAMS", async () => {
    const h = setup({ ports: { web: 3007 } });
    await expect(h.call("host.ports.get", { componentName: "nope" })).rejects.toMatchObject({
      code: -32602,
    });
  });
});

describe("host.component.report* push (no polling)", () => {
  it("reportStatus pushes the status into the injected sink", async () => {
    const h = setup();
    const status: ComponentStatus = {
      name: "db",
      status: "running",
      setupComplete: true,
    };
    const result = await h.call("host.component.reportStatus", status);
    // The handler forwards the raw params, which now also carry the routing
    // benchId the SDK stamps (#685); the status fields are preserved.
    expect(h.reportStatus).toHaveBeenCalledWith(expect.objectContaining(status));
    expect(result).toBeNull();
  });

  it("reportStatus rejects a non-object payload", async () => {
    const h = setup();
    await expect(h.call("host.component.reportStatus", "nope")).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("reportLog routes a {source,text,ts} line to the named component's sink (#685)", async () => {
    const h = setup();
    const line = { source: "stdout" as const, text: "hello", ts: "2026-06-21T00:00:00Z" };
    const result = await h.call("host.component.reportLog", { ...line, componentName: "web" });
    // The sink receives the component the call named plus the log line, so a
    // bench with two plugin-bound components routes each to its own log.
    expect(h.reportLog).toHaveBeenCalledWith("web", line);
    expect(result).toBeNull();
  });

  it("reportLog rejects a missing componentName", async () => {
    const h = setup();
    await expect(
      h.call("host.component.reportLog", {
        source: "stdout",
        text: "x",
        ts: "2026-06-21T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("reportLog rejects an invalid source", async () => {
    const h = setup();
    await expect(
      h.call("host.component.reportLog", {
        source: "stdin",
        text: "x",
        ts: "t",
        componentName: "web",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

// The SDK sends host.component.reportStatus as a JSON-RPC NOTIFICATION carrying
// no `name` (only benchId). An imperative component plugin's status pushes must
// be receivable this way and routed to the component the context is driving
// (#396, AC2).
describe("host.component.reportStatus notification (imperative push, #396)", () => {
  it("routes a nameless status push to the context's componentName", () => {
    const h = setup({ componentName: "deploy" });
    h.notify("host.component.reportStatus", { status: "completed" });
    expect(h.reportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ name: "deploy", status: "completed" }),
    );
  });

  it("prefers an explicit name in the status over the context componentName", () => {
    const h = setup({ componentName: "deploy" });
    h.notify("host.component.reportStatus", { name: "other", status: "running" });
    expect(h.reportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ name: "other", status: "running" }),
    );
  });

  it("drops (does not throw) a push with no routable bench context", () => {
    const h = setup({ componentName: "deploy" });
    // benchId that resolves to no context (the harness resolver is a constant,
    // so force a non-numeric benchId that resolveCtxLoose rejects).
    expect(() =>
      h.connection.notifyHandlers.get("host.component.reportStatus")?.({
        status: "completed",
        benchId: "nope",
      }),
    ).not.toThrow();
    expect(h.reportStatus).not.toHaveBeenCalled();
  });

  it("drops (does not throw) a push carrying no status", () => {
    const h = setup({ componentName: "deploy" });
    h.notify("host.component.reportStatus", { pid: 1 });
    expect(h.reportStatus).not.toHaveBeenCalled();
  });

  it("drops a nameless push when the context has no componentName", () => {
    const h = setup();
    h.notify("host.component.reportStatus", { status: "completed" });
    expect(h.reportStatus).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith("warn", expect.stringContaining("no component name"));
  });
});

// Broker-spawned processes must be ledger-tracked so pre-restart crash cleanup
// and the startup orphan sweep can reap them (#396, AC4).
describe("ledger tracking of broker-spawned processes (#396)", () => {
  it("records a host.process.start process after a successful spawn", async () => {
    const h = setup({ withLedger: true });
    await h.call("host.process.start", {
      id: "svc-1",
      command: "node",
      args: ["server.js"],
      env: {},
      cwd: "/work",
    });
    expect(h.recordProcess).toHaveBeenCalledWith("plugin-under-test", 7, "svc-1");
  });

  it("records a host.process.run process (before the blocking run)", async () => {
    const h = setup({ withLedger: true });
    await h.call("host.process.run", {
      id: "deploy-1",
      command: "echo",
      env: {},
      cwd: "/work",
    });
    expect(h.recordProcess).toHaveBeenCalledWith("plugin-under-test", 7, "deploy-1");
  });

  it("does not record when no ledger is wired", async () => {
    const h = setup();
    await h.call("host.process.start", {
      id: "svc-1",
      command: "node",
      env: {},
      cwd: "/work",
    });
    expect(h.recordProcess).not.toHaveBeenCalled();
  });

  it("does not record a host.process.start that fails to spawn", async () => {
    const h = setup({ withLedger: true });
    vi.mocked(h.pm.startProcess).mockRejectedValueOnce(new Error("spawn EACCES"));
    await expect(
      h.call("host.process.start", { id: "svc-1", command: "node", env: {}, cwd: "/work" }),
    ).rejects.toBeDefined();
    expect(h.recordProcess).not.toHaveBeenCalled();
  });
});

describe("host.capability.query (CP-TC-008, CP-TC-053)", () => {
  it("returns { available: true, introducedIn } for a known method", async () => {
    const h = setup();
    const result = await h.call("host.capability.query", { method: "host.docker.composeUp" });
    expect(result).toEqual({ available: true, introducedIn: BROKER_API_VERSION });
  });

  it("returns { available: false } for an unknown / future method, with no error", async () => {
    const h = setup();
    const result = await h.call("host.capability.query", { method: "host.docker.startService" });
    expect(result).toEqual({ available: false });
  });

  it("answers for every method in the registry", async () => {
    const h = setup();
    for (const method of Object.keys(BROKER_METHODS)) {
      const result = await h.call("host.capability.query", { method });
      expect(result).toEqual({ available: true, introducedIn: BROKER_API_VERSION });
    }
  });

  it("rejects a malformed query (missing method name)", async () => {
    const h = setup();
    await expect(h.call("host.capability.query", {})).rejects.toMatchObject({ code: -32602 });
  });
});

describe("unknown invoked method (FR-017, CP-TC-009, CP-TC-054)", () => {
  it("does not register an unimplemented method, so the transport returns METHOD_NOT_FOUND without crashing", () => {
    const h = setup();
    // The broker never registers a handler the host does not implement, so an
    // unknown invocation is handled by vscode-jsonrpc's built-in
    // METHOD_NOT_FOUND (-32601) response rather than crashing the host or bench.
    expect(h.connection.handlers.has("host.docker.startService")).toBe(false);
    expect(h.connection.handlers.has("host.totally.madeUp")).toBe(false);
  });

  it("METHOD_NOT_FOUND is -32601 (the JSON-RPC error a real connection returns for an unknown method)", () => {
    // Documents the contract the transport enforces: an unimplemented method
    // surfaces as a clean JSON-RPC error, not an exception in the host.
    const err = new ResponseError(-32601, "Method not found");
    expect(err.code).toBe(-32601);
  });

  it("fallback names a known-but-unregistered method and the minimum host version that provides it (CP-TC-009 S002-O01)", () => {
    const h = setup();
    // CP-TC-009 precondition, "simulated by patching the broker": a method that
    // exists in the surface catalogue (host.docker.assignContainer, part of the
    // v1 surface) invoked as if this host build never registered it. The star
    // fallback keeps the -32601 code but now names the method and its
    // introducedIn version instead of the transport's bare error.
    const star = need(h.connection.starHandler, "fallback (star) handler");
    let caught: unknown;
    try {
      star("host.docker.assignContainer", { benchId: 7 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseError);
    const err = caught as ResponseError<{ code: string; method: string; introducedIn?: string }>;
    expect(err.code).toBe(-32601);
    expect(err.message).toContain("host.docker.assignContainer");
    expect(err.message).toContain(BROKER_API_VERSION);
    expect(err.data).toMatchObject({
      code: "method-not-found",
      method: "host.docker.assignContainer",
      introducedIn: BROKER_API_VERSION,
    });
  });

  it("fallback names a truly-unknown method and states it is not part of any known surface", () => {
    const h = setup();
    const star = need(h.connection.starHandler, "fallback (star) handler");
    let caught: unknown;
    try {
      star("host.totally.madeUp", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseError);
    const err = caught as ResponseError<{ code: string; method: string; introducedIn?: string }>;
    expect(err.code).toBe(-32601);
    expect(err.message).toContain("host.totally.madeUp");
    expect(err.message).toMatch(/not part of any known/i);
    expect(err.data).toMatchObject({ code: "method-not-found", method: "host.totally.madeUp" });
    expect(err.data?.introducedIn).toBeUndefined();
  });
});

describe("PermissionEnforcer: deny undeclared broker calls (CP-TC-086, CP-TC-093)", () => {
  // One representative method per enforced category, with the args its handler
  // needs and the host delegate (on the harness) it must NOT reach when denied.
  const cases: Array<{
    category: BrokerPermissionCategory;
    method: string;
    params: unknown;
    delegate: (h: Harness) => ReturnType<typeof vi.fn>;
  }> = [
    {
      category: "process",
      method: "host.process.start",
      params: { id: "web", command: "node", args: [], env: {}, cwd: "/work" },
      delegate: (h) => h.pm.startProcess as ReturnType<typeof vi.fn>,
    },
    {
      category: "docker",
      method: "host.docker.composeUp",
      params: { projectName: "p", composeFile: "c.yml", cwd: "/w", service: "db", env: {} },
      delegate: (h) => h.docker.composeUp as ReturnType<typeof vi.fn>,
    },
    {
      category: "ports",
      method: "host.ports.get",
      params: { componentName: "web" },
      // ports.get reads ctx.ports directly; the "delegate" we assert against is
      // simply that no port value is returned (covered by the AC2 rejection).
      delegate: () => vi.fn(),
    },
  ];

  for (const { category, method, params } of cases) {
    it(`AC1: ${method} passes through unchanged when "${category}" is declared`, async () => {
      const h = setup({ allow: true, ports: { web: 3001 } });
      await expect(h.call(method, params)).resolves.toBeDefined();
      expect(h.hasPermission).toHaveBeenCalledWith(category);
    });

    it(`AC2: ${method} is denied with a permission-denied error when "${category}" is not declared`, async () => {
      const h = setup({ deny: [category], ports: { web: 3001 } });
      await expect(h.call(method, params)).rejects.toMatchObject({
        code: -32001,
        data: { code: "permission-denied", category, reason: "category-not-declared", method },
      });
      expect(h.hasPermission).toHaveBeenCalledWith(category);
      expect(h.log).toHaveBeenCalledWith("warn", expect.stringContaining(`${method} denied`));
    });
  }

  // AC3: a denied docker / process operation must never execute on the host.
  for (const { category, method, params, delegate } of cases.filter(
    (c) => c.category !== "ports",
  )) {
    it(`AC3: ${method} never reaches the host delegate when "${category}" is denied`, async () => {
      const h = setup({ deny: [category], ports: { web: 3001 } });
      await expect(h.call(method, params)).rejects.toMatchObject({ code: -32001 });
      expect(delegate(h)).not.toHaveBeenCalled();
    });
  }

  it("only the denied category is blocked; an unrelated declared category still passes", async () => {
    // process denied, docker allowed: the docker call must still go through.
    const h = setup({ deny: ["process"] });
    await expect(
      h.call("host.docker.composeDown", { projectName: "p", composeFile: "c.yml", cwd: "/w" }),
    ).resolves.toBeNull();
    expect(h.docker.composeDown).toHaveBeenCalled();
  });

  it("host.component.report* is not gated (no privileged category)", async () => {
    // reportStatus / reportLog are push sinks, not privileged ops; denying every
    // category must not block them.
    const h = setup({ deny: ["process", "docker", "ports"] });
    await expect(
      h.call("host.component.reportStatus", { name: "db", status: "running" }),
    ).resolves.toBeNull();
    expect(h.reportStatus).toHaveBeenCalled();
  });
});

describe("default services binding", () => {
  it("uses the real process-manager / docker modules when no overrides are supplied", () => {
    const connection = makeConnection();
    const ctx: BrokerContext = {
      pluginId: "p",
      benchId: 1,
      ports: {},
      reportStatus: vi.fn(),
      reportLog: vi.fn(),
      hasPermission: () => true,
      recordAudit: vi.fn(),
    };
    // Should register all handlers without throwing, binding default modules.
    expect(() => registerBrokerHandlers(connection, ctx)).not.toThrow();
    expect(connection.handlers.size).toBe(15);
  });
});

describe("audit recording of privileged calls (CP-TC-070/093)", () => {
  it("records an allowed entry for a gated process call with the raw params", async () => {
    const h = setup({ allow: true });
    const params = { id: "web", command: "node", args: ["server.js"], env: {}, cwd: "/work" };
    await h.call("host.process.start", params);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      pluginId: "plugin-under-test",
      benchId: 7,
      method: "host.process.start",
      params,
      outcome: "allowed",
    });
    expect(typeof h.audit[0].ts).toBe("string");
    expect(Number.isNaN(Date.parse(h.audit[0].ts))).toBe(false);
  });

  it("records a denied entry when the plugin lacks the permission category", async () => {
    const h = setup({ allow: false });
    // Enforcement (F2.1) throws permission-denied for a category the plugin did
    // not declare; the audit entry is recorded BEFORE that throw, so the denied
    // call still appears in the log with outcome "denied".
    await expect(
      h.call("host.docker.composeDown", {
        projectName: "p",
        composeFile: "c.yml",
        cwd: "/work",
      }),
    ).rejects.toMatchObject({ code: -32001 });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      method: "host.docker.composeDown",
      outcome: "denied",
    });
  });

  it("captures the raw params on a denied call, recorded before validation runs", async () => {
    const h = setup({ allow: false });
    // The gate records the audit entry with the raw, unvalidated params and then
    // throws permission-denied, before per-param validation. So even a call with
    // missing params (no id) is logged with its raw params and outcome "denied".
    await expect(h.call("host.process.stop", {})).rejects.toMatchObject({ code: -32001 });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      method: "host.process.stop",
      params: {},
      outcome: "denied",
    });
  });

  it("records one entry per gated call across the process / docker / ports families", async () => {
    const h = setup({ allow: true });
    await h.call("host.process.run", {
      id: "x",
      command: "echo",
      args: [],
      env: {},
      cwd: "/w",
    });
    await h.call("host.docker.composeUp", {
      projectName: "p",
      composeFile: "c.yml",
      cwd: "/w",
      service: "web",
      env: {},
    });
    await h.call("host.ports.get", { componentName: "web" });
    expect(h.audit.map((e) => e.method)).toEqual([
      "host.process.run",
      "host.docker.composeUp",
      "host.ports.get",
    ]);
    expect(h.audit.every((e) => e.outcome === "allowed")).toBe(true);
  });

  it("does NOT record the ungated component.report* and capability.query methods", async () => {
    const h = setup({ allow: true });
    await h.call("host.component.reportStatus", {
      name: "db",
      status: "running",
      setupComplete: true,
    });
    await h.call("host.component.reportLog", {
      source: "stdout",
      text: "hi",
      ts: "2026-06-21T00:00:00Z",
      componentName: "web",
    });
    await h.call("host.capability.query", { method: "host.docker.composeUp" });
    expect(h.audit).toHaveLength(0);
    expect(h.recordAudit).not.toHaveBeenCalled();
  });
});

describe("per-call BrokerContext resolver (#677; precise routing #685, multiplexed connection)", () => {
  // Build a BrokerContext that records its own audit entries, so we can assert a
  // privileged call routed to the context the resolver returned for the call's
  // benchId. reportLog records (componentName, line) pairs so we can assert
  // per-component routing within one bench.
  function makeCtx(
    benchId: number,
  ): BrokerContext & { audit: AuditEntry[]; logs: Array<{ componentName: string; text: string }> } {
    const audit: AuditEntry[] = [];
    const logs: Array<{ componentName: string; text: string }> = [];
    return {
      pluginId: "plugin-under-test",
      benchId,
      ports: { web: 3000 + benchId },
      reportStatus: vi.fn(),
      reportLog: (componentName, line) => logs.push({ componentName, text: line.text }),
      hasPermission: () => true,
      recordAudit: (entry: AuditEntry) => audit.push(entry),
      audit,
      logs,
    };
  }

  // A registry keyed by benchId, exactly mirroring plugin-manager's exact-key
  // resolver: the broker call carries its benchId in params and routes to that
  // bench's context, with no most-recent-wins fallback (#685).
  function makeRegistryResolver(contexts: Map<number, BrokerContext>) {
    return (benchId: number) => contexts.get(benchId) ?? null;
  }

  it("routes each call to its own bench by the param benchId, so audit attributes to the originating bench (#685 defect 1)", async () => {
    const connection = makeConnection();
    const ctxA = makeCtx(1);
    const ctxB = makeCtx(2);
    const contexts = new Map<number, BrokerContext>([
      [1, ctxA],
      [2, ctxB],
    ]);
    registerBrokerHandlers(connection, makeRegistryResolver(contexts), {
      processManager: makeProcessManager(),
      docker: makeDocker(),
      log: vi.fn(),
    });
    const call = (method: string, params?: unknown) =>
      need(connection.handlers.get(method), method)(params);

    // Two benches share the connection. A call naming bench 1 audits to bench 1,
    // a call naming bench 2 audits to bench 2, regardless of registration order.
    await call("host.process.start", {
      benchId: 1,
      id: "x",
      command: "node",
      args: [],
      env: {},
      cwd: "/w",
    });
    await call("host.process.stop", { benchId: 2, id: "x" });

    expect(ctxA.audit.map((e) => e.method)).toEqual(["host.process.start"]);
    expect(ctxA.audit[0].benchId).toBe(1);
    expect(ctxB.audit.map((e) => e.method)).toEqual(["host.process.stop"]);
    expect(ctxB.audit[0].benchId).toBe(2);
  });

  it("reads ports from the bench the call names, not the newest", async () => {
    const connection = makeConnection();
    const contexts = new Map<number, BrokerContext>([
      [1, makeCtx(1)],
      [5, makeCtx(5)],
    ]);
    registerBrokerHandlers(connection, makeRegistryResolver(contexts), {
      processManager: makeProcessManager(),
      docker: makeDocker(),
      log: vi.fn(),
    });
    const port = await need(
      connection.handlers.get("host.ports.get"),
      "host.ports.get",
    )({
      benchId: 5,
      componentName: "web",
    });
    expect(port).toBe(3005);
  });

  it("routes reportLog within one bench to the named component (#685 defect 2)", async () => {
    const connection = makeConnection();
    const ctx = makeCtx(1);
    const contexts = new Map<number, BrokerContext>([[1, ctx]]);
    registerBrokerHandlers(connection, makeRegistryResolver(contexts), {
      processManager: makeProcessManager(),
      docker: makeDocker(),
      log: vi.fn(),
    });
    const call = (params: unknown) =>
      need(connection.handlers.get("host.component.reportLog"), "host.component.reportLog")(params);

    // Two components in the SAME bench (one shared plugin/connection). Each log
    // routes to its own component sink instead of overwriting the other.
    await call({
      benchId: 1,
      componentName: "web",
      source: "stdout",
      text: "from-web",
      ts: "2026-06-21T00:00:00Z",
    });
    await call({
      benchId: 1,
      componentName: "db",
      source: "stderr",
      text: "from-db",
      ts: "2026-06-21T00:00:01Z",
    });

    expect(ctx.logs).toEqual([
      { componentName: "web", text: "from-web" },
      { componentName: "db", text: "from-db" },
    ]);
  });

  it("fails a privileged call with an internal-error when no bench context is bound for the named benchId", async () => {
    const connection = makeConnection();
    // Only bench 1 is bound; a call naming bench 9 resolves null, no fallback.
    const contexts = new Map<number, BrokerContext>([[1, makeCtx(1)]]);
    registerBrokerHandlers(connection, makeRegistryResolver(contexts), {
      processManager: makeProcessManager(),
      docker: makeDocker(),
      log: vi.fn(),
    });
    await expect(
      need(
        connection.handlers.get("host.process.start"),
        "host.process.start",
      )({
        benchId: 9,
        id: "x",
        command: "node",
        args: [],
        env: {},
        cwd: "/w",
      }),
    ).rejects.toMatchObject({ code: -32603 });
  });
});

describe("BROKER_METHODS registry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is frozen and every entry maps to the broker API version", () => {
    expect(Object.isFrozen(BROKER_METHODS)).toBe(true);
    for (const v of Object.values(BROKER_METHODS)) {
      expect(v).toBe(BROKER_API_VERSION);
    }
  });
});
