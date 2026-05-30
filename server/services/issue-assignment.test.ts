import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";

vi.mock("./bench-manager.js", () => ({
  getBench: vi.fn(),
  createBench: vi.fn(),
  // Stubbed so tests can assert issue-assignment never invokes the auto-start
  // primitives directly — those live behind createBench's background path.
  startAllComponents: vi.fn(),
  runComponentsInOrder: vi.fn(),
}));

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
  resolveEnforceIssueDependencies: vi.fn().mockReturnValue(false),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn().mockReturnValue(false) },
  };
});

vi.mock("./state.js", () => ({
  updateBench: vi.fn(),
  getWorkspacePath: vi.fn().mockReturnValue("/workspaces/project/bench-0-issue-42-fix-login-bug"),
  getPersistedBenches: vi.fn().mockReturnValue([]),
  loadSettings: vi.fn().mockReturnValue({
    jigs: {
      autoExecute: true,
      autoInject: true,
      defaultJigId: "feature-dev",
    },
  }),
}));

vi.mock("./github.js", () => ({
  fetchIssueDetail: vi.fn(),
  fetchIssueComments: vi.fn(),
  fetchBlockingRelationships: vi.fn().mockResolvedValue({ blockedBy: {}, blockingCount: {} }),
  fetchLinkedPullRequests: vi.fn().mockResolvedValue([]),
  fetchIssueType: vi.fn().mockResolvedValue(null),
}));

vi.mock("./terminal.js", () => ({
  createSession: vi.fn(),
  writeToSession: vi.fn(),
}));

vi.mock("./exec.js", () => ({
  runCommand: vi.fn(),
}));

vi.mock("./config-parser.js", () => ({
  buildTemplateContext: vi.fn().mockReturnValue({
    ports: {},
    portHttps: {},
    workspace: "/workspace",
    components: {},
  }),
}));

vi.mock("./jig-manager.js", () => ({
  getDefaultJigId: vi.fn().mockReturnValue("feature-dev"),
  resolveJigForIssue: vi.fn().mockReturnValue({ jigId: "feature-dev", source: "app" }),
  getJig: vi.fn().mockReturnValue({
    id: "feature-dev",
    name: "Feature Development",
    description: "Action a GitHub issue",
    icon: "code",
    source: "app",
    content:
      "You are working on issue #{{issueNumber}}: {{issueTitle}}\n{{issueUrl}}\n{{issueBody}}\n{{comments}}",
    sizeBytes: 100,
  }),
  resolveJigContent: vi.fn(
    (_content: string, ctx: Record<string, unknown>) =>
      `Issue #${ctx.issueNumber}: ${ctx.issueTitle}\n${ctx.issueUrl}\n${ctx.issueBody}\n${ctx.comments}`,
  ),
}));

vi.mock("./issue-formatting.js", () => ({
  formatIssueBody: vi.fn((body: string | null) => body ?? ""),
  formatComments: vi.fn((comments: Array<{ user: string; body: string }>) =>
    comments.map((c) => `**${c.user}:**\n${c.body}`).join("\n"),
  ),
}));

import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as stateService from "./state.js";
import * as githubService from "./github.js";
import * as terminalService from "./terminal.js";
import * as jigManager from "./jig-manager.js";
import { runCommand } from "./exec.js";
import fs from "node:fs";
import type { NormalizedIssue } from "@roubo/shared";
import {
  assignIssue,
  unassignIssue,
  createBenchAndAssignIssue,
  createBenchAndAssignAlert,
} from "./issue-assignment.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("assignIssue", () => {
  const bench = {
    id: 1,
    projectId: "project1",
    branch: "bench-1",
    workspacePath: "/workspace",
    ports: { backend: 5000 },
    createdAt: "2026-01-01",
    components: {},
    status: "idle" as const,
    provisioningSteps: [],
  };

  const project = {
    repoPath: "/repos/project",
    config: {
      project: {
        name: "project",
        displayName: "My Project",
        type: "web" as const,
        repo: "org/repo",
      },
      layout: { type: "single-repo" as const },
      components: {},
      ports: {},
      benches: { max: 5 },
    },
  };

  it("creates branch, assigns issue, and launches Claude Code", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Users cannot log in",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "2026-01-01",
      command: "claude",
      status: "live",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [],
      issueType: null,
    });
    expect(result.bench.branch).toBe("issue-42-fix-login-bug");
    expect(result.terminalSessionId).toBe("term-1");
    expect(runCommand).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "issue-42-fix-login-bug"],
      "/workspace",
    );
    expect(stateService.updateBench).toHaveBeenCalled();
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      expect.stringContaining("https://github.com/org/repo/issues/42"),
      undefined,
    );
    // assignIssue must never trigger auto-start directly — that lives behind
    // bench-manager. (Plain assignIssue doesn't create a bench, so the
    // setting wouldn't apply anyway, but lock it in regardless.)
    expect(benchManager.startAllComponents).not.toHaveBeenCalled();
    expect(benchManager.runComponentsInOrder).not.toHaveBeenCalled();
  });

  it("falls back to checkout when branch already exists", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 10,
      title: "Test",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/10",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "already exists" }) // checkout -b fails
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // checkout succeeds
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-2",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    const result = await assignIssue("project1", 1, 10);
    expect(result.bench.branch).toBe("issue-10-test");
  });

  it("throws when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    await expect(assignIssue("project1", 1, 42)).rejects.toThrow("Bench not found");
  });

  it("refuses a blank-workspace-path bench (allowlist-rejected) before any git checkout", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench, workspacePath: "" });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);

    // Must reject before running `git checkout -b` with cwd="" (the server's own repo).
    await expect(assignIssue("project1", 1, 42)).rejects.toThrow(/no valid workspace path/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("throws when both checkout -b and checkout fail", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "already exists" })
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "pathspec did not match",
      });

    await expect(assignIssue("project1", 1, 42)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining("Failed to create/checkout branch"),
        statusCode: 422,
      }),
    );
  });

  it("throws when project config not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: undefined,
    } as any);

    await expect(assignIssue("project1", 1, 42)).rejects.toThrow("Project config not found");
  });

  it("overwrites existing issue assignment", async () => {
    const benchWithIssue = {
      ...bench,
      assignedIssue: {
        number: 10,
        integrationId: "github-com",
        externalId: "10",
        title: "Old issue",
      },
    };
    vi.mocked(benchManager.getBench).mockReturnValue({ ...benchWithIssue });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "New issue",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    const result = await assignIssue("project1", 1, 42);
    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "New issue",
      linkedPullRequests: [],
      issueType: null,
    });
  });

  it("throws when project has no repo", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        project: {
          name: "no-repo",
          displayName: "No Repo",
          type: "web",
          repo: "",
        },
        layout: { type: "single-repo" },
        components: {},
        ports: {},
        benches: { max: 5 },
      },
    } as any);

    await expect(assignIssue("project1", 1, 42)).rejects.toThrow("no repo");
  });

  it("uses jig manager to load and resolve the jig", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Body",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    await assignIssue("project1", 1, 42);

    expect(jigManager.resolveJigForIssue).toHaveBeenCalledWith(
      "project1",
      undefined,
      expect.anything(),
    );
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", "feature-dev");
    expect(jigManager.resolveJigContent).toHaveBeenCalled();
  });

  it("includes comments in Claude Code prompt", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 1,
      title: "Issue",
      body: "Body",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 1,
      htmlUrl: "https://github.com/org/repo/issues/1",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([
      { id: 1, body: "Please fix ASAP", user: "reviewer", createdAt: "" },
    ]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-3",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    await assignIssue("project1", 1, 1);

    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      expect.stringContaining("Please fix ASAP"),
      undefined,
    );
  });

  it("passes jig as CLI arg when autoExecute is true", async () => {
    vi.mocked(stateService.loadSettings).mockReturnValue({
      theme: "system",
      jigs: {
        autoExecute: true,
        autoInject: true,
        defaultJigId: "feature-dev",
      },
    });
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Body",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    await assignIssue("project1", 1, 42);

    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      expect.any(String),
      undefined,
    );
    expect(terminalService.writeToSession).not.toHaveBeenCalled();
  });

  it("forwards claudeCode settings to createSession", async () => {
    vi.mocked(stateService.loadSettings).mockReturnValue({
      theme: "system",
      jigs: {
        autoExecute: true,
        autoInject: true,
        defaultJigId: "feature-dev",
      },
      claudeCode: { enableAutoMode: true, startInPlanMode: false },
    });
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Body",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    await assignIssue("project1", 1, 42);

    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      expect.any(String),
      { enableAutoMode: true, startInPlanMode: false },
    );
  });

  it("writes jig without executing when autoExecute is false", async () => {
    vi.useFakeTimers();
    vi.mocked(stateService.loadSettings).mockReturnValue({
      theme: "system",
      jigs: {
        autoExecute: false,
        autoInject: true,
        defaultJigId: "feature-dev",
      },
    });
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Body",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    await assignIssue("project1", 1, 42);

    // Session created without initialInput (no CLI arg)
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      undefined,
    );
    // Jig not written yet (before timeout)
    expect(terminalService.writeToSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500);

    // Jig written without \r (no auto-execute)
    expect(terminalService.writeToSession).toHaveBeenCalledWith(
      "term-1",
      expect.stringContaining("https://github.com/org/repo/issues/42"),
    );
    const writtenText = vi.mocked(terminalService.writeToSession).mock.calls[0][1];
    expect(writtenText).not.toMatch(/\r$/);

    vi.useRealTimers();
  });

  it("creates the bench even when the issue has open blockers (soft-block)", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchBlockingRelationships).mockResolvedValue({
      blockedBy: { 42: [{ number: 10, title: "Add auth middleware" }] },
      blockingCount: { 42: 0 },
    });
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    const result = await assignIssue("project1", 1, 42);
    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [],
      issueType: null,
    });
    expect(githubService.fetchBlockingRelationships).not.toHaveBeenCalled();
  });

  it("forwards workUnits when persisting", async () => {
    const workUnits = [
      {
        submodule: "api",
        branch: "feat/my-feature",
        workspacePath: "/workspace/api",
      },
    ];
    vi.mocked(benchManager.getBench).mockReturnValue({
      ...bench,
      workUnits,
      notifications: [],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    await assignIssue("project1", 1, 42);

    expect(stateService.updateBench).toHaveBeenCalledWith(expect.objectContaining({ workUnits }));
  });

  it("populates linkedPullRequests when GitHub returns linked PRs", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(githubService.fetchLinkedPullRequests).mockResolvedValue([
      { repoFullName: "org/repo", number: 99 },
    ]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [{ repoFullName: "org/repo", number: 99 }],
      issueType: null,
    });
    expect(githubService.fetchLinkedPullRequests).toHaveBeenCalledWith("org/repo", 42);
  });

  it("succeeds with empty linkedPullRequests when no linked PRs exist", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(githubService.fetchLinkedPullRequests).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(result.bench.assignedIssue?.linkedPullRequests).toEqual([]);
  });
});

describe("createBenchAndAssignIssue", () => {
  const project = {
    repoPath: "/repos/project",
    config: {
      project: {
        name: "project",
        displayName: "My Project",
        type: "web" as const,
        repo: "org/repo",
      },
      layout: { type: "single-repo" as const },
      components: {},
      ports: {},
      benches: { max: 5 },
    },
  };

  const createdBench = {
    id: 1,
    projectId: "project1",
    branch: "issue-42-fix-login-bug",
    workspacePath: "/workspace",
    ports: { backend: 5000 },
    createdAt: "2026-01-01",
    components: {},
    status: "preparing" as const,
    provisioningSteps: [],
  };

  function setupHappyPath() {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Broken",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "",
    }); // branch does not exist
    vi.mocked(benchManager.createBench).mockReturnValue({ ...createdBench });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });
  }

  it("creates a bench and assigns issue in one operation", async () => {
    setupHappyPath();

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(githubService.fetchIssueDetail).toHaveBeenCalledWith("org/repo", 42);
    expect(benchManager.createBench).toHaveBeenCalledWith("project1", "issue-42-fix-login-bug");
    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [],
      issueType: null,
    });
    expect(result.terminalSessionId).toBe("term-1");
    expect(result.status).toBe("success");
    // createBenchAndAssignIssue must delegate auto-start orchestration to
    // benchManager.createBench — never invoke the start primitives itself.
    expect(benchManager.startAllComponents).not.toHaveBeenCalled();
    expect(benchManager.runComponentsInOrder).not.toHaveBeenCalled();
  });

  it("leaves bench idle (no component start) when autoStartComponents is off — default", async () => {
    vi.mocked(stateService.loadSettings).mockReturnValue({
      theme: "system",
      jigs: {
        autoExecute: true,
        autoInject: true,
        defaultJigId: "feature-dev",
      },
      benches: { autoStartComponents: false },
    });
    setupHappyPath();

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    expect(benchManager.createBench).toHaveBeenCalledTimes(1);
    expect(benchManager.createBench).toHaveBeenCalledWith("project1", "issue-42-fix-login-bug");
    expect(benchManager.startAllComponents).not.toHaveBeenCalled();
    expect(benchManager.runComponentsInOrder).not.toHaveBeenCalled();
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [],
      issueType: null,
    });
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedIssue: expect.objectContaining({ number: 42 }),
      }),
    );
  });

  it("delegates to createBench when autoStartComponents is on — assignment is unchanged", async () => {
    vi.mocked(stateService.loadSettings).mockReturnValue({
      theme: "system",
      jigs: {
        autoExecute: true,
        autoInject: true,
        defaultJigId: "feature-dev",
      },
      benches: { autoStartComponents: true },
    });
    setupHappyPath();

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    // The setting flips behaviour inside createBench's background path, not in
    // issue-assignment — so the calls observable from this layer are identical
    // to the off path. createBench is the single orchestration entry point.
    expect(benchManager.createBench).toHaveBeenCalledTimes(1);
    expect(benchManager.createBench).toHaveBeenCalledWith("project1", "issue-42-fix-login-bug");
    expect(benchManager.startAllComponents).not.toHaveBeenCalled();
    expect(benchManager.runComponentsInOrder).not.toHaveBeenCalled();
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [],
      issueType: null,
    });
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedIssue: expect.objectContaining({ number: 42 }),
      }),
    );
  });

  it("succeeds and returns undefined terminalSessionId when Claude terminal fails to spawn", async () => {
    setupHappyPath();
    vi.mocked(terminalService.createSession).mockImplementation(() => {
      throw new Error("Failed to spawn terminal (shell: /not/found/claude, cwd: /workspace): ...");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.terminalSessionId).toBeUndefined();
    expect(result.bench.assignedIssue).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to start Claude terminal"),
      expect.any(Error),
    );
  });

  it("returns branch conflict info when branch exists and no resolution provided", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "abc123",
      stderr: "",
    }); // branch exists
    vi.mocked(stateService.getPersistedBenches).mockReturnValue([]);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("conflict");
    expect(result.status === "conflict" && result.branchConflict).toEqual({
      branchExists: true,
      workspaceExists: false,
      branchName: "issue-42-fix-login-bug",
    });
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });

  it("detects workspace from persisted bench when branch conflicts", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "abc123",
      stderr: "",
    });
    vi.mocked(stateService.getPersistedBenches).mockReturnValue([
      {
        id: 3,
        projectId: "project1",
        branch: "issue-42-fix-login-bug",
        workspacePath: "/workspaces/project/bench-3",
        ports: {},
        createdAt: "",
      },
    ]);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status === "conflict" && result.branchConflict.workspaceExists).toBe(true);
    expect(fs.existsSync).toHaveBeenCalledWith("/workspaces/project/bench-3");
  });

  it("uses existing branch when resolution is resume", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "abc123",
      stderr: "",
    }); // branch exists
    vi.mocked(benchManager.createBench).mockReturnValue({ ...createdBench });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    const result = await createBenchAndAssignIssue("project1", 42, "resume");

    expect(benchManager.createBench).toHaveBeenCalledWith("project1", "issue-42-fix-login-bug");
    expect(result.status).toBe("success");
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "refs/heads/issue-42-fix-login-bug"],
      expect.any(String),
    );
    expect(runCommand).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["checkout", "-b"]),
      expect.any(String),
    );
  });

  it("appends suffix when resolution is new", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "abc", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
    vi.mocked(benchManager.createBench).mockReturnValue({
      ...createdBench,
      branch: "issue-42-fix-login-bug-2",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });

    const result = await createBenchAndAssignIssue("project1", 42, "new");

    expect(benchManager.createBench).toHaveBeenCalledWith("project1", "issue-42-fix-login-bug-2");
    expect(result.status).toBe("success");
  });

  it("throws when too many branch suffix conflicts", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "abc",
      stderr: "",
    });

    await expect(createBenchAndAssignIssue("project1", 42, "new")).rejects.toThrow(
      "Too many branch name conflicts",
    );
  });

  it("rejects closed issues", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: null,
      state: "closed",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });

    await expect(createBenchAndAssignIssue("project1", 42)).rejects.toThrow("not open");
  });

  it("throws when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as any);

    await expect(createBenchAndAssignIssue("project1", 42)).rejects.toThrow(
      "Project config not found",
    );
  });

  it("passes jig as CLI arg when autoExecute is true", async () => {
    vi.mocked(stateService.loadSettings).mockReturnValue({
      theme: "system",
      jigs: {
        autoExecute: true,
        autoInject: true,
        defaultJigId: "feature-dev",
      },
    });
    setupHappyPath();

    await createBenchAndAssignIssue("project1", 42);

    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      expect.any(String),
      undefined,
    );
    expect(terminalService.writeToSession).not.toHaveBeenCalled();
  });

  it("writes jig without executing when autoExecute is false", async () => {
    vi.useFakeTimers();
    vi.mocked(stateService.loadSettings).mockReturnValue({
      theme: "system",
      jigs: {
        autoExecute: false,
        autoInject: true,
        defaultJigId: "feature-dev",
      },
    });
    setupHappyPath();

    await createBenchAndAssignIssue("project1", 42);

    // Session created without initialInput (no CLI arg)
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      undefined,
    );
    // Jig not written yet (before timeout)
    expect(terminalService.writeToSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500);

    // Jig written without \r (no auto-execute)
    expect(terminalService.writeToSession).toHaveBeenCalledWith(
      "term-1",
      expect.stringContaining("https://github.com/org/repo/issues/42"),
    );
    const writtenText = vi.mocked(terminalService.writeToSession).mock.calls[0][1];
    expect(writtenText).not.toMatch(/\r$/);

    vi.useRealTimers();
  });

  it("creates the bench even when the issue has open blockers (soft-block)", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(githubService.fetchBlockingRelationships).mockResolvedValue({
      blockedBy: { 42: [{ number: 10, title: "Add auth middleware" }] },
      blockingCount: { 42: 0 },
    });
    setupHappyPath();

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [],
      issueType: null,
    });
    expect(githubService.fetchBlockingRelationships).not.toHaveBeenCalled();
  });

  it("forwards workUnits when persisting", async () => {
    const workUnits = [
      {
        submodule: "api",
        branch: "feat/my-feature",
        workspacePath: "/workspace/api",
      },
    ];
    setupHappyPath();
    vi.mocked(benchManager.createBench).mockReturnValue({
      ...createdBench,
      workUnits,
      notifications: [],
    });

    await createBenchAndAssignIssue("project1", 42);

    expect(stateService.updateBench).toHaveBeenCalledWith(expect.objectContaining({ workUnits }));
  });

  it("populates linkedPullRequests when GitHub returns linked PRs", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchLinkedPullRequests).mockResolvedValue([
      { repoFullName: "org/repo", number: 55 },
      { repoFullName: "org/other", number: 12 },
    ]);

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    expect(result.status === "success" && result.bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Fix login bug",
      linkedPullRequests: [
        { repoFullName: "org/repo", number: 55 },
        { repoFullName: "org/other", number: 12 },
      ],
      issueType: null,
    });
    expect(githubService.fetchLinkedPullRequests).toHaveBeenCalledWith("org/repo", 42);
  });

  it("succeeds with empty linkedPullRequests when no linked PRs exist", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchLinkedPullRequests).mockResolvedValue([]);

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    expect(result.status === "success" && result.bench.assignedIssue?.linkedPullRequests).toEqual(
      [],
    );
  });
});

describe("unassignIssue", () => {
  it("removes assigned issue from bench", async () => {
    const bench = {
      id: 1,
      projectId: "project1",
      branch: "issue-42-fix",
      workspacePath: "/workspace",
      ports: { backend: 5000 },
      createdAt: "2026-01-01",
      components: {},
      status: "idle" as const,
      provisioningSteps: [],
      assignedIssue: {
        number: 42,
        integrationId: "github-com",
        externalId: "42",
        title: "Fix it",
      },
    };
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });

    const result = await unassignIssue("project1", 1);
    expect(result.assignedIssue).toBeUndefined();
    expect(stateService.updateBench).toHaveBeenCalled();
  });

  it("throws when no issue assigned", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      id: 1,
      projectId: "project1",
      branch: "bench-1",
      workspacePath: "/workspace",
      ports: {},
      createdAt: "",
      components: {},
      status: "idle" as const,
      provisioningSteps: [],
    });

    await expect(unassignIssue("project1", 1)).rejects.toThrow("No issue assigned");
  });

  it("forwards workUnits when persisting", async () => {
    const workUnits = [
      {
        submodule: "api",
        branch: "feat/my-feature",
        workspacePath: "/workspace/api",
      },
    ];
    vi.mocked(benchManager.getBench).mockReturnValue({
      id: 1,
      projectId: "project1",
      branch: "issue-42-fix",
      workspacePath: "/workspace",
      ports: { backend: 5000 },
      createdAt: "2026-01-01",
      components: {},
      status: "idle" as const,
      provisioningSteps: [],
      teardownSteps: [],
      notifications: [],
      assignedIssue: {
        number: 42,
        integrationId: "github-com",
        externalId: "42",
        title: "Fix it",
      },
      workUnits,
    });

    await unassignIssue("project1", 1);

    expect(stateService.updateBench).toHaveBeenCalledWith(expect.objectContaining({ workUnits }));
  });

  it("preserves injectedJigId and injectedJigSource when unassigning an issue", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      id: 1,
      projectId: "project1",
      branch: "issue-42-fix",
      workspacePath: "/workspace",
      ports: { backend: 5000 },
      createdAt: "2026-01-01",
      components: {},
      status: "idle" as const,
      provisioningSteps: [],
      notifications: [],
      assignedIssue: {
        number: 42,
        integrationId: "github-com",
        externalId: "42",
        title: "Fix it",
      },
      injectedJigId: "my-jig",
      injectedJigSource: "issue-type-mapping" as const,
    });

    await unassignIssue("project1", 1);

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        injectedJigId: "my-jig",
        injectedJigSource: "issue-type-mapping",
      }),
    );
  });
});

describe("default jig hierarchy injection", () => {
  const project = {
    repoPath: "/repos/project",
    config: {
      project: {
        name: "project",
        displayName: "My Project",
        type: "web" as const,
        repo: "org/repo",
      },
      layout: { type: "single-repo" as const },
      components: {},
      ports: {},
      benches: { max: 5 },
    },
  };

  const createdBench = {
    id: 1,
    projectId: "project1",
    branch: "issue-42-fix-login-bug",
    workspacePath: "/workspace",
    ports: { backend: 5000 },
    createdAt: "2026-01-01",
    components: {},
    status: "preparing" as const,
    provisioningSteps: [],
    notifications: [],
  };

  function setupHappyPath() {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Broken",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "",
    });
    vi.mocked(benchManager.createBench).mockReturnValue({ ...createdBench });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });
  }

  it("records the project-level default jig ID on the bench", async () => {
    setupHappyPath();
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "proj-jig",
      source: "project",
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigId).toBe("proj-jig");
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", "proj-jig");
  });

  it("records the app-level default jig ID on the bench", async () => {
    setupHappyPath();
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "app-jig",
      source: "app",
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigId).toBe("app-jig");
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", "app-jig");
  });

  it("records the global default jig ID when no project or app default is set", async () => {
    setupHappyPath();
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: GLOBAL_DEFAULT_JIG_ID,
      source: "global",
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigId).toBe(GLOBAL_DEFAULT_JIG_ID);
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", GLOBAL_DEFAULT_JIG_ID);
  });

  it("persists the injected jig ID via updateBench", async () => {
    setupHappyPath();
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "proj-jig",
      source: "project",
    });

    await createBenchAndAssignIssue("project1", 42);

    const calls = vi.mocked(stateService.updateBench).mock.calls;
    const callWithJig = calls.find(([arg]) => arg.injectedJigId === "proj-jig");
    expect(callWithJig).toBeDefined();
  });

  it("skips jig resolution and injection when autoInject is false", async () => {
    setupHappyPath();
    vi.mocked(stateService.loadSettings).mockReturnValue({
      jigs: { autoInject: false, autoExecute: true },
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigId).toBeUndefined();
    expect(jigManager.resolveJigForIssue).not.toHaveBeenCalled();
    expect(jigManager.getJig).not.toHaveBeenCalled();
  });

  it("does not persist injectedJigId when terminal session fails to spawn", async () => {
    setupHappyPath();
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "proj-jig",
      source: "project",
    });
    vi.mocked(terminalService.createSession).mockImplementation(() => {
      throw new Error("terminal spawn failed");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigId).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to start Claude terminal"),
      expect.any(Error),
    );
  });

  it("records injected jig ID on bench when assignIssue resolves via hierarchy", async () => {
    vi.mocked(stateService.loadSettings).mockReturnValue({
      jigs: {
        autoInject: true,
        autoExecute: true,
        defaultJigId: "feature-dev",
      },
    });
    const bench = {
      id: 1,
      projectId: "project1",
      branch: "bench-1",
      workspacePath: "/workspace",
      ports: { backend: 5000 },
      createdAt: "2026-01-01",
      components: {},
      status: "idle" as const,
      provisioningSteps: [],
      notifications: [],
    };
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Fix login bug",
      body: "Broken",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(githubService.fetchLinkedPullRequests).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "proj-jig",
      source: "project",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(result.bench.injectedJigId).toBe("proj-jig");
    const calls = vi.mocked(stateService.updateBench).mock.calls;
    const callWithJig = calls.find(([arg]) => arg.injectedJigId === "proj-jig");
    expect(callWithJig).toBeDefined();
  });
});

describe("issue-type-to-jig mapping resolution", () => {
  const project = {
    repoPath: "/repos/project",
    config: {
      project: {
        name: "project",
        displayName: "My Project",
        type: "web" as const,
        repo: "org/repo",
      },
      layout: { type: "single-repo" as const },
      components: {},
      ports: {},
      benches: { max: 5 },
    },
  };

  const createdBench = {
    id: 1,
    projectId: "project1",
    branch: "issue-42-bug-report",
    workspacePath: "/workspace",
    ports: { backend: 5000 },
    createdAt: "2026-01-01",
    components: {},
    status: "preparing" as const,
    provisioningSteps: [],
    notifications: [],
  };

  function setupHappyPath() {
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Bug report",
      body: "Something broke",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "",
    });
    vi.mocked(benchManager.createBench).mockReturnValue({ ...createdBench });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });
  }

  it("passes the fetched issue type to resolveJigForIssue and records source when type has a mapping", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue("Bug");
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "bug-fix",
      source: "issue-type-mapping",
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    expect(jigManager.resolveJigForIssue).toHaveBeenCalledWith(
      "project1",
      "Bug",
      expect.anything(),
    );
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigId).toBe("bug-fix");
    expect(result.bench.injectedJigSource).toBe("issue-type-mapping");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        injectedJigId: "bug-fix",
        injectedJigSource: "issue-type-mapping",
      }),
    );
  });

  it("records source from default hierarchy when issue type has no mapping", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue("Enhancement");
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "feature-dev",
      source: "app",
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigSource).toBe("app");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigSource: "app" }),
    );
  });

  it("records source from default hierarchy when issue has no type", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue(null);
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "feature-dev",
      source: "app",
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    expect(jigManager.resolveJigForIssue).toHaveBeenCalledWith(
      "project1",
      undefined,
      expect.anything(),
    );
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigSource).toBe("app");
  });

  it("records source from default hierarchy when mapping points to a deleted jig (fallback)", async () => {
    // Simulates resolveJigForIssue logging a warning and falling through to the
    // project-level default because the mapped jig ID no longer exists.
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue("Bug");
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "proj-jig",
      source: "project",
    });

    const result = await createBenchAndAssignIssue("project1", 42);

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.bench.injectedJigSource).toBe("project");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigSource: "project" }),
    );
  });
});

describe("issue-type-to-jig mapping resolution (assignIssue)", () => {
  const bench = {
    id: 1,
    projectId: "project1",
    branch: "bench-1",
    workspacePath: "/workspace",
    ports: { backend: 5000 },
    createdAt: "2026-01-01",
    components: {},
    status: "idle" as const,
    provisioningSteps: [],
  };

  const project = {
    repoPath: "/repos/project",
    config: {
      project: {
        name: "project",
        displayName: "My Project",
        type: "web" as const,
        repo: "org/repo",
      },
      layout: { type: "single-repo" as const },
      components: {},
      ports: {},
      benches: { max: 5 },
    },
  };

  function setupHappyPath() {
    vi.mocked(benchManager.getBench).mockReturnValue({ ...bench });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      title: "Bug report",
      body: "Something broke",
      state: "open",
      labels: [],
      createdAt: "",
      updatedAt: "",
      commentsCount: 0,
      htmlUrl: "https://github.com/org/repo/issues/42",
    });
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue([]);
    vi.mocked(githubService.fetchLinkedPullRequests).mockResolvedValue([]);
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "",
      command: "claude",
      status: "live",
    });
  }

  it("passes the fetched issue type to resolveJigForIssue and records source when type has a mapping", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue("Bug");
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "bug-fix",
      source: "issue-type-mapping",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(jigManager.resolveJigForIssue).toHaveBeenCalledWith(
      "project1",
      "Bug",
      expect.anything(),
    );
    expect(result.bench.injectedJigId).toBe("bug-fix");
    expect(result.bench.injectedJigSource).toBe("issue-type-mapping");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        injectedJigId: "bug-fix",
        injectedJigSource: "issue-type-mapping",
      }),
    );
  });

  it("records source from default hierarchy when issue type has no mapping", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue("Enhancement");
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "feature-dev",
      source: "app",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(result.bench.injectedJigSource).toBe("app");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigSource: "app" }),
    );
  });

  it("records source from default hierarchy when issue has no type", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue(null);
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "feature-dev",
      source: "app",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(jigManager.resolveJigForIssue).toHaveBeenCalledWith(
      "project1",
      undefined,
      expect.anything(),
    );
    expect(result.bench.injectedJigSource).toBe("app");
  });

  it("records source from default hierarchy when mapping points to a deleted jig (fallback)", async () => {
    setupHappyPath();
    vi.mocked(githubService.fetchIssueType).mockResolvedValue("Bug");
    vi.mocked(jigManager.resolveJigForIssue).mockReturnValue({
      jigId: "proj-jig",
      source: "project",
    });

    const result = await assignIssue("project1", 1, 42);

    expect(result.bench.injectedJigSource).toBe("project");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigSource: "project" }),
    );
  });
});

describe("createBenchAndAssignAlert", () => {
  const project = {
    repoPath: "/repos/project",
    config: {
      project: {
        name: "project",
        displayName: "My Project",
        type: "web" as const,
        repo: "org/repo",
      },
      layout: { type: "single-repo" as const },
      components: {},
      ports: {},
      benches: { max: 5 },
    },
  };

  function makeBench() {
    return {
      id: 3,
      projectId: "project1",
      branch: "",
      workspacePath: "/workspace",
      ports: { backend: 5000 },
      createdAt: "2026-01-01",
      assignedContainers: {},
      notifications: [],
    } as any;
  }

  function codeScanningAlert(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
    return {
      integrationId: "github-com",
      externalId: "org/repo#code-scanning-117",
      externalUrl: "https://github.com/org/repo/security/code-scanning/117",
      title: "Bad thing",
      body: null,
      currentState: "open",
      allowedTransitions: [],
      assignees: [],
      labels: [],
      issueType: "security-code-scanning",
      blocks: [],
      blockedBy: [],
      updatedAt: "t",
      raw: {
        number: 117,
        rule: { id: "js/x", description: "Bad thing", security_severity_level: "high" },
        most_recent_instance: { location: { path: "src/a.ts", start_line: 5 } },
      },
      ...overrides,
    };
  }

  function setup() {
    const bench = makeBench();
    vi.mocked(projectRegistry.getProject).mockReturnValue(project as any);
    vi.mocked(benchManager.createBench).mockReturnValue(bench);
    // Branch does not yet exist -> rev-parse --verify fails (non-zero).
    vi.mocked(runCommand).mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-9",
      benchKey: "project1:3",
      label: "Claude 3",
      createdAt: "",
      command: "claude",
      status: "live",
    });
    return bench;
  }

  it("creates a bench on a category-prefixed branch and persists the full alert externalId + redacted raw", async () => {
    const bench = setup();

    const result = await createBenchAndAssignAlert("project1", codeScanningAlert());

    expect(result.status).toBe("success");
    expect(benchManager.createBench).toHaveBeenCalledWith(
      "project1",
      "code-scanning-117-bad-thing",
    );
    expect(bench.assignedIssue).toMatchObject({
      number: 117,
      integrationId: "github-com",
      externalId: "org/repo#code-scanning-117",
      issueType: "security-code-scanning",
    });
    // The persisted raw is the redacted clone passed in (never re-fetched).
    expect(bench.assignedIssue.raw).toEqual(codeScanningAlert().raw);
  });

  it("never fetches a GitHub issue by number for alerts (no open-check)", async () => {
    setup();
    await createBenchAndAssignAlert("project1", codeScanningAlert());
    expect(githubService.fetchIssueDetail).not.toHaveBeenCalled();
    expect(githubService.fetchIssueComments).not.toHaveBeenCalled();
  });

  it("resolves the jig from the alert issueType", async () => {
    setup();
    await createBenchAndAssignAlert("project1", codeScanningAlert());
    expect(jigManager.resolveJigForIssue).toHaveBeenCalledWith(
      "project1",
      "security-code-scanning",
      expect.anything(),
    );
  });

  it("falls back to a bare category-number branch when the title slugifies to empty", async () => {
    setup();
    await createBenchAndAssignAlert(
      "project1",
      codeScanningAlert({
        externalId: "org/repo#secret-scanning-42",
        title: "!!!",
        issueType: "security-secret-scanning",
        raw: { number: 42, secret_type_display_name: "GitHub PAT" },
      }),
    );
    expect(benchManager.createBench).toHaveBeenCalledWith("project1", "secret-scanning-42");
  });

  it("rejects a non-alert externalId", async () => {
    setup();
    await expect(
      createBenchAndAssignAlert("project1", codeScanningAlert({ externalId: "org/repo#42" })),
    ).rejects.toThrow(/Not a security alert/);
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });

  it("returns a conflict when the branch exists and no resolution is given", async () => {
    setup();
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const result = await createBenchAndAssignAlert("project1", codeScanningAlert());
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.branchConflict.branchName).toBe("code-scanning-117-bad-thing");
    }
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });
});
