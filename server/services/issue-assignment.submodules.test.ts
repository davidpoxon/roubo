import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedIssue } from "@roubo/shared";

// Real git end to end (#1437): only the bench lookup, the project registry and
// the agent launch are stubbed. The checkout and the submodule update run
// against a throwaway meta-repo.

vi.mock("./bench-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bench-manager.js")>()),
  getBench: vi.fn(),
  isBenchLive: vi.fn().mockReturnValue(true),
  whenWorkspaceProvisioned: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("./state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state.js")>()),
  updateBench: vi.fn(),
  getProjectPermissions: vi.fn().mockReturnValue({ allow: [], deny: [], ask: [] }),
  loadSettings: vi.fn().mockReturnValue({ jigs: { autoInject: false } }),
}));

vi.mock("./github.js", () => ({
  getGithubToken: vi.fn().mockReturnValue(null),
  fetchLinkedPullRequests: vi.fn(),
}));

vi.mock("./agent-launch-pipeline.js", () => ({
  resolveLaunchAgent: vi.fn().mockReturnValue({ agentPluginId: undefined }),
}));

vi.mock("./notification.js", () => ({
  createNotification: vi.fn(),
}));

import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import { assignIssue } from "./issue-assignment.js";

const BRANCH = "issue-7-pin-b";

let root: string;
let workspace: string;
let repoPath: string;
let pinA: string;
let pinB: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function issue(): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "org/meta#7",
    externalUrl: "https://github.com/org/meta/issues/7",
    title: "Pin B",
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "t",
    raw: { number: 7 },
  };
}

beforeAll(() => {
  // Isolate from the host's git config, and allow the file:// submodule clone.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", "3");
  vi.stubEnv("GIT_CONFIG_KEY_0", "protocol.file.allow");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "always");
  vi.stubEnv("GIT_CONFIG_KEY_1", "user.name");
  vi.stubEnv("GIT_CONFIG_VALUE_1", "Test");
  vi.stubEnv("GIT_CONFIG_KEY_2", "user.email");
  vi.stubEnv("GIT_CONFIG_VALUE_2", "test@example.com");

  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-1437-")));
  const sub = path.join(root, "sub");
  repoPath = path.join(root, "meta");
  workspace = path.join(root, "bench-1");

  // A submodule with two commits.
  git(root, "init", "-q", "-b", "main", sub);
  git(sub, "commit", "-q", "--allow-empty", "-m", "A");
  pinA = git(sub, "rev-parse", "HEAD");
  git(sub, "commit", "-q", "--allow-empty", "-m", "B");
  pinB = git(sub, "rev-parse", "HEAD");

  // A meta-repo whose main pins A and whose issue branch pins B.
  git(root, "init", "-q", "-b", "main", repoPath);
  git(repoPath, "submodule", "add", "-q", sub, "sub");
  git(path.join(repoPath, "sub"), "checkout", "-q", pinA);
  git(repoPath, "add", "sub");
  git(repoPath, "commit", "-q", "-m", "pin A");
  git(repoPath, "checkout", "-q", "-b", BRANCH);
  git(path.join(repoPath, "sub"), "checkout", "-q", pinB);
  git(repoPath, "add", "sub");
  git(repoPath, "commit", "-q", "-m", "pin B");
  git(repoPath, "checkout", "-q", "main");
  git(repoPath, "submodule", "update", "-q");

  // A bench: a linked worktree on its own branch from main, submodules at A.
  git(repoPath, "worktree", "add", "-q", "-b", "bench-1", workspace, "main");
  git(workspace, "submodule", "update", "-q", "--init");
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("assignIssue on a meta-repo bench (#1437)", () => {
  it("checks the submodules out at the existing branch's gitlinks", async () => {
    expect(git(path.join(workspace, "sub"), "rev-parse", "HEAD")).toBe(pinA);

    vi.mocked(benchManager.getBench).mockReturnValue({
      id: 1,
      projectId: "meta",
      branch: "bench-1",
      workspacePath: workspace,
      ports: {},
      createdAt: "2026-01-01",
      components: {},
      status: "idle",
      provisioningSteps: [],
      teardownSteps: [],
      notifications: [],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "meta",
      repoPath,
      config: {
        project: { name: "meta", displayName: "Meta", repo: "org/meta" },
        layout: { type: "meta-repo", submodules: { sub: "sub" } },
        components: {},
        ports: {},
        benches: { max: 5 },
      },
    } as never);

    const result = await assignIssue("meta", 1, issue(), []);

    expect(result.bench.branch).toBe(BRANCH);
    expect(git(workspace, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(git(workspace, "ls-tree", "HEAD", "sub").split(/\s+/)[2]).toBe(pinB);
    expect(git(path.join(workspace, "sub"), "rev-parse", "HEAD")).toBe(pinB);
    expect(git(workspace, "status", "--porcelain")).toBe("");
  });
});
