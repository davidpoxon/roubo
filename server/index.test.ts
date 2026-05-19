import { describe, it, expect, vi } from "vitest";

vi.mock("./services/env.js", () => ({
  loadEnvFile: vi.fn(),
  resolveShellPath: vi.fn(),
  resolveClaudeBinary: vi.fn(),
}));
vi.mock("./services/project-registry.js", () => ({
  initialize: vi.fn(),
  getProjects: vi.fn(() => []),
}));
vi.mock("./services/bench-manager.js", () => ({
  initialize: vi.fn(),
  reconcile: vi.fn(() => Promise.resolve()),
  getBenches: vi.fn(() => []),
  refreshComponentStatuses: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/process-manager.js", () => ({
  stopAllProcesses: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/database.js", () => ({
  closeIdleConnections: vi.fn(() => Promise.resolve()),
  closeAllConnections: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/terminal.js", () => ({
  loadPersistedSessions: vi.fn(),
  destroyAllSessions: vi.fn(),
  hasSession: vi.fn(() => false),
  handleWebSocket: vi.fn(),
}));
vi.mock("./services/blueprint-manager.js", () => ({
  startAppBlueprintsWatcher: vi.fn(),
  startWatchers: vi.fn(),
  stopAllWatchers: vi.fn(),
  listGlobalBlueprints: vi.fn(() => []),
}));
vi.mock("./services/auto-clear.js", () => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./services/version-check.js", () => ({
  checkForUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock("./services/claude-version.js", () => ({
  detectClaudeAutoMode: vi.fn(() => Promise.resolve()),
}));

import { startServer } from "./index.js";

describe.sequential("startServer", () => {
  it("port 0: OS assigns a free port and handle.port reflects it", async () => {
    const handle = await startServer({ port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/benches`);
    expect(res.status).toBe(200);
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
      }));
      vi.doMock("./services/process-manager.js", () => ({
        stopAllProcesses: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/database.js", () => ({
        closeIdleConnections: vi.fn(() => Promise.resolve()),
        closeAllConnections: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/terminal.js", () => ({
        loadPersistedSessions: vi.fn(),
        destroyAllSessions: vi.fn(),
        hasSession: vi.fn(() => false),
        handleWebSocket: vi.fn(),
      }));
      vi.doMock("./services/blueprint-manager.js", () => ({
        startAppBlueprintsWatcher: vi.fn(),
        startWatchers: vi.fn(),
        stopAllWatchers: vi.fn(),
        listGlobalBlueprints: vi.fn(() => []),
      }));
      vi.doMock("./services/auto-clear.js", () => ({
        start: vi.fn(),
        stop: vi.fn(),
      }));
      vi.doMock("./services/version-check.js", () => ({
        checkForUpdate: vi.fn(() => Promise.resolve()),
      }));
      vi.doMock("./services/claude-version.js", () => ({
        detectClaudeAutoMode: vi.fn(() => Promise.resolve()),
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
      vi.doUnmock("./services/database.js");
      vi.doUnmock("./services/terminal.js");
      vi.doUnmock("./services/blueprint-manager.js");
      vi.doUnmock("./services/auto-clear.js");
      vi.doUnmock("./services/version-check.js");
      vi.doUnmock("./services/claude-version.js");
      vi.resetModules();
      if (originalPort !== undefined) {
        process.env.ROUBO_PORT = originalPort;
      } else {
        delete process.env.ROUBO_PORT;
      }
    }
  });
});
