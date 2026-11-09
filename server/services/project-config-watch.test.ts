/**
 * The roubo.yaml watch of each registered project, against real temp
 * directories, the real config parser and real chokidar. Only the state dir,
 * the persisted project list and the plugin manager are redirected; the
 * notification stream is read through a fake client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Response } from "express";
import type { InputChangedEvent } from "@roubo/shared";

const hoisted = vi.hoisted(() => ({
  rouboDir: "",
  projects: [] as { id: string; repoPath: string }[],
}));
vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    ...actual,
    getRouboDir: () => hoisted.rouboDir,
    loadProjects: () => ({ projects: hoisted.projects }),
    addProject: (entry: { id: string; repoPath: string }) => {
      hoisted.projects = [...hoisted.projects.filter((p) => p.id !== entry.id), entry];
    },
    removeProject: (id: string) => {
      hoisted.projects = hoisted.projects.filter((p) => p.id !== id);
    },
    getPersistedBenches: () => [],
    removeBench: () => undefined,
  };
});
vi.mock("./plugin-manager.js", () => ({ getComponentManifests: () => [] }));
vi.mock("./cut-list-query-service.js", () => ({
  cutListQueryService: { evictProject: () => undefined, evictPlugin: () => undefined },
}));

import * as registry from "./project-registry.js";
import { atomicWrite } from "./state.js";
import { resetSelfWriteTokens } from "./self-write-tokens.js";
import { addClient, _resetClientsForTest } from "./sse.js";

let base: string;
let lanternDir: string;
let configFile: string;
let lines: string[];
let streamed: unknown[];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 4_000) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out; log so far:\n${lines.join("\n")}`);
    await sleep(20);
  }
}

function configLines(outcome: string): string[] {
  return lines.filter(
    (l) =>
      l.startsWith("[input-watcher] surface=project-config ") && l.includes(` outcome=${outcome} `),
  );
}

function inputEvents(): InputChangedEvent[] {
  return streamed.filter(
    (e): e is InputChangedEvent => (e as { type?: string }).type === "input-changed",
  );
}

function roubo(name: string, opts: { webBase?: number; worker?: boolean } = {}): string {
  const worker = opts.worker
    ? "  worker:\n    plugin:\n      id: process\n    config:\n      command: npm run worker\n"
    : "";
  const workerPort = opts.worker ? "  worker:\n    base: 4300\n" : "";
  return (
    `project:\n  name: ${name}\n  displayName: ${name}\nlayout:\n  type: single-repo\n` +
    `components:\n  web:\n    plugin:\n      id: process\n    config:\n      command: npm start\n` +
    worker +
    `ports:\n  web:\n    base: ${opts.webBase ?? 4100}\n` +
    workerPort +
    `benches:\n  max: 3\n`
  );
}

function makeProjectDir(name: string, yaml: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, ".roubo"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".roubo", "roubo.yaml"), yaml);
  return dir;
}

async function armed(projectId: string): Promise<void> {
  const watch = registry.__test.configWatch(projectId);
  if (!watch) throw new Error(`no roubo.yaml watch for ${projectId}`);
  await watch.ready;
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-config-watch-")));
  hoisted.rouboDir = path.join(base, "state");
  fs.mkdirSync(hoisted.rouboDir, { recursive: true });
  lanternDir = makeProjectDir("lantern", roubo("lantern"));
  configFile = path.join(lanternDir, ".roubo", "roubo.yaml");
  hoisted.projects = [{ id: "lantern", repoPath: lanternDir }];
  resetSelfWriteTokens();
  lines = [];
  streamed = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  _resetClientsForTest();
  addClient({
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    on: vi.fn(),
    write: vi.fn((chunk: string) => {
      const match = /^data: (.*)\n\n$/s.exec(chunk);
      if (match) streamed.push(JSON.parse(match[1]));
      return true;
    }),
  } as unknown as Response);

  registry.__test.reset();
  registry.registerLiveBenchSource(null);
  registry.initialize();
  registry.watchProjectConfigs();
  await armed("lantern");
});

afterEach(async () => {
  await registry.unwatchProjectConfigs();
  registry.__test.reset();
  _resetClientsForTest();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("roubo.yaml watch", () => {
  it("HR-TC-001: a saved roubo.yaml applies with no relaunch, with one applied log line and one notice", async () => {
    fs.writeFileSync(configFile, roubo("lantern", { worker: true }));
    await waitFor(() => configLines("applied").length === 1);
    await sleep(300);

    expect(configLines("applied")).toHaveLength(1);
    expect(Object.keys(registry.getProject("lantern")?.config?.components ?? {})).toEqual([
      "web",
      "worker",
    ]);
    expect(inputEvents()).toEqual([
      {
        type: "input-changed",
        surface: "project-config",
        outcome: "applied",
        projectId: "lantern",
        summary: "Project lantern: roubo.yaml applied.",
      },
    ]);
  });

  it("HR-TC-002: an apply under a running bench names the stale bench in the notice", async () => {
    registry.registerLiveBenchSource({
      listBenchIds: () => [2],
      dropBenches: () => 0,
      removeWorkspaces: async () => ({ leftovers: [] }),
      listStaleBenchIds: () => [2],
    });

    fs.writeFileSync(configFile, roubo("lantern", { webBase: 4200 }));
    await waitFor(() => inputEvents().length === 1);

    expect(inputEvents()[0]).toMatchObject({
      outcome: "applied",
      projectId: "lantern",
      benchIds: [2],
      summary: "Project lantern: roubo.yaml applied. 1 bench is stale.",
    });
  });

  it("HR-TC-004: a half-typed roubo.yaml keeps the last good config live and sends the path and first error", async () => {
    const lastGood = registry.getProject("lantern");
    fs.writeFileSync(
      configFile,
      roubo("lantern").replace(
        "      command: npm start\n",
        "      command: npm start\n    command: 42\n",
      ),
    );
    await waitFor(() => configLines("rejected").length === 1);
    await sleep(200);

    const events = inputEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.outcome).toBe("rejected");
    expect(event.error?.path).toBe(".roubo/roubo.yaml");
    expect(event.error?.first).toMatch(/^components\.web/);
    expect(event.summary).toBe(
      `Project lantern: roubo.yaml not applied. .roubo/roubo.yaml: ${event.error?.first}. Last good config is still live.`,
    );
    // GET /api/projects reads getProjects: the previous valid config.
    expect(registry.getProjects()).toEqual([lastGood]);
    expect(registry.getProject("lantern")?.configValid).toBe(true);
  });

  it("HR-TC-038: a notice with two errors carries the path and the first error only", async () => {
    fs.writeFileSync(configFile, roubo("lantern").replace("max: 3", "max: many\n  extra: 1"));
    await waitFor(() => inputEvents().length === 1);

    const [event] = inputEvents();
    expect(event.outcome).toBe("rejected");
    expect(event.error?.path).toBe(".roubo/roubo.yaml");
    expect(event.error?.first).not.toContain(";");
    expect(event.summary).toContain(".roubo/roubo.yaml");
    expect(event.summary.endsWith("Last good config is still live.")).toBe(true);
  });

  it("HR-TC-005: the next valid save sends an applied event with no error or path field, even when it restores the last good content", async () => {
    const good = fs.readFileSync(configFile, "utf-8");
    fs.writeFileSync(configFile, "project: [\n");
    await waitFor(() => inputEvents().length === 1);
    expect(inputEvents()[0].outcome).toBe("rejected");

    fs.writeFileSync(configFile, good);
    await waitFor(() => inputEvents().length === 2);

    const applied = inputEvents()[1];
    expect(applied).toEqual({
      type: "input-changed",
      surface: "project-config",
      outcome: "applied",
      projectId: "lantern",
      summary: "Project lantern: roubo.yaml applied.",
    });
    expect(applied).not.toHaveProperty("error");
    expect(applied).not.toHaveProperty("path");
  });

  it("HR-TC-010: an atomic-rename save (write to temp, rename) is detected", async () => {
    const tmp = path.join(lanternDir, ".roubo", ".roubo.yaml.swp");
    fs.writeFileSync(tmp, roubo("lantern", { webBase: 4400 }));
    fs.renameSync(tmp, configFile);
    await waitFor(() => configLines("applied").length === 1);

    expect(registry.getProject("lantern")?.config?.ports.web.base).toBe(4400);
    expect(inputEvents()).toHaveLength(1);
  });

  it("HR-TC-041: an unchanged save logs deduped and an app write logs self-write, and neither sends an event", async () => {
    fs.writeFileSync(configFile, fs.readFileSync(configFile, "utf-8"));
    await waitFor(() => configLines("deduped").length === 1);

    // The app writes roubo.yaml through atomicWrite, then reloads it itself.
    atomicWrite(configFile, roubo("lantern", { webBase: 4500 }));
    registry.reloadConfig("lantern");
    await waitFor(() => configLines("self-write").length === 1);
    await sleep(300);

    expect(registry.getProject("lantern")?.config?.ports.web.base).toBe(4500);
    expect(configLines("applied")).toHaveLength(0);
    expect(inputEvents()).toHaveLength(0);
  });

  it("HR-TC-009: the manual reload applies unchanged content with no dedupe and writes one applied line and one event", async () => {
    fs.writeFileSync(configFile, fs.readFileSync(configFile, "utf-8"));
    await waitFor(() => configLines("deduped").length === 1);
    expect(inputEvents()).toHaveLength(0);

    const project = registry.reloadConfigManually("lantern");

    expect(project.configValid).toBe(true);
    expect(configLines("applied")).toHaveLength(1);
    expect(configLines("applied")[0]).toContain(`path=${configFile} `);
    expect(inputEvents()).toEqual([
      {
        type: "input-changed",
        surface: "project-config",
        outcome: "applied",
        projectId: "lantern",
        summary: "Project lantern: roubo.yaml applied.",
      },
    ]);
  });

  it("HR-TC-045: a save reaches one log line and one event well within the 2 s budget", async () => {
    const start = Date.now();
    fs.writeFileSync(configFile, roubo("lantern", { webBase: 4600 }));
    await waitFor(() => inputEvents().length === 1, 2_000);

    expect(Date.now() - start).toBeLessThan(2_000);
    expect(configLines("applied")).toHaveLength(1);
  });

  it("arms a watch for a project registered after boot and disposes it at unregister", async () => {
    const harborDir = makeProjectDir("harbor", roubo("harbor", { webBase: 4800 }));
    registry.registerProject(harborDir);
    await armed("harbor");

    fs.writeFileSync(
      path.join(harborDir, ".roubo", "roubo.yaml"),
      roubo("harbor", { webBase: 4900 }),
    );
    await waitFor(() => inputEvents().some((e) => e.projectId === "harbor"));
    expect(registry.getProject("harbor")?.config?.ports.web.base).toBe(4900);

    await registry.unregisterProject("harbor");
    expect(registry.__test.configWatch("harbor")).toBeUndefined();
  });
});
