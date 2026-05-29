import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginEnableState, PluginRecord } from "@roubo/shared";
import type { ConnectionStatus } from "@roubo/plugin-sdk";

vi.mock("./project-registry.js", () => ({
  getProjects: vi.fn(() => []),
}));
vi.mock("./active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(() => null),
}));

// Mock the persistence boundary so plugin-manager tests don't touch the real
// ~/.roubo/plugins-state.json. The unit-tested behaviour is "plugin-manager
// calls these in the right order" — the actual file IO is covered by
// plugin-enable-state.test.ts and the migrate integration test.
const enableStateMocks = vi.hoisted(() => {
  return {
    loadEnableState: vi.fn<() => PluginEnableState | null>(() => null),
    saveEnableState: vi.fn<(s: PluginEnableState) => void>(),
    setPluginEnabled: vi.fn<(id: string, enabled: boolean) => PluginEnableState>(),
    removePlugin: vi.fn<(id: string) => void>(),
  };
});
vi.mock("./plugin-enable-state.js", () => enableStateMocks);

beforeEach(() => {
  enableStateMocks.loadEnableState.mockReset().mockReturnValue(null);
  enableStateMocks.saveEnableState.mockReset();
  enableStateMocks.setPluginEnabled.mockReset().mockImplementation((id, enabled) => ({
    schemaVersion: 1,
    installInitialized: true,
    plugins: { [id]: enabled ? "enabled" : "disabled" },
  }));
  enableStateMocks.removePlugin.mockReset();
});

import * as pluginManager from "./plugin-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as activePlugin from "./active-plugin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(here, "__fixtures__", "plugins");

async function loadManager() {
  pluginManager.__test.reset();
  return pluginManager;
}

interface Sandbox {
  bundledDir: string;
  userDir: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(opts: { bundled?: string[]; user?: string[] }): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), "roubo-plugin-test-"));
  const bundledDir = path.join(root, "bundled");
  const userDir = path.join(root, "user");
  await mkdir(bundledDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  // Symlink (not copy) so the fixture's `require("vscode-jsonrpc/node")`
  // resolves via the project's node_modules through the realpath walk.
  for (const id of opts.bundled ?? []) {
    await symlink(path.join(FIXTURES_ROOT, id), path.join(bundledDir, id), "dir");
  }
  for (const id of opts.user ?? []) {
    await symlink(path.join(FIXTURES_ROOT, id), path.join(userDir, id), "dir");
  }
  process.env.ROUBO_BUNDLED_PLUGINS_DIR = bundledDir;
  process.env.ROUBO_USER_PLUGINS_DIR = userDir;
  return {
    bundledDir,
    userDir,
    cleanup: async () => {
      // Drain any in-flight writeLog calls before clearing ROUBO_USER_PLUGINS_DIR so logs from
      // the just-finished test don't race the env-var clear and leak into ~/.roubo.
      await pluginManager.__test.flushLogs();
      delete process.env.ROUBO_BUNDLED_PLUGINS_DIR;
      delete process.env.ROUBO_USER_PLUGINS_DIR;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function need<T>(value: T | undefined | null, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

function findRecord(records: PluginRecord[], id: string, source?: string): PluginRecord {
  const match = records.find((r) => r.id === id && (source === undefined || r.source === source));
  return need(match, `plugin ${id}`);
}

function getManager(): typeof pluginManager {
  return need(mgr, "manager");
}

let sandbox: Sandbox | null = null;
let mgr: typeof pluginManager | null = null;

afterEach(async () => {
  if (mgr) {
    try {
      await mgr.shutdown();
    } catch {
      // ignore
    }
    mgr = null;
  }
  if (sandbox) {
    await sandbox.cleanup();
    sandbox = null;
  }
});

describe("host-API version", () => {
  it("reports host-API 1.1.0 (FR-067, TC-128)", () => {
    expect(pluginManager.HOST_API_VERSION).toBe("1.1.0");
  });
});

describe("discovery", () => {
  it("discovers manifests from both bundled and user roots", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"], user: ["incompatible"] });
    mgr = await loadManager();
    await mgr.initialize();
    const installed = mgr.listInstalled();
    const ids = installed.map((p) => p.id).sort();
    expect(ids).toEqual(["echo", "incompatible"]);
    expect(findRecord(installed, "echo").source).toBe("bundled");
    expect(findRecord(installed, "incompatible").source).toBe("user");
  });

  it("flags invalid manifest as 'invalid' and continues boot (TC-002, FR-033)", async () => {
    sandbox = await makeSandbox({
      bundled: ["echo", "invalid-manifest"],
    });
    mgr = await loadManager();
    await mgr.initialize();
    const installed = mgr.listInstalled();
    const invalid = findRecord(installed, "invalid-manifest");
    expect(invalid.status).toBe("invalid");
    expect(invalid.lastError?.code).toBe("invalid-manifest");
    const echo = findRecord(installed, "echo");
    expect(echo.status).toBe("enabled");
    expect(echo.pid).not.toBeNull();
  });

  it("flags incompatible plugin and does not spawn it (TC-003)", async () => {
    sandbox = await makeSandbox({ bundled: ["incompatible"] });
    mgr = await loadManager();
    await mgr.initialize();
    const installed = mgr.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0].status).toBe("incompatible");
    expect(installed[0].pid).toBeNull();
  });

  it("prefers bundled over user when ids collide", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"], user: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const installed = mgr.listInstalled();
    const bundled = findRecord(installed, "echo", "bundled");
    expect(bundled.status).toBe("enabled");
    const userDup = installed.find(
      (p) => p.source === "user" && p.lastError?.code === "duplicate-id",
    );
    expect(userDup).toBeDefined();
  });

  it("resolves a relative plugins root against cwd before discovery (CodeQL #117 barrier)", async () => {
    // discoverRoot now resolves the env-overridable root and runs a
    // path-containment barrier before readdir (the CodeQL #117 sanitizer). A
    // relative ROUBO_BUNDLED_PLUGINS_DIR is normalised to an absolute path under
    // cwd, passes the barrier, and is discovered from there rather than throwing.
    sandbox = await makeSandbox({});
    const cwd = process.cwd();
    const relName = path.join("roubo-rel-plugins-test", "bundled");
    const absRel = path.join(cwd, relName);
    await mkdir(absRel, { recursive: true });
    await symlink(path.join(FIXTURES_ROOT, "echo"), path.join(absRel, "echo"), "dir");
    process.env.ROUBO_BUNDLED_PLUGINS_DIR = relName;
    mgr = await loadManager();
    try {
      await mgr.initialize();
      const installed = mgr.listInstalled();
      const echo = findRecord(installed, "echo", "bundled");
      expect(echo.status).toBe("enabled");
    } finally {
      await rm(path.join(cwd, "roubo-rel-plugins-test"), { recursive: true, force: true });
    }
  });
});

describe("lifecycle", () => {
  it("spawns an isolated child Node process per enabled plugin (TC-001, TC-004)", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const echo = findRecord(mgr.listInstalled(), "echo");
    expect(echo.status).toBe("enabled");
    expect(typeof echo.pid).toBe("number");
    const pid = need(echo.pid, "pid");
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("round-trips a JSON-RPC request via invoke (TC-005)", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const result = await mgr.invoke<{ payload: number }>("echo", "echo", { payload: 42 });
    expect(result).toEqual({ payload: 42 });
  });

  it("supports TC-033 by routing listIssueTypes through invoke", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const result = await mgr.invoke<{ id: string; name: string }[]>("echo", "listIssueTypes", {});
    expect(result).toEqual([
      { id: "bug", name: "Bug" },
      { id: "task", name: "Task" },
    ]);
  });

  // WU-066 / FR-061 (TC-172): enable() must throw when the plugin dies during
  // startup so the route handler can return 409 and the Enable-plugin prompt
  // modal can render the inline error. spawnPlugin captures sync failures
  // into entry.record without throwing, and a plugin that exits immediately
  // dies AFTER spawnPlugin returns. The setImmediate yield inside enable()
  // gives the exit handler a chance to fire so we can detect the death and
  // throw before the route returns.
  it("throws when a plugin exits during startup, leaving status=errored (WU-066)", async () => {
    sandbox = await makeSandbox({ bundled: ["echo", "crashy"] });
    mgr = await loadManager();
    await mgr.initialize();

    // crashy auto-restarts up to the budget on initialize; wait for the
    // budget exhaustion so we start from a deterministic errored baseline,
    // then disable to drop the in-memory process state cleanly.
    await waitFor(() => {
      const rec = getManager()
        .listInstalled()
        .find((p) => p.id === "crashy");
      return !!rec && rec.status === "errored";
    }, 15_000);
    await mgr.disable("crashy");

    await expect(mgr.enable("crashy")).rejects.toThrow(/exit/i);

    // TC-154 (#222): enable() rolls the record back to "disabled" (not
    // "errored") when the spawned process dies during startup, so the user
    // can retry without a restart cycle and the UI reflects a clean state.
    const rec = findRecord(mgr.listInstalled(), "crashy");
    expect(rec.status).toBe("disabled");
    // The persisted state was rolled back so the next boot doesn't keep
    // respawning the broken plugin.
    expect(enableStateMocks.setPluginEnabled).toHaveBeenCalledWith("crashy", false);
  }, 30_000);

  it("disables and re-enables a plugin (TC-013)", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const before = findRecord(mgr.listInstalled(), "echo");
    const firstPid = need(before.pid, "first pid");
    await mgr.disable("echo");
    const disabled = findRecord(mgr.listInstalled(), "echo");
    expect(disabled.status).toBe("disabled");
    expect(disabled.pid).toBeNull();
    await waitFor(() => {
      try {
        process.kill(firstPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await mgr.enable("echo");
    const reenabled = findRecord(mgr.listInstalled(), "echo");
    expect(reenabled.status).toBe("enabled");
    expect(reenabled.pid).not.toBeNull();
    expect(reenabled.pid).not.toBe(firstPid);
  });

  it("dispatches host.credentials.* with slot-scope enforcement (TC-070)", async () => {
    sandbox = await makeSandbox({ bundled: ["host-credentials-caller"] });
    mgr = await loadManager();
    await mgr.initialize();

    // Undeclared slot → structured permission-denied error reaches the plugin.
    const denied = await mgr.invoke<{
      ok: false;
      error: {
        message: string;
        code: number;
        data: { code: string; reason: string; slot: string };
      };
    }>("host-credentials-caller", "getCredential", { slot: "undeclared-slot" });
    expect(denied.ok).toBe(false);
    expect(denied.error.data).toEqual({
      code: "permission-denied",
      category: "credentials",
      slot: "undeclared-slot",
      reason: "slot-not-declared",
    });

    // Read-only-declared slot: set is denied with scope-read-only.
    const writeDenied = await mgr.invoke<{
      ok: false;
      error: { data: { reason: string } };
    }>("host-credentials-caller", "setCredential", { slot: "declared-ro", value: "x" });
    expect(writeDenied.ok).toBe(false);
    expect(writeDenied.error.data.reason).toBe("scope-read-only");

    // Denials are logged with the stable pluginId.methodName identifier.
    const logs = await mgr.readLogs("host-credentials-caller", "current", 200);
    expect(
      logs.some(
        (line) =>
          line.source === "host" &&
          line.text.includes("host-credentials-caller.host.credentials.get") &&
          line.text.includes("slot-not-declared"),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (line) =>
          line.source === "host" &&
          line.text.includes("host-credentials-caller.host.credentials.set") &&
          line.text.includes("scope-read-only"),
      ),
    ).toBe(true);
  });

  it("rejects off-allowlist host.fetch before any network I/O (TC-150)", async () => {
    sandbox = await makeSandbox({ bundled: ["host-fetch-caller"] });
    mgr = await loadManager();
    await mgr.initialize();

    const denied = await mgr.invoke<{
      ok: false;
      error: {
        message: string;
        code: number;
        data: {
          code: string;
          category: string;
          host: string;
          url: string;
          reason: string;
        };
      };
    }>("host-fetch-caller", "fetch", { url: "https://malicious.example.com/anything" });

    expect(denied.ok).toBe(false);
    expect(denied.error.data).toMatchObject({
      code: "network-denied",
      category: "network",
      host: "malicious.example.com",
      url: "https://malicious.example.com/anything",
    });

    const logs = await mgr.readLogs("host-fetch-caller", "current", 200);
    expect(
      logs.some(
        (line) =>
          line.source === "host" &&
          line.text.includes("host-fetch-caller.host.fetch denied") &&
          line.text.includes('host="malicious.example.com"'),
      ),
    ).toBe(true);
  });

  it("runs the @roubo/plugin-sdk reference fixture end-to-end (TC-035)", async () => {
    const { createServer } = await import("node:http");
    const issuePayload = {
      items: [
        {
          integrationId: "sdk-reference",
          externalId: "ISSUE-1",
          externalUrl: "http://example/ISSUE-1",
          title: "First",
          body: null,
          currentState: "open",
          allowedTransitions: [],
          assignees: [],
          labels: [],
          issueType: null,
          blocks: [],
          blockedBy: [],
          updatedAt: "2026-05-22T00:00:00.000Z",
          raw: null,
        },
      ],
      nextCursor: "page-2",
    };
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(issuePayload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port =
      typeof address === "object" && address && "port" in address
        ? (address as { port: number }).port
        : null;
    if (port === null) throw new Error("expected test HTTP server to have a port");
    process.env.SDK_REFERENCE_FETCH_URL = `http://127.0.0.1:${port}/issues`;

    try {
      sandbox = await makeSandbox({ bundled: ["sdk-reference"] });
      mgr = await loadManager();
      await mgr.initialize();

      const installed = findRecord(mgr.listInstalled(), "sdk-reference");
      expect(installed.status).toBe("enabled");

      // validateConfig: exercises a basic contract method + host.logger.warn
      const validation = await mgr.invoke<{ ok: boolean }>("sdk-reference", "validateConfig", {
        config: {},
      });
      expect(validation).toEqual({ ok: true });

      // listIssues: exercises host.fetch round-trip and the pagination shape
      const page = await mgr.invoke<{
        items: Array<{ externalId: string }>;
        nextCursor: string | null;
      }>("sdk-reference", "listIssues", { cursor: null, pageSize: 25 });
      expect(page.nextCursor).toBe("page-2");
      expect(page.items.map((i) => i.externalId)).toEqual(["ISSUE-1"]);

      // getCurrentUser: exercises host.credentials.get + host.logger.info.
      // The keyring may be empty in CI; either way the SDK returns cleanly.
      const user = await mgr.invoke<{ externalId: string }>("sdk-reference", "getCurrentUser", {});
      expect(typeof user.externalId).toBe("string");

      // host.logger.* are fire-and-forget JSON-RPC notifications; readLogs() now
      // drains pending writes internally so the info line is visible without an
      // explicit flushLogs here.
      const logs = await mgr.readLogs("sdk-reference", "current", 500);
      expect(
        logs.some(
          (line) =>
            line.source === "host" &&
            line.level === "warn" &&
            line.text.includes("validateConfig is a no-op"),
        ),
      ).toBe(true);
      expect(
        logs.some(
          (line) =>
            line.source === "host" &&
            line.level === "info" &&
            line.text.includes("getCurrentUser called"),
        ),
      ).toBe(true);
    } finally {
      delete process.env.SDK_REFERENCE_FETCH_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("shutdown tears children down within 5s and clears the registry (TC-077)", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const pid = need(findRecord(mgr.listInstalled(), "echo").pid, "pid");
    const t0 = Date.now();
    await mgr.shutdown();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_500);
    expect(mgr.listInstalled()).toHaveLength(0);
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
    mgr = null;
  });
});

describe("invoke timeouts and errors (TC-014, TC-073, TC-074)", () => {
  it("cancels a hanging call without orphaning the child (TC-014)", async () => {
    sandbox = await makeSandbox({ bundled: ["slow"] });
    mgr = await loadManager();
    await mgr.initialize();
    const pidBefore = need(findRecord(mgr.listInstalled(), "slow").pid, "pid");
    await expect(mgr.invoke("slow", "hang", {}, { timeoutMs: 150 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(() => process.kill(pidBefore, 0)).not.toThrow();
    const pong = await mgr.invoke<string>("slow", "ping", {}, { timeoutMs: 2_000 });
    expect(pong).toBe("pong");
  });

  it("survives a malformed JSON-RPC reply (TC-073)", async () => {
    sandbox = await makeSandbox({ bundled: ["echo", "garbage-bytes"] });
    mgr = await loadManager();
    await mgr.initialize();
    const result = await mgr.invoke<string>("echo", "ping", {});
    expect(result).toBe("pong");
    const garbage = findRecord(mgr.listInstalled(), "garbage-bytes");
    expect(garbage.pid).not.toBeNull();
  });

  it("handles an oversized JSON-RPC reply (TC-074)", async () => {
    sandbox = await makeSandbox({ bundled: ["oversized"] });
    mgr = await loadManager();
    await mgr.initialize();
    try {
      const result = await mgr.invoke<{ payload: string }>(
        "oversized",
        "oversized",
        {},
        { timeoutMs: 15_000 },
      );
      expect(result.payload.length).toBeGreaterThan(10_000_000);
    } catch (err) {
      expect(err).toBeTruthy();
    }
    const pong = await mgr.invoke<string>("oversized", "ping", {}, { timeoutMs: 2_000 });
    expect(pong).toBe("pong");
  }, 30_000);

  it("rejects invoke for an unknown plugin", async () => {
    sandbox = await makeSandbox({});
    mgr = await loadManager();
    await mgr.initialize();
    await expect(mgr.invoke("nope", "ping", {})).rejects.toMatchObject({
      code: "unknown-plugin",
    });
  });

  it("rejects invoke for a disabled plugin", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    await mgr.disable("echo");
    await expect(mgr.invoke("echo", "ping", {})).rejects.toMatchObject({
      code: "plugin-not-enabled",
    });
  });
});

describe("restart budget (TC-015)", () => {
  it("auto-restarts up to 3 times then marks errored", async () => {
    sandbox = await makeSandbox({ bundled: ["crashy"] });
    mgr = await loadManager();
    await mgr.initialize();
    await waitFor(() => {
      const rec = getManager()
        .listInstalled()
        .find((p) => p.id === "crashy");
      return !!rec && rec.status === "errored";
    }, 15_000);
    const rec = findRecord(mgr.listInstalled(), "crashy");
    expect(rec.status).toBe("errored");
    expect(rec.lastError?.code).toBe("restart-budget-exhausted");
    expect(rec.restartHistory.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  // TC-163 (#240): the e2e harness uses `__test.crashRunningPlugin` to drive
  // the supervisor through the same restart-budget arithmetic that TC-015
  // exercises via a self-crashing fixture. This test pins the helper's
  // contract independently: a healthy `echo` plugin SIGKILLed three times in
  // quick succession should land in `errored` with `restart-budget-exhausted`
  // and a `restartHistory` of length 3.
  it("crashRunningPlugin (TC-163) drives a healthy plugin to errored after 3 crashes", async () => {
    const originalE2E = process.env.ROUBO_E2E;
    process.env.ROUBO_E2E = "1";
    try {
      sandbox = await makeSandbox({ bundled: ["echo"] });
      mgr = await loadManager();
      await mgr.initialize();
      await waitFor(() => {
        const r = getManager()
          .listInstalled()
          .find((p) => p.id === "echo");
        return !!r && r.status === "enabled" && r.pid !== null;
      });
      for (let i = 0; i < 3; i++) {
        const expectedHistory = i + 1;
        mgr.__test.crashRunningPlugin("echo");
        // First wait for the SIGKILL to register through handleChildExit — the
        // restartHistory entry is pushed synchronously on the child's `exit`
        // event, so seeing history grow guards against the race where a fast
        // `pid !== null` check passes before the kill has taken effect.
        await waitFor(() => {
          const r = getManager()
            .listInstalled()
            .find((p) => p.id === "echo");
          return !!r && r.restartHistory.length >= expectedHistory;
        }, 8_000);
        // Then wait for the supervisor's next action: respawn on the first
        // two crashes, transition to errored on the third.
        await waitFor(() => {
          const r = getManager()
            .listInstalled()
            .find((p) => p.id === "echo");
          if (!r) return false;
          if (i < 2) return r.status === "enabled" && r.pid !== null;
          return r.status === "errored";
        }, 8_000);
      }
      const rec = findRecord(mgr.listInstalled(), "echo");
      expect(rec.status).toBe("errored");
      expect(rec.lastError?.code).toBe("restart-budget-exhausted");
      expect(rec.restartHistory.length).toBe(3);
    } finally {
      if (originalE2E === undefined) {
        delete process.env.ROUBO_E2E;
      } else {
        process.env.ROUBO_E2E = originalE2E;
      }
    }
  }, 30_000);

  it("crashRunningPlugin refuses to run without ROUBO_E2E=1", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    delete process.env.ROUBO_E2E;
    const m = need(mgr, "manager");
    expect(() => m.__test.crashRunningPlugin("echo")).toThrow(/ROUBO_E2E=1/);
  });

  it("crashRunningPlugin throws when the plugin is unknown or not running", async () => {
    const originalE2E = process.env.ROUBO_E2E;
    process.env.ROUBO_E2E = "1";
    try {
      sandbox = await makeSandbox({ bundled: ["echo"] });
      mgr = await loadManager();
      await mgr.initialize();
      const m = need(mgr, "manager");
      expect(() => m.__test.crashRunningPlugin("does-not-exist")).toThrow(/Unknown plugin/);
      await mgr.disable("echo");
      expect(() => m.__test.crashRunningPlugin("echo")).toThrow(/not running/);
    } finally {
      if (originalE2E === undefined) {
        delete process.env.ROUBO_E2E;
      } else {
        process.env.ROUBO_E2E = originalE2E;
      }
    }
  });

  it("manual restart clears the history and respawns a healthy plugin", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const entry = need(mgr.__test.getEntry("echo"), "echo entry");
    entry.record.restartHistory.push(
      { at: new Date().toISOString(), reason: "unexpected-exit", exitCode: 1 },
      { at: new Date().toISOString(), reason: "unexpected-exit", exitCode: 1 },
    );
    await mgr.restart("echo");
    const rec = findRecord(mgr.listInstalled(), "echo");
    expect(rec.status).toBe("enabled");
    expect(rec.restartHistory).toHaveLength(0);
    expect(rec.pid).not.toBeNull();
  });
});

describe("logs", () => {
  it("writes plugin stderr to current.log via readLogs", async () => {
    sandbox = await makeSandbox({ bundled: ["crashy"] });
    mgr = await loadManager();
    await mgr.initialize();
    await waitFor(() => {
      const rec = getManager()
        .listInstalled()
        .find((p) => p.id === "crashy");
      return !!rec && rec.status === "errored";
    }, 15_000);
    const logs = await mgr.readLogs("crashy", "current", 100);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.text.includes("exiting with code 1"))).toBe(true);
  }, 30_000);

  it("rejects plugin ids that contain path traversal characters", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    await expect(mgr.readLogs("../etc", "current", 10)).rejects.toThrow(/Invalid pluginId/);
    await expect(mgr.readLogs("a/b", "current", 10)).rejects.toThrow(/Invalid pluginId/);
    await expect(mgr.readLogs("", "current", 10)).rejects.toThrow(/Invalid pluginId/);
  }, 15_000);

  it("rotates current.log to previous.log when threshold exceeded", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    mgr.__test.setLogRotationBytes(256);
    await mgr.initialize();
    // Each log line is ~120 bytes once timestamped; 5 lines comfortably crosses 256.
    for (let i = 0; i < 5; i++) {
      await mgr.__test.appendLog("echo", "stdout", `line ${i} ${"x".repeat(70)}`);
    }
    const previousPath = path.join(sandbox.userDir, "echo", "logs", "previous.log");
    const exists = await stat(previousPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("round-trips multi-line text as a single log entry", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const multi = "spawn failed: [vitest] No 'cleanEnv' export\nIf you need to mock partially";
    await mgr.__test.appendLog("echo", "host", multi);
    await mgr.__test.flushLogs();
    const logs = await mgr.readLogs("echo", "current", 100);
    const match = logs.find((l) => l.text.startsWith("spawn failed:"));
    expect(match).toBeDefined();
    // The embedded newline survives the round-trip and the entry isn't fragmented.
    expect(match?.text).toBe(multi);
    expect(logs.filter((l) => l.text.startsWith("If you need to mock"))).toEqual([]);
  });

  it("returns ts: '' for malformed log lines (no synthesised 'now' timestamp)", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    // Simulate a pre-fix legacy log entry that doesn't match the strict format. To exercise
    // parseLogLine directly we write straight to current.log here (bypassing writeLog/openLogStream
    // so the legacy-rotation guard doesn't kick in on the same call).
    const logFile = path.join(sandbox.userDir, "echo", "logs", "current.log");
    await mkdir(path.dirname(logFile), { recursive: true });
    await writeFile(logFile, "this line has no timestamp prefix at all\n");
    // openLogStream will detect the legacy entry and rotate it to previous.log; read from there.
    await mgr.__test.appendLog("echo", "host", "after rotation");
    await mgr.__test.flushLogs();
    const previous = await mgr.readLogs("echo", "previous", 100);
    const malformed = previous.find((l) => l.text.includes("no timestamp prefix"));
    expect(malformed).toBeDefined();
    expect(malformed?.ts).toBe("");
  });

  it("auto-rotates a legacy log on first open and starts current.log clean", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const logDir = path.join(sandbox.userDir, "echo", "logs");
    await mkdir(logDir, { recursive: true });
    const current = path.join(logDir, "current.log");
    // Mix of one well-formed entry and one legacy multi-line record (no newline escape).
    await writeFile(
      current,
      "2026-05-01T00:00:00.000Z host [error] line A\n2026-05-01T00:00:00.001Z host [error] line B\nleaked continuation with no prefix\n",
    );
    // First writeLog after process start triggers the one-time rotation.
    await mgr.__test.appendLog("echo", "host", "fresh entry after rotation");
    await mgr.__test.flushLogs();
    const fresh = await mgr.readLogs("echo", "current", 100);
    expect(fresh.map((l) => l.text)).toEqual(["fresh entry after rotation"]);
    const archived = await mgr.readLogs("echo", "previous", 100);
    expect(archived.some((l) => l.text === "line A")).toBe(true);
    expect(archived.some((l) => l.text.includes("leaked continuation"))).toBe(true);
  });

  it("refuses to write to the real user plugins dir under NODE_ENV=test without an override", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    // Strip the isolation env var to simulate the leaky race: a writeLog scheduled before the
    // test's afterEach runs, resolving after cleanup has cleared ROUBO_USER_PLUGINS_DIR.
    const saved = process.env.ROUBO_USER_PLUGINS_DIR;
    delete process.env.ROUBO_USER_PLUGINS_DIR;
    try {
      await expect(mgr.__test.appendLog("echo", "host", "y")).rejects.toThrow(
        /refusing to write logs to the real user plugins dir/,
      );
    } finally {
      // Restore for the rest of the test lifecycle (sandbox.cleanup expects it set).
      if (saved !== undefined) process.env.ROUBO_USER_PLUGINS_DIR = saved;
    }
  });
});

describe("entry path validation", () => {
  it("rejects an absolute entry", async () => {
    sandbox = await makeSandbox({});
    const dir = path.join(sandbox.bundledDir, "bad-entry");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "roubo-plugin.yaml"),
      `id: bad-entry
name: Bad
version: 0.0.0
description: x
kind: integration
roubo: ^1.0.0
entry: /etc/passwd
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`,
    );
    mgr = await loadManager();
    await mgr.initialize();
    const rec = findRecord(mgr.listInstalled(), "bad-entry");
    expect(rec.status).toBe("invalid");
    expect(rec.lastError?.code).toBe("invalid-entry");
  });

  it("rejects a parent-escaping entry", async () => {
    sandbox = await makeSandbox({});
    const dir = path.join(sandbox.bundledDir, "escape");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "roubo-plugin.yaml"),
      `id: escape
name: Escape
version: 0.0.0
description: x
kind: integration
roubo: ^1.0.0
entry: ../outside.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`,
    );
    mgr = await loadManager();
    await mgr.initialize();
    const rec = findRecord(mgr.listInstalled(), "escape");
    expect(rec.status).toBe("invalid");
    expect(rec.lastError?.code).toBe("invalid-entry");
  });
});

describe("uninstall", () => {
  async function makeRealUserPluginDir(parent: string, id: string): Promise<string> {
    const dir = path.join(parent, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "roubo-plugin.yaml"),
      `id: ${id}
name: ${id}
version: 0.0.0
description: x
kind: integration
roubo: ^1.0.0
entry: ./index.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`,
    );
    // The entry path doesn't need to be runnable — we won't initialize a
    // process, we'll register via registerInstalled which spawns it briefly,
    // OR we'll add the entry manually for cases where we don't want to spawn.
    await writeFile(
      path.join(dir, "index.js"),
      "// no-op for uninstall test\nsetInterval(()=>{}, 60000);\n",
    );
    return dir;
  }

  afterEach(() => {
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
  });

  it("removes the plugin directory and drops the entry from listInstalled", async () => {
    sandbox = await makeSandbox({});
    mgr = await loadManager();
    await mgr.initialize();

    const dir = await makeRealUserPluginDir(sandbox.userDir, "to-remove");
    await mgr.registerInstalled(dir);
    expect(findRecord(mgr.listInstalled(), "to-remove").source).toBe("user");

    await mgr.uninstall("to-remove");

    expect(mgr.listInstalled().find((p) => p.id === "to-remove")).toBeUndefined();
    const dirGone = await stat(dir)
      .then(() => false)
      .catch(() => true);
    expect(dirGone).toBe(true);
    // WU-046: uninstall must also drop the plugin from plugins-state.json so
    // a future install of the same id starts from the default.
    expect(enableStateMocks.removePlugin).toHaveBeenCalledWith("to-remove");
  });

  it("refuses to uninstall a bundled plugin", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();

    await expect(mgr.uninstall("echo")).rejects.toThrow(/bundled plugins cannot be uninstalled/i);
    // Still present on disk and in the registry.
    expect(findRecord(mgr.listInstalled(), "echo").source).toBe("bundled");
  });

  it("throws for an unknown plugin id", async () => {
    sandbox = await makeSandbox({});
    mgr = await loadManager();
    await mgr.initialize();

    await expect(mgr.uninstall("does-not-exist")).rejects.toThrow(/unknown plugin/i);
  });

  it("refuses when the plugin is the active integration for one or more projects", async () => {
    sandbox = await makeSandbox({});
    mgr = await loadManager();
    await mgr.initialize();

    const dir = await makeRealUserPluginDir(sandbox.userDir, "still-active");
    await mgr.registerInstalled(dir);

    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      { id: "proj-a" },
      { id: "proj-b" },
      { id: "proj-c" },
    ] as never);
    vi.mocked(activePlugin.resolveActivePlugin).mockImplementation((projectId: string) =>
      projectId === "proj-a" || projectId === "proj-c"
        ? { pluginId: "still-active", integrationId: "still-active", pageSize: 50 }
        : null,
    );

    await expect(mgr.uninstall("still-active")).rejects.toThrow(/proj-a.*proj-c|proj-c.*proj-a/);

    // Plugin still installed and on disk.
    expect(findRecord(mgr.listInstalled(), "still-active").id).toBe("still-active");
    const exists = await stat(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("succeeds even when the plugin process is already stopped", async () => {
    sandbox = await makeSandbox({});
    mgr = await loadManager();
    await mgr.initialize();

    const dir = await makeRealUserPluginDir(sandbox.userDir, "already-stopped");
    await mgr.registerInstalled(dir);
    await mgr.disable("already-stopped");
    expect(findRecord(mgr.listInstalled(), "already-stopped").pid).toBeNull();

    await mgr.uninstall("already-stopped");
    expect(mgr.listInstalled().find((p) => p.id === "already-stopped")).toBeUndefined();
  });
});

describe("registerInstalled (WU-011)", () => {
  async function makeUserPluginDir(parent: string, id: string): Promise<string> {
    const dir = path.join(parent, id);
    await symlink(path.join(FIXTURES_ROOT, "echo"), dir, "dir");
    return dir;
  }

  it("registers a freshly-installed plugin dir and spawns it", async () => {
    sandbox = await makeSandbox({ bundled: [] });
    mgr = await loadManager();
    await mgr.initialize();
    expect(mgr.listInstalled()).toHaveLength(0);

    const target = await makeUserPluginDir(sandbox.userDir, "echo");
    const record = await mgr.registerInstalled(target);

    expect(record.id).toBe("echo");
    expect(record.status).toBe("enabled");
    expect(record.source).toBe("user");
    const installed = findRecord(mgr.listInstalled(), "echo");
    expect(installed.status).toBe("enabled");
    expect(typeof installed.pid).toBe("number");
  });

  it("throws if the plugin id is already registered", async () => {
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();

    const target = await makeUserPluginDir(sandbox.userDir, "echo");
    await expect(mgr.registerInstalled(target)).rejects.toThrow(/already registered/);
  });

  it("throws if the directory contains no manifest", async () => {
    sandbox = await makeSandbox({});
    mgr = await loadManager();
    await mgr.initialize();

    const empty = path.join(sandbox.userDir, "empty");
    await mkdir(empty, { recursive: true });
    await expect(mgr.registerInstalled(empty)).rejects.toThrow(/No roubo-plugin manifest/);
  });
});

describe("plugin-enable-state integration (WU-046)", () => {
  it("does not spawn plugins whose persisted state is 'disabled'", async () => {
    enableStateMocks.loadEnableState.mockReturnValueOnce({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { echo: "disabled" },
    });
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();

    const echo = findRecord(mgr.listInstalled(), "echo");
    expect(echo.status).toBe("disabled");
    expect(echo.pid).toBeNull();
  });

  it("spawns plugins whose persisted state is 'enabled'", async () => {
    enableStateMocks.loadEnableState.mockReturnValueOnce({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { echo: "enabled" },
    });
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();

    const echo = findRecord(mgr.listInstalled(), "echo");
    expect(echo.status).toBe("enabled");
    expect(echo.pid).not.toBeNull();
  });

  it("treats a missing plugins-state.json file as 'enable everything' (legacy install)", async () => {
    enableStateMocks.loadEnableState.mockReturnValueOnce(null);
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();

    const echo = findRecord(mgr.listInstalled(), "echo");
    expect(echo.status).toBe("enabled");
  });

  it("treats a plugin missing from the persisted map as enabled (preserves discovery default)", async () => {
    enableStateMocks.loadEnableState.mockReturnValueOnce({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "some-other-plugin": "disabled" },
    });
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();

    const echo = findRecord(mgr.listInstalled(), "echo");
    expect(echo.status).toBe("enabled");
  });

  it("write-throughs enable() to setPluginEnabled after a successful spawn (TC-154)", async () => {
    enableStateMocks.loadEnableState.mockReturnValueOnce({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { echo: "disabled" },
    });
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    expect(findRecord(mgr.listInstalled(), "echo").status).toBe("disabled");

    await mgr.enable("echo");

    expect(enableStateMocks.setPluginEnabled).toHaveBeenCalledWith("echo", true);
    expect(findRecord(mgr.listInstalled(), "echo").status).toBe("enabled");
  });

  // TC-154 (#222): NFR-024 ("plugin remains in its previous disabled state"
  // on spawn failure) is the invariant that broke when WU-046 ordered the
  // plugins-state.json write before the spawn attempt. This test pins the
  // corrected ordering: a plugin whose entry script crashes on launch must
  // (a) leave plugins-state.json unchanged, (b) surface a thrown error so
  // the route returns 4xx and EnablePluginPromptModal's onError fires, and
  // (c) leave the in-memory record back in "disabled" (not "errored" mid-
  // restart-cycle and not silently "enabled").
  it("does not write-through enable() on spawn failure and surfaces the error (TC-154, NFR-024)", async () => {
    enableStateMocks.loadEnableState.mockReturnValueOnce({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { crashy: "disabled" },
    });
    sandbox = await makeSandbox({ bundled: ["crashy"] });
    mgr = await loadManager();
    await mgr.initialize();
    expect(findRecord(mgr.listInstalled(), "crashy").status).toBe("disabled");
    expect(enableStateMocks.setPluginEnabled).not.toHaveBeenCalled();

    await expect(mgr.enable("crashy")).rejects.toThrow(/failed to start/i);

    expect(enableStateMocks.setPluginEnabled).not.toHaveBeenCalled();
    const rec = findRecord(mgr.listInstalled(), "crashy");
    expect(rec.status).toBe("disabled");
    expect(rec.restartHistory).toHaveLength(0);
  }, 15_000);

  it("write-throughs disable() to setPluginEnabled before stopping the process", async () => {
    enableStateMocks.loadEnableState.mockReturnValueOnce({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { echo: "enabled" },
    });
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    expect(findRecord(mgr.listInstalled(), "echo").status).toBe("enabled");

    await mgr.disable("echo");

    expect(enableStateMocks.setPluginEnabled).toHaveBeenCalledWith("echo", false);
    expect(findRecord(mgr.listInstalled(), "echo").status).toBe("disabled");
  });
});

describe("getConnectionStatus (WU-044)", () => {
  const PLUGIN_ID = "github-com";
  const CONFIG = { instance: "https://api.github.com" };
  const FROZEN_TIME = new Date("2026-05-25T12:00:00.000Z");

  type InvokerArgs = [string, string, unknown, { timeoutMs?: number } | undefined];
  let invokerMock: ReturnType<typeof vi.fn<(...a: InvokerArgs) => Promise<unknown>>>;

  function methodNotFound(method: string): Error & { code: string } {
    const err = new Error(`Method not found: ${method}`) as Error & { code: string };
    err.code = "MethodNotFound";
    return err;
  }

  beforeEach(() => {
    pluginManager.__test.reset();
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_TIME);
    invokerMock = vi.fn();
    pluginManager.__test.setConnectionStatusInvoker(invokerMock);
    // TC-153 / NFR-023: every observed state transition is written to the
    // host structured logger (console.info JSON line). Suppress here so the
    // tests that don't care about the log do not leak it to stdout; the
    // TC-153 sub-describe below reads the captured calls off this spy.
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    pluginManager.__test.setConnectionStatusInvoker(null);
    pluginManager.__test.resetConnectionStatusCache();
    vi.restoreAllMocks();
  });

  it("returns the plugin's reported status when getConnectionStatus is implemented", async () => {
    invokerMock.mockResolvedValueOnce({
      state: "connected",
      checkedAt: "2026-05-25T11:59:59.000Z",
    });

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({ state: "connected", checkedAt: "2026-05-25T11:59:59.000Z" });
    expect(invokerMock).toHaveBeenCalledExactlyOnceWith(
      PLUGIN_ID,
      "getConnectionStatus",
      undefined,
      { timeoutMs: 5_000 },
    );
  });

  it("falls back to validateConfig and reports connected when ok (TC-113)", async () => {
    invokerMock
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockResolvedValueOnce({ ok: true });

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });
    expect(invokerMock).toHaveBeenNthCalledWith(
      2,
      PLUGIN_ID,
      "validateConfig",
      { config: CONFIG },
      { timeoutMs: 5_000 },
    );
  });

  it("falls back to validateConfig and reports auth-problem with detail when not ok", async () => {
    invokerMock.mockRejectedValueOnce(methodNotFound("getConnectionStatus")).mockResolvedValueOnce({
      ok: false,
      errors: [{ field: "token", message: "Token expired" }],
    });

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "auth-problem",
      detail: "Token expired",
      checkedAt: FROZEN_TIME.toISOString(),
    });
  });

  it("reports auth-problem with undefined detail when validateConfig returns no errors array", async () => {
    invokerMock
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockResolvedValueOnce({ ok: false });

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "auth-problem",
      detail: undefined,
      checkedAt: FROZEN_TIME.toISOString(),
    });
  });

  it("treats both methods missing as connected (no plugin-wide config to validate)", async () => {
    invokerMock
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockRejectedValueOnce(methodNotFound("validateConfig"));

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });
  });

  it("reports errored when validateConfig throws a non-MethodNotFound error", async () => {
    const boom = Object.assign(new Error("upstream down"), { code: "rpc-error" });
    invokerMock
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockRejectedValueOnce(boom);

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "errored",
      detail: "upstream down",
      checkedAt: FROZEN_TIME.toISOString(),
    });
  });

  it("reports errored when getConnectionStatus throws a non-MethodNotFound error", async () => {
    const boom = Object.assign(new Error("connection refused"), { code: "rpc-error" });
    invokerMock.mockRejectedValueOnce(boom);

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "errored",
      detail: "connection refused",
      checkedAt: FROZEN_TIME.toISOString(),
    });
    expect(invokerMock).toHaveBeenCalledTimes(1);
  });

  it("produces a parseable ISO-8601 checkedAt in fallback paths", async () => {
    invokerMock
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockResolvedValueOnce({ ok: true });

    const status = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  });

  it("returns the cached value for subsequent calls within the 30s TTL", async () => {
    invokerMock.mockResolvedValueOnce({
      state: "connected",
      checkedAt: FROZEN_TIME.toISOString(),
    });

    const first = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
    vi.advanceTimersByTime(pluginManager.CONNECTION_STATUS_TTL_MS - 1);
    const second = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(second).toEqual(first);
    expect(invokerMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the 30s TTL expires", async () => {
    invokerMock
      .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() })
      .mockResolvedValueOnce({
        state: "auth-problem",
        detail: "token expired",
        checkedAt: new Date(FROZEN_TIME.getTime() + 31_000).toISOString(),
      });

    await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
    vi.advanceTimersByTime(pluginManager.CONNECTION_STATUS_TTL_MS + 1);
    const second = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(second.state).toBe("auth-problem");
    expect(invokerMock).toHaveBeenCalledTimes(2);
  });

  it("de-dups concurrent in-flight calls for the same plugin (acceptance criterion)", async () => {
    let resolveInvoker: (value: ConnectionStatus) => void = () => {};
    invokerMock.mockReturnValueOnce(
      new Promise<ConnectionStatus>((resolve) => {
        resolveInvoker = resolve;
      }),
    );

    const inFlight = pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
    const piggyback = pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    resolveInvoker({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });
    const [a, b] = await Promise.all([inFlight, piggyback]);

    expect(a).toEqual(b);
    expect(invokerMock).toHaveBeenCalledTimes(1);
  });

  it("releases the in-flight slot after settle so the next call can refresh post-TTL", async () => {
    invokerMock
      .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() })
      .mockResolvedValueOnce({
        state: "connected",
        checkedAt: new Date(FROZEN_TIME.getTime() + 31_000).toISOString(),
      });

    await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
    vi.advanceTimersByTime(pluginManager.CONNECTION_STATUS_TTL_MS + 1);
    await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(invokerMock).toHaveBeenCalledTimes(2);
  });

  describe("force option (WU-050)", () => {
    it("bypasses the value cache so the next call re-probes the plugin", async () => {
      invokerMock
        .mockResolvedValueOnce({ state: "auth-problem", checkedAt: FROZEN_TIME.toISOString() })
        .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });

      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
      const fresh = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { force: true });

      expect(fresh.state).toBe("connected");
      expect(invokerMock).toHaveBeenCalledTimes(2);
    });

    it("still participates in per-plugin in-flight dedup", async () => {
      let resolveInvoker: (value: ConnectionStatus) => void = () => {};
      invokerMock.mockReturnValueOnce(
        new Promise<ConnectionStatus>((resolve) => {
          resolveInvoker = resolve;
        }),
      );

      const forced = pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { force: true });
      const piggyback = pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { force: true });

      resolveInvoker({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });
      const [a, b] = await Promise.all([forced, piggyback]);

      expect(a).toEqual(b);
      expect(invokerMock).toHaveBeenCalledTimes(1);
    });

    it("piggy-backs on an in-flight non-forced call instead of starting a second RPC", async () => {
      let resolveInvoker: (value: ConnectionStatus) => void = () => {};
      invokerMock.mockReturnValueOnce(
        new Promise<ConnectionStatus>((resolve) => {
          resolveInvoker = resolve;
        }),
      );

      const cached = pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
      const forced = pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { force: true });

      resolveInvoker({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });
      await Promise.all([cached, forced]);

      expect(invokerMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidateConnectionStatus (WU-031)", () => {
    it("drops the cached value so the next call re-probes the plugin", async () => {
      invokerMock
        .mockResolvedValueOnce({ state: "auth-problem", checkedAt: FROZEN_TIME.toISOString() })
        .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });

      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
      pluginManager.invalidateConnectionStatus(PLUGIN_ID);
      const fresh = await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

      expect(fresh.state).toBe("connected");
      expect(invokerMock).toHaveBeenCalledTimes(2);
    });

    it("only invalidates the named plugin, leaving other caches intact", async () => {
      invokerMock
        .mockResolvedValueOnce({ state: "auth-problem", checkedAt: FROZEN_TIME.toISOString() })
        .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });

      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
      await pluginManager.getConnectionStatus("ghe", CONFIG);
      pluginManager.invalidateConnectionStatus(PLUGIN_ID);

      const ghe = await pluginManager.getConnectionStatus("ghe", CONFIG);
      expect(ghe.state).toBe("connected");
      expect(invokerMock).toHaveBeenCalledTimes(2);
    });

    it("is a no-op when called with an unknown pluginId", () => {
      expect(() => pluginManager.invalidateConnectionStatus("does-not-exist")).not.toThrow();
    });
  });

  // TC-153 / NFR-023: every transition is written to the host's structured
  // logger (console.info as a JSON line). Under ROUBO_E2E=1 the same entries
  // are mirrored to an in-memory tap so Playwright specs (TC-169) can poll
  // without scraping the server's stdout. These tests reuse the parent
  // describe's `console.info` spy (installed in the outer beforeEach).
  describe("connection-state structured logging (TC-153)", () => {
    const originalRouboE2E = process.env.ROUBO_E2E;

    afterEach(() => {
      if (originalRouboE2E === undefined) {
        delete process.env.ROUBO_E2E;
      } else {
        process.env.ROUBO_E2E = originalRouboE2E;
      }
    });

    function decodeEmittedEntries(): unknown[] {
      const spy = vi.mocked(console.info);
      return spy.mock.calls.map((args) => {
        const first = args[0];
        if (typeof first !== "string") {
          throw new Error("console.info expected a JSON string, got " + typeof first);
        }
        return JSON.parse(first) as unknown;
      });
    }

    it("emits a JSON log line on the first observation (null → state)", async () => {
      invokerMock.mockResolvedValueOnce({
        state: "connected",
        checkedAt: FROZEN_TIME.toISOString(),
      });

      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { trigger: "ui-recheck" });

      const entries = decodeEmittedEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        event: "plugin.connection-state.changed",
        pluginId: PLUGIN_ID,
        previousState: null,
        newState: "connected",
        trigger: "ui-recheck",
      });
      const at = (entries[0] as { at: string }).at;
      expect(Number.isNaN(Date.parse(at))).toBe(false);
    });

    it("emits a second JSON log line when the state changes between calls", async () => {
      invokerMock
        .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() })
        .mockResolvedValueOnce({
          state: "auth-problem",
          detail: "Token expired",
          checkedAt: FROZEN_TIME.toISOString(),
        });

      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { trigger: "ui-recheck" });
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, {
        force: true,
        trigger: "ui-recheck",
      });

      const entries = decodeEmittedEntries();
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({
        event: "plugin.connection-state.changed",
        pluginId: PLUGIN_ID,
        previousState: "connected",
        newState: "auth-problem",
        trigger: "ui-recheck",
      });
    });

    it("emits nothing when the state is unchanged between calls", async () => {
      invokerMock
        .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() })
        .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });

      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { force: true });

      const entries = decodeEmittedEntries();
      expect(entries).toHaveLength(1);
      expect((entries[0] as { newState: string }).newState).toBe("connected");
    });

    it("defaults the trigger to opportunistic-recheck when not provided", async () => {
      invokerMock.mockResolvedValueOnce({
        state: "connected",
        checkedAt: FROZEN_TIME.toISOString(),
      });

      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);

      const entries = decodeEmittedEntries();
      expect((entries[0] as { trigger: string }).trigger).toBe("opportunistic-recheck");
    });

    it("mirrors emissions into the e2e tap only when ROUBO_E2E=1", async () => {
      invokerMock.mockResolvedValueOnce({
        state: "connected",
        checkedAt: FROZEN_TIME.toISOString(),
      });

      delete process.env.ROUBO_E2E;
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { trigger: "ui-recheck" });
      expect(pluginManager.__test.getE2EConnectionStateLogTap()).toEqual([]);

      // Same plugin, force-reload to drive a second transition under the tap.
      invokerMock.mockResolvedValueOnce({
        state: "auth-problem",
        detail: "Token expired",
        checkedAt: FROZEN_TIME.toISOString(),
      });
      process.env.ROUBO_E2E = "1";
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, {
        force: true,
        trigger: "ui-recheck",
      });

      const tap = pluginManager.__test.getE2EConnectionStateLogTap();
      expect(tap).toHaveLength(1);
      expect(tap[0]).toMatchObject({
        event: "plugin.connection-state.changed",
        pluginId: PLUGIN_ID,
        previousState: "connected",
        newState: "auth-problem",
        trigger: "ui-recheck",
      });
    });

    it("resetE2EConnectionStateLogTap clears the tap", async () => {
      process.env.ROUBO_E2E = "1";
      invokerMock.mockResolvedValueOnce({
        state: "connected",
        checkedAt: FROZEN_TIME.toISOString(),
      });
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG);
      expect(pluginManager.__test.getE2EConnectionStateLogTap()).toHaveLength(1);

      pluginManager.__test.resetE2EConnectionStateLogTap();
      expect(pluginManager.__test.getE2EConnectionStateLogTap()).toEqual([]);
    });
  });
});

// WU-063: when the Playwright harness pins a scenario + frozen-now via
// __test.setE2EConfig under ROUBO_E2E=1, the spawned plugin must receive the
// values as --scenario / --now argv. The echo fixture exposes process.argv
// over RPC so we can assert on the child's actual argv.
describe("e2e config argv propagation (WU-063)", () => {
  const originalRouboE2E = process.env.ROUBO_E2E;

  afterEach(() => {
    if (originalRouboE2E === undefined) {
      delete process.env.ROUBO_E2E;
    } else {
      process.env.ROUBO_E2E = originalRouboE2E;
    }
  });

  it("appends --scenario / --now when set and ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    mgr.__test.setE2EConfig({
      scenario: "github-com-multi-list",
      now: "2026-05-21T12:00:00.000Z",
    });
    await mgr.initialize();
    const argv = await mgr.invoke<string[]>("echo", "argv", {});
    expect(argv).toContain("--scenario=github-com-multi-list");
    expect(argv).toContain("--now=2026-05-21T12:00:00.000Z");
  });

  it("omits both flags when no e2e config is set", async () => {
    process.env.ROUBO_E2E = "1";
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    await mgr.initialize();
    const argv = await mgr.invoke<string[]>("echo", "argv", {});
    expect(argv.some((a) => a.startsWith("--scenario"))).toBe(false);
    expect(argv.some((a) => a.startsWith("--now"))).toBe(false);
  });

  it("omits both flags when ROUBO_E2E is not '1', even if config is set", async () => {
    delete process.env.ROUBO_E2E;
    sandbox = await makeSandbox({ bundled: ["echo"] });
    mgr = await loadManager();
    mgr.__test.setE2EConfig({ scenario: "any", now: "2026-01-01T00:00:00.000Z" });
    await mgr.initialize();
    const argv = await mgr.invoke<string[]>("echo", "argv", {});
    expect(argv.some((a) => a.startsWith("--scenario"))).toBe(false);
    expect(argv.some((a) => a.startsWith("--now"))).toBe(false);
  });

  it("__test.reset clears any pinned e2e config", async () => {
    mgr = await loadManager();
    mgr.__test.setE2EConfig({ scenario: "x", now: "2026-01-01T00:00:00.000Z" });
    expect(mgr.__test.getE2EConfig()).toEqual({
      scenario: "x",
      now: "2026-01-01T00:00:00.000Z",
    });
    mgr.__test.reset();
    expect(mgr.__test.getE2EConfig()).toEqual({ scenario: null, now: null });
  });
});
