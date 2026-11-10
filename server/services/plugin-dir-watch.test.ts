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
import type {
  InputChangedEvent,
  PluginEnableState,
  PluginEnableStateValue,
  ResourceOwnershipEntry,
} from "@roubo/shared";

const hoisted = vi.hoisted(() => ({
  rouboDir: "",
  ledger: [] as ResourceOwnershipEntry[],
  consented: new Set<string>(),
  events: [] as Omit<InputChangedEvent, "type">[],
  enableState: null as PluginEnableState | null,
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
// A plugins-state.json held in memory, so a relaunch (shutdown, then
// initialize) reads back what the previous run wrote.
vi.mock("./plugin-enable-state.js", () => {
  const setValue = (pluginId: string, value: PluginEnableStateValue): PluginEnableState => {
    const current = hoisted.enableState ?? {
      schemaVersion: 1 as const,
      installInitialized: false,
      plugins: {},
    };
    hoisted.enableState = { ...current, plugins: { ...current.plugins, [pluginId]: value } };
    return structuredClone(hoisted.enableState);
  };
  return {
    loadEnableState: vi.fn(() =>
      hoisted.enableState ? structuredClone(hoisted.enableState) : null,
    ),
    saveEnableState: vi.fn(),
    setPluginEnabled: vi.fn((pluginId: string, enabled: boolean) =>
      setValue(pluginId, enabled ? "enabled" : "disabled"),
    ),
    setPluginEnableValue: vi.fn(setValue),
    removePlugin: vi.fn((pluginId: string) => {
      if (!hoisted.enableState) return;
      hoisted.enableState = {
        ...hoisted.enableState,
        plugins: Object.fromEntries(
          Object.entries(hoisted.enableState.plugins).filter(([id]) => id !== pluginId),
        ),
      };
    }),
  };
});
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
  notUpdatedLiveNotice,
  onPluginSetChanged,
  runAppPluginWrite,
  staleUpdateNotice,
  startPluginDirWatch,
  stopPluginDirWatch,
  updatedNotice,
  type PluginSetChange,
} from "./plugin-dir-watch.js";

// An entry that exits as soon as it starts: a rebuild that crashes at start.
const EXITS_AT_START = `"use strict";\nprocess.exit(1);\n`;

/**
 * Answer the swap's "which benches use this plugin" from the fake ledger, as
 * the host does: each entry with a resource is a bench of project 'lantern'.
 */
function benchesFromLedger(): void {
  pluginManager.registerComponentPluginHooks({
    findBenchesUsingPlugin: (pluginId: string) =>
      hoisted.ledger
        .filter((e) => e.pluginId === pluginId)
        .filter((e) => e.processIds.length > 0 || e.composeProjects.length > 0)
        .map((e) => ({ projectId: "lantern", benchId: e.benchId })),
  });
}

let base: string;
let root: string;
let scratch: string;
let lines: string[];
let setChanges: PluginSetChange[];
let stopSetListener: () => void;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Edit `pluginId`'s value in the in-memory plugins-state.json by hand. */
function handEditEnableValue(pluginId: string, value: PluginEnableStateValue): void {
  const state = hoisted.enableState;
  if (!state) throw new Error("expected a plugins-state.json to edit");
  hoisted.enableState = { ...state, plugins: { ...state.plugins, [pluginId]: value } };
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

function manifestYaml(
  id: string,
  kind = "integration",
  version = "1.0.0",
  componentMode?: "imperative",
): string {
  return [
    `id: ${id}`,
    `name: ${id}`,
    `version: ${version}`,
    "description: a plugin directory watch fixture",
    `kind: ${kind}`,
    kind === "component" ? "roubo: ^1.3.0" : "roubo: ^1.0.0",
    "entry: ./index.cjs",
    ...(kind === "component" ? ["contractVersion: 1"] : []),
    ...(componentMode ? [`componentMode: ${componentMode}`] : []),
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
  opts: {
    id?: string;
    kind?: string;
    version?: string;
    marker?: string;
    componentMode?: "imperative";
  } = {},
): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "roubo-plugin.yaml"),
    manifestYaml(opts.id ?? name, opts.kind, opts.version, opts.componentMode),
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
async function dropRunningPlugin(
  name: string,
  opts: Parameters<typeof buildPlugin>[1] = {},
): Promise<number> {
  hoisted.consented.add(name);
  const started = path.join(scratch, `${name}.started`);
  dropPlugin(name, { ...opts, marker: started });
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
  hoisted.enableState = null;
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
  pluginManager.registerComponentPluginHooks(null);
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

  it("HR-TC-012 and HR-TC-013 word the notice of an update that left benches without their link", () => {
    expect(staleUpdateNotice("database", null, [2])).toBe(
      "Plugin database updated, but bench 2 lost its link to it. The components still run. Restart bench 2 to reconnect.",
    );
    expect(staleUpdateNotice("database", "1.2.0", [2, 5])).toBe(
      "Plugin database updated to 1.2.0, but benches 2 and 5 lost their link to it. The components still run. Restart benches 2 and 5 to reconnect.",
    );
    expect(staleUpdateNotice("database", null, [])).toBe(
      "Plugin database updated, but it did not start cleanly. Restart it to retry.",
    );
  });

  it("HR-TC-013 words the notice of a swap refused because the plugin keeps component state", () => {
    expect(notUpdatedLiveNotice("my-plugin", [2, 5])).toBe(
      "Plugin my-plugin not updated live. It keeps component state. Stop benches 2 and 5, then update it.",
    );
    expect(notUpdatedLiveNotice("my-plugin", [2])).toBe(
      "Plugin my-plugin not updated live. It keeps component state. Stop bench 2, then update it.",
    );
    expect(notUpdatedLiveNotice("my-plugin", [])).toBe(
      "Plugin my-plugin not updated live. It keeps component state. Relaunch Roubo to update it.",
    );
  });
});

describe("a plugin directory added by hand", () => {
  it("HR-TC-014 registers a dropped agent plugin directory with no process until consent is granted", async () => {
    await startWatch();
    dropPlugin("new-plugin", { kind: "agent" });

    await waitFor(() => record("new-plugin") !== undefined);
    await waitFor(() => hoisted.events.length === 1);
    expect(record("new-plugin")?.status).toBe("disabled");
    expect(record("new-plugin")?.pid).toBeNull();
    expect(hoisted.enableState?.plugins["new-plugin"]).toBe("awaiting-consent");
    expect(summaries()).toEqual([
      "Plugin new-plugin installed. Grant consent in Settings > Plugins to enable it.",
    ]);
    expect(hoisted.events[0]).toMatchObject({
      surface: "plugin",
      outcome: "applied",
      pluginId: "new-plugin",
    });
    expect(setChanges).toEqual([{ added: ["new-plugin"], swapped: [], removed: [] }]);

    // Granting consent starts the process and clears the hold.
    hoisted.consented.add("new-plugin");
    await pluginManager.startAfterConsent("new-plugin");
    expect(record("new-plugin")?.status).toBe("enabled");
    expect(typeof record("new-plugin")?.pid).toBe("number");
    expect(hoisted.enableState?.plugins["new-plugin"]).toBe("enabled");
  }, 20_000);

  it("HR-TC-014 starts a dropped integration plugin, which is never consent-gated, and names no consent step", async () => {
    await startWatch();
    dropPlugin("new-integration");

    await waitFor(() => typeof record("new-integration")?.pid === "number");
    await waitFor(() => hoisted.events.length === 1);
    expect(record("new-integration")?.status).toBe("enabled");
    expect(hoisted.enableState?.plugins["new-integration"]).toBeUndefined();
    expect(summaries()).toEqual(["Plugin new-integration installed."]);
  }, 20_000);

  it("HR-TC-014 does not start a dropped integration plugin that the user disabled", async () => {
    hoisted.enableState = {
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "off-integration": "disabled" },
    };
    await pluginManager.shutdown();
    await pluginManager.initialize();
    await startWatch();
    dropPlugin("off-integration");

    await waitFor(() => outcomeLines("off-integration", "applied").length === 1);
    expect(record("off-integration")?.status).toBe("disabled");
    expect(record("off-integration")?.pid).toBeNull();
  }, 20_000);

  it("HR-TC-014 keeps a dropped agent plugin that the user disabled disabled, held until consent", async () => {
    hoisted.enableState = {
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "off-agent": "disabled" },
    };
    await pluginManager.shutdown();
    await pluginManager.initialize();
    await startWatch();
    dropPlugin("off-agent", { kind: "agent" });

    await waitFor(() => outcomeLines("off-agent", "applied").length === 1);
    expect(record("off-agent")?.pid).toBeNull();
    expect(hoisted.enableState?.plugins["off-agent"]).toBe("disabled-awaiting-consent");
    await expect(pluginManager.enable("off-agent")).rejects.toThrow(/no consent yet/);

    // A grant of consent keeps the user's disable.
    hoisted.consented.add("off-agent");
    expect(await pluginManager.startAfterConsent("off-agent")).toBe(false);
    expect(hoisted.enableState?.plugins["off-agent"]).toBe("disabled");
    expect(record("off-agent")?.pid).toBeNull();
  }, 20_000);

  it("HR-TC-015 never spawns an un-consented plugin found on disk and logs action=register", async () => {
    await startWatch();
    const marker = path.join(base, "started.marker");
    dropPlugin("marker-plugin", { kind: "agent", marker });

    await waitFor(() => outcomeLines("marker-plugin", "applied").length === 1);
    await sleep(1_500);

    expect(fs.existsSync(marker)).toBe(false);
    expect(record("marker-plugin")?.pid).toBeNull();
    expect(applyLines("marker-plugin")).toHaveLength(1);
    expect(applyLines("marker-plugin")[0]).toMatch(
      /^\[input-watcher\] surface=plugin path=\S+\/marker-plugin outcome=applied hash8=[0-9a-f]{8} durationMs=\d+ action=register$/,
    );
  }, 20_000);

  it("HR-TC-015 and HR-TC-014 keep an un-consented dropped plugin unspawned after a relaunch, and enable and restart refuse it", async () => {
    await startWatch();
    const marker = path.join(base, "relaunch.marker");
    dropPlugin("held-plugin", { kind: "agent", marker });
    await waitFor(() => outcomeLines("held-plugin", "applied").length === 1);
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("awaiting-consent");

    // Relaunch: the next initialize discovers the directory from disk.
    await stopPluginDirWatch();
    await pluginManager.shutdown();
    await pluginManager.initialize();
    await sleep(500);

    expect(record("held-plugin")?.status).toBe("disabled");
    expect(record("held-plugin")?.pid).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);

    await expect(pluginManager.enable("held-plugin")).rejects.toThrow(/no consent yet/);
    await expect(pluginManager.restart("held-plugin")).rejects.toThrow(/no consent yet/);
    expect(record("held-plugin")?.pid).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);

    // Consent lifts the hold.
    hoisted.consented.add("held-plugin");
    await pluginManager.startAfterConsent("held-plugin");
    expect(typeof record("held-plugin")?.pid).toBe("number");
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("enabled");
    await waitFor(() => fs.existsSync(marker));
  }, 20_000);

  it("HR-TC-014 keeps a plugin disabled while it awaited consent disabled after consent, across a relaunch", async () => {
    await startWatch();
    const marker = path.join(base, "disabled-held.marker");
    dropPlugin("held-plugin", { kind: "agent", marker });
    await waitFor(() => outcomeLines("held-plugin", "applied").length === 1);
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("awaiting-consent");

    // Disable during the hold: recorded with the hold, and enable and restart
    // still refuse it.
    await pluginManager.disable("held-plugin");
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("disabled-awaiting-consent");
    await expect(pluginManager.enable("held-plugin")).rejects.toThrow(/no consent yet/);
    await expect(pluginManager.restart("held-plugin")).rejects.toThrow(/no consent yet/);

    // A relaunch with the module state reset, so only plugins-state.json
    // carries the hold, neither starts it nor lets enable or restart start it.
    await stopPluginDirWatch();
    await pluginManager.shutdown();
    pluginManager.__test.reset();
    await pluginManager.initialize();
    await sleep(500);
    expect(record("held-plugin")?.pid).toBeNull();
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("disabled-awaiting-consent");
    await expect(pluginManager.enable("held-plugin")).rejects.toThrow(/no consent yet/);
    await expect(pluginManager.restart("held-plugin")).rejects.toThrow(/no consent yet/);
    expect(record("held-plugin")?.pid).toBeNull();

    // A grant of consent leaves the disabled plugin as it is.
    hoisted.consented.add("held-plugin");
    await pluginManager.startAfterConsent("held-plugin");
    await sleep(500);
    expect(record("held-plugin")?.status).toBe("disabled");
    expect(record("held-plugin")?.pid).toBeNull();
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("disabled");
    expect(fs.existsSync(marker)).toBe(false);

    // Once consented, the user can enable it.
    await pluginManager.enable("held-plugin");
    expect(typeof record("held-plugin")?.pid).toBe("number");
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("enabled");
    await waitFor(() => fs.existsSync(marker));
  }, 20_000);

  it("HR-TC-014 keeps the hold of a held plugin that a hand edit of plugins-state.json disables while the app runs", async () => {
    await startWatch();
    dropPlugin("held-plugin", { kind: "agent" });
    await waitFor(() => outcomeLines("held-plugin", "applied").length === 1);
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("awaiting-consent");

    handEditEnableValue("held-plugin", "disabled");
    await pluginManager.reloadEnableState();
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("disabled-awaiting-consent");

    // A relaunch reads the hold back from the file.
    await stopPluginDirWatch();
    await pluginManager.shutdown();
    pluginManager.__test.reset();
    await pluginManager.initialize();
    await expect(pluginManager.enable("held-plugin")).rejects.toThrow(/no consent yet/);
    await expect(pluginManager.restart("held-plugin")).rejects.toThrow(/no consent yet/);
    expect(record("held-plugin")?.pid).toBeNull();
  }, 20_000);

  it("HR-TC-014 keeps the hold of a held plugin that a hand edit of plugins-state.json disables while the app is closed", async () => {
    await startWatch();
    dropPlugin("held-plugin", { kind: "agent" });
    await waitFor(() => outcomeLines("held-plugin", "applied").length === 1);
    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("awaiting-consent");

    await stopPluginDirWatch();
    await pluginManager.shutdown();
    pluginManager.__test.reset();
    handEditEnableValue("held-plugin", "disabled");
    await pluginManager.initialize();
    expect(pluginManager.holdUnconsentedDisabledPlugins()).toEqual(["held-plugin"]);

    expect(hoisted.enableState?.plugins["held-plugin"]).toBe("disabled-awaiting-consent");
    await expect(pluginManager.enable("held-plugin")).rejects.toThrow(/no consent yet/);
    await expect(pluginManager.restart("held-plugin")).rejects.toThrow(/no consent yet/);
    expect(record("held-plugin")?.pid).toBeNull();
  }, 20_000);

  it("HR-TC-015 does not hold a legacy plugin with no consent record and no awaiting-consent value", async () => {
    hoisted.enableState = {
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "legacy-agent": "enabled" },
    };
    buildPlugin("legacy-agent", { kind: "agent" });
    fs.cpSync(path.join(scratch, "legacy-agent"), path.join(root, "legacy-agent"), {
      recursive: true,
    });
    await pluginManager.shutdown();
    await pluginManager.initialize();

    expect(typeof record("legacy-agent")?.pid).toBe("number");
    await pluginManager.restart("legacy-agent");
    expect(typeof record("legacy-agent")?.pid).toBe("number");
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

  it("HR-TC-013 says which bench lost its link when the rebuilt entry exits at start, and keeps the ledger", async () => {
    benchesFromLedger();
    await startWatch();
    const ledger: ResourceOwnershipEntry[] = [
      { pluginId: "database", benchId: 2, processIds: [], composeProjects: ["roubo-l-bench-2"] },
    ];
    hoisted.ledger = structuredClone(ledger);
    await dropRunningPlugin("database", { kind: "component" });
    hoisted.events = [];

    fs.writeFileSync(path.join(root, "database", "index.cjs"), EXITS_AT_START);

    await waitFor(() => hoisted.events.length === 1);
    expect(summaries()).toEqual([
      "Plugin database updated, but bench 2 lost its link to it. The components still run. Restart bench 2 to reconnect.",
    ]);
    expect(hoisted.events[0]).toMatchObject({ outcome: "applied", benchIds: [2] });
    expect(record("database")?.stale).toBe(true);
    expect(record("database")?.status).toBe("errored");
    expect(hoisted.ledger).toEqual(ledger);
    expect(outcomeLines("database", "applied").at(-1)).toMatch(/ action=swap$/);
  }, 30_000);

  it("HR-TC-013 refuses to swap a plugin that keeps component state and names the benches to stop", async () => {
    benchesFromLedger();
    await startWatch();
    hoisted.ledger = [
      { pluginId: "my-plugin", benchId: 2, processIds: [], composeProjects: ["roubo-l-bench-2"] },
      { pluginId: "my-plugin", benchId: 5, processIds: ["process:5:api"], composeProjects: [] },
    ];
    const pid = await dropRunningPlugin("my-plugin", {
      kind: "component",
      componentMode: "imperative",
    });
    hoisted.events = [];

    fs.writeFileSync(path.join(root, "my-plugin", "index.cjs"), entrySource(undefined, "two"));

    await waitFor(() => outcomeLines("my-plugin", "refused").length === 1);
    expect(summaries()).toEqual([
      "Plugin my-plugin not updated live. It keeps component state. Stop benches 2 and 5, then update it.",
    ]);
    expect(hoisted.events[0]).toMatchObject({ outcome: "refused", benchIds: [2, 5] });
    expect(record("my-plugin")?.pid).toBe(pid);
    expect(isAlive(pid)).toBe(true);
    expect(outcomeLines("my-plugin", "refused")[0]).toMatch(/ action=swap$/);
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

  /** Give the watch time to run, then drop a plugin and wait for it, so later runs are seen. */
  async function settleAfter(): Promise<void> {
    await sleep(1_200);
    dropPlugin("sentinel");
    await waitFor(() => outcomeLines("sentinel", "applied").length === 1);
  }

  it("HR-TC-018 sends no removal for the logs-only directory that a bundled plugin writes", async () => {
    await startWatch();
    const logs = path.join(root, "github-com", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, "plugin.log"), "started\n");
    await settleAfter();
    fs.rmSync(path.join(root, "github-com"), { recursive: true, force: true });
    await sleep(1_200);

    expect(applyLines("github-com")).toEqual([]);
    expect(summaries()).toEqual(["Plugin sentinel installed."]);
    expect(setChanges).toEqual([{ added: ["sentinel"], swapped: [], removed: [] }]);
  }, 20_000);

  it("HR-TC-018 sends no removal for an empty directory made under the plugins root", async () => {
    await startWatch();
    fs.mkdirSync(path.join(root, "foo"));
    await settleAfter();
    fs.rmdirSync(path.join(root, "foo"));
    await sleep(1_200);

    expect(applyLines("foo")).toEqual([]);
    expect(summaries()).toEqual(["Plugin sentinel installed."]);
    expect(setChanges).toEqual([{ added: ["sentinel"], swapped: [], removed: [] }]);
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

  it("HR-TC-011 an integration install names no consent step, which integration plugins never need", async () => {
    await startWatch();
    const src = buildPlugin("tracker");

    const installed = await runAppPluginWrite(
      async () => {
        const target = path.join(root, "tracker");
        fs.cpSync(src, target, { recursive: true });
        return pluginManager.registerInstalled(target, { inertUntilConsent: true });
      },
      (r) => appInstallOutcome(r, false),
    );

    expect(installed.status).toBe("enabled");
    expect(summaries()).toEqual(["Plugin tracker installed."]);
  }, 20_000);

  it("HR-TC-011 an agent install with no consent yet stays inert, says so, and runs once consent is granted", async () => {
    await startWatch();
    const src = buildPlugin("database", { kind: "agent" });

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

  it("HR-TC-012 an update through the app whose new copy exits at start names the bench that lost its link", async () => {
    benchesFromLedger();
    await startWatch();
    const ledger: ResourceOwnershipEntry[] = [
      { pluginId: "database", benchId: 2, processIds: [], composeProjects: ["roubo-l-bench-2"] },
    ];
    hoisted.ledger = structuredClone(ledger);
    await dropRunningPlugin("database", { kind: "component" });
    hoisted.events = [];
    const next = buildPlugin("database-next", {
      id: "database",
      kind: "component",
      version: "1.1.0",
    });
    fs.writeFileSync(path.join(next, "index.cjs"), EXITS_AT_START);
    const target = path.join(root, "database");
    const backup = path.join(base, "database-prev");

    const updated = await runAppPluginWrite(
      async () => {
        fs.renameSync(target, backup);
        await pluginManager.uninstallForUpdate("database");
        fs.cpSync(next, target, { recursive: true });
        return pluginManager.registerInstalled(target);
      },
      (r) => appInstallOutcome(r, true, pluginManager.benchesUsingPlugin(r.id).length),
    );

    expect(updated.stale).toBe(true);
    expect(updated.status).toBe("errored");
    expect(summaries()).toEqual([
      "Plugin database updated to 1.1.0, but bench 2 lost its link to it. The components still run. Restart bench 2 to reconnect.",
    ]);
    expect(hoisted.events[0]).toMatchObject({ outcome: "applied", benchIds: [2] });
    expect(hoisted.ledger).toEqual(ledger);
  }, 30_000);
});
