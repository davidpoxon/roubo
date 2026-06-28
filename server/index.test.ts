import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./services/env.js", () => ({
  loadEnvFile: vi.fn(),
  resolveShellPath: vi.fn(),
  resolveClaudeBinary: vi.fn(),
  cleanEnv: vi.fn(() => ({})),
  getClaudeBinary: vi.fn(() => "claude"),
  getEnvFileKeys: vi.fn(() => []),
  getContextWindow: vi.fn(() => 200000),
}));
vi.mock("./services/project-registry.js", () => ({
  initialize: vi.fn(),
  getProjects: vi.fn(() => []),
  getProject: vi.fn(),
  onProjectConfigLoaded: vi.fn(),
}));
vi.mock("./services/integration-migrations.js", () => ({
  initializeIntegrationMigrations: vi.fn(),
  awaitPendingIntegrationSetup: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/bench-manager.js", () => ({
  initialize: vi.fn(),
  reconcile: vi.fn(() => Promise.resolve()),
  getBenches: vi.fn(() => []),
  refreshComponentStatuses: vi.fn(() => Promise.resolve()),
  sweepOrphanedComposeProjects: vi.fn(() => Promise.resolve()),
  handleComponentPluginPreRestart: vi.fn(() => Promise.resolve()),
  handleComponentPluginRestarted: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/process-manager.js", () => ({
  stopAllProcesses: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/terminal.js", () => ({
  loadPersistedSessions: vi.fn(),
  destroyAllSessions: vi.fn(),
  hasSession: vi.fn(() => false),
  handleWebSocket: vi.fn(),
}));
vi.mock("./services/jig-manager.js", () => ({
  startAppJigsWatcher: vi.fn(),
  startWatchers: vi.fn(),
  stopAllWatchers: vi.fn(),
  listGlobalJigs: vi.fn(() => []),
}));
vi.mock("./services/version-check.js", () => ({
  checkForUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/claude-version.js", () => ({
  detectClaudeAutoMode: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/plugin-manager.js", () => ({
  initialize: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
  listInstalled: vi.fn(() => []),
  registerComponentPluginHooks: vi.fn(),
}));
vi.mock("./services/catalog-client.js", () => ({
  prefetch: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/migrate.js", () => ({
  run: vi.fn(() => Promise.resolve({ status: "noop" as const })),
  seedOnlyToDoNotice: vi.fn(() => null),
  isFreshInstall: vi.fn(() => false),
}));
vi.mock("./services/github.js", () => ({
  refreshAuth: vi.fn(() => Promise.resolve()),
}));

import * as benchManager from "./services/bench-manager.js";
import { startServer } from "./index.js";

describe.sequential("startServer", () => {
  beforeEach(() => {
    // startServer's bootstrap log/warn/error lines are noise during tests.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("port 0: OS assigns a free port and handle.port reflects it", async () => {
    const handle = await startServer({ port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/benches`);
    expect(res.status).toBe(200);
    await handle.shutdown();
  });

  it("runs the startup orphan sweep before reconcile and registers the crash hooks (issue #613)", async () => {
    const pluginManager = await import("./services/plugin-manager.js");
    const sweep = vi.mocked(benchManager.sweepOrphanedComposeProjects);
    const reconcile = vi.mocked(benchManager.reconcile);
    sweep.mockClear();
    reconcile.mockClear();

    const handle = await startServer({ port: 0 });

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    // Sweep must reap escaped projects before reconcile rebuilds the live view.
    expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0]);
    expect(pluginManager.registerComponentPluginHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        onComponentPluginPreRestart: benchManager.handleComponentPluginPreRestart,
        onComponentPluginRestarted: benchManager.handleComponentPluginRestarted,
      }),
    );

    await handle.shutdown();
  });

  it("specific port: binds to the requested port", async () => {
    const first = await startServer({ port: 0 });
    const knownFreePort = first.port;
    await first.shutdown();
    const second = await startServer({ port: knownFreePort });
    expect(second.port).toBe(knownFreePort);
    await second.shutdown();
  });

  it("shutdown: resolves cleanly and closes the listener", async () => {
    const handle = await startServer({ port: 0 });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${handle.port}/api/benches`)).rejects.toThrow();
  });

  it("GET /api/benches?issue=N excludes alert-backed benches that collide on the alert number (#291)", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, assignedIssue: { number: 42, externalId: "42" } },
      { id: 2, assignedIssue: { number: 42, externalId: "owner/repo#code-scanning-42" } },
    ] as any);
    const handle = await startServer({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/benches?issue=42`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: number }>;
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(1);
    } finally {
      await handle.shutdown();
      vi.mocked(benchManager.getBenches).mockReturnValue([]);
    }
  });

  it("port already in use: rejects with a bind error", async () => {
    const handle = await startServer({ port: 0 });
    await expect(startServer({ port: handle.port })).rejects.toThrow();
    await handle.shutdown();
  });

  it("shutdown: is idempotent (double call is a no-op)", async () => {
    const handle = await startServer({ port: 0 });
    await handle.shutdown();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("publishes the bound port to process.env.ROUBO_PORT so downstream code (Claude hook URL) can resolve it", async () => {
    // Downstream concern: writeClaudeSettingsLocal reads process.env.ROUBO_PORT
    // to build the notification hook URL written into each bench's
    // .claude/settings.local.json. With port: 0 the OS assigns the port, so
    // startServer must publish it back into the environment.
    const originalPort = process.env.ROUBO_PORT;
    delete process.env.ROUBO_PORT;
    try {
      const handle = await startServer({ port: 0 });
      expect(process.env.ROUBO_PORT).toBe(String(handle.port));
      await handle.shutdown();
    } finally {
      if (originalPort !== undefined) {
        process.env.ROUBO_PORT = originalPort;
      } else {
        delete process.env.ROUBO_PORT;
      }
    }
  });

  it("snapshots ROUBO_PORT after loadEnvFile() so a value populated from $ROUBO_DIR/.env is honored as the default", async () => {
    // The snapshot must be captured AFTER loadEnvFile() runs (so .env-supplied
    // values land in process.env first) but BEFORE startServer publishes the
    // bound port back. Reset module state so the first-call init block runs
    // again, and have loadEnvFile populate ROUBO_PORT to simulate a .env file.
    const originalPort = process.env.ROUBO_PORT;
    delete process.env.ROUBO_PORT;
    try {
      // Pre-pick a free port by binding 0, capturing the OS-chosen port, releasing.
      const probe = await startServer({ port: 0 });
      const freePort = probe.port;
      await probe.shutdown();

      vi.resetModules();
      vi.doMock("./services/env.js", () => ({
        loadEnvFile: vi.fn(() => {
          process.env.ROUBO_PORT = String(freePort);
        }),
        resolveShellPath: vi.fn(),
        resolveClaudeBinary: vi.fn(),
        cleanEnv: vi.fn(() => ({})),
        getClaudeBinary: vi.fn(() => "claude"),
        getEnvFileKeys: vi.fn(() => []),
        getContextWindow: vi.fn(() => 200000),
      }));
      vi.doMock("./services/project-registry.js", () => ({
        initialize: vi.fn(),
        getProjects: vi.fn(() => []),
      }));
      vi.doMock("./services/bench-manager.js", () => ({
        initialize: vi.fn(),
        reconcile: vi.fn(() => Promise.resolve()),
        getBenches: vi.fn(() => []),
        refreshComponentStatuses: vi.fn(() => Promise.resolve()),
        sweepOrphanedComposeProjects: vi.fn(() => Promise.resolve()),
        handleComponentPluginPreRestart: vi.fn(() => Promise.resolve()),
        handleComponentPluginRestarted: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/process-manager.js", () => ({
        stopAllProcesses: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/terminal.js", () => ({
        loadPersistedSessions: vi.fn(),
        destroyAllSessions: vi.fn(),
        hasSession: vi.fn(() => false),
        handleWebSocket: vi.fn(),
      }));
      vi.doMock("./services/jig-manager.js", () => ({
        startAppJigsWatcher: vi.fn(),
        startWatchers: vi.fn(),
        stopAllWatchers: vi.fn(),
        listGlobalJigs: vi.fn(() => []),
      }));
      vi.doMock("./services/version-check.js", () => ({
        checkForUpdate: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/claude-version.js", () => ({
        detectClaudeAutoMode: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/plugin-manager.js", () => ({
        initialize: vi.fn(() => Promise.resolve()),
        shutdown: vi.fn(() => Promise.resolve()),
        listInstalled: vi.fn(() => []),
        registerComponentPluginHooks: vi.fn(),
      }));
      vi.doMock("./services/catalog-client.js", () => ({
        prefetch: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/migrate.js", () => ({
        run: vi.fn(() => Promise.resolve({ status: "noop" as const })),
        seedOnlyToDoNotice: vi.fn(() => null),
        isFreshInstall: vi.fn(() => false),
      }));
      vi.doMock("./services/github.js", () => ({
        refreshAuth: vi.fn(() => Promise.resolve()),
      }));

      delete process.env.ROUBO_PORT;
      const fresh = (await import("./index.js")) as typeof import("./index.js");
      const handle = await fresh.startServer();
      expect(handle.port).toBe(freePort);
      expect(process.env.ROUBO_PORT).toBe(String(freePort));
      await handle.shutdown();
    } finally {
      vi.doUnmock("./services/env.js");
      vi.doUnmock("./services/project-registry.js");
      vi.doUnmock("./services/bench-manager.js");
      vi.doUnmock("./services/process-manager.js");
      vi.doUnmock("./services/terminal.js");
      vi.doUnmock("./services/jig-manager.js");
      vi.doUnmock("./services/version-check.js");
      vi.doUnmock("./services/claude-version.js");
      vi.doUnmock("./services/plugin-manager.js");
      vi.doUnmock("./services/catalog-client.js");
      vi.doUnmock("./services/migrate.js");
      vi.doUnmock("./services/github.js");
      vi.resetModules();
      if (originalPort !== undefined) {
        process.env.ROUBO_PORT = originalPort;
      } else {
        delete process.env.ROUBO_PORT;
      }
    }
  });
});
