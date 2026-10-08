// A forced unregister against a real git repository (#1435). The registry and
// bench-manager are both real and wired through the live-bench seam the way
// server/index.ts wires them, so the test sees what actually stays on disk:
// the bench workspaces and git's admin dirs for them under .git/worktrees/.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistedBench } from "@roubo/shared";
import { makeConfig } from "../test/fixtures.js";

vi.mock("./state.js", () => ({
  loadState: vi.fn(() => ({ benches: [] })),
  loadProjects: vi.fn(() => ({ projects: [] })),
  addProject: vi.fn(),
  removeProject: vi.fn(),
  addBench: vi.fn(),
  removeBench: vi.fn(),
  updateBench: vi.fn(),
  getPersistedBenches: vi.fn(() => []),
  getProjectWorkspacesDir: vi.fn(),
  loadSettings: vi.fn(() => ({ benches: {} })),
}));
vi.mock("./config-parser.js", () => ({ parseConfig: vi.fn() }));
vi.mock("./port-allocator.js", () => ({
  checkPortConflicts: vi.fn(() => []),
  getPortConflicts: vi.fn(() => []),
  allocatePorts: vi.fn(),
}));
vi.mock("./plugin-manager.js", () => ({
  getComponentManifests: vi.fn(() => []),
  registerComponentPluginHooks: vi.fn(),
}));
vi.mock("./cut-list-query-service.js", () => ({
  cutListQueryService: { evictProject: vi.fn(), evictPlugin: vi.fn() },
}));
vi.mock("./terminal.js", () => ({ destroyBenchSessions: vi.fn() }));
vi.mock("./notification.js", () => ({ createNotification: vi.fn() }));
vi.mock("./sse.js", () => ({ broadcast: vi.fn(), broadcastBenchStatus: vi.fn() }));
vi.mock("./docker.js", () => ({}));
vi.mock("./process-manager.js", () => ({ stopProcess: vi.fn() }));

import { parseConfig } from "./config-parser.js";
import * as state from "./state.js";
import * as registry from "./project-registry.js";
import * as benchManager from "./bench-manager.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function persisted(id: number, workspacePath: string, branch: string): PersistedBench {
  return {
    id,
    projectId: "test-project",
    branch,
    workspacePath,
    ports: {},
    createdAt: "now",
  } as PersistedBench;
}

let tmp: string;
let repo: string;
let workspaces: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-1435-")));
  repo = path.join(tmp, "repo");
  workspaces = path.join(tmp, "workspaces");
  fs.mkdirSync(repo);
  fs.mkdirSync(workspaces);
  git(repo, "init", "-q", "-b", "main");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "c",
  );

  vi.mocked(parseConfig).mockReturnValue({ valid: true, config: makeConfig() });
  registry.__test.reset();
  registry.registerProject(repo);
  registry.registerLiveBenchSource({
    listBenchIds: benchManager.getLiveBenchIds,
    dropBenches: benchManager.dropProjectBenches,
    removeWorkspaces: benchManager.removeProjectBenchWorkspaces,
  });
});

afterEach(() => {
  registry.registerLiveBenchSource(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function addBench(id: number, opts: { dirty?: boolean } = {}): PersistedBench {
  const ws = path.join(workspaces, `bench-${id}`);
  const branch = `bench-${id}`;
  git(repo, "worktree", "add", "-q", "-b", branch, ws);
  if (opts.dirty) fs.writeFileSync(path.join(ws, "uncommitted.txt"), "work");
  return persisted(id, ws, branch);
}

function adminDirs(): string[] {
  const dir = path.join(repo, ".git", "worktrees");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe("forced unregister (#1435)", () => {
  it("removes every bench workspace and admin dir when the repo exists, and keeps the branches", async () => {
    const benches = [addBench(1), addBench(2, { dirty: true })];
    vi.mocked(state.getPersistedBenches).mockReturnValue(benches);
    expect(adminDirs()).toHaveLength(2);

    await registry.unregisterProject("test-project", { force: true });

    expect(adminDirs()).toEqual([]);
    for (const b of benches) expect(fs.existsSync(b.workspacePath)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(workspaces);
    // Branches are kept, so committed work on them survives the unregister.
    expect(git(repo, "branch", "--list", "bench-*").trim().split(/\s+/)).toEqual([
      "bench-1",
      "bench-2",
    ]);
    expect(registry.getProject("test-project")).toBeUndefined();
    expect(state.removeBench).toHaveBeenCalledWith("test-project", 1);
    expect(state.removeBench).toHaveBeenCalledWith("test-project", 2);
  });

  it("still succeeds when the repo is missing, and logs each workspace it leaves on disk", async () => {
    const benches = [addBench(1), addBench(2)];
    vi.mocked(state.getPersistedBenches).mockReturnValue(benches);
    const movedRepo = path.join(tmp, "moved");
    fs.renameSync(repo, movedRepo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let warnings: string[];
    try {
      await registry.unregisterProject("test-project", { force: true });
    } finally {
      warnings = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
    }

    expect(registry.getProject("test-project")).toBeUndefined();
    for (const b of benches) {
      expect(fs.existsSync(b.workspacePath)).toBe(true);
      expect(warnings.some((w) => w.includes(b.workspacePath))).toBe(true);
    }
    expect(state.removeBench).toHaveBeenCalledWith("test-project", 1);
    expect(state.removeBench).toHaveBeenCalledWith("test-project", 2);
  });
});
