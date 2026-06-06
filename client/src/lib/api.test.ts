import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DirtyReason } from "@roubo/shared";
import {
  ApiError,
  isDirtyBenchError,
  fetchProjects,
  registerProject,
  unregisterProject,
  fetchProjectConfig,
  fetchAllBenches,
  fetchBenches,
  fetchBench,
  createBench,
  teardownBench,
  cleanupAndRetryBench,
  startBench,
  stopBench,
  startComponent,
  stopComponent,
  fetchComponentLogs,
  browseDirectory,
  checkConfig,
  scanRepo,
  validateConfig,
  saveConfig,
  fetchRawConfig,
  fetchTools,
  executeTool,
  assignContainer,
  unassignContainer,
  fetchContainers,
  createTerminal,
  fetchTerminals,
  destroyTerminal,
  startInspection,
  fetchInspectionRun,
  abortInspection,
  fetchGitHubProjects,
  fetchProjectGitHubProjects,
  fetchIssuesPage,
  fetchIssueComments,
  applyTransition,
  fetchLabels,
  assignIssue,
  unassignIssue,
  fetchGlobalJigs,
  fetchJigs,
  fetchJig,
  createProjectJig,
  updateProjectJig,
  deleteProjectJig,
  injectJig,
  fetchSettings,
  updateSettings,
  fetchEnvKeys,
  startGithubPluginOauth,
  fetchSourceOptions,
} from "./api";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("request helper (tested through exported functions)", () => {
  it("sets Content-Type: application/json", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchProjects();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("returns parsed JSON on success", async () => {
    const projects = [{ id: "p1", repoPath: "/path" }];
    mockFetch.mockResolvedValue(jsonResponse(projects));
    const result = await fetchProjects();
    expect(result).toEqual(projects);
  });

  it("returns void on 204 (via requestVoid)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: () => Promise.resolve(null),
    });
    const result = await unregisterProject("p1");
    expect(result).toBeUndefined();
  });

  it("throws with error message from body.error", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: "Project not found" }, 404, "Not Found"));
    await expect(fetchProjects()).rejects.toThrow("Project not found");
  });

  it("throws ApiError with status and code when body has code", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: "Duplicate", code: "ALREADY_REGISTERED" }, 409, "Conflict"),
    );
    try {
      await registerProject("/some/path");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).code).toBe("ALREADY_REGISTERED");
    }
  });

  it("isDirtyBenchError identifies 409 bench-dirty errors", async () => {
    const reasons: DirtyReason[] = [
      { kind: "dirty-worktree", location: "workspace", detail: "1 modified" },
    ];
    mockFetch.mockResolvedValue(
      jsonResponse(
        { error: "Bench has uncommitted work", code: "bench-dirty", reasons },
        409,
        "Conflict",
      ),
    );
    try {
      await teardownBench("p1", 2);
      expect.fail("should have thrown");
    } catch (err) {
      expect(isDirtyBenchError(err)).toBe(true);
      if (isDirtyBenchError(err)) {
        expect(err.status).toBe(409);
        expect(err.code).toBe("bench-dirty");
        expect(err.details.reasons).toEqual(reasons);
      }
    }
  });

  it("falls back to statusText when JSON parse fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("bad json")),
    });
    await expect(fetchProjects()).rejects.toThrow("Internal Server Error");
  });
});

describe("fetchProjects", () => {
  it("sends GET to /api/projects", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchProjects();
    expect(mockFetch).toHaveBeenCalledWith("/api/projects", expect.objectContaining({}));
  });
});

describe("registerProject", () => {
  it("sends POST to /api/projects with repoPath", async () => {
    const project = { id: "p1", repoPath: "/path" };
    mockFetch.mockResolvedValue(jsonResponse(project));
    const result = await registerProject("/path");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repoPath: "/path" }),
      }),
    );
    expect(result).toEqual(project);
  });
});

describe("unregisterProject", () => {
  it("sends DELETE to /api/projects/:projectId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: () => Promise.resolve(null),
    });
    await unregisterProject("my-project");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/my-project",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("createBench", () => {
  it("sends POST without branch when not provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await createBench("p1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });

  it("sends POST with branch when provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await createBench("p1", { branch: "feature/x" });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "feature/x" }),
      }),
    );
  });
});

describe("teardownBench", () => {
  it("sends DELETE with removeWorkspace=true by default", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: () => Promise.resolve(null),
    });
    await teardownBench("p1", 2);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/2?removeWorkspace=true",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends DELETE with removeWorkspace=false when specified", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: () => Promise.resolve(null),
    });
    await teardownBench("p1", 2, false);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/2?removeWorkspace=false",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends DELETE with force=true when specified", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      statusText: "Accepted",
      json: () => Promise.resolve({}),
    });
    await teardownBench("p1", 2, true, true);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/2?removeWorkspace=true&force=true",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("browseDirectory", () => {
  it("sends request with path and showHidden params", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ path: "/home", entries: [] }));
    await browseDirectory("/home", true);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/filesystem/browse?path=%2Fhome&showHidden=true",
      expect.objectContaining({}),
    );
  });

  it("omits path param when not provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ path: "~", entries: [] }));
    await browseDirectory();
    expect(mockFetch).toHaveBeenCalledWith("/api/filesystem/browse?", expect.objectContaining({}));
  });

  it("omits showHidden param when false", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ path: "/tmp", entries: [] }));
    await browseDirectory("/tmp", false);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/filesystem/browse?path=%2Ftmp",
      expect.objectContaining({}),
    );
  });
});

describe("fetchAllBenches", () => {
  it("sends GET to /api/benches", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchAllBenches();
    expect(mockFetch).toHaveBeenCalledWith("/api/benches", expect.objectContaining({}));
  });
});

describe("fetchBenches", () => {
  it("sends GET to /api/projects/:projectId/benches", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchBenches("p1");
    expect(mockFetch).toHaveBeenCalledWith("/api/projects/p1/benches", expect.objectContaining({}));
  });
});

describe("fetchBench", () => {
  it("sends GET to /api/projects/:projectId/benches/:benchId", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await fetchBench("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1",
      expect.objectContaining({}),
    );
  });
});

describe("startBench", () => {
  it("sends POST to /api/projects/:projectId/benches/:benchId/start", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await startBench("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/start",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("stopBench", () => {
  it("sends POST to /api/projects/:projectId/benches/:benchId/stop", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await stopBench("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("checkConfig", () => {
  it("sends POST to /api/projects/check-config", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ hasConfig: true }));
    await checkConfig("/repo");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/check-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repoPath: "/repo" }),
      }),
    );
  });
});

describe("scanRepo", () => {
  it("sends POST to /api/projects/scan", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ detected: {} }));
    await scanRepo("/repo");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/scan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repoPath: "/repo" }),
      }),
    );
  });
});

describe("saveConfig", () => {
  it("sends POST to /api/projects/save-config", async () => {
    const config = { project: { name: "test" } } as never;
    mockFetch.mockResolvedValue(jsonResponse({ path: "/repo/roubo.yaml" }));
    await saveConfig("/repo", config);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/save-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repoPath: "/repo", config }),
      }),
    );
  });
});

describe("fetchProjectConfig", () => {
  it("sends GET to /api/projects/:projectId/config", async () => {
    const configResult = {
      config: { project: { name: "test" } },
      configValid: true,
    };
    mockFetch.mockResolvedValue(jsonResponse(configResult));
    const result = await fetchProjectConfig("p1");
    expect(mockFetch).toHaveBeenCalledWith("/api/projects/p1/config", expect.objectContaining({}));
    expect(result).toEqual(configResult);
  });
});

describe("startComponent", () => {
  it("sends POST to /api/projects/:projectId/benches/:benchId/components/:name/start", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await startComponent("p1", 1, "backend");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/components/backend/start",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("stopComponent", () => {
  it("sends POST to /api/projects/:projectId/benches/:benchId/components/:name/stop", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await stopComponent("p1", 1, "backend");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/components/backend/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("fetchComponentLogs", () => {
  it("sends GET with tail param", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ logs: ["line 1"] }));
    await fetchComponentLogs("p1", 1, "backend", 50);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/components/backend/logs?tail=50",
      expect.objectContaining({}),
    );
  });

  it("uses default tail of 200 when not specified", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ logs: [] }));
    await fetchComponentLogs("p1", 1, "backend");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/components/backend/logs?tail=200",
      expect.objectContaining({}),
    );
  });
});

describe("validateConfig", () => {
  it("includes currentProjectId in body when provided", async () => {
    const config = { project: { name: "test" } } as never;
    mockFetch.mockResolvedValue(jsonResponse({ valid: true, errors: [], portConflicts: [] }));
    await validateConfig(config, "existing-project");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/validate-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ config, currentProjectId: "existing-project" }),
      }),
    );
  });
});

describe("fetchContainers", () => {
  it("sends GET to /api/containers", async () => {
    const containers = [{ id: "c1", name: "postgres", image: "postgres:15", status: "running" }];
    mockFetch.mockResolvedValue(jsonResponse(containers));
    const result = await fetchContainers();
    expect(mockFetch).toHaveBeenCalledWith("/api/containers", expect.objectContaining({}));
    expect(result).toEqual(containers);
  });
});

describe("fetchRawConfig", () => {
  it("sends GET to /api/projects/:projectId/config/raw", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ yaml: "project:\n  name: test" }));
    await fetchRawConfig("p1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/config/raw",
      expect.objectContaining({}),
    );
  });
});

describe("fetchGitHubProjects", () => {
  it("sends GET to /api/projects/github-projects with repo query param", async () => {
    const projects = [{ number: 1, title: "Project Alpha" }];
    mockFetch.mockResolvedValue(jsonResponse(projects));
    const result = await fetchGitHubProjects("org/repo");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/github-projects?repo=org%2Frepo",
      expect.objectContaining({}),
    );
    expect(result).toEqual(projects);
  });
});

describe("fetchProjectGitHubProjects", () => {
  it("sends GET to /api/projects/:projectId/projects", async () => {
    const projects = [{ number: 1, title: "Project Alpha" }];
    mockFetch.mockResolvedValue(jsonResponse(projects));
    const result = await fetchProjectGitHubProjects("my-project");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/my-project/projects",
      expect.objectContaining({}),
    );
    expect(result).toEqual(projects);
  });
});

describe("startGithubPluginOauth", () => {
  it("POSTs to /api/plugins/github-com/oauth/authorize and returns the URL", async () => {
    const authUrl = {
      url: "https://github.com/login/oauth/authorize?client_id=abc&state=xyz",
    };
    mockFetch.mockResolvedValue(jsonResponse(authUrl));
    const result = await startGithubPluginOauth();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/plugins/github-com/oauth/authorize",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual(authUrl);
  });
});

describe("cleanupAndRetryBench", () => {
  it("sends POST to /api/projects/:id/benches/:id/cleanup-and-retry", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await cleanupAndRetryBench("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/cleanup-and-retry",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("fetchTools", () => {
  it("sends GET to /api/projects/:id/benches/:id/tools", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchTools("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/tools",
      expect.objectContaining({}),
    );
  });
});

describe("executeTool", () => {
  it("sends POST with userName in body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));
    await executeTool("p1", 1, 0, "alice");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/tools/0/execute",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userName: "alice" }),
      }),
    );
  });
});

describe("assignContainer", () => {
  it("sends POST to /api/projects/:id/benches/:id/assign-container", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await assignContainer("p1", 1, "container-1", "db");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/assign-container",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ containerId: "container-1", component: "db" }),
      }),
    );
  });
});

describe("unassignContainer", () => {
  it("sends DELETE to /api/projects/:id/benches/:id/assign-container/:component", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await unassignContainer("p1", 1, "db");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/assign-container/db",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("createTerminal", () => {
  it("sends POST to /api/projects/:id/benches/:id/terminals", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ sessionId: "s1" }));
    await createTerminal("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/terminals",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("fetchTerminals", () => {
  it("sends GET to /api/projects/:id/benches/:id/terminals", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchTerminals("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/terminals",
      expect.objectContaining({}),
    );
  });
});

describe("destroyTerminal", () => {
  it("sends DELETE to /api/projects/:id/benches/:id/terminals/:sessionId", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await destroyTerminal("p1", 1, "sess-1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/terminals/sess-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("startInspection", () => {
  it("sends POST to /api/projects/:id/benches/:id/inspection", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: "running" }));
    await startInspection("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/inspection",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("includes filter in body when provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: "running" }));
    await startInspection("p1", 1, "login");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/inspection",
      expect.objectContaining({ body: JSON.stringify({ filter: "login" }) }),
    );
  });
});

describe("fetchInspectionRun", () => {
  it("appends since param when provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: "done" }));
    await fetchInspectionRun("p1", 1, 12345);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/inspection?since=12345",
      expect.objectContaining({}),
    );
  });

  it("omits since param when not provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: "done" }));
    await fetchInspectionRun("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/inspection",
      expect.objectContaining({}),
    );
  });
});

describe("abortInspection", () => {
  it("sends DELETE to /api/projects/:id/benches/:id/inspection", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await abortInspection("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/inspection",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("fetchIssuesPage", () => {
  it("fetches without params when none provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await fetchIssuesPage("p1", {});
    expect(mockFetch).toHaveBeenCalledWith("/api/projects/p1/issues", expect.objectContaining({}));
  });

  it("includes cursor, pageSize, labels, and search params when provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await fetchIssuesPage("p1", {
      cursor: "abc",
      pageSize: 25,
      labels: "bug",
      search: "login",
    });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("cursor=abc");
    expect(url).toContain("pageSize=25");
    expect(url).toContain("labels=bug");
    expect(url).toContain("search=login");
  });

  it("omits the cursor param when null", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await fetchIssuesPage("p1", { cursor: null, pageSize: 50 });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("cursor=");
    expect(url).toContain("pageSize=50");
  });
});

describe("applyTransition", () => {
  it("sends POST to /api/projects/:id/issues/:externalId/transitions with transitionName in body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await applyTransition("p1", "ROUBO-42", "In Review");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/issues/ROUBO-42/transitions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ transitionName: "In Review" }),
      }),
    );
  });

  it("URI-encodes the externalId", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await applyTransition("p1", "a/b", "Done");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/issues/a%2Fb/transitions",
      expect.anything(),
    );
  });
});

describe("fetchIssueComments", () => {
  it("sends GET to /api/projects/:id/issues/:externalId/comments", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchIssueComments("p1", "5");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/issues/5/comments",
      expect.objectContaining({}),
    );
  });
});

describe("fetchLabels", () => {
  it("sends GET to /api/projects/:id/labels", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchLabels("p1");
    expect(mockFetch).toHaveBeenCalledWith("/api/projects/p1/labels", expect.objectContaining({}));
  });
});

describe("assignIssue", () => {
  it("sends POST with issueNumber in body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await assignIssue("p1", 1, 42);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/assign-issue",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ issueNumber: 42 }),
      }),
    );
  });
});

describe("unassignIssue", () => {
  it("sends DELETE to /api/projects/:id/benches/:id/assign-issue", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await unassignIssue("p1", 1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/benches/1/assign-issue",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("fetchGlobalJigs", () => {
  it("sends GET to /api/jigs", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchGlobalJigs();
    expect(mockFetch).toHaveBeenCalledWith("/api/jigs", expect.objectContaining({}));
  });
});

describe("fetchJigs", () => {
  it("sends GET to /api/projects/:id/jigs", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchJigs("p1");
    expect(mockFetch).toHaveBeenCalledWith("/api/projects/p1/jigs", expect.objectContaining({}));
  });
});

describe("fetchJig", () => {
  it("sends GET to /api/projects/:id/jigs/:jigId", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await fetchJig("p1", "bp-1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/jigs/bp-1",
      expect.objectContaining({}),
    );
  });
});

describe("createProjectJig", () => {
  it("sends POST to /api/projects/:id/jigs with the body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await createProjectJig("p1", {
      name: "n",
      description: "d",
      content: "c",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/jigs",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body).toEqual({ name: "n", description: "d", content: "c" });
  });
});

describe("updateProjectJig", () => {
  it("sends PUT to /api/projects/:id/jigs/:jigId with the body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await updateProjectJig("p1", "bp-1", { name: "renamed" });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/jigs/bp-1",
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body).toEqual({ name: "renamed" });
  });
});

describe("deleteProjectJig", () => {
  it("sends DELETE to /api/projects/:id/jigs/:jigId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: () => Promise.resolve(null),
    });
    await deleteProjectJig("p1", "bp-1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/p1/jigs/bp-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("injectJig", () => {
  it("includes sessionId in body when provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));
    await injectJig("p1", 1, "bp-1", "sess-1");
    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.sessionId).toBe("sess-1");
  });

  it("omits sessionId from body when not provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }));
    await injectJig("p1", 1, "bp-1");
    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.sessionId).toBeUndefined();
  });
});

describe("fetchSettings", () => {
  it("sends GET to /api/settings", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ maxBenches: 3 }));
    await fetchSettings();
    expect(mockFetch).toHaveBeenCalledWith("/api/settings", expect.objectContaining({}));
  });
});

describe("updateSettings", () => {
  it("sends PUT to /api/settings", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ maxBenches: 5 }));
    await updateSettings({ maxBenches: 5 } as never);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("fetchEnvKeys", () => {
  it("sends GET to /api/settings/env-keys", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ keys: [] }));
    await fetchEnvKeys();
    expect(mockFetch).toHaveBeenCalledWith("/api/settings/env-keys", expect.objectContaining({}));
  });
});

describe("fetchSourceOptions", () => {
  it("encodes category, scope (JSON), search, and cursor into the query string", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await fetchSourceOptions("p1", {
      category: "board",
      scope: { project: ["PLAT"] },
      search: "back",
      cursor: "c1",
    });
    const url = mockFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://localhost");
    expect(parsed.pathname).toBe("/api/projects/p1/integration/source-options");
    expect(parsed.searchParams.get("category")).toBe("board");
    expect(parsed.searchParams.get("scope")).toBe(JSON.stringify({ project: ["PLAT"] }));
    expect(parsed.searchParams.get("search")).toBe("back");
    expect(parsed.searchParams.get("cursor")).toBe("c1");
  });

  it("omits scope, search, and cursor when not provided", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await fetchSourceOptions("p1", { category: "project" });
    const url = mockFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.get("category")).toBe("project");
    expect(parsed.searchParams.has("scope")).toBe(false);
    expect(parsed.searchParams.has("search")).toBe(false);
    expect(parsed.searchParams.has("cursor")).toBe(false);
  });
});
