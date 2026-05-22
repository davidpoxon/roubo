import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, symlink, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginRecord } from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";

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
    await expect(mgr.readLogs("../etc", "current", 10)).rejects.toThrow(/Invalid plugin id/);
    await expect(mgr.readLogs("a/b", "current", 10)).rejects.toThrow(/Invalid plugin id/);
    await expect(mgr.readLogs("", "current", 10)).rejects.toThrow(/Invalid plugin id/);
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
