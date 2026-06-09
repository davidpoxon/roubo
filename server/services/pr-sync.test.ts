import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncBenchWorkUnitPRs, syncAllWorkUnitPRs, startPolling, stopPolling } from "./pr-sync.js";

vi.mock("./project-registry.js");
vi.mock("./github.js");
vi.mock("./notification.js");
vi.mock("./state.js", () => ({
  updateBench: vi.fn(),
  toPersistedBench: vi.fn((bench) => bench),
}));
vi.mock("./git-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-helpers.js")>()),
  resolveRepoFullName: vi.fn(),
  probeWorkUnitState: vi.fn(),
}));
vi.mock("./bench-manager.js", () => ({
  isBenchLive: vi.fn(),
  getBenches: vi.fn(() => []),
}));

import * as projectRegistry from "./project-registry.js";
import * as githubService from "./github.js";
import * as notificationService from "./notification.js";
import * as state from "./state.js";
import * as gitHelpers from "./git-helpers.js";
import * as benchManager from "./bench-manager.js";
import type { Bench, BenchWorkUnit, RegisteredProject, RouboConfig } from "@roubo/shared";

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "proj-1",
    branch: "issue-42-fix",
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

function makeProject(): RegisteredProject {
  const config: RouboConfig = {
    project: { name: "proj", displayName: "Proj", repo: "owner/repo" },
    layout: { type: "meta-repo" },
    components: {},
    ports: {},
    benches: { max: 3 },
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
    branch: "feat/checkout",
    workspacePath: "/tmp/workspace/services/api",
    ...overrides,
  };
}

const openPrResponse = {
  notModified: false,
  pr: {
    number: 99,
    title: "Add feature",
    state: "open" as const,
    merged: false,
    url: "https://github.com/owner/repo/pull/99",
    updatedAt: new Date().toISOString(),
  },
};

// Clean probe result: no dirty state, branch matches the default makeWorkUnit branch
const cleanProbeResult = {
  branch: "feat/checkout",
  dirty: { modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(githubService.getGithubToken).mockReturnValue("gh-token");
  vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
  vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue("owner/repo");
  vi.mocked(githubService.fetchOpenPullRequestByBranch).mockResolvedValue(openPrResponse);
  vi.mocked(state.toPersistedBench).mockImplementation((bench) => bench);
  vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue(cleanProbeResult);
  // Default: bench is still tracked, so syncs persist as normal.
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  // Default: no benches; polling tests override this per case.
  vi.mocked(benchManager.getBenches).mockReturnValue([]);
});

describe("syncBenchWorkUnitPRs", () => {
  it("returns early when no GitHub token", async () => {
    vi.mocked(githubService.getGithubToken).mockReturnValue(undefined);
    const bench = makeBench({ workUnits: [makeWorkUnit()] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(githubService.fetchOpenPullRequestByBranch).not.toHaveBeenCalled();
  });

  it("returns early when project config is missing", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const bench = makeBench({ workUnits: [makeWorkUnit()] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(githubService.fetchOpenPullRequestByBranch).not.toHaveBeenCalled();
  });

  it("sets pullRequest and lastSyncedAt when open PR found", async () => {
    const wu = makeWorkUnit();
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(wu.pullRequest).toMatchObject({ number: 99, state: "open" });
    expect(wu.lastSyncedAt).toBeDefined();
    expect(wu.syncError).toBeUndefined();
    expect(state.updateBench).toHaveBeenCalled();
  });

  it("does not persist when the bench was cleared mid-sync (no resurrection)", async () => {
    // Simulates a teardown removing the bench from state.json + the in-memory map
    // while this sync holds the bench reference across its awaited GitHub calls.
    // Persisting here would write the bench back into state.json and resurrect it
    // on the next app restart, so the guard must skip the write.
    vi.mocked(benchManager.isBenchLive).mockReturnValue(false);
    const wu = makeWorkUnit();
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(benchManager.isBenchLive).toHaveBeenCalledWith(bench.projectId, bench.id);
    expect(state.updateBench).not.toHaveBeenCalled();
  });

  it("resolves repoFullName from root submodule via project config", async () => {
    const wu = makeWorkUnit({ submodule: "." });
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(gitHelpers.resolveRepoFullName).not.toHaveBeenCalled();
    expect(githubService.fetchOpenPullRequestByBranch).toHaveBeenCalledWith(
      "owner/repo",
      wu.branch,
    );
  });

  it("resolves repoFullName via git for non-root submodule", async () => {
    const wu = makeWorkUnit({ submodule: "api" });
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(gitHelpers.resolveRepoFullName).toHaveBeenCalledWith(wu.workspacePath);
  });

  it("sets syncError when repoFullName cannot be resolved", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue(null);
    const wu = makeWorkUnit();
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(wu.syncError).toBeDefined();
    expect(notificationService.createNotification).toHaveBeenCalled();
    expect(state.updateBench).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not update pullRequest or lastSyncedAt on ETag 304 not-modified response", async () => {
    vi.mocked(githubService.fetchOpenPullRequestByBranch).mockResolvedValue({
      notModified: true,
      pr: null,
    });
    const wu = makeWorkUnit();
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    // PR fields are not touched; dirty probe always writes dirtyState so updateBench is called
    expect(wu.pullRequest).toBeUndefined();
    expect(wu.lastSyncedAt).toBeUndefined();
    expect(state.updateBench).toHaveBeenCalled();
  });

  it("fetches PR detail when no open PR but previous PR was recent", async () => {
    vi.mocked(githubService.fetchOpenPullRequestByBranch).mockResolvedValue({
      notModified: false,
      pr: null,
    });
    const prevPr = {
      repoFullName: "owner/repo",
      number: 50,
      title: "Old PR",
      state: "open" as const,
      merged: false,
      url: "https://github.com/owner/repo/pull/50",
      updatedAt: new Date().toISOString(),
    };
    const mergedPr = { ...prevPr, state: "closed" as const, merged: true };
    vi.mocked(githubService.fetchPullRequestDetail).mockResolvedValue(mergedPr);
    const wu = makeWorkUnit({ pullRequest: prevPr });
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(githubService.fetchPullRequestDetail).toHaveBeenCalledWith("owner/repo", 50);
    expect(wu.pullRequest?.merged).toBe(true);
    expect(state.updateBench).toHaveBeenCalled();
  });

  it("clears tracked state when no open PR and no recent previous PR", async () => {
    vi.mocked(githubService.fetchOpenPullRequestByBranch).mockResolvedValue({
      notModified: false,
      pr: null,
    });
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    const wu = makeWorkUnit({
      pullRequest: {
        repoFullName: "owner/repo",
        number: 50,
        title: "Old PR",
        state: "closed",
        merged: false,
        url: "https://github.com/owner/repo/pull/50",
        updatedAt: oldDate,
      },
    });
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(wu.pullRequest).toBeUndefined();
    expect(wu.lastSyncedAt).toBeDefined();
    expect(state.updateBench).toHaveBeenCalled();
  });

  it("sets syncError when fetch throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(githubService.fetchOpenPullRequestByBranch).mockRejectedValue(
      new Error("network error"),
    );
    const wu = makeWorkUnit();
    const bench = makeBench({ workUnits: [wu] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    expect(wu.syncError).toBe("network error");
    expect(notificationService.createNotification).toHaveBeenCalled();
    expect(state.updateBench).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("PR sync failed"));
    consoleError.mockRestore();
  });

  it("deduplicates GitHub requests for work units sharing the same repo/branch", async () => {
    const wu1 = makeWorkUnit({
      submodule: "api",
      branch: "shared-branch",
      workspacePath: "/tmp/api",
    });
    const wu2 = makeWorkUnit({
      submodule: "web",
      branch: "shared-branch",
      workspacePath: "/tmp/web",
    });
    // Both resolve to same repoFullName
    vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue("owner/repo");
    const bench = makeBench({ workUnits: [wu1, wu2] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    // Should only fetch once despite two work units
    expect(githubService.fetchOpenPullRequestByBranch).toHaveBeenCalledTimes(1);
  });

  it("always calls updateBench to persist dirty probe results even when PR response is 304", async () => {
    vi.mocked(githubService.fetchOpenPullRequestByBranch).mockResolvedValue({
      notModified: true,
      pr: null,
    });
    const bench = makeBench({ workUnits: [makeWorkUnit()] });
    await syncBenchWorkUnitPRs("proj-1", bench);
    // Dirty probe always updates dirtyState, so a persist is always required
    expect(state.updateBench).toHaveBeenCalled();
  });

  describe("branch refresh and dirty probe", () => {
    it("updates workUnit.branch when probe returns a different branch", async () => {
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: "feat/new-branch",
        dirty: { modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 },
      });
      const wu = makeWorkUnit({ branch: "main" });
      const bench = makeBench({ workUnits: [wu] });
      await syncBenchWorkUnitPRs("proj-1", bench);
      expect(wu.branch).toBe("feat/new-branch");
      expect(wu.detached).toBe(false);
    });

    it("sets detached=true when probe returns null branch", async () => {
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: null,
        dirty: { modifiedCount: 5, untrackedCount: 2, unpushedCommits: 0 },
      });
      const wu = makeWorkUnit({ branch: "main" });
      const bench = makeBench({ workUnits: [wu] });
      await syncBenchWorkUnitPRs("proj-1", bench);
      expect(wu.detached).toBe(true);
      // Preserves last-known branch for display continuity
      expect(wu.branch).toBe("main");
    });

    it("skips PR fetch for detached-HEAD submodule", async () => {
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: null,
        dirty: { modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 },
      });
      const wu = makeWorkUnit();
      const bench = makeBench({ workUnits: [wu] });
      await syncBenchWorkUnitPRs("proj-1", bench);
      expect(githubService.fetchOpenPullRequestByBranch).not.toHaveBeenCalled();
    });

    it("sets lastSyncedAt for detached-HEAD submodule without a PR fetch", async () => {
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: null,
        dirty: { modifiedCount: 3, untrackedCount: 1, unpushedCommits: 0 },
      });
      const wu = makeWorkUnit();
      const bench = makeBench({ workUnits: [wu] });
      await syncBenchWorkUnitPRs("proj-1", bench);
      expect(wu.lastSyncedAt).toBeDefined();
      expect(wu.syncError).toBeUndefined();
    });

    it("clears stale PR when detached HEAD and previous PR has aged out", async () => {
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: null,
        dirty: { modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 },
      });
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const wu = makeWorkUnit({
        detached: true,
        pullRequest: {
          repoFullName: "owner/repo",
          number: 10,
          title: "Old PR",
          state: "closed",
          merged: false,
          url: "https://github.com/owner/repo/pull/10",
          updatedAt: oldDate,
        },
      });
      const bench = makeBench({ workUnits: [wu] });
      await syncBenchWorkUnitPRs("proj-1", bench);
      expect(wu.pullRequest).toBeUndefined();
    });

    it("populates dirtyState on the work unit from the probe result", async () => {
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: "feat/checkout",
        dirty: { modifiedCount: 12, untrackedCount: 4, unpushedCommits: 2 },
      });
      const wu = makeWorkUnit();
      const bench = makeBench({ workUnits: [wu] });
      await syncBenchWorkUnitPRs("proj-1", bench);
      expect(wu.dirtyState).toEqual({ modifiedCount: 12, untrackedCount: 4, unpushedCommits: 2 });
    });

    it('probes dirty state for the "." root work unit but does not refresh its branch', async () => {
      vi.mocked(gitHelpers.probeWorkUnitState).mockResolvedValue({
        branch: "some-other-branch",
        dirty: { modifiedCount: 1, untrackedCount: 0, unpushedCommits: 0 },
      });
      const wu = makeWorkUnit({ submodule: ".", branch: "issue-42-fix" });
      const bench = makeBench({ workUnits: [wu] });
      await syncBenchWorkUnitPRs("proj-1", bench);
      // Branch must not change for the root: it is owned by bench.branch
      expect(wu.branch).toBe("issue-42-fix");
      expect(wu.detached).toBeUndefined();
      // But dirty state should be probed
      expect(wu.dirtyState).toEqual({ modifiedCount: 1, untrackedCount: 0, unpushedCommits: 0 });
    });
  });
});

describe("syncAllWorkUnitPRs", () => {
  it("syncs all meta-repo benches across projects", async () => {
    const wu = makeWorkUnit();
    const bench = makeBench({ workUnits: [wu] });
    const byProject = new Map([["proj-1", [bench]]]);
    await syncAllWorkUnitPRs(byProject);
    expect(githubService.fetchOpenPullRequestByBranch).toHaveBeenCalled();
    expect(wu.pullRequest).toMatchObject({ number: 99 });
  });

  it("returns early when no GitHub token", async () => {
    vi.mocked(githubService.getGithubToken).mockReturnValue(undefined);
    const bench = makeBench({ workUnits: [makeWorkUnit()] });
    const byProject = new Map([["proj-1", [bench]]]);
    await syncAllWorkUnitPRs(byProject);
    expect(githubService.fetchOpenPullRequestByBranch).not.toHaveBeenCalled();
  });

  it("skips projects with missing config", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const bench = makeBench({ workUnits: [makeWorkUnit()] });
    const byProject = new Map([["proj-1", [bench]]]);
    await syncAllWorkUnitPRs(byProject);
    expect(githubService.fetchOpenPullRequestByBranch).not.toHaveBeenCalled();
  });

  it("deduplicates across benches in the same call", async () => {
    const wu1 = makeWorkUnit({ submodule: "api", branch: "shared", workspacePath: "/tmp/api" });
    const wu2 = makeWorkUnit({ submodule: "web", branch: "shared", workspacePath: "/tmp/web" });
    vi.mocked(gitHelpers.resolveRepoFullName).mockResolvedValue("owner/repo");
    const bench1 = makeBench({ id: 1, workUnits: [wu1] });
    const bench2 = makeBench({ id: 2, workUnits: [wu2] });
    const byProject = new Map([["proj-1", [bench1, bench2]]]);
    await syncAllWorkUnitPRs(byProject);
    expect(githubService.fetchOpenPullRequestByBranch).toHaveBeenCalledTimes(1);
  });
});

describe("startPolling / stopPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Always tear down the interval so a registered timer never leaks across tests.
    stopPolling();
    vi.useRealTimers();
  });

  it("registers an interval that groups benches by project and triggers a sync", async () => {
    const wu = makeWorkUnit();
    const bench = makeBench({ workUnits: [wu] });
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);

    startPolling();
    expect(githubService.fetchOpenPullRequestByBranch).not.toHaveBeenCalled();

    // Fire the interval once, then stop it so the async pollOnce() chain we flush
    // below is the only tick that runs (no second tick from a still-live interval).
    vi.advanceTimersByTime(30_000);
    stopPolling();
    await vi.runAllTimersAsync();

    expect(benchManager.getBenches).toHaveBeenCalled();
    expect(githubService.fetchOpenPullRequestByBranch).toHaveBeenCalledWith(
      "owner/repo",
      wu.branch,
    );
  });

  it("is idempotent: a second startPolling() does not register a second interval", async () => {
    const bench = makeBench({ workUnits: [makeWorkUnit()] });
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);

    startPolling();
    startPolling();

    // Fire exactly one tick, then stop both/one interval before flushing async work.
    vi.advanceTimersByTime(30_000);
    stopPolling();
    await vi.runAllTimersAsync();

    // A single interval means getBenches runs once per tick, not twice.
    expect(benchManager.getBenches).toHaveBeenCalledTimes(1);
  });

  it("stopPolling clears the interval so no further syncs run", async () => {
    const bench = makeBench({ workUnits: [makeWorkUnit()] });
    vi.mocked(benchManager.getBenches).mockReturnValue([bench]);

    startPolling();
    stopPolling();

    vi.advanceTimersByTime(60_000);
    await vi.runAllTimersAsync();

    expect(benchManager.getBenches).not.toHaveBeenCalled();
  });

  it("stopPolling is idempotent when no interval is running", () => {
    expect(() => {
      stopPolling();
      stopPolling();
    }).not.toThrow();
  });
});
