/**
 * A hand edit of a state file followed, inside the settle window, by an app
 * write of the same file. The app writes are read-modify-write from disk, so
 * the app write lands on the edit. These cases run the real state.ts,
 * plugin-enable-state.ts and plugin-consent-state.ts writers against a temp
 * home, with the real watch and self-write tokens, and check that the edit
 * still gets its own outcome rather than being taken in as the app's write.
 * The bench manager and the plugin manager are fakes that diff the file as the
 * real ones do: against the content the app last knew.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  InputChangedEvent,
  PersistedBench,
  PersistedState,
  PluginEnableState,
} from "@roubo/shared";

const hoisted = vi.hoisted(() => ({
  events: [] as Omit<InputChangedEvent, "type">[],
  /** The live benches of the fake bench manager: their edits are refused. */
  live: new Set<number>(),
  /** The fake plugin manager's enable-state cache. */
  cache: null as PluginEnableState | null,
}));

vi.mock("./sse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sse.js")>();
  return {
    ...actual,
    broadcastInputChanged: vi.fn((event: Omit<InputChangedEvent, "type">) => {
      hoisted.events.push(event);
    }),
  };
});

// Diffs each record's hand-editable fields against the known content, as the
// real one does: an edit of a live bench is refused and written back from
// memory, and an edit of an idle bench is taken in.
vi.mock("./bench-manager.js", async () => {
  const stateService = await import("./state.js");
  const editable = (r: PersistedBench) => JSON.stringify({ branch: r.branch, ports: r.ports });
  return {
    applyStateFileEdit: vi.fn((persisted: PersistedState) => {
      const known = new Map(
        (stateService.getKnownState()?.benches ?? []).map((r) => [`${r.projectId}/${r.id}`, r]),
      );
      const applied: { projectId: string; benchId: number }[] = [];
      const refused: { projectId: string; benchId: number; status: string }[] = [];
      const restored: PersistedBench[] = [];
      for (const record of persisted.benches) {
        const prior = known.get(`${record.projectId}/${record.id}`);
        if (prior === undefined || editable(prior) === editable(record)) {
          restored.push(record);
          continue;
        }
        const ref = { projectId: record.projectId, benchId: record.id };
        if (hoisted.live.has(record.id)) {
          refused.push({ ...ref, status: "active" });
          restored.push(prior);
        } else {
          applied.push(ref);
          restored.push(record);
        }
      }
      if (refused.length > 0) stateService.saveState({ ...persisted, benches: restored });
      else stateService.rememberState(persisted);
      return { applied, refused, reverted: [], unmatched: [], removed: [] };
    }),
  };
});

// Compares the cache with the file, as the real reload does.
vi.mock("./plugin-manager.js", async () => {
  const enableState = await import("./plugin-enable-state.js");
  return {
    startAfterConsent: vi.fn(() => Promise.resolve(true)),
    reloadEnableState: vi.fn(() => {
      const before = hoisted.cache;
      hoisted.cache = enableState.loadEnableState();
      const disabled = Object.entries(hoisted.cache?.plugins ?? {})
        .filter(([id, value]) => value === "disabled" && before?.plugins[id] !== "disabled")
        .map(([id]) => id);
      return Promise.resolve({ disabled, enabled: [] });
    }),
  };
});
vi.mock("./project-registry.js", () => ({ applyProjectsFileEdit: vi.fn(() => []) }));
vi.mock("./credential-store.js", () => ({ set: vi.fn(() => Promise.resolve()) }));

let home: string;
let dir: string;
let originalHome: string | undefined;
let originalProduction: string | undefined;
let lines: string[];

let state: typeof import("./state.js");
let enableState: typeof import("./plugin-enable-state.js");
let consentState: typeof import("./plugin-consent-state.js");
let tokens: typeof import("./self-write-tokens.js");
let watch: typeof import("./state-dir-watch.js");
let pluginManager: typeof import("./plugin-manager.js");
let benchManager: typeof import("./bench-manager.js");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) {
      throw new Error(
        `timed out; log so far:\n${lines.join("\n")}\nevents: ${JSON.stringify(hoisted.events)}`,
      );
    }
    await sleep(20);
  }
}

function bench(id: number, branch: string, port: number): PersistedBench {
  return {
    id,
    projectId: "lantern",
    branch,
    workspacePath: `/w/${id}`,
    ports: { web: port },
    createdAt: "2026-11-01T00:00:00.000Z",
    notifications: [],
  } as unknown as PersistedBench;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));
}

function recordOf(data: PersistedState, id: number): PersistedBench | undefined {
  return data.benches.find((r) => r.id === id);
}

// The state dir is fixed when state.ts is first imported, so every module is
// imported once, against one temp home, and each case starts from fresh files.
beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-state-race-")));
  originalHome = process.env.HOME;
  originalProduction = process.env.ROUBO_PRODUCTION;
  process.env.HOME = home;
  process.env.ROUBO_PRODUCTION = "1";
  vi.resetModules();
  state = await import("./state.js");
  enableState = await import("./plugin-enable-state.js");
  consentState = await import("./plugin-consent-state.js");
  tokens = await import("./self-write-tokens.js");
  watch = await import("./state-dir-watch.js");
  pluginManager = await import("./plugin-manager.js");
  benchManager = await import("./bench-manager.js");
  dir = state.getRouboDir();
  state.ensureDirs();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProduction === undefined) delete process.env.ROUBO_PRODUCTION;
  else process.env.ROUBO_PRODUCTION = originalProduction;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".json")) fs.rmSync(path.join(dir, name), { force: true });
  }
  tokens.resetSelfWriteTokens();
  enableState.__test.reset();
  consentState.__test.reset();
  vi.clearAllMocks();
  hoisted.events = [];
  hoisted.live = new Set([2]);
  lines = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  writeJson("state.json", { benches: [bench(2, "bench-2", 3000), bench(3, "bench-3", 3100)] });
  writeJson("settings.json", { theme: "dark" });
  writeJson("plugins-state.json", {
    schemaVersion: 1,
    installInitialized: true,
    plugins: { database: "enabled", process: "enabled" },
  });
  // What the app holds at boot: its read of each file.
  state.rememberState(state.loadState());
  hoisted.cache = enableState.loadEnableState();
  await watch.startStateDirWatch({ dir });
});

afterEach(async () => {
  await watch.stopStateDirWatch();
});

describe("a hand edit followed by an app write inside the settle window", () => {
  it("HR-TC-029 an idle bench edit is still applied, and the app write keeps its own change", async () => {
    writeJson("state.json", { benches: [bench(2, "bench-2", 3000), bench(3, "by-hand", 3100)] });
    // The app updates the other bench before the watch has run for the edit.
    state.updateBench({ ...bench(2, "bench-2", 3000), baseBranch: "main" } as PersistedBench);

    await waitFor(() => hoisted.events.length === 1);

    expect(benchManager.applyStateFileEdit).toHaveBeenCalledTimes(1);
    expect(hoisted.events[0]).toMatchObject({
      surface: "bench",
      outcome: "applied",
      benchIds: [3],
      summary: "Bench state applied: bench 3 on lantern.",
    });
    const onDisk = readJson<PersistedState>("state.json");
    expect(recordOf(onDisk, 3)?.branch).toBe("by-hand");
    expect(recordOf(onDisk, 2)?.baseBranch).toBe("main");
    const known = state.getKnownState() as PersistedState;
    expect(recordOf(known, 3)?.branch).toBe("by-hand");
    expect(recordOf(known, 2)?.baseBranch).toBe("main");
  });

  it("HR-TC-029 an active bench edit is still refused with a notice and undone in the file", async () => {
    writeJson("state.json", { benches: [bench(2, "bench-2", 4000), bench(3, "bench-3", 3100)] });
    state.updateBench({ ...bench(3, "bench-3", 3100), baseBranch: "main" } as PersistedBench);

    await waitFor(() => hoisted.events.length === 1);

    expect(hoisted.events[0]).toMatchObject({
      surface: "bench",
      outcome: "refused",
      benchIds: [2],
      summary: "Bench state not applied: bench 2 on lantern is active. Stop it first.",
    });
    await waitFor(() => recordOf(readJson<PersistedState>("state.json"), 2)?.ports.web === 3000);
    const onDisk = readJson<PersistedState>("state.json");
    expect(recordOf(onDisk, 3)?.baseBranch).toBe("main");
    const known = state.getKnownState() as PersistedState;
    expect(recordOf(known, 2)?.ports).toEqual({ web: 3000 });
  });

  it("HR-TC-029 an active bench edit is refused when the app write is of the same bench", async () => {
    writeJson("state.json", { benches: [bench(2, "bench-2", 4000), bench(3, "bench-3", 3100)] });
    // The app writes bench 2 from memory, with a change of its own.
    state.updateBench({ ...bench(2, "bench-2", 3000), baseBranch: "main" } as PersistedBench);

    await waitFor(() => hoisted.events.length === 1);

    expect(hoisted.events[0]).toMatchObject({ outcome: "refused", benchIds: [2] });
    await sleep(300);
    const onDisk = readJson<PersistedState>("state.json");
    expect(recordOf(onDisk, 2)?.ports).toEqual({ web: 3000 });
    expect(recordOf(onDisk, 2)?.baseBranch).toBe("main");
  });

  it("HR-TC-031 two app writes on one hand edit both log self-write, and the edit still applies", async () => {
    writeJson("state.json", { benches: [bench(2, "bench-2", 3000), bench(3, "by-hand", 3100)] });
    state.updateBench({ ...bench(2, "bench-2", 3000), baseBranch: "one" } as PersistedBench);
    state.updateBench({ ...bench(2, "bench-2", 3000), baseBranch: "two" } as PersistedBench);

    await waitFor(() => hoisted.events.length === 1);

    expect(hoisted.events[0]).toMatchObject({ outcome: "applied", benchIds: [3] });
    const stateLines = lines.filter((l) => l.includes("/state.json outcome="));
    expect(stateLines.filter((l) => l.includes(" outcome=self-write "))).toHaveLength(2);
    expect(recordOf(state.getKnownState() as PersistedState, 2)?.baseBranch).toBe("two");
  });

  it("HR-TC-030 an app write with no hand edit before it still runs no handler", async () => {
    state.updateBench({ ...bench(2, "bench-2", 3000), baseBranch: "main" } as PersistedBench);

    await waitFor(() => lines.some((l) => l.includes("/state.json outcome=self-write ")));
    await sleep(400);

    expect(benchManager.applyStateFileEdit).not.toHaveBeenCalled();
    expect(hoisted.events).toEqual([]);
  });

  it("HR-TC-030 a plain app write after a hand edit that took in an earlier app write runs no handler", async () => {
    const selfWrites = () =>
      lines.filter((l) => l.includes("/settings.json outcome=self-write ")).length;
    // H1, then app write A lands on it, then H2 before the watch runs.
    writeJson("settings.json", { theme: "light" });
    state.saveSettings({ ...state.loadSettings(), theme: "dark" });
    writeJson("settings.json", { theme: "light" });

    // The run reads H2, matches no app write, and applies it.
    await waitFor(() => hoisted.events.length === 1);
    expect(hoisted.events[0]).toMatchObject({ surface: "settings", outcome: "applied" });
    expect(selfWrites()).toBe(0);

    // App write B: the run consumes A and B, and neither carries a hand edit now.
    state.saveSettings({ ...state.loadSettings(), theme: "dark" });
    await waitFor(() => selfWrites() === 2);
    await sleep(400);

    expect(hoisted.events).toHaveLength(1);
    expect(lines.filter((l) => l.includes("/settings.json outcome=applied "))).toHaveLength(1);
  });

  it("HR-TC-030 a plain app write of plugins-state.json after the same sequence runs no handler", async () => {
    const selfWrites = () =>
      lines.filter((l) => l.includes("/plugins-state.json outcome=self-write ")).length;
    const byHand = {
      schemaVersion: 1,
      installInitialized: true,
      plugins: { database: "enabled", process: "enabled", extra: "enabled" },
    };
    writeJson("plugins-state.json", byHand);
    hoisted.cache = enableState.setPluginEnabled("process", false);
    writeJson("plugins-state.json", {
      ...byHand,
      plugins: { ...byHand.plugins, extra: "disabled" },
    });

    await waitFor(() => hoisted.events.length === 1);
    expect(pluginManager.reloadEnableState).toHaveBeenCalledTimes(1);

    hoisted.cache = enableState.setPluginEnabled("database", false);
    await waitFor(() => selfWrites() >= 1);
    await sleep(400);

    expect(pluginManager.reloadEnableState).toHaveBeenCalledTimes(1);
    expect(hoisted.events).toHaveLength(1);
  });

  it("HR-TC-034 a rejected settings.json notice clears when the app saves valid settings", async () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{");
    await waitFor(() => hoisted.events.length === 1);
    expect(hoisted.events[0]).toMatchObject({ surface: "settings", outcome: "rejected" });

    state.saveSettings({ ...state.loadSettings(), theme: "light" });
    await waitFor(() => hoisted.events.length === 2);

    // Untargeted, as the rejection was, so a client clears that notice.
    expect(hoisted.events[1]).toEqual({
      surface: "settings",
      outcome: "applied",
      summary: "Settings applied.",
    });
    expect(lines.filter((l) => l.includes("/settings.json outcome=self-write "))).toHaveLength(1);

    // The notice is cleared once: a later app write sends nothing.
    state.saveSettings({ ...state.loadSettings(), theme: "dark" });
    await waitFor(
      () => lines.filter((l) => l.includes("/settings.json outcome=self-write ")).length === 2,
    );
    await sleep(300);
    expect(hoisted.events).toHaveLength(2);
  });

  it("HR-TC-034 a rejected projects.json notice clears when the app saves the projects", async () => {
    fs.writeFileSync(path.join(dir, "projects.json"), "{");
    await waitFor(() => hoisted.events.length === 1);
    expect(hoisted.events[0]).toMatchObject({ surface: "project-config", outcome: "rejected" });

    state.saveProjects({ projects: [] });
    await waitFor(() => hoisted.events.length === 2);

    expect(hoisted.events[1]).toEqual({
      surface: "project-config",
      outcome: "applied",
      summary: "Project state applied.",
    });
  });

  it("HR-TC-028 a plugin disabled by hand is still stopped when the app writes the enable state", async () => {
    writeJson("plugins-state.json", {
      schemaVersion: 1,
      installInitialized: true,
      plugins: { database: "disabled", process: "enabled" },
    });
    // The app disables another plugin; the plugin manager caches what it returns.
    hoisted.cache = enableState.setPluginEnabled("process", false);
    expect(hoisted.cache.plugins.database).toBe("enabled");

    await waitFor(() => hoisted.events.length === 1);

    expect(pluginManager.reloadEnableState).toHaveBeenCalledTimes(1);
    expect(hoisted.events[0]).toMatchObject({
      surface: "plugin",
      outcome: "applied",
      summary: "Plugin database disabled.",
    });
    expect(readJson<PluginEnableState>("plugins-state.json").plugins).toEqual({
      database: "disabled",
      process: "disabled",
    });
  });

  it("HR-TC-027 a consent added by hand still starts its plugin when the app writes a consent", async () => {
    writeJson("plugins-consent.json", {
      schemaVersion: 1,
      plugins: {
        database: {
          pluginId: "database",
          acknowledgedCategories: [],
          consentedAt: "2026-11-01T00:00:00.000Z",
        },
      },
    });
    consentState.upsertConsent("process", []);

    await waitFor(() => hoisted.events.length === 1);

    expect(pluginManager.startAfterConsent).toHaveBeenCalledWith("database");
    expect(hoisted.events[0]).toMatchObject({ surface: "plugin", outcome: "applied" });
    expect(Object.keys(consentState.loadConsentState()?.plugins ?? {}).sort()).toEqual([
      "database",
      "process",
    ]);
  });
});
