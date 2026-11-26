/**
 * Project register, re-path and unregister reach every watch (HR-FR-014,
 * HR-US-007), against real temp directories, real chokidar, the real
 * InputWatcher, the real state dir watch, the real project registry and the
 * real jig manager. Only the state dir, the persisted bench list and the
 * modules the state dir watch feeds besides the registry are redirected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InputChangedEvent, PersistedProjects } from "@roubo/shared";

const hoisted = vi.hoisted(() => ({
  rouboDir: "",
  events: [] as Omit<InputChangedEvent, "type">[],
}));

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  const projectsFile = () => `${hoisted.rouboDir}/projects.json`;
  const loadProjects = (): PersistedProjects =>
    fs.existsSync(projectsFile())
      ? (JSON.parse(fs.readFileSync(projectsFile(), "utf-8")) as PersistedProjects)
      : { projects: [] };
  // The app writes projects.json through atomicWrite, as the server does, so
  // the state dir watch takes each such write as a self-write.
  const saveProjects = (data: PersistedProjects) =>
    actual.atomicWrite(projectsFile(), JSON.stringify(data, null, 2));
  return {
    ...actual,
    getRouboDir: () => hoisted.rouboDir,
    ensureDirs: () => {},
    loadSettings: () => ({}),
    loadProjects,
    saveProjects,
    addProject: (entry: PersistedProjects["projects"][number]) => {
      const data = loadProjects();
      saveProjects({ projects: [...data.projects.filter((p) => p.id !== entry.id), entry] });
    },
    removeProject: (id: string) => {
      saveProjects({ projects: loadProjects().projects.filter((p) => p.id !== id) });
    },
    getPersistedBenches: () => [],
    removeBench: () => undefined,
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
  applyStateFileEdit: vi.fn(() => ({
    applied: [],
    refused: [],
    reverted: [],
    unmatched: [],
    removed: [],
  })),
}));
vi.mock("./plugin-manager.js", () => ({
  getComponentManifests: () => [],
  startAfterConsent: vi.fn(() => Promise.resolve(false)),
  reloadEnableState: vi.fn(() => Promise.resolve({ disabled: [], enabled: [] })),
}));
vi.mock("./credential-store.js", () => ({ set: vi.fn(() => Promise.resolve()) }));
vi.mock("./cut-list-query-service.js", () => ({
  cutListQueryService: { evictProject: () => undefined, evictPlugin: () => undefined },
}));

import * as registry from "./project-registry.js";
import * as jigManager from "./jig-manager.js";
import { startStateDirWatch, stopStateDirWatch } from "./state-dir-watch.js";
import { resetSelfWriteTokens } from "./self-write-tokens.js";
import { resetForTests as resetRepathMarks } from "./project-repath-state.js";
import { createWaitFor, sleep } from "../test/watch-wait.js";

let base: string;
let lines: string[];
let stopJigWatches: () => void;

const waitFor = createWaitFor(
  () => `log so far:\n${lines.join("\n")}\nevents: ${JSON.stringify(hoisted.events)}`,
);

function roubo(name: string, webBase: number, max = 3): string {
  return (
    `project:\n  name: ${name}\n  displayName: ${name}\nlayout:\n  type: single-repo\n` +
    `components:\n  web:\n    plugin:\n      id: process\n    config:\n      command: npm start\n` +
    `ports:\n  web:\n    base: ${webBase}\n` +
    `benches:\n  max: ${max}\n`
  );
}

function makeProjectDir(name: string, yaml: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, ".roubo", "jigs"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".roubo", "roubo.yaml"), yaml);
  return dir;
}

function jig(name: string): string {
  return `---\nname: ${name}\ndescription: A jig named ${name}\n---\nDo the thing.\n`;
}

/** A hand edit of projects.json: a plain write, not the app's atomicWrite. */
function handEditProjects(projects: { id: string; repoPath: string }[]): void {
  fs.writeFileSync(path.join(hoisted.rouboDir, "projects.json"), JSON.stringify({ projects }));
}

function configWatchLines(dir: string): string[] {
  const configPath = path.join(dir, ".roubo", "roubo.yaml");
  return lines.filter((l) => l.startsWith("[input-watcher] ") && l.includes(configPath));
}

async function armed(projectId: string): Promise<void> {
  const watch = registry.__test.configWatch(projectId);
  if (!watch) throw new Error(`no roubo.yaml watch for ${projectId}`);
  await watch.ready;
}

let lanternDir: string;

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-project-lifecycle-")));
  hoisted.rouboDir = path.join(base, "state");
  hoisted.events = [];
  fs.mkdirSync(hoisted.rouboDir, { recursive: true });
  lanternDir = makeProjectDir("lantern", roubo("lantern", 4100));
  fs.writeFileSync(
    path.join(hoisted.rouboDir, "projects.json"),
    JSON.stringify({ projects: [{ id: "lantern", repoPath: lanternDir }] }),
  );
  resetSelfWriteTokens();
  resetRepathMarks();
  lines = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }

  registry.__test.reset();
  registry.registerLiveBenchSource(null);
  registry.initialize();
  registry.watchProjectConfigs();
  stopJigWatches = jigManager.watchProjectJigs();
  await armed("lantern");
  await startStateDirWatch({ dir: hoisted.rouboDir });
});

afterEach(async () => {
  await stopStateDirWatch();
  stopJigWatches();
  jigManager.stopAllWatchers();
  jigManager.invalidateCache();
  await registry.unwatchProjectConfigs();
  registry.__test.reset();
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("project add, re-path and remove", () => {
  it("HR-TC-026 a project added to projects.json by hand is listed and its roubo.yaml watch is armed", async () => {
    const lantern2Dir = makeProjectDir("lantern-2", roubo("lantern-2", 4300));
    handEditProjects([
      { id: "lantern", repoPath: lanternDir },
      { id: "lantern-2", repoPath: lantern2Dir },
    ]);

    await waitFor(() => hoisted.events.length === 1);
    expect(hoisted.events[0]).toMatchObject({
      surface: "project-config",
      outcome: "applied",
      projectId: "lantern-2",
      input: "projects.json",
      summary: `Project lantern-2 registered from ${lantern2Dir}.`,
    });
    // The cut list and every other view read the registry's project list.
    expect(registry.getProjects().map((p) => p.id)).toEqual(["lantern", "lantern-2"]);

    await armed("lantern-2");
    fs.writeFileSync(path.join(lantern2Dir, ".roubo", "roubo.yaml"), roubo("lantern-2", 4300, 4));
    await waitFor(() => hoisted.events.length === 2);
    expect(hoisted.events[1]).toMatchObject({
      surface: "project-config",
      outcome: "applied",
      projectId: "lantern-2",
      summary: "Project lantern-2: roubo.yaml applied.",
    });
    expect(registry.getProject("lantern-2")?.config?.benches.max).toBe(4);
  });

  it("HR-TC-026 a project added by hand has its jig watch armed", async () => {
    const lantern2Dir = makeProjectDir("lantern-2", roubo("lantern-2", 4300));
    handEditProjects([
      { id: "lantern", repoPath: lanternDir },
      { id: "lantern-2", repoPath: lantern2Dir },
    ]);
    await waitFor(() => registry.getProject("lantern-2") !== undefined);
    expect(jigManager.listJigsForProject("lantern-2").map((j) => j.id)).not.toContain("triage");

    fs.writeFileSync(path.join(lantern2Dir, ".roubo", "jigs", "triage.md"), jig("Triage"));

    await waitFor(() => jigManager.listJigsForProject("lantern-2").some((j) => j.id === "triage"));
  });

  it("HR-TC-032 re-pathing a project re-arms its config and jig watches at the new path", async () => {
    const movedDir = path.join(base, "lantern-moved");
    fs.renameSync(lanternDir, movedDir);
    handEditProjects([{ id: "lantern", repoPath: movedDir }]);

    await waitFor(() => hoisted.events.length === 1);
    expect(hoisted.events[0]).toMatchObject({
      surface: "project-config",
      outcome: "applied",
      projectId: "lantern",
      input: "projects.json",
      summary: `Project lantern now at ${movedDir}.`,
    });
    expect(registry.getProject("lantern")?.repoPath).toBe(movedDir);

    await armed("lantern");
    fs.writeFileSync(path.join(movedDir, ".roubo", "roubo.yaml"), roubo("lantern", 4100, 5));
    await waitFor(() => hoisted.events.length === 2);
    expect(hoisted.events[1]).toMatchObject({
      outcome: "applied",
      projectId: "lantern",
      summary: "Project lantern: roubo.yaml applied.",
    });
    expect(registry.getProject("lantern")?.config?.benches.max).toBe(5);

    expect(jigManager.listJigsForProject("lantern").map((j) => j.id)).not.toContain("triage");
    fs.writeFileSync(path.join(movedDir, ".roubo", "jigs", "triage.md"), jig("Triage"));
    await waitFor(() => jigManager.listJigsForProject("lantern").some((j) => j.id === "triage"));
  });

  it("HR-TC-033 a project removed through the app disposes its watches", async () => {
    // Warm the jig list, so a reload after the remove would show.
    expect(jigManager.listJigsForProject("lantern").length).toBeGreaterThan(0);
    // The DELETE /api/projects/lantern route calls this.
    await registry.unregisterProject("lantern");
    expect(registry.getProjects()).toEqual([]);
    expect(registry.__test.configWatch("lantern")).toBeUndefined();
    const before = hoisted.events.length;
    const linesBefore = configWatchLines(lanternDir).length;

    fs.writeFileSync(path.join(lanternDir, ".roubo", "roubo.yaml"), roubo("lantern", 4100, 6));
    fs.writeFileSync(path.join(lanternDir, ".roubo", "jigs", "triage.md"), jig("Triage"));
    await sleep(800);

    expect(hoisted.events.slice(before)).toEqual([]);
    expect(configWatchLines(lanternDir).slice(linesBefore)).toEqual([]);
    expect(registry.getProject("lantern")).toBeUndefined();
  });

  it("HR-TC-033 a project removed from projects.json by hand disposes its watches", async () => {
    handEditProjects([]);
    await waitFor(() => hoisted.events.length === 1);
    expect(hoisted.events[0]).toMatchObject({
      outcome: "applied",
      projectId: "lantern",
      summary: "Project lantern unregistered.",
    });
    expect(registry.getProjects()).toEqual([]);
    const linesBefore = configWatchLines(lanternDir).length;

    fs.writeFileSync(path.join(lanternDir, ".roubo", "roubo.yaml"), roubo("lantern", 4100, 6));
    await sleep(800);

    expect(hoisted.events).toHaveLength(1);
    expect(configWatchLines(lanternDir).slice(linesBefore)).toEqual([]);
  });

  it("rejects a hand-added project whose ports overlap another's and keeps the registry", async () => {
    const clashDir = makeProjectDir("clash", roubo("clash", 4100));
    handEditProjects([
      { id: "lantern", repoPath: lanternDir },
      { id: "clash", repoPath: clashDir },
    ]);

    await waitFor(() => hoisted.events.length === 1);
    expect(hoisted.events[0]).toMatchObject({ outcome: "rejected", input: "projects.json" });
    expect(hoisted.events[0].summary).toMatch(/^Project state not applied\. projects\.json: /);
    expect(registry.getProjects().map((p) => p.id)).toEqual(["lantern"]);
    expect(registry.__test.configWatch("clash")).toBeUndefined();
  });
});
