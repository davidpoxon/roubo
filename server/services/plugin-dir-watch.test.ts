/**
 * The plugin directory watch (HR-FR-006, HR-FR-007, HR-FR-008) against a real
 * temp plugins root, real chokidar, and the real plugin-manager with real child
 * processes. The state dir, the ownership ledger and the consent, enable and
 * provenance ledgers are fakes, so nothing touches a real ~/.roubo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InputChangedEvent, ResourceOwnershipEntry } from "@roubo/shared";

const hoisted = vi.hoisted(() => ({
  rouboDir: "",
  ledger: [] as ResourceOwnershipEntry[],
  consented: new Set<string>(),
  events: [] as Omit<InputChangedEvent, "type">[],
}));

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    ...actual,
    getRouboDir: () => hoisted.rouboDir,
    loadProjects: () => ({ projects: [] }),
  };
});
vi.mock("./sse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sse.js")>();
  return {
    ...actual,
    broadcastInputChanged: vi.fn((event: Omit<InputChangedEvent, "type">) => {
      hoisted.events.push(event);
    }),
  };
});
vi.mock("./resource-ownership-ledger.js", () => ({
  getAllEntries: vi.fn(() => hoisted.ledger),
  getEntry: vi.fn(),
  clearEntry: vi.fn(),
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
  loadEnableState: vi.fn(() => null),
  saveEnableState: vi.fn(),
  setPluginEnabled: vi.fn(),
  removePlugin: vi.fn(),
}));
vi.mock("./plugin-consent-state.js", () => ({
  getConsent: vi.fn((pluginId: string) =>
    hoisted.consented.has(pluginId)
      ? { pluginId, acknowledgedCategories: [], consentedAt: "2026-11-01T00:00:00.000Z" }
      : null,
  ),
  hasConsent: vi.fn((pluginId: string) => hoisted.consented.has(pluginId)),
  removeConsent: vi.fn((pluginId: string) => {
    hoisted.consented.delete(pluginId);
  }),
}));
vi.mock("./plugin-provenance-state.js", () => ({
  getProvenance: vi.fn(() => null),
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  markOrphanedBySource: vi.fn(() => 0),
}));

import * as pluginManager from "./plugin-manager.js";
import {
  appInstallOutcome,
  installedNotice,
  manifestFirstError,
  onPluginSetChanged,
  runAppPluginWrite,
  startPluginDirWatch,
  stopPluginDirWatch,
  updatedNotice,
  type PluginSetChange,
} from "./plugin-dir-watch.js";

let base: string;
let root: string;
let scratch: string;
let lines: string[];
let setChanges: PluginSetChange[];
let stopSetListener: () => void;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) {
      throw new Error(
        `timed out; log so far:\n${lines.join("\n")}\nevents: ${JSON.stringify(hoisted.events)}`,
      );
    }
    await sleep(25);
  }
}

function applyLines(dirName: string): string[] {
  return lines.filter(
    (l) => l.startsWith("[input-watcher] surface=plugin ") && l.includes(`/${dirName} outcome=`),
  );
}

function outcomeLines(dirName: string, outcome: string): string[] {
  return applyLines(dirName).filter((l) => l.includes(` outcome=${outcome} `));
}

function summaries(): string[] {
  return hoisted.events.map((e) => e.summary);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function manifestYaml(id: string, kind = "integration", version = "1.0.0"): string {
  return [
    `id: ${id}`,
    `name: ${id}`,
    `version: ${version}`,
    "description: a plugin directory watch fixture",
    `kind: ${kind}`,
    "roubo: ^1.0.0",
    "entry: ./index.cjs",
    "permissions:",
    "  network:",
    "    hosts: []",
    "  credentials:",
    "    slots: []",
    "  filesystem:",
    "    paths: []",
    "  processes: false",
    "",
  ].join("\n");
}

// A keep-alive entry that writes `marker` (when given) as it starts.
function entrySource(marker?: string, tag = "one"): string {
  return [
    `"use strict";`,
    `// build ${tag}`,
    ...(marker ? [`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`] : []),
    "setInterval(() => {}, 60000).unref();",
    "process.stdin.resume();",
    "",
  ].join("\n");
}

/** Build a plugin directory in the scratch dir, outside the watched root. */
function buildPlugin(
  name: string,
  opts: { id?: string; kind?: string; version?: string; marker?: string } = {},
): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "roubo-plugin.yaml"),
    manifestYaml(opts.id ?? name, opts.kind, opts.version),
  );
  fs.writeFileSync(path.join(dir, "index.cjs"), entrySource(opts.marker));
  return dir;
}

/** Copy a built plugin directory into the watched root, as `cp -R` does. */
function dropPlugin(name: string, opts: Parameters<typeof buildPlugin>[1] = {}): string {
  const src = buildPlugin(name, opts);
  const target = path.join(root, name);
  fs.cpSync(src, target, { recursive: true });
  return target;
}

function record(id: string) {
  return pluginManager.getRecord(id);
}

async function startWatch(): Promise<void> {
  await startPluginDirWatch({ root, settleMs: 100, pollMs: 150, rearmPollMs: 200 });
}

/**
 * Drop a consented plugin and wait until its entry runs. A pid alone is not
 * enough: Node loads the entry after the spawn returns, so a directory removed
 * in that window ends the process with "Cannot find module".
 */
async function dropRunningPlugin(name: string): Promise<number> {
  hoisted.consented.add(name);
  const started = path.join(scratch, `${name}.started`);
  dropPlugin(name, { marker: started });
  await waitFor(() => typeof record(name)?.pid === "number");
  await waitFor(() => fs.existsSync(started));
  await waitFor(() => outcomeLines(name, "applied").length === 1);
  return record(name)?.pid as number;
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-plugin-dir-watch-")));
  hoisted.rouboDir = path.join(base, "state");
  root = path.join(base, "plugins");
  scratch = path.join(base, "scratch");
  for (const d of [hoisted.rouboDir, root, scratch]) fs.mkdirSync(d, { recursive: true });
  process.env.ROUBO_USER_PLUGINS_DIR = root;
  hoisted.ledger = [];
  hoisted.consented = new Set();
  hoisted.events = [];
  lines = [];
  setChanges = [];
  stopSetListener = onPluginSetChanged((change) => setChanges.push(change));
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  pluginManager.__test.reset();
  await pluginManager.initialize();
});

afterEach(async () => {
  stopSetListener();
  await stopPluginDirWatch();
  await pluginManager.shutdown();
  pluginManager.__test.reset();
  await pluginManager.__test.flushLogs();
  delete process.env.ROUBO_USER_PLUGINS_DIR;
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("notice copy", () => {
  it("HR-TC-019 reads a zod enum error as 'must be one of'", () => {
    expect(
      manifestFirstError('kind: Invalid option: expected one of "integration"|"component"|"agent"'),
    ).toBe("kind must be one of integration, component, agent");
    expect(manifestFirstError("entry: Required.")).toBe("entry: Required");
  });

  it("HR-TC-011 and HR-TC-012 word the install and update notices", () => {
    expect(installedNotice("database", false)).toBe(
      "Plugin database installed. Grant consent in Settings > Plugins to enable it.",
    );
    expect(installedNotice("database", true)).toBe("Plugin database installed.");
    expect(updatedNotice("database", "1.2.0", 1)).toBe(
      "Plugin database updated to 1.2.0. 1 bench kept its components.",
    );
    expect(updatedNotice("database", "1.2.0", 2)).toBe(
      "Plugin database updated to 1.2.0. 2 benches kept their components.",
    );
    expect(updatedNotice("database", "1.2.0", 0)).toBe("Plugin database updated to 1.2.0.");
  });
});

describe("a plugin directory added by hand", () => {
  it("HR-TC-014 registers a dropped plugin directory with no process until consent is granted", async () => {
    await startWatch();
    dropPlugin("new-plugin");

    await waitFor(() => record("new-plugin") !== undefined);
    await waitFor(() => hoisted.events.length === 1);
    expect(record("new-plugin")?.status).toBe("disabled");
    expect(record("new-plugin")?.pid).toBeNull();
    expect(summaries()).toEqual([
      "Plugin new-plugin installed. Grant consent in Settings > Plugins to enable it.",
    ]);
    expect(hoisted.events[0]).toMatchObject({
      surface: "plugin",
      outcome: "applied",
      pluginId: "new-plugin",
    });
    expect(setChanges).toEqual([{ added: ["new-plugin"], swapped: [], removed: [] }]);

    // Granting consent starts the process.
    hoisted.consented.add("new-plugin");
    await pluginManager.startAfterConsent("new-plugin");
    expect(record("new-plugin")?.status).toBe("enabled");
    expect(typeof record("new-plugin")?.pid).toBe("number");
  }, 20_000);

  it("HR-TC-015 never spawns an un-consented plugin found on disk and logs action=register", async () => {
    await startWatch();
    const marker = path.join(base, "started.marker");
    dropPlugin("marker-plugin", { marker });

    await waitFor(() => outcomeLines("marker-plugin", "applied").length === 1);
    await sleep(1_500);

    expect(fs.existsSync(marker)).toBe(false);
    expect(record("marker-plugin")?.pid).toBeNull();
    expect(applyLines("marker-plugin")).toHaveLength(1);
    expect(applyLines("marker-plugin")[0]).toMatch(
      /^\[input-watcher\] surface=plugin path=\S+\/marker-plugin outcome=applied hash8=[0-9a-f]{8} durationMs=\d+ action=register$/,
    );
  }, 20_000);

  it("HR-TC-019 rejects a new directory with an invalid manifest with its first error and registers nothing", async () => {
    await startWatch();
    dropPlugin("widget-plugin", { kind: "widget" });

    await waitFor(() => outcomeLines("widget-plugin", "rejected").length === 1);
    expect(record("widget-plugin")).toBeUndefined();
    expect(pluginManager.listInstalled()).toEqual([]);
    expect(summaries()).toEqual([
      "Plugin widget-plugin not registered. roubo-plugin.yaml: kind must be one of integration, component, agent.",
    ]);
    expect(hoisted.events[0]).toMatchObject({
      outcome: "rejected",
      error: {
        path: "roubo-plugin.yaml",
        first: "kind must be one of integration, component, agent",
      },
    });
    expect(outcomeLines("widget-plugin", "applied")).toEqual([]);
  }, 20_000);

  it("HR-TC-020 registers a slow recursive copy with node_modules exactly once", async () => {
    await startWatch();
    const target = path.join(root, "slow-copy");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "roubo-plugin.yaml"), manifestYaml("slow-copy"));
    fs.writeFileSync(path.join(target, "index.cjs"), entrySource());
    // The rest of the copy lands in node_modules, which the watch does not
    // see, file by file, for longer than the settle window.
    const modules = path.join(target, "node_modules", "dep");
    fs.mkdirSync(modules, { recursive: true });
    for (let i = 0; i < 16; i++) {
      fs.writeFileSync(path.join(modules, `file-${i}.js`), `module.exports = ${i};\n`);
      await sleep(70);
    }

    await waitFor(() => outcomeLines("slow-copy", "applied").length === 1);
    await sleep(1_000);
    expect(outcomeLines("slow-copy", "applied")).toHaveLength(1);
    expect(applyLines("slow-copy").filter((l) => !l.includes(" outcome=deduped "))).toHaveLength(1);
    expect(hoisted.events.filter((e) => e.outcome === "applied")).toHaveLength(1);
    expect(hoisted.events.filter((e) => e.outcome !== "applied")).toEqual([]);
    expect(record("slow-copy")).toBeDefined();
  }, 20_000);
});

describe("a plugin directory changed in place", () => {
  it("HR-TC-013 swaps the plugin process when its entry file is rebuilt", async () => {
    await startWatch();
    const oldPid = await dropRunningPlugin("my-agent");
    hoisted.events = [];

    fs.writeFileSync(path.join(root, "my-agent", "index.cjs"), entrySource(undefined, "two"));

    await waitFor(() => {
      const pid = record("my-agent")?.pid;
      return typeof pid === "number" && pid !== oldPid;
    });
    await waitFor(() => hoisted.events.length === 1);
    expect(summaries()).toEqual(["Plugin my-agent updated."]);
    expect(record("my-agent")?.status).toBe("enabled");
    expect(outcomeLines("my-agent", "applied").at(-1)).toMatch(/ action=swap$/);
    await waitFor(() => !isAlive(oldPid), 6_000);
  }, 30_000);
});

describe("a plugin directory removed", () => {
  it("HR-TC-016 refuses to remove a plugin that benches use, names them, and keeps it running", async () => {
    await startWatch();
    const pid = await dropRunningPlugin("database");
    hoisted.events = [];
    hoisted.ledger = [
      { pluginId: "database", benchId: 2, processIds: [], composeProjects: ["roubo-l-bench-2"] },
      { pluginId: "database", benchId: 5, processIds: ["process:5:api"], composeProjects: [] },
    ];

    fs.rmSync(path.join(root, "database"), { recursive: true, force: true });

    await waitFor(() => outcomeLines("database", "refused").length === 1);
    expect(summaries()).toEqual([
      "Plugin database not removed. Benches 2 and 5 use it. Clear those benches first.",
    ]);
    expect(hoisted.events[0]).toMatchObject({ outcome: "refused", benchIds: [2, 5] });
    expect(record("database")?.pid).toBe(pid);
    expect(isAlive(pid)).toBe(true);
    expect(outcomeLines("database", "refused")[0]).toMatch(/ action=unregister$/);
  }, 20_000);

  it("HR-TC-018 unregisters a removed plugin that no bench uses and stops its process", async () => {
    await startWatch();
    const pid = await dropRunningPlugin("new-plugin");
    hoisted.events = [];
    setChanges = [];

    fs.rmSync(path.join(root, "new-plugin"), { recursive: true, force: true });

    await waitFor(() => record("new-plugin") === undefined);
    await waitFor(() => hoisted.events.length === 1);
    expect(summaries()).toEqual(["Plugin new-plugin removed."]);
    await waitFor(() => !isAlive(pid), 6_000);
    expect(setChanges).toEqual([{ added: [], swapped: [], removed: ["new-plugin"] }]);
  }, 20_000);
});

describe("the marketplace path and the watch", () => {
  it("HR-TC-022 converge on one registration, one notice, one applied and one deduped line", async () => {
    await startWatch();
    hoisted.consented.add("database");
    const src = buildPlugin("database");

    const installed = await runAppPluginWrite(
      async () => {
        const target = path.join(root, "database");
        fs.cpSync(src, target, { recursive: true });
        return pluginManager.registerInstalled(target);
      },
      (r) => appInstallOutcome(r, false),
    );
    expect(installed.id).toBe("database");

    await waitFor(() => outcomeLines("database", "deduped").length === 1);
    await sleep(800);
    expect(pluginManager.listInstalled().filter((r) => r.id === "database")).toHaveLength(1);
    expect(summaries()).toEqual(["Plugin database installed."]);
    expect(outcomeLines("database", "applied")).toHaveLength(1);
    expect(outcomeLines("database", "deduped")).toHaveLength(1);
    expect(applyLines("database")).toHaveLength(2);
  }, 20_000);

  it("HR-TC-011 an install with no consent yet stays inert, says so, and runs once consent is granted", async () => {
    await startWatch();
    const src = buildPlugin("database");

    const installed = await runAppPluginWrite(
      async () => {
        const target = path.join(root, "database");
        fs.cpSync(src, target, { recursive: true });
        return pluginManager.registerInstalled(target, { inertUntilConsent: true });
      },
      (r) => appInstallOutcome(r, false),
    );

    expect(installed.status).toBe("disabled");
    expect(installed.pid).toBeNull();
    expect(summaries()).toEqual([
      "Plugin database installed. Grant consent in Settings > Plugins to enable it.",
    ]);

    hoisted.consented.add("database");
    await pluginManager.startAfterConsent("database");
    expect(record("database")?.status).toBe("enabled");
    expect(typeof record("database")?.pid).toBe("number");
  }, 20_000);

  it("HR-TC-012 an update through the app keeps the bench ledger and reports one swap", async () => {
    await startWatch();
    const oldPid = await dropRunningPlugin("database");
    hoisted.events = [];
    const ledger: ResourceOwnershipEntry[] = [
      { pluginId: "database", benchId: 2, processIds: [], composeProjects: ["roubo-l-bench-2"] },
    ];
    hoisted.ledger = structuredClone(ledger);
    const next = buildPlugin("database-next", { id: "database", version: "1.1.0" });
    const target = path.join(root, "database");
    const backup = path.join(base, "database-prev");

    const updated = await runAppPluginWrite(
      async () => {
        // The installer's update: back the old copy up, tear the runtime down
        // without stopping bench resources, move the new copy in, register it.
        fs.renameSync(target, backup);
        await pluginManager.uninstallForUpdate("database");
        fs.cpSync(next, target, { recursive: true });
        return pluginManager.registerInstalled(target);
      },
      (r) => appInstallOutcome(r, true, pluginManager.benchesUsingPlugin(r.id).length),
    );

    expect(updated.manifest?.version).toBe("1.1.0");
    expect(summaries()).toEqual(["Plugin database updated to 1.1.0. 1 bench kept its components."]);
    expect(hoisted.ledger).toEqual(ledger);
    await waitFor(() => outcomeLines("database", "deduped").length === 1);
    expect(outcomeLines("database", "applied")).toHaveLength(2);
    expect(outcomeLines("database", "applied").at(-1)).toMatch(/ action=swap$/);
    expect(outcomeLines("database", "refused")).toEqual([]);
    expect(record("database")?.pid).not.toBe(oldPid);
  }, 30_000);
});
