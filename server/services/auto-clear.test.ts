import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkAndClearDoneBenches, classifyWorkUnitBench } from "./auto-clear.js";

vi.mock("./bench-manager.js");
vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
  resolveAutoClear: vi.fn(),
  resolveWorkUnitAutoClear: vi.fn(),
}));
vi.mock("./github.js");
vi.mock("./plugin-manager.js", () => ({
  invoke: vi.fn(),
}));
vi.mock("./active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(),
}));
vi.mock("./git-state.js");
vi.mock("./notification.js");
vi.mock("./state.js", () => ({
  loadSettings: vi.fn(),
  getRouboDir: vi.fn().mockReturnValue("/tmp/roubo-test"),
  updateBench: vi.fn(),
  toPersistedBench: vi.fn((bench) => bench),
}));
vi.mock("./git-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-helpers.js")>()),
  resolveRepoFullName: vi.fn(),
  probeWorkUnitState: vi.fn(),
}));

import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as githubService from "./github.js";
import * as pluginManager from "./plugin-manager.js";
import { resolveActivePlugin } from "./active-plugin.js";
import * as gitState from "./git-state.js";
import * as notificationService from "./notification.js";
import * as state from "./state.js";
import * as gitHelpers from "./git-helpers.js";
import type {
  Bench,
  BenchWorkUnit,
  DirtyReason,
  GitHubIssue,
  NormalizedIssue,
  RegisteredProject,
  RouboConfig,
} from "@roubo/shared";

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "proj-1",
    branch: "issue-42-fix-bug",
    workspacePath: "/tmp/workspace",
    status: "active",
    ports: {},
    components: {},
    createdAt: new Date().toISOString(),
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
    assignedIssue: { number: 42, title: "Fix bug" },
    ...overrides,
  };
}

function makeProject(overrides: Partial<RouboConfig> = {}): RegisteredProject {
  const config: RouboConfig = {
    project: {
      name: "proj",
      displayName: "Proj",
      repo: "owner/repo",
      ...overrides.project,
    },
    layout: { type: "single-repo" },
    components: {},
    ports: {},
    benches: { max: 3 },
    ...overrides,
  } as RouboConfig;
  return {
    id: "proj-1",
    repoPath: "/tmp/repo",
    config,
    configValid: true,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  };
}

function makeWorkUnit(overrides: Partial<BenchWorkUnit> = {}): BenchWorkUnit {
  return {
    submodule: "api",
    branch: "feat/checkout-v2",
    workspacePath: "/tmp/workspace/services/api",
    ...overrides,
  };
}

function makeMetaBench(workUnits: BenchWorkUnit[], idOverride = 10): Bench {
  return makeBench({ id: idOverride, workUnits });
}

function makeMetaProject(): RegisteredProject {
  return makeProject({ layout: { type: "meta-repo" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  // auto-clear's classification and clearing paths emit informational
  // console.log/debug lines (e.g. "Clearing bench N: reason=…"). The
  // behavior we verify is the side effects (clearBench/teardown), not the
  // log text. Suppress to keep test output clean.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.mocked(state.loadSettings).mockReturnValue({
    theme: "dark",
    benches: { autoClear: true, enforceIssueDependencies: false },
  });
  vi.mocked(projectRegistry.resolveAutoClear).mockReturnValue(true);
  vi.mocked(projectRegistry.resolveWorkUnitAutoClear).mockReturnValue(true);
  // pr-sync (driven through this tick) only persists a bench that is still
  // tracked; default it live so PR-sync write assertions hold.
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(gitState.getDirtyState).mockResolvedValue({
    clean: true,
    reasons: [],
  });
});

describe("checkAndClearDoneBenches", () => {
  it("does nothing when no benches have assigned issues", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench({ assignedIssue: undefined })]);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("does nothing when eligible benches are in preparing state", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench({ status: "preparing" })]);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("does nothing when eligible benches are in clearing state", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench({ status: "clearing" })]);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("does nothing when eligible benches are in error state", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench({ status: "error" })]);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("does nothing when autoClear is false", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench()]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(projectRegistry.resolveAutoClear).mockReturnValue(false);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it('clears bench when project board status is "Done"', async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        project: {
          name: "proj",
          displayName: "Proj",
          repo: "owner/repo",
          github: { project: 1 },
        },
      }),
    );
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [{ issue: { number: 42 } as unknown as GitHubIssue, status: "Done" }],
      projectTitle: "My Project",
    });
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("is case-insensitive for status matching", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        project: {
          name: "proj",
          displayName: "Proj",
          repo: "owner/repo",
          github: { project: 1 },
        },
      }),
    );
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [{ issue: { number: 42 } as unknown as GitHubIssue, status: "DONE" }],
      projectTitle: "My Project",
    });
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it('does not clear bench when status is "In Progress"', async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        project: {
          name: "proj",
          displayName: "Proj",
          repo: "owner/repo",
          github: { project: 1 },
        },
      }),
    );
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [
        {
          issue: { number: 42 } as unknown as GitHubIssue,
          status: "In Progress",
        },
      ],
      projectTitle: "My Project",
    });
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("falls back to fetchIssueDetail when project board item has null status", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        project: {
          name: "proj",
          displayName: "Proj",
          repo: "owner/repo",
          github: { project: 1 },
        },
      }),
    );
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [{ issue: { number: 42 } as unknown as GitHubIssue, status: null }],
      projectTitle: "My Project",
    });
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(githubService.fetchIssueDetail).toHaveBeenCalledWith("owner/repo", 42);
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("never tears down an alert-backed bench via the issue-state fallback (#291 collision guard)", async () => {
    const alertBench = makeBench({
      assignedIssue: {
        number: 117,
        title: "Bad thing",
        externalId: "owner/repo#code-scanning-117",
        issueType: "security-code-scanning",
      } as never,
    });
    vi.mocked(benchManager.getBenches).mockReturnValue([alertBench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    // Even if an unrelated issue #117 were closed, the alert bench must never be
    // classified by issue number.
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 117,
      state: "closed",
    } as unknown as GitHubIssue);

    await checkAndClearDoneBenches();

    expect(githubService.fetchIssueDetail).not.toHaveBeenCalled();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  describe("alert-backed bench auto-clear (#289)", () => {
    function makeAlertBench(): Bench {
      return makeBench({
        id: 7,
        assignedIssue: {
          number: 117,
          title: "SQL injection",
          externalId: "owner/repo#code-scanning-117",
          issueType: "security-code-scanning",
        } as never,
      });
    }

    const ACTIVE = { pluginId: "github-com", integrationId: "github-com", pageSize: 50 };

    function mockAlertState(currentState: string): void {
      vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
      vi.mocked(pluginManager.invoke).mockResolvedValue({
        currentState,
      } as unknown as NormalizedIssue);
    }

    it("fetches the alert via getIssue by externalId, never by issue number", async () => {
      vi.mocked(benchManager.getBenches).mockReturnValue([makeAlertBench()]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      mockAlertState("open");

      await checkAndClearDoneBenches();

      expect(pluginManager.invoke).toHaveBeenCalledWith(
        "github-com",
        "getIssue",
        { externalId: "owner/repo#code-scanning-117" },
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      expect(githubService.fetchIssueDetail).not.toHaveBeenCalled();
    });

    it("leaves the bench when the alert is still open", async () => {
      vi.mocked(benchManager.getBenches).mockReturnValue([makeAlertBench()]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      mockAlertState("open");

      await checkAndClearDoneBenches();

      expect(benchManager.teardownBench).not.toHaveBeenCalled();
    });

    it("tears down a clean bench when the alert is fixed", async () => {
      vi.mocked(benchManager.getBenches).mockReturnValue([makeAlertBench()]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      mockAlertState("fixed");

      await checkAndClearDoneBenches();

      expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 7, true);
    });

    it("tears down a clean bench when the alert is dismissed", async () => {
      vi.mocked(benchManager.getBenches).mockReturnValue([makeAlertBench()]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      mockAlertState("dismissed");

      await checkAndClearDoneBenches();

      expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 7, true);
    });

    it("blocks teardown and raises teardown-blocked notification for a dirty alert bench", async () => {
      const bench = makeAlertBench();
      const dirtyReasons: DirtyReason[] = [
        { kind: "dirty-worktree", location: "workspace", detail: "1 modified" },
      ];
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      mockAlertState("fixed");
      vi.mocked(gitState.getDirtyState).mockResolvedValue({ clean: false, reasons: dirtyReasons });

      await checkAndClearDoneBenches();

      expect(benchManager.teardownBench).not.toHaveBeenCalled();
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        bench,
        "teardown-blocked",
        undefined,
        { dirtyReasons },
      );
    });

    it("leaves the bench intact when the alert fetch fails", async () => {
      vi.mocked(benchManager.getBenches).mockReturnValue([makeAlertBench()]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
      vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("plugin offline"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await checkAndClearDoneBenches();

      expect(benchManager.teardownBench).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("does not fetch the alert when there is no active integration plugin", async () => {
      vi.mocked(benchManager.getBenches).mockReturnValue([makeAlertBench()]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(resolveActivePlugin).mockReturnValue(null);

      await checkAndClearDoneBenches();

      expect(pluginManager.invoke).not.toHaveBeenCalled();
      expect(benchManager.teardownBench).not.toHaveBeenCalled();
    });

    it("does not fetch the alert when autoClear is disabled", async () => {
      vi.mocked(benchManager.getBenches).mockReturnValue([makeAlertBench()]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(projectRegistry.resolveAutoClear).mockReturnValue(false);
      mockAlertState("fixed");

      await checkAndClearDoneBenches();

      expect(pluginManager.invoke).not.toHaveBeenCalled();
      expect(benchManager.teardownBench).not.toHaveBeenCalled();
    });
  });

  it("does not clear bench when project board item has null status and issue is open", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        project: {
          name: "proj",
          displayName: "Proj",
          repo: "owner/repo",
          github: { project: 1 },
        },
      }),
    );
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [{ issue: { number: 42 } as unknown as GitHubIssue, status: null }],
      projectTitle: "My Project",
    });
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "open",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(githubService.fetchIssueDetail).toHaveBeenCalledWith("owner/repo", 42);
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("falls back to fetchIssueDetail when issue not in project board items", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        project: {
          name: "proj",
          displayName: "Proj",
          repo: "owner/repo",
          github: { project: 1 },
        },
      }),
    );
    // Issue not present in project items (e.g. was closed and filtered out)
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [],
      projectTitle: "My Project",
    });
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("clears bench when issue is closed (no project board configured)", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("does not clear bench when issue is open and not in done column", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "open",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("defaults autoClear to enabled when property is undefined", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ benches: { max: 3 } }));
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("handles GitHub errors gracefully without crashing", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(githubService.fetchIssueDetail).mockRejectedValue(new Error("Unauthorized"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(checkAndClearDoneBenches()).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch issue #42"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("continues checking other projects when one fails", async () => {
    const bench1 = makeBench({ id: 1, projectId: "proj-1" });
    const bench2 = makeBench({ id: 2, projectId: "proj-2" });
    vi.mocked(benchManager.getBenches).mockReturnValue([bench1, bench2]);
    vi.mocked(projectRegistry.getProject).mockImplementation((projectId) => {
      if (projectId === "proj-1") throw new Error("Config missing");
      return makeProject();
    });
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await checkAndClearDoneBenches();
    // proj-2 should still be checked and cleared
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-2", 2, true);
    consoleSpy.mockRestore();
  });

  it("handles fetchProjectItems failure gracefully and falls back to issue state", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        project: {
          name: "proj",
          displayName: "Proj",
          repo: "owner/repo",
          github: { project: 1 },
        },
      }),
    );
    vi.mocked(githubService.fetchProjectItems).mockRejectedValue(new Error("Rate limited"));
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
    consoleSpy.mockRestore();
  });

  it("does nothing when global autoClear setting is false", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench()]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(projectRegistry.resolveAutoClear).mockReturnValue(false);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("checks benches when global autoClear setting is true", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      benches: { autoClear: true, enforceIssueDependencies: false },
    });
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench()]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("checks benches when benches setting is undefined (defaults to enabled)", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(benchManager.getBenches).mockReturnValue([makeBench()]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("does not tear down work-unit bench when a PR is still open", async () => {
    const workUnit = makeWorkUnit({
      pullRequest: {
        repoFullName: "acme/api",
        number: 7,
        title: "wip",
        state: "open",
        merged: false,
        url: "https://github.com/acme/api/pull/7",
        updatedAt: new Date().toISOString(),
      },
      lastSyncedAt: new Date().toISOString(),
    });
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("reason=blocked:open-pr"));
    debugSpy.mockRestore();
  });

  it("tears down legacy bench (no workUnits) when issue is closed", async () => {
    const bench = makeBench();
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  it("only clears benches in done state when multiple benches exist in the same project", async () => {
    const benchDone = makeBench({
      id: 1,
      assignedIssue: { number: 42, title: "Done issue" },
    });
    const benchActive = makeBench({
      id: 2,
      assignedIssue: { number: 43, title: "Active issue" },
    });
    vi.mocked(benchManager.getBenches).mockReturnValue([benchDone, benchActive]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(githubService.fetchIssueDetail).mockImplementation(async (_repo, issueNumber) => {
      return {
        number: issueNumber,
        state: issueNumber === 42 ? "closed" : "open",
      } as unknown as GitHubIssue;
    });
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledTimes(1);
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
  });

  describe("dirty-state safety checks", () => {
    const dirtyReasons: DirtyReason[] = [
      {
        kind: "dirty-worktree",
        location: "workspace",
        detail: "2 modified, 1 untracked",
      },
    ];

    it("tears down a clean bench via project board (Path 1)", async () => {
      const bench = makeBench();
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(
        makeProject({
          project: {
            name: "proj",
            displayName: "Proj",
            repo: "owner/repo",
            github: { project: 1 },
          },
        }),
      );
      vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
        items: [{ issue: { number: 42 } as unknown as GitHubIssue, status: "Done" }],
        projectTitle: "My Project",
      });
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: true,
        reasons: [],
      });
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
      expect(notificationService.createNotification).not.toHaveBeenCalled();
    });

    it("blocks teardown and raises teardown-blocked notification for a dirty bench via project board (Path 1)", async () => {
      const bench = makeBench();
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(
        makeProject({
          project: {
            name: "proj",
            displayName: "Proj",
            repo: "owner/repo",
            github: { project: 1 },
          },
        }),
      );
      vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
        items: [{ issue: { number: 42 } as unknown as GitHubIssue, status: "Done" }],
        projectTitle: "My Project",
      });
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: false,
        reasons: dirtyReasons,
      });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).not.toHaveBeenCalled();
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        bench,
        "teardown-blocked",
        undefined,
        { dirtyReasons },
      );
      consoleSpy.mockRestore();
    });

    it("tears down a clean bench via closed issue fallback (Path 2)", async () => {
      const bench = makeBench();
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
        number: 42,
        state: "closed",
      } as unknown as GitHubIssue);
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: true,
        reasons: [],
      });
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
      expect(notificationService.createNotification).not.toHaveBeenCalled();
    });

    it("blocks teardown and raises teardown-blocked notification for a dirty bench via closed issue fallback (Path 2)", async () => {
      const bench = makeBench();
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
        number: 42,
        state: "closed",
      } as unknown as GitHubIssue);
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: false,
        reasons: dirtyReasons,
      });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).not.toHaveBeenCalled();
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        bench,
        "teardown-blocked",
        undefined,
        { dirtyReasons },
      );
      consoleSpy.mockRestore();
    });

    it("stays sticky when a teardown-blocked notification already exists and the bench is still dirty", async () => {
      // Re-evaluating dirty state on each poll lets us self-heal when state
      // clears, but as long as the bench is still dirty we must not pile up
      // duplicate notifications or attempt teardown.
      const bench = makeBench({
        notifications: [
          {
            id: "n1",
            type: "teardown-blocked",
            priority: "action-needed",
            createdAt: new Date().toISOString(),
          },
        ],
      });
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
        number: 42,
        state: "closed",
      } as unknown as GitHubIssue);
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: false,
        reasons: dirtyReasons,
      });
      await checkAndClearDoneBenches();
      expect(gitState.getDirtyState).toHaveBeenCalled();
      expect(benchManager.teardownBench).not.toHaveBeenCalled();
      expect(notificationService.createNotification).not.toHaveBeenCalled();
      expect(notificationService.dismissOne).not.toHaveBeenCalled();
    });

    it("self-heals a stale teardown-blocked notification when state is now clean (e.g. PR merged + remote branch deleted)", async () => {
      const bench = makeBench({
        notifications: [
          {
            id: "n1",
            type: "teardown-blocked",
            priority: "action-needed",
            createdAt: new Date().toISOString(),
          },
        ],
      });
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
        number: 42,
        state: "closed",
      } as unknown as GitHubIssue);
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: true,
        reasons: [],
      });
      await checkAndClearDoneBenches();
      expect(notificationService.dismissOne).toHaveBeenCalledWith(bench, "n1");
      expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
    });

    it("passes knownMergedLocations built from merged work-unit PRs into getDirtyState", async () => {
      const mergedUnit = makeWorkUnit({
        submodule: "api",
        pullRequest: {
          repoFullName: "acme/api",
          number: 7,
          title: "t",
          state: "closed",
          merged: true,
          url: "u",
          updatedAt: new Date().toISOString(),
        },
        lastSyncedAt: new Date().toISOString(),
      });
      const openUnit = makeWorkUnit({
        submodule: "web",
        pullRequest: {
          repoFullName: "acme/web",
          number: 8,
          title: "t",
          state: "closed",
          merged: true,
          url: "u",
          updatedAt: new Date().toISOString(),
        },
        lastSyncedAt: new Date().toISOString(),
      });
      const bench = makeMetaBench([mergedUnit, openUnit]);
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
      vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue("acme/api");
      vi.mocked(githubService.getGithubToken).mockReturnValue("test-token");
      vi.mocked(
        githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
      ).mockResolvedValue({ notModified: true });
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: "feat/checkout-v2",
        dirty: { modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 },
      });
      vi.mocked(gitState.buildKnownMergedLocations).mockReturnValue(new Set(["api", "web"]));
      vi.mocked(gitState.getDirtyState).mockResolvedValue({ clean: true, reasons: [] });

      await checkAndClearDoneBenches();

      expect(gitState.buildKnownMergedLocations).toHaveBeenCalledWith(
        expect.objectContaining({ id: bench.id }),
      );
      const call = vi.mocked(gitState.getDirtyState).mock.calls.at(-1);
      expect(call).toBeDefined();
      expect(call?.[0].id).toBe(bench.id);
      const passed = call?.[1]?.knownMergedLocations;
      expect(passed).toBeInstanceOf(Set);
      expect([...(passed ?? new Set())].sort()).toEqual(["api", "web"]);
    });

    it("re-blocks when notification is dismissed but bench is still dirty", async () => {
      // Simulates: notification was dismissed (not present on bench), but worktree is still dirty
      const bench = makeBench({ notifications: [] });
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
        number: 42,
        state: "closed",
      } as unknown as GitHubIssue);
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: false,
        reasons: dirtyReasons,
      });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).not.toHaveBeenCalled();
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        bench,
        "teardown-blocked",
        undefined,
        { dirtyReasons },
      );
      consoleSpy.mockRestore();
    });

    it("proceeds with teardown when notification is dismissed and bench is now clean", async () => {
      // Simulates: notification was dismissed, user cleaned the worktree
      const bench = makeBench({ notifications: [] });
      vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
      vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
        number: 42,
        state: "closed",
      } as unknown as GitHubIssue);
      vi.mocked(gitState.getDirtyState).mockResolvedValue({
        clean: true,
        reasons: [],
      });
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
      expect(notificationService.createNotification).not.toHaveBeenCalled();
    });

    it("getDirtyState error in Path 1 does not abort remaining benches in the project", async () => {
      // bench1: getDirtyState throws; bench2: clean — bench2 must still be torn down
      const bench1 = makeBench({ id: 1, notifications: [] });
      const bench2 = makeBench({
        id: 2,
        notifications: [],
        assignedIssue: { number: 43, title: "Other" },
      });
      vi.mocked(benchManager.getBenches).mockReturnValue([bench1, bench2]);
      vi.mocked(projectRegistry.getProject).mockReturnValue(
        makeProject({
          project: {
            name: "proj",
            displayName: "Proj",
            repo: "owner/repo",
            github: { project: 1 },
          },
        }),
      );
      vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
        items: [
          { issue: { number: 42 } as unknown as GitHubIssue, status: "Done" },
          { issue: { number: 43 } as unknown as GitHubIssue, status: "Done" },
        ],
        projectTitle: "My Project",
      });
      vi.mocked(gitState.getDirtyState)
        .mockRejectedValueOnce(new Error("git binary not found"))
        .mockResolvedValueOnce({ clean: true, reasons: [] });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).toHaveBeenCalledTimes(1);
      expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 2, true);
      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});

// ── PR sync for meta-repo work units ──

describe("PR sync for meta-repo work units", () => {
  beforeEach(() => {
    // Default: submodule remote resolves to acme/api
    vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue("acme/api");
    // GitHub is connected
    vi.mocked(githubService.getGithubToken).mockReturnValue("test-token");
    // Default probe: branch matches default makeWorkUnit branch, clean working tree
    vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
      branch: "feat/checkout-v2",
      dirty: { modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 },
    });
  });

  it("ETag 304 — does not update PR fields but still persists dirty probe results", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: true,
      pr: null,
    });

    await checkAndClearDoneBenches();

    // pullRequest and lastSyncedAt are not written on 304, but dirty probe updates dirtyState
    expect(workUnit.pullRequest).toBeUndefined();
    expect(workUnit.lastSyncedAt).toBeUndefined();
    expect(state.updateBench).toHaveBeenCalled();
  });

  it("PR found — updates pullRequest and lastSyncedAt, clears syncError", async () => {
    const workUnit = makeWorkUnit({ syncError: "previous error" });
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: {
        number: 42,
        title: "feat: checkout v2",
        state: "open",
        merged: false,
        url: "https://github.com/acme/api/pull/42",
        updatedAt: "2026-04-10T12:00:00Z",
      },
    });

    await checkAndClearDoneBenches();

    expect(workUnit.pullRequest).toMatchObject({
      repoFullName: "acme/api",
      number: 42,
      state: "open",
      merged: false,
    });
    expect(workUnit.lastSyncedAt).toBeDefined();
    expect(workUnit.syncError).toBeUndefined();
    expect(state.updateBench).toHaveBeenCalledTimes(1);
    expect(state.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, workUnits: [workUnit] }),
    );
  });

  it("PR not found with no previous — clears pullRequest and sets lastSyncedAt", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: null,
    });

    await checkAndClearDoneBenches();

    expect(workUnit.pullRequest).toBeUndefined();
    expect(workUnit.lastSyncedAt).toBeDefined();
    expect(state.updateBench).toHaveBeenCalledTimes(1);
  });

  it("PR merged transition — detects closed/merged via fetchPullRequestDetail when previous PR is recent", async () => {
    const recentUpdatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const workUnit = makeWorkUnit({
      pullRequest: {
        repoFullName: "acme/api",
        number: 42,
        title: "feat: checkout v2",
        state: "open",
        merged: false,
        url: "https://github.com/acme/api/pull/42",
        updatedAt: recentUpdatedAt,
      },
    });
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: null,
    });
    vi.mocked(githubService.fetchPullRequestDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 42,
      title: "feat: checkout v2",
      state: "closed",
      merged: true,
      url: "https://github.com/acme/api/pull/42",
      updatedAt: new Date().toISOString(),
    });

    await checkAndClearDoneBenches();

    expect(workUnit.pullRequest?.state).toBe("closed");
    expect(workUnit.pullRequest?.merged).toBe(true);
    expect(githubService.fetchPullRequestDetail).toHaveBeenCalledWith("acme/api", 42);
    expect(state.updateBench).toHaveBeenCalledTimes(1);
  });

  it("stale previous PR (>24h) — clears pullRequest without fetching detail", async () => {
    const staleUpdatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const workUnit = makeWorkUnit({
      pullRequest: {
        repoFullName: "acme/api",
        number: 42,
        title: "old PR",
        state: "open",
        merged: false,
        url: "https://github.com/acme/api/pull/42",
        updatedAt: staleUpdatedAt,
      },
    });
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: null,
    });

    await checkAndClearDoneBenches();

    expect(workUnit.pullRequest).toBeUndefined();
    expect(githubService.fetchPullRequestDetail).not.toHaveBeenCalled();
    expect(state.updateBench).toHaveBeenCalledTimes(1);
  });

  it("sync error — sets syncError on work unit and does not trigger teardown", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockRejectedValue(new Error("rate limited"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkAndClearDoneBenches();

    expect(workUnit.syncError).toBe("rate limited");
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
    expect(state.updateBench).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("dedup — two benches sharing same {repoFullName, branch} produce a single request", async () => {
    const wu1 = makeWorkUnit({ workspacePath: "/tmp/bench-1/api" });
    const wu2 = makeWorkUnit({ workspacePath: "/tmp/bench-2/api" });
    const bench1 = makeMetaBench([wu1], 11);
    const bench2 = makeMetaBench([wu2], 12);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench1, bench2]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue("acme/api");
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: null,
    });

    await checkAndClearDoneBenches();

    expect(githubService.fetchOpenPullRequestByBranch).toHaveBeenCalledTimes(1);
  });

  it("meta-repo bench gets PR sync but not auto-clear teardown", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: {
        number: 7,
        title: "wip",
        state: "open",
        merged: false,
        url: "https://github.com/acme/api/pull/7",
        updatedAt: new Date().toISOString(),
      },
    });

    await checkAndClearDoneBenches();

    // PR state was synced
    expect(workUnit.pullRequest?.number).toBe(7);
    expect(state.updateBench).toHaveBeenCalledTimes(1);
    // Auto-clear teardown did NOT run — PR is open (blocked:open-pr)
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it('root work unit (submodule ".") uses config.project.repo and skips resolveRepoFullName', async () => {
    const workUnit = makeWorkUnit({
      submodule: ".",
      workspacePath: "/tmp/meta-root",
    });
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject()); // repo: 'owner/repo'
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: null,
    });

    await checkAndClearDoneBenches();

    expect(gitHelpers.resolveRepoFullName).not.toHaveBeenCalled();
    expect(githubService.fetchOpenPullRequestByBranch).toHaveBeenCalledWith(
      "owner/repo",
      expect.any(String),
    );
  });

  it("no GitHub token — skips PR sync entirely without writing syncError", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(githubService.getGithubToken).mockReturnValue(undefined);

    await checkAndClearDoneBenches();

    expect(githubService.fetchOpenPullRequestByBranch).not.toHaveBeenCalled();
    expect(state.updateBench).not.toHaveBeenCalled();
    expect(workUnit.syncError).toBeUndefined();
  });

  it("sync error — creates a sync-error notification with submodule name and error message", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockRejectedValue(new Error("rate limited"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkAndClearDoneBenches();

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      bench,
      "sync-error",
      "sync-error::api",
      { submodule: "api", error: "rate limited" },
    );
    errorSpy.mockRestore();
  });

  it("sync error dedup — second failure on same work unit calls createNotification both times (dedup is in notification service)", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockRejectedValue(new Error("rate limited"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkAndClearDoneBenches();
    await checkAndClearDoneBenches();

    expect(notificationService.createNotification).toHaveBeenCalledTimes(2);
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      bench,
      "sync-error",
      "sync-error::api",
      expect.objectContaining({ submodule: "api" }),
    );
    errorSpy.mockRestore();
  });

  it("sync error resolution — dismisses the sync-error notification when error clears", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: false,
      pr: {
        number: 42,
        title: "feat: checkout v2",
        state: "open",
        merged: false,
        url: "https://github.com/acme/api/pull/42",
        updatedAt: new Date().toISOString(),
      },
    });

    await checkAndClearDoneBenches();

    expect(notificationService.dismissSyncErrorForWorkUnit).toHaveBeenCalledWith(bench, "api");
  });

  it("unresolvable repoFullName — creates a sync-error notification with the submodule name and error", async () => {
    const workUnit = makeWorkUnit();
    const bench = makeMetaBench([workUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await checkAndClearDoneBenches();

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      bench,
      "sync-error",
      "sync-error::api",
      expect.objectContaining({
        submodule: "api",
        error: expect.stringContaining("repoFullName"),
      }),
    );
    errorSpy.mockRestore();
  });
});

// ── Work-unit auto-clear semantics ──

function makeDoneWorkUnit(overrides: Partial<BenchWorkUnit> = {}): BenchWorkUnit {
  return makeWorkUnit({
    pullRequest: {
      repoFullName: "acme/api",
      number: 42,
      title: "feat: checkout v2",
      state: "closed",
      merged: true,
      url: "https://github.com/acme/api/pull/42",
      updatedAt: new Date().toISOString(),
    },
    lastSyncedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("classifyWorkUnitBench", () => {
  it("all work units merged — returns done with reason merged", () => {
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({ submodule: "api" }),
      makeDoneWorkUnit({ submodule: "web" }),
    ]);
    expect(result.done).toBe(true);
    expect(result.reason).toBe("merged");
  });

  it("all work units closed but not merged — returns done with reason closed", () => {
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({
        submodule: "api",
        pullRequest: {
          repoFullName: "acme/api",
          number: 1,
          title: "t",
          state: "closed",
          merged: false,
          url: "u",
          updatedAt: new Date().toISOString(),
        },
      }),
    ]);
    expect(result.done).toBe(true);
    expect(result.reason).toBe("closed");
  });

  it("one merged + one open PR — blocked:open-pr", () => {
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({ submodule: "api" }),
      makeWorkUnit({
        submodule: "web",
        pullRequest: {
          repoFullName: "acme/web",
          number: 2,
          title: "t",
          state: "open",
          merged: false,
          url: "u",
          updatedAt: new Date().toISOString(),
        },
        lastSyncedAt: new Date().toISOString(),
      }),
    ]);
    expect(result.done).toBe(false);
    expect(result.reason).toBe("blocked:open-pr");
    expect(result.blockingSubmodule).toBe("web");
  });

  it("work unit with lastSyncedAt undefined — blocked:stale-sync", () => {
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({ submodule: "api", lastSyncedAt: undefined }),
    ]);
    expect(result.done).toBe(false);
    expect(result.reason).toBe("blocked:stale-sync");
    expect(result.blockingSubmodule).toBe("api");
  });

  it("work unit with stale lastSyncedAt (> 2 min) — blocked:stale-sync", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({ submodule: "api", lastSyncedAt: fiveMinutesAgo }),
    ]);
    expect(result.done).toBe(false);
    expect(result.reason).toBe("blocked:stale-sync");
  });

  it("work unit with syncError — blocked:sync-error", () => {
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({ submodule: "api", syncError: "rate limited" }),
    ]);
    expect(result.done).toBe(false);
    expect(result.reason).toBe("blocked:sync-error");
    expect(result.blockingSubmodule).toBe("api");
  });

  it("empty work units array — blocked:open-pr (not vacuously done)", () => {
    const result = classifyWorkUnitBench([]);
    expect(result.done).toBe(false);
    expect(result.reason).toBe("blocked:open-pr");
  });

  it("ignored work unit with open PR does not block — returns done when remaining unit is merged", () => {
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({ submodule: "api" }),
      makeWorkUnit({
        submodule: "web",
        pullRequest: {
          repoFullName: "acme/web",
          number: 2,
          title: "t",
          state: "open",
          merged: false,
          url: "u",
          updatedAt: new Date().toISOString(),
        },
        lastSyncedAt: new Date().toISOString(),
        ignoredForAutoClear: true,
      }),
    ]);
    expect(result.done).toBe(true);
    expect(result.reason).toBe("merged");
  });

  it("all work units ignored — returns done:closed", () => {
    const result = classifyWorkUnitBench([
      makeWorkUnit({ submodule: "api", ignoredForAutoClear: true }),
      makeWorkUnit({ submodule: "web", ignoredForAutoClear: true }),
    ]);
    expect(result.done).toBe(true);
    expect(result.reason).toBe("closed");
  });

  it("non-ignored unit with open PR still blocks even when sibling is ignored", () => {
    const result = classifyWorkUnitBench([
      makeWorkUnit({
        submodule: "api",
        pullRequest: {
          repoFullName: "acme/api",
          number: 1,
          title: "t",
          state: "open",
          merged: false,
          url: "u",
          updatedAt: new Date().toISOString(),
        },
        lastSyncedAt: new Date().toISOString(),
        ignoredForAutoClear: true,
      }),
      makeWorkUnit({
        submodule: "web",
        pullRequest: {
          repoFullName: "acme/web",
          number: 2,
          title: "t",
          state: "open",
          merged: false,
          url: "u",
          updatedAt: new Date().toISOString(),
        },
        lastSyncedAt: new Date().toISOString(),
      }),
    ]);
    expect(result.done).toBe(false);
    expect(result.reason).toBe("blocked:open-pr");
    expect(result.blockingSubmodule).toBe("web");
  });

  it("ignored work unit with syncError does not block", () => {
    const result = classifyWorkUnitBench([
      makeDoneWorkUnit({ submodule: "api" }),
      makeWorkUnit({
        submodule: "web",
        syncError: "rate limited",
        ignoredForAutoClear: true,
      }),
    ]);
    expect(result.done).toBe(true);
    expect(result.reason).toBe("merged");
  });
});

describe("work-unit auto-clear via checkAndClearDoneBenches", () => {
  beforeEach(() => {
    vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue("acme/api");
    vi.mocked(githubService.getGithubToken).mockReturnValue("test-token");
    vi.mocked(
      githubService.fetchOpenPullRequestByBranch as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      notModified: true,
    });
    vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
      branch: "feat/checkout-v2",
      dirty: { modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 },
    });
  });

  it("tears down bench when all work units are merged", async () => {
    const wu1 = makeDoneWorkUnit({ submodule: "api" });
    const wu2 = makeDoneWorkUnit({ submodule: "web" });
    const bench = makeMetaBench([wu1, wu2]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", bench.id, true);
  });

  it("does not tear down bench when workUnitAutoClear is false", async () => {
    vi.mocked(projectRegistry.resolveWorkUnitAutoClear).mockReturnValue(false);
    const wu = makeDoneWorkUnit({ submodule: "api" });
    const bench = makeMetaBench([wu]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("blocks teardown and raises teardown-blocked notification for a dirty work-unit bench", async () => {
    const wu = makeDoneWorkUnit({ submodule: "api" });
    const bench = makeMetaBench([wu]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    const dirtyReasons: DirtyReason[] = [
      { kind: "dirty-worktree", location: "workspace", detail: "1 modified" },
    ];
    vi.mocked(gitState.getDirtyState).mockResolvedValue({
      clean: false,
      reasons: dirtyReasons,
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await checkAndClearDoneBenches();
      expect(benchManager.teardownBench).not.toHaveBeenCalled();
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        bench,
        "teardown-blocked",
        undefined,
        { dirtyReasons },
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("legacy bench (no workUnits) uses issue fallback unchanged", async () => {
    const legacyBench = makeBench({ id: 1 });
    const workUnitBench = makeMetaBench([makeDoneWorkUnit()], 2);
    vi.mocked(benchManager.getBenches).mockReturnValue([legacyBench, workUnitBench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue({
      number: 42,
      state: "closed",
    } as unknown as GitHubIssue);
    await checkAndClearDoneBenches();
    // Legacy bench torn down via issue fallback
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 1, true);
    // Work-unit bench also torn down (all PRs done)
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", 2, true);
  });

  it("tears down bench when one work unit is merged and another is ignored (with open PR)", async () => {
    const mergedUnit = makeDoneWorkUnit({ submodule: "api" });
    const ignoredUnit = makeWorkUnit({
      submodule: "web",
      pullRequest: {
        repoFullName: "acme/web",
        number: 2,
        title: "t",
        state: "open",
        merged: false,
        url: "u",
        updatedAt: new Date().toISOString(),
      },
      lastSyncedAt: new Date().toISOString(),
      ignoredForAutoClear: true,
    });
    const bench = makeMetaBench([mergedUnit, ignoredUnit]);
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMetaProject());
    await checkAndClearDoneBenches();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("proj-1", bench.id, true);
  });
});
