import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { BrokerContext, ComponentStatus } from "@roubo/shared";
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

function need<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be registered`);
  return value;
}

function makeProcessManager(): ProcessManagerLike {
  return {
    startProcess: vi.fn(async () => ({ pid: 4242 })),
    runProcess: vi.fn(async () => ({ exitCode: 0 })),
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
  log: ReturnType<typeof vi.fn>;
  call: (method: string, params?: unknown) => Promise<unknown>;
}

function setup(opts: { ports?: Record<string, number>; allow?: boolean } = {}): Harness {
  const connection = makeConnection();
  const pm = makeProcessManager();
  const docker = makeDocker();
  const reportStatus = vi.fn();
  const reportLog = vi.fn();
  const assignContainer = vi.fn();
  const hasPermission = vi.fn(() => opts.allow ?? true);
  const log = vi.fn();
  const ctx: BrokerContext = {
    ports: opts.ports ?? { web: 3001, db: 5433 },
    reportStatus,
    reportLog,
    assignContainer,
    hasPermission,
  };
  registerBrokerHandlers(connection, ctx, { processManager: pm, docker, log });
  // Wrap in an async function so a handler's synchronous throw (validation
  // errors on the sync handlers) surfaces as a rejected promise, exactly as
  // vscode-jsonrpc converts a thrown ResponseError into a JSON-RPC error reply.
  const call = async (method: string, params?: unknown) =>
    need(connection.handlers.get(method), method)(params);
  return {
    connection,
    pm,
    docker,
    ctx,
    reportStatus,
    reportLog,
    assignContainer,
    hasPermission,
    log,
    call,
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

  it("composeStop delegates with the service when given, and empty string otherwise", async () => {
    const h = setup();
    await h.call("host.docker.composeStop", {
      projectName: "p",
      composeFile: "c.yml",
      cwd: "/w",
      service: "db",
    });
    expect(h.docker.composeStop).toHaveBeenCalledWith("p", "c.yml", "/w", "db");
    await h.call("host.docker.composeStop", { projectName: "p", composeFile: "c.yml", cwd: "/w" });
    expect(h.docker.composeStop).toHaveBeenLastCalledWith("p", "c.yml", "/w", "");
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

describe("host.docker.assignContainer advisory gate (CP-TC-026)", () => {
  it("records the assignment through the injected sink", async () => {
    const h = setup();
    const result = await h.call("host.docker.assignContainer", {
      componentName: "db",
      containerId: "ext-999",
    });
    expect(h.assignContainer).toHaveBeenCalledWith("db", "ext-999");
    expect(result).toBeNull();
  });

  it("warns but still proceeds when docker permission is not declared (advisory in v1)", async () => {
    const h = setup({ allow: false });
    await h.call("host.docker.assignContainer", { componentName: "db", containerId: "ext-1" });
    // advisory: the call is NOT denied, the assignment still happens.
    expect(h.assignContainer).toHaveBeenCalledWith("db", "ext-1");
    expect(h.hasPermission).toHaveBeenCalledWith("docker");
    expect(h.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("host.docker.assignContainer"),
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
    expect(h.reportStatus).toHaveBeenCalledWith(status);
    expect(result).toBeNull();
  });

  it("reportStatus rejects a non-object payload", async () => {
    const h = setup();
    await expect(h.call("host.component.reportStatus", "nope")).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("reportLog pushes a {source,text,ts} line into the injected sink", async () => {
    const h = setup();
    const line = { source: "stdout" as const, text: "hello", ts: "2026-06-21T00:00:00Z" };
    const result = await h.call("host.component.reportLog", line);
    expect(h.reportLog).toHaveBeenCalledWith(line);
    expect(result).toBeNull();
  });

  it("reportLog rejects an invalid source", async () => {
    const h = setup();
    await expect(
      h.call("host.component.reportLog", { source: "stdin", text: "x", ts: "t" }),
    ).rejects.toMatchObject({ code: -32602 });
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
});

describe("default services binding", () => {
  it("uses the real process-manager / docker modules when no overrides are supplied", () => {
    const connection = makeConnection();
    const ctx: BrokerContext = {
      ports: {},
      reportStatus: vi.fn(),
      reportLog: vi.fn(),
      hasPermission: () => true,
    };
    // Should register all handlers without throwing, binding default modules.
    expect(() => registerBrokerHandlers(connection, ctx)).not.toThrow();
    expect(connection.handlers.size).toBe(15);
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
