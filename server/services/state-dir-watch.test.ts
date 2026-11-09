/**
 * The state dir watch (HR-FR-012, HR-FR-013) against a real temp state dir,
 * real chokidar, the real InputWatcher and the real `atomicWrite`, so the
 * self-write path is the one the server runs. What each state file feeds (the
 * bench manager, the plugin manager, the project registry, the credential
 * store) is a fake, so each case checks what the watch asks of it and the
 * notice it sends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InputChangedEvent, PluginConsentState } from "@roubo/shared";

const hoisted = vi.hoisted(() => ({
  rouboDir: "",
  events: [] as Omit<InputChangedEvent, "type">[],
  consent: null as PluginConsentState | null,
}));

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    ...actual,
    getRouboDir: () => hoisted.rouboDir,
    loadProjects: () => ({ projects: [] }),
    // The real one reads the process's own state dir, never the temp one.
    loadSettings: vi.fn(() => ({ theme: "dark" })),
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
vi.mock("./bench-manager.js", () => ({
  applyStateFileEdit: vi.fn(() => ({ applied: [], refused: [] })),
}));
vi.mock("./plugin-manager.js", () => ({
  startAfterConsent: vi.fn(() => Promise.resolve(true)),
  reloadEnableState: vi.fn(() => Promise.resolve({ disabled: [], enabled: [] })),
}));
vi.mock("./project-registry.js", () => ({
  applyProjectsFileEdit: vi.fn(() => []),
}));
vi.mock("./credential-store.js", () => ({
  set: vi.fn(() => Promise.resolve()),
}));
vi.mock("./plugin-consent-state.js", () => ({
  loadConsentState: vi.fn(() => hoisted.consent),
}));

import * as benchManager from "./bench-manager.js";
import * as credentialStore from "./credential-store.js";
import * as pluginManager from "./plugin-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as state from "./state.js";
import { atomicWrite } from "./state.js";
import { resetSelfWriteTokens } from "./self-write-tokens.js";
import {
  STATE_FILES,
  benchAppliedNotice,
  benchRefusedNotice,
  jsonParseError,
  startStateDirWatch,
  stopStateDirWatch,
} from "./state-dir-watch.js";

let base: string;
let dir: string;
let lines: string[];

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

/** The apply lines of one state file. */
function fileLines(file: string, outcome?: string): string[] {
  return lines.filter(
    (l) =>
      l.startsWith("[input-watcher] ") &&
      l.includes(`/${file} outcome=`) &&
      (outcome === undefined || l.includes(` outcome=${outcome} `)),
  );
}

function consentFile(...ids: string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    plugins: Object.fromEntries(
      ids.map((id) => [
        id,
        { pluginId: id, acknowledgedCategories: [], consentedAt: "2026-11-01T00:00:00.000Z" },
      ]),
    ),
  });
}

function benchFile(branch: string): string {
  return JSON.stringify({
    benches: [{ id: 3, projectId: "lantern", branch, workspacePath: "/w", ports: {} }],
  });
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-state-dir-watch-")));
  dir = path.join(base, "state");
  fs.mkdirSync(dir, { recursive: true });
  hoisted.rouboDir = dir;
  hoisted.events = [];
  hoisted.consent = null;
  resetSelfWriteTokens();
  vi.clearAllMocks();
  lines = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  fs.writeFileSync(path.join(dir, "state.json"), benchFile("bench-3"));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: "light" }));
  fs.writeFileSync(
    path.join(dir, "plugins-state.json"),
    JSON.stringify({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { database: "enabled" },
    }),
  );
  await startStateDirWatch({ dir });
});

afterEach(async () => {
  await stopStateDirWatch();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("state dir watch", () => {
  it("watches the five state files and settings.json, and nothing else in the state dir", async () => {
    expect([...STATE_FILES].sort()).toEqual(
      [
        "auth.json",
        "plugins-consent.json",
        "plugins-state.json",
        "projects.json",
        "settings.json",
        "state.json",
      ].sort(),
    );

    // The tmp sibling atomicWrite renames from, and any other file, run nothing.
    fs.writeFileSync(path.join(dir, "state.json.tmp"), benchFile("other"));
    fs.writeFileSync(path.join(dir, "notes.json"), "{}");
    await sleep(400);

    expect(lines.filter((l) => l.includes(" outcome="))).toEqual([]);
    expect(hoisted.events).toEqual([]);
  });

  it("HR-TC-027 a consent record added to plugins-consent.json by hand starts the plugin with a notice", async () => {
    fs.writeFileSync(path.join(dir, "plugins-consent.json"), consentFile("database"));

    await waitFor(() => hoisted.events.length === 1);

    expect(pluginManager.startAfterConsent).toHaveBeenCalledWith("database");
    expect(hoisted.events[0]).toMatchObject({
      surface: "plugin",
      outcome: "applied",
      pluginId: "database",
      summary: "Plugin consent applied: database.",
    });
    expect(fileLines("plugins-consent.json", "applied")).toHaveLength(1);
    expect(fileLines("plugins-consent.json")[0]).toContain("surface=plugin ");
  });

  it("HR-TC-027 a consented plugin that is already running is not named in the notice", async () => {
    await stopStateDirWatch();
    hoisted.consent = JSON.parse(consentFile("process"));
    fs.writeFileSync(path.join(dir, "plugins-consent.json"), consentFile("process"));
    await startStateDirWatch({ dir });
    // "process" runs already, so its start is a no-op that starts nothing.
    // The file lists "process" first, then "database".
    vi.mocked(pluginManager.startAfterConsent)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    fs.writeFileSync(path.join(dir, "plugins-consent.json"), consentFile("process", "database"));
    await waitFor(() => hoisted.events.length === 1);

    expect(pluginManager.startAfterConsent).toHaveBeenCalledWith("process");
    expect(pluginManager.startAfterConsent).toHaveBeenCalledWith("database");
    expect(hoisted.events[0]).toMatchObject({
      pluginId: "database",
      summary: "Plugin consent applied: database.",
    });
  });

  it("HR-TC-027 a consent record removed by the app and added back by hand starts the plugin", async () => {
    const file = path.join(dir, "plugins-consent.json");
    await stopStateDirWatch();
    hoisted.consent = JSON.parse(consentFile("database"));
    fs.writeFileSync(file, consentFile("database"));
    await startStateDirWatch({ dir });

    // The app removes the record, as an uninstall does: a self-write, which
    // runs no handler.
    hoisted.consent = JSON.parse(consentFile());
    atomicWrite(file, consentFile());
    await waitFor(() => fileLines("plugins-consent.json", "self-write").length === 1);
    expect(pluginManager.startAfterConsent).not.toHaveBeenCalled();

    // The record is added back by hand.
    hoisted.consent = JSON.parse(consentFile("database"));
    fs.writeFileSync(file, consentFile("database"));
    await waitFor(() => hoisted.events.length === 1);

    expect(pluginManager.startAfterConsent).toHaveBeenCalledWith("database");
    expect(hoisted.events[0]).toMatchObject({
      surface: "plugin",
      outcome: "applied",
      pluginId: "database",
      summary: "Plugin consent applied: database.",
    });
  });

  it("HR-TC-028 setting a plugin disabled in plugins-state.json by hand reloads the enable state with a notice", async () => {
    vi.mocked(pluginManager.reloadEnableState).mockResolvedValueOnce({
      disabled: ["database"],
      enabled: [],
    });
    fs.writeFileSync(
      path.join(dir, "plugins-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        installInitialized: true,
        plugins: { database: "disabled" },
      }),
    );

    await waitFor(() => hoisted.events.length === 1);

    expect(pluginManager.reloadEnableState).toHaveBeenCalledTimes(1);
    expect(hoisted.events[0]).toMatchObject({
      surface: "plugin",
      outcome: "applied",
      pluginId: "database",
      summary: "Plugin database disabled.",
    });
  });

  it("HR-TC-028 a plugins-state.json that fails its schema reloads nothing", async () => {
    fs.writeFileSync(
      path.join(dir, "plugins-state.json"),
      JSON.stringify({ schemaVersion: 1, installInitialized: true, plugins: { database: "off" } }),
    );

    await waitFor(() => hoisted.events.length === 1);

    expect(pluginManager.reloadEnableState).not.toHaveBeenCalled();
    expect(hoisted.events[0]).toMatchObject({
      surface: "plugin",
      outcome: "rejected",
      error: { path: "plugins-state.json" },
    });
  });

  it("HR-TC-029 a branch edit of an idle bench in state.json is applied with a notice naming the bench", async () => {
    vi.mocked(benchManager.applyStateFileEdit).mockReturnValueOnce({
      applied: [{ projectId: "lantern", benchId: 3 }],
      refused: [],
    });
    fs.writeFileSync(path.join(dir, "state.json"), benchFile("feature/new"));

    await waitFor(() => hoisted.events.length === 1);

    const persisted = vi.mocked(benchManager.applyStateFileEdit).mock.calls[0][0];
    expect(persisted.benches[0]).toMatchObject({
      id: 3,
      projectId: "lantern",
      branch: "feature/new",
    });
    expect(hoisted.events[0]).toEqual({
      surface: "bench",
      outcome: "applied",
      projectId: "lantern",
      benchIds: [3],
      summary: "Bench state applied: bench 3 on lantern.",
    });
  });

  it("HR-TC-029 a ports edit of an active bench in state.json is refused with a notice naming the bench", async () => {
    vi.mocked(benchManager.applyStateFileEdit).mockReturnValueOnce({
      applied: [],
      refused: [{ projectId: "lantern", benchId: 2, status: "active" }],
    });
    fs.writeFileSync(path.join(dir, "state.json"), benchFile("bench-3-ports"));

    await waitFor(() => hoisted.events.length === 1);

    expect(hoisted.events[0]).toEqual({
      surface: "bench",
      outcome: "refused",
      projectId: "lantern",
      benchIds: [2],
      summary: "Bench state not applied: bench 2 on lantern is active. Stop it first.",
      error: { path: "state.json", first: "bench 2 on lantern is active" },
    });
    expect(fileLines("state.json", "refused")).toHaveLength(1);
  });

  it("HR-TC-029 the write-back that undoes a refused state.json edit is a self-write and is not applied again", async () => {
    const file = path.join(dir, "state.json");
    // The bench manager writes the live bench back from memory, as it does for
    // a refused edit, through the real atomicWrite.
    vi.mocked(benchManager.applyStateFileEdit).mockImplementationOnce(() => {
      atomicWrite(file, benchFile("bench-3"));
      return { applied: [], refused: [{ projectId: "lantern", benchId: 3, status: "active" }] };
    });
    fs.writeFileSync(file, benchFile("refused-by-hand"));

    await waitFor(() => fileLines("state.json", "self-write").length === 1);
    await sleep(400);

    expect(benchManager.applyStateFileEdit).toHaveBeenCalledTimes(1);
    expect(fileLines("state.json", "refused")).toHaveLength(1);
    expect(fileLines("state.json", "applied")).toHaveLength(0);
    expect(hoisted.events).toHaveLength(1);
    expect(hoisted.events[0]).toMatchObject({ outcome: "refused" });
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).benches[0].branch).toBe("bench-3");
  });

  it("HR-TC-030 the app's own write of state.json logs self-write and applies and sends nothing", async () => {
    atomicWrite(path.join(dir, "state.json"), benchFile("set-up-by-roubo"));

    await waitFor(() => fileLines("state.json", "self-write").length === 1);
    await sleep(400);

    expect(fileLines("state.json")).toHaveLength(1);
    expect(fileLines("state.json")[0]).toContain("surface=bench ");
    expect(benchManager.applyStateFileEdit).not.toHaveBeenCalled();
    expect(hoisted.events).toEqual([]);
  });

  it("HR-TC-031 three back-to-back app writes log three self-writes, and a hand edit after them applies", async () => {
    const file = path.join(dir, "state.json");
    atomicWrite(file, benchFile("one"));
    atomicWrite(file, benchFile("two"));
    atomicWrite(file, benchFile("three"));

    await waitFor(() => fileLines("state.json", "self-write").length === 3);
    await sleep(400);
    expect(fileLines("state.json", "self-write")).toHaveLength(3);
    expect(fileLines("state.json", "applied")).toHaveLength(0);
    expect(benchManager.applyStateFileEdit).not.toHaveBeenCalled();

    fs.writeFileSync(file, benchFile("by-hand"));
    await waitFor(() => fileLines("state.json", "applied").length === 1);

    expect(benchManager.applyStateFileEdit).toHaveBeenCalledTimes(1);
    expect(fileLines("state.json", "self-write")).toHaveLength(3);
  });

  it("HR-TC-034 invalid JSON in settings.json is rejected with a notice naming the file and the parse error", async () => {
    vi.mocked(state.loadSettings).mockClear();
    fs.writeFileSync(path.join(dir, "settings.json"), "{");

    await waitFor(() => hoisted.events.length === 1);

    const event = hoisted.events[0];
    expect(event).toMatchObject({
      surface: "settings",
      outcome: "rejected",
      error: { path: "settings.json", first: "invalid JSON at line 1 column 2" },
    });
    expect(event.summary).toBe(
      "Settings not applied. settings.json: invalid JSON at line 1 column 2. Last good settings still in effect.",
    );
    // Nothing reads the broken file as new settings.
    expect(state.loadSettings).not.toHaveBeenCalled();

    // The watch keeps running: a fixed file applies.
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
    await waitFor(() => hoisted.events.length === 2);
    expect(hoisted.events[1]).toMatchObject({
      surface: "settings",
      outcome: "applied",
      summary: "Settings applied.",
    });
    expect(state.loadSettings).toHaveBeenCalledTimes(1);
  });

  it("invalid JSON in any state file is rejected and nothing of it is applied", async () => {
    fs.writeFileSync(path.join(dir, "state.json"), '{"benches": [');

    await waitFor(() => hoisted.events.length === 1);

    expect(benchManager.applyStateFileEdit).not.toHaveBeenCalled();
    expect(hoisted.events[0]).toMatchObject({
      surface: "bench",
      outcome: "rejected",
      error: { path: "state.json" },
    });
    expect(hoisted.events[0].summary).toMatch(
      /^Bench state not applied\. state\.json: invalid JSON/,
    );
  });

  it("applies the project settings that a projects.json edit changes", async () => {
    vi.mocked(projectRegistry.applyProjectsFileEdit).mockReturnValueOnce(["lantern"]);
    fs.writeFileSync(
      path.join(dir, "projects.json"),
      JSON.stringify({ projects: [{ id: "lantern", repoPath: "/r", settings: {} }] }),
    );

    await waitFor(() => hoisted.events.length === 1);

    expect(projectRegistry.applyProjectsFileEdit).toHaveBeenCalledTimes(1);
    expect(hoisted.events[0]).toMatchObject({
      surface: "project-config",
      outcome: "applied",
      projectId: "lantern",
      summary: "Project settings applied: lantern.",
    });
  });

  it("copies a GitHub token put in auth.json into the github-com credential slot and leaves the file", async () => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ githubToken: "ghp_example" }));

    await waitFor(() => hoisted.events.length === 1);

    expect(credentialStore.set).toHaveBeenCalledWith("github-com", "github-token", "ghp_example");
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(true);
    expect(hoisted.events[0]).toMatchObject({
      surface: "github",
      outcome: "applied",
      summary: "GitHub token applied from auth.json.",
    });
    // The token is never logged or sent.
    expect(lines.join("\n")).not.toContain("ghp_example");
    expect(JSON.stringify(hoisted.events)).not.toContain("ghp_example");
  });
});

describe("state dir watch notice copy", () => {
  it("names each bench by project, in order", () => {
    expect(benchAppliedNotice([])).toBe("Bench state applied.");
    expect(
      benchAppliedNotice([
        { projectId: "lantern", benchId: 4 },
        { projectId: "lantern", benchId: 3 },
        { projectId: "kiln", benchId: 1 },
      ]),
    ).toBe("Bench state applied: benches 3, 4 on lantern and bench 1 on kiln.");
    expect(
      benchRefusedNotice([
        { projectId: "lantern", benchId: 2, status: "active" },
        { projectId: "lantern", benchId: 5, status: "active" },
      ]).summary,
    ).toBe("Bench state not applied: benches 2, 5 on lantern are active. Stop them first.");
  });

  it("names the place of a JSON parse error and never the input", () => {
    expect(jsonParseError('{"a":1}')).toBeNull();
    expect(jsonParseError("{")).toBe("invalid JSON at line 1 column 2");
    const quoted = jsonParseError("secret-token-value");
    expect(quoted).toMatch(/^invalid JSON/);
    expect(quoted).not.toContain("secret");
  });
});
