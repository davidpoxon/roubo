import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginEnableState, ResourceOwnershipEntry } from "@roubo/shared";

// Plugin process swap (HR-FR-009) and removal while in use (HR-FR-010), driven
// through the real plugin-manager with real child processes. The ownership
// ledger is an in-memory fake, so the tests can read it before and after a swap
// without touching a state.json; the Docker daemon and host processes are out
// of scope here (bench-manager's re-bind tests cover them).

const ledgerFake = vi.hoisted(() => ({ entries: [] as ResourceOwnershipEntry[] }));
vi.mock("./resource-ownership-ledger.js", () => ({
  getAllEntries: vi.fn(() => ledgerFake.entries),
  getEntry: vi.fn((pluginId: string, benchId: number) =>
    ledgerFake.entries.find((e) => e.pluginId === pluginId && e.benchId === benchId),
  ),
  clearEntry: vi.fn((pluginId: string, benchId: number) => {
    ledgerFake.entries = ledgerFake.entries.filter(
      (e) => !(e.pluginId === pluginId && e.benchId === benchId),
    );
  }),
  recordProcess: vi.fn(),
  recordComposeProject: vi.fn(),
  removeProcess: vi.fn(),
  removeComposeProject: vi.fn(),
}));
vi.mock("./project-registry.js", () => ({ getProjects: vi.fn(() => []) }));
vi.mock("./active-plugin.js", () => ({ resolveActivePlugin: vi.fn(() => null) }));
vi.mock("./cut-list-query-service.js", () => ({
  cutListQueryService: { evictPlugin: vi.fn(), evictProject: vi.fn() },
}));
vi.mock("./plugin-enable-state.js", () => ({
  loadEnableState: vi.fn<() => PluginEnableState | null>(() => null),
  saveEnableState: vi.fn(),
  setPluginEnabled: vi.fn(),
  removePlugin: vi.fn(),
}));
const consentFake = vi.hoisted(() => ({ acknowledged: ["ports"] as string[] }));
vi.mock("./plugin-consent-state.js", () => ({
  getConsent: vi.fn((pluginId: string) => ({
    pluginId,
    acknowledgedCategories: consentFake.acknowledged,
    consentedAt: "2026-11-01T00:00:00.000Z",
  })),
  hasConsent: vi.fn(() => true),
  removeConsent: vi.fn(),
}));
vi.mock("./plugin-provenance-state.js", () => ({
  getProvenance: vi.fn(() => null),
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  markOrphanedBySource: vi.fn(() => 0),
}));

import * as pluginManager from "./plugin-manager.js";
import * as swapState from "./plugin-swap-state.js";

const JSONRPC_PATH = createRequire(import.meta.url).resolve("vscode-jsonrpc/node");

// A component plugin that answers `translate` and a per-bench `componentStatus`
// with its own pid, so a test can tell which process answered.
const ENTRY_SOURCE = `"use strict";
const rpc = require(${JSON.stringify(JSONRPC_PATH)});
const connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(process.stdin),
  new rpc.StreamMessageWriter(process.stdout),
);
connection.onRequest("ping", () => "pong");
connection.onRequest("translate", (p) => ({ kind: "process", command: "run", benchId: p.context.benchId }));
connection.onRequest("componentStatus", (p) => ({ benchId: p.benchId, status: "running", pid: process.pid }));
connection.listen();
`;

const EXITS_AT_START = `"use strict";\nprocess.exit(1);\n`;

interface ManifestOptions {
  version?: string;
  contractVersion?: number;
  componentMode?: "imperative";
  docker?: boolean;
}

function manifestYaml(opts: ManifestOptions = {}): string {
  return [
    "id: database",
    "name: Database",
    `version: ${opts.version ?? "1.0.0"}`,
    "description: A component fixture for the swap tests",
    "kind: component",
    "roubo: ^1.3.0",
    "entry: ./index.cjs",
    `contractVersion: ${opts.contractVersion ?? 1}`,
    ...(opts.componentMode ? [`componentMode: ${opts.componentMode}`] : []),
    "permissions:",
    "  network:",
    "    hosts: []",
    "  credentials:",
    "    slots: []",
    "  filesystem:",
    "    paths: []",
    "  processes: false",
    "  ports:",
    "    names:",
    "      - db",
    `  docker: ${opts.docker ? "{}" : "false"}`,
    "",
  ].join("\n");
}

let root: string | null = null;
let pluginDir = "";

async function writePlugin(opts: ManifestOptions = {}, entry = ENTRY_SOURCE): Promise<void> {
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "roubo-plugin.yaml"), manifestYaml(opts));
  await writeFile(path.join(pluginDir, "index.cjs"), entry);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function record() {
  const r = pluginManager.getRecord("database");
  if (!r) throw new Error("expected the database plugin record");
  return r;
}

async function startDatabase(opts: ManifestOptions = {}): Promise<number> {
  await writePlugin(opts);
  await pluginManager.initialize();
  await waitFor(() => record().status === "enabled" && record().pid !== null);
  expect(await pluginManager.invoke("database", "ping", {})).toBe("pong");
  return record().pid as number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const twoBenches = (): ResourceOwnershipEntry[] => [
  {
    pluginId: "database",
    benchId: 2,
    processIds: ["process:2:api"],
    composeProjects: ["roubo-lantern-bench-2"],
  },
  {
    pluginId: "database",
    benchId: 3,
    processIds: [],
    composeProjects: ["roubo-lantern-bench-3"],
  },
];

const preRestart = vi.fn();
const restarted = vi.fn();
const swapped = vi.fn();

beforeEach(async () => {
  pluginManager.__test.reset();
  root = await mkdtemp(path.join(tmpdir(), "roubo-plugin-swap-"));
  pluginDir = path.join(root, "database");
  process.env.ROUBO_USER_PLUGINS_DIR = root;
  ledgerFake.entries = [];
  consentFake.acknowledged = ["ports"];
  preRestart.mockReset();
  restarted.mockReset();
  swapped.mockReset();
  pluginManager.registerComponentPluginHooks({
    onComponentPluginPreRestart: preRestart,
    onComponentPluginRestarted: restarted,
    onComponentPluginSwapped: swapped,
  });
});

afterEach(async () => {
  await pluginManager.shutdown();
  pluginManager.registerComponentPluginHooks(null);
  pluginManager.__test.reset();
  await pluginManager.__test.flushLogs();
  delete process.env.ROUBO_USER_PLUGINS_DIR;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("swapProcess (HR-FR-009)", () => {
  it("HR-TC-021 re-binds every ledger entry to the new plugin process", async () => {
    ledgerFake.entries = twoBenches();
    const before = structuredClone(ledgerFake.entries);
    const answers: unknown[] = [];
    swapped.mockImplementation(async (pluginId: string) => {
      for (const benchId of pluginManager.benchesUsingPlugin(pluginId)) {
        answers.push(await pluginManager.invoke(pluginId, "componentStatus", { benchId }));
      }
    });
    const oldPid = await startDatabase();

    await writePlugin({ version: "1.0.1" });
    await pluginManager.swapProcess("database");

    const newPid = record().pid as number;
    expect(newPid).not.toBe(oldPid);
    expect(record().manifest?.version).toBe("1.0.1");
    expect(record().status).toBe("enabled");
    expect(record().stale).toBe(false);
    // The ledger entries, compose projects included, are unchanged.
    expect(ledgerFake.entries).toEqual(before);
    expect(swapped).toHaveBeenCalledWith("database");
    // The new process answers a component status request for both benches.
    expect(answers).toEqual([
      { benchId: 2, status: "running", pid: newPid },
      { benchId: 3, status: "running", pid: newPid },
    ]);
    // The old process's exit was the swap's own stop, not a crash.
    await waitFor(() => !isAlive(oldPid), 5_000);
    await new Promise((r) => setTimeout(r, 700));
    expect(preRestart).not.toHaveBeenCalled();
    expect(restarted).not.toHaveBeenCalled();
    expect(record().restartHistory).toEqual([]);
    expect(record().pid).toBe(newPid);
  }, 30_000);

  it("HR-TC-056 keeps the bench resources and marks the plugin stale when the new process does not start", async () => {
    ledgerFake.entries = [twoBenches()[0]];
    const before = structuredClone(ledgerFake.entries);
    const oldPid = await startDatabase();

    await writePlugin({}, EXITS_AT_START);
    await expect(pluginManager.swapProcess("database")).resolves.toBeUndefined();

    // Wait past the first restart backoff (500 ms): a crash read of the exit
    // would have fired the pre-restart teardown and scheduled a respawn by now.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(preRestart).not.toHaveBeenCalled();
    expect(restarted).not.toHaveBeenCalled();
    expect(swapped).not.toHaveBeenCalled();
    expect(ledgerFake.entries).toEqual(before);
    expect(isAlive(oldPid)).toBe(false);

    const r = record();
    expect(r.stale).toBe(true);
    // Stale sits beside status: no new PluginStatus value.
    expect(r.status).toBe("errored");
    expect(r.lastError?.code).toBe("swap-start-failed");
    expect(r.lastError?.message).toMatch(/still running/);
    expect(r.restartHistory).toEqual([]);
    expect(r.pid).toBeNull();
    expect(swapState.isBenchStaleFromSwap(2)).toBe(true);
    expect(swapState.isBenchStaleFromSwap(3)).toBe(false);
  }, 30_000);

  it("clears the stale mark when a later swap starts", async () => {
    ledgerFake.entries = [twoBenches()[0]];
    await startDatabase();
    await writePlugin({}, EXITS_AT_START);
    await pluginManager.swapProcess("database");
    expect(record().stale).toBe(true);

    // A plugin left errored by a failed swap takes the next manifest but is
    // not started by a swap; the user restarts it.
    await writePlugin({ version: "1.0.2" });
    await pluginManager.swapProcess("database");
    expect(record().manifest?.version).toBe("1.0.2");
    await pluginManager.restart("database");
    expect(record().status).toBe("enabled");
    await pluginManager.swapProcess("database");
    expect(record().stale).toBe(false);
    expect(swapState.isBenchStaleFromSwap(2)).toBe(false);
  }, 30_000);

  it("refuses an imperative plugin before the stop", async () => {
    ledgerFake.entries = [twoBenches()[0]];
    const pid = await startDatabase({ componentMode: "imperative" });

    await expect(pluginManager.swapProcess("database")).rejects.toMatchObject({
      code: "plugin-swap-refused",
      reason: "imperative",
    });
    expect(record().pid).toBe(pid);
    expect(isAlive(pid)).toBe(true);
    expect(await pluginManager.invoke("database", "ping", {})).toBe("pong");
  }, 30_000);

  it("refuses a contractVersion change before the stop", async () => {
    const pid = await startDatabase();
    await writePlugin({ contractVersion: 2 });

    await expect(pluginManager.swapProcess("database")).rejects.toMatchObject({
      code: "plugin-swap-refused",
      reason: "contract-version",
    });
    expect(record().pid).toBe(pid);
    expect(record().manifest?.contractVersion).toBe(1);
  }, 30_000);

  it("refuses a permission that needs consent before the stop", async () => {
    const pid = await startDatabase();
    await writePlugin({ docker: true });

    await expect(pluginManager.swapProcess("database")).rejects.toMatchObject({
      code: "plugin-swap-refused",
      reason: "permission",
    });
    expect(record().pid).toBe(pid);
  }, 30_000);

  it("refuses a manifest that breaks a component a bench uses before the stop", async () => {
    pluginManager.registerComponentPluginHooks({
      onComponentPluginPreRestart: preRestart,
      onComponentPluginSwapped: swapped,
      findBindingsBrokenBySwap: () => ["component 'db' of bench 2"],
    });
    const pid = await startDatabase();
    await writePlugin({ version: "2.0.0" });

    await expect(pluginManager.swapProcess("database")).rejects.toMatchObject({
      code: "plugin-swap-refused",
      reason: "component-type",
      message: expect.stringContaining("component 'db' of bench 2"),
    });
    expect(record().pid).toBe(pid);
    expect(swapped).not.toHaveBeenCalled();
  }, 30_000);
});

describe("an in-place update keeps the ledger (HR-FR-009)", () => {
  it("HR-TC-021 re-attaches the ledger to the re-registered entry and queues a call made in the gap", async () => {
    ledgerFake.entries = twoBenches();
    const before = structuredClone(ledgerFake.entries);
    await startDatabase();

    await pluginManager.uninstallForUpdate("database");
    expect(swapState.isInSwapGap("database")).toBe(true);
    // A call that lands in the gap waits for the new process instead of
    // failing with plugin-not-enabled.
    const queued = pluginManager.invoke("database", "componentStatus", { benchId: 2 });

    await writePlugin({ version: "1.1.0" });
    await pluginManager.registerInstalled(pluginDir);

    const newPid = record().pid as number;
    await expect(queued).resolves.toEqual({ benchId: 2, status: "running", pid: newPid });
    expect(swapState.isInSwapGap("database")).toBe(false);
    expect(swapped).toHaveBeenCalledWith("database");
    expect(ledgerFake.entries).toEqual(before);
    await new Promise((r) => setTimeout(r, 700));
    expect(preRestart).not.toHaveBeenCalled();
  }, 30_000);
});

describe("removal while a bench uses the plugin (HR-FR-010)", () => {
  it("benchesUsingPlugin reads the bench ids from the ledger", async () => {
    ledgerFake.entries = [
      ...twoBenches(),
      { pluginId: "database", benchId: 4, processIds: [], composeProjects: [] },
      { pluginId: "process", benchId: 5, processIds: ["process:5:api"], composeProjects: [] },
    ];
    expect(pluginManager.benchesUsingPlugin("database")).toEqual([2, 3]);
    expect(pluginManager.benchesUsingPlugin("process")).toEqual([5]);
    expect(pluginManager.benchesUsingPlugin("nothing")).toEqual([]);
  });

  it("HR-TC-017 refuses removal naming each bench, and removes the plugin once they are cleared", async () => {
    ledgerFake.entries = twoBenches();
    const pid = await startDatabase();

    await expect(pluginManager.uninstall("database")).rejects.toMatchObject({
      code: "plugin-in-use",
      benchIds: [2, 3],
      message:
        '"Database" is in use by bench 2 and bench 3. Clear bench 2 and bench 3 to remove it.',
    });
    expect(record().pid).toBe(pid);

    ledgerFake.entries = [];
    await pluginManager.uninstall("database");
    expect(pluginManager.getRecord("database")).toBeUndefined();
  }, 30_000);

  it("names a single bench in the notice", () => {
    expect(pluginManager.pluginInUseNotice("Database", [2])).toBe(
      '"Database" is in use by bench 2. Clear bench 2 to remove it.',
    );
  });
});
