import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/project-registry.js");
vi.mock("../services/git-helpers.js", () => {
  class DefaultBranchResolutionError extends Error {
    constructor() {
      super(
        "Could not determine the default branch for this project. Fetch from origin or disable 'Branch from default branch' in project settings.",
      );
      this.name = "DefaultBranchResolutionError";
    }
  }
  return {
    resolveDefaultBranch: vi.fn(),
    DefaultBranchResolutionError,
    DEFAULT_BRANCH_RESOLUTION_ERROR:
      "Could not determine the default branch for this project. Fetch from origin or disable 'Branch from default branch' in project settings.",
  };
});

import router from "./project-settings.js";
import * as projectRegistry from "../services/project-registry.js";
import * as gitHelpers from "../services/git-helpers.js";

const mockedResolveDefaultBranch = vi.mocked(gitHelpers.resolveDefaultBranch);

const app = express();
app.use(express.json());
app.use("/", router);

const mockProject = {
  id: "test-project",
  repoPath: "/some/path",
  name: "Test Project",
  settings: {
    worktreeSource: { branchFromDefault: true, pullLatest: true },
  },
};

describe("GET /:projectId/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
    mockedResolveDefaultBranch.mockResolvedValue("main");
  });

  it("returns the project settings with resolved default branch", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      ...mockProject,
      settings: { worktreeSource: { branchFromDefault: false, pullLatest: true } },
    } as never);

    const res = await request(app).get("/test-project/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      worktreeSource: { branchFromDefault: false, pullLatest: true },
      defaultBranch: "main",
    });
    expect(res.body.defaultBranchError).toBeUndefined();
  });

  it("returns default settings (both on) when project has no persisted settings", async () => {
    const res = await request(app).get("/test-project/settings");
    expect(res.status).toBe(200);
    expect(res.body.worktreeSource).toEqual({ branchFromDefault: true, pullLatest: true });
    expect(res.body.defaultBranch).toBe("main");
  });

  it("returns defaultBranchError (not 500) when resolveDefaultBranch throws DefaultBranchResolutionError", async () => {
    const { DefaultBranchResolutionError } = await import("../services/git-helpers.js");
    mockedResolveDefaultBranch.mockRejectedValue(new DefaultBranchResolutionError());

    const res = await request(app).get("/test-project/settings");
    expect(res.status).toBe(200);
    expect(res.body.defaultBranchError).toBe(
      "Could not determine the default branch for this project. Fetch from origin or disable 'Branch from default branch' in project settings.",
    );
    expect(res.body.defaultBranch).toBeUndefined();
  });

  it("returns defaultBranchError (not 500) when resolveDefaultBranch throws an unexpected error", async () => {
    mockedResolveDefaultBranch.mockRejectedValue(new Error("boom"));

    const res = await request(app).get("/test-project/settings");
    expect(res.status).toBe(200);
    expect(res.body.defaultBranchError).toBe("boom");
    expect(res.body.defaultBranch).toBeUndefined();
  });

  it("returns 404 for unknown project without calling resolveDefaultBranch", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/unknown-project/settings");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
    expect(mockedResolveDefaultBranch).not.toHaveBeenCalled();
  });
});

describe("PUT /:projectId/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
    vi.mocked(projectRegistry.updateProjectSettings).mockReturnValue(mockProject as never);
  });

  it("replaces settings and returns persisted value", async () => {
    const body = { worktreeSource: { branchFromDefault: false, pullLatest: false } };
    const res = await request(app).put("/test-project/settings").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(projectRegistry.updateProjectSettings).toHaveBeenCalledWith("test-project", body);
  });

  it("returns 400 for unknown top-level field", async () => {
    const res = await request(app)
      .put("/test-project/settings")
      .send({ worktreeSource: { branchFromDefault: true, pullLatest: true }, bogus: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown field/i);
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown nested field", async () => {
    const res = await request(app)
      .put("/test-project/settings")
      .send({ worktreeSource: { branchFromDefault: true, pullLatest: true, rogue: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/worktreeSource\.rogue/i);
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when branchFromDefault is wrong type", async () => {
    const res = await request(app)
      .put("/test-project/settings")
      .send({ worktreeSource: { branchFromDefault: "yes", pullLatest: true } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/branchFromDefault/i);
    expect(res.body.error).toMatch(/boolean/i);
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when worktreeSource is missing", async () => {
    const res = await request(app).put("/test-project/settings").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/worktreeSource/i);
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when pullLatest is wrong type", async () => {
    const res = await request(app)
      .put("/test-project/settings")
      .send({ worktreeSource: { branchFromDefault: true, pullLatest: "yes" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pullLatest/i);
    expect(res.body.error).toMatch(/boolean/i);
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when body is an array", async () => {
    const res = await request(app)
      .put("/test-project/settings")
      .set("Content-Type", "application/json")
      .send("[]");
    expect(res.status).toBe(400);
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when body is null", async () => {
    // Express json() strict mode rejects non-object/array JSON bodies (like null)
    // before the route handler runs, so only the status matters here
    const res = await request(app)
      .put("/test-project/settings")
      .set("Content-Type", "application/json")
      .send("null");
    expect(res.status).toBe(400);
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .put("/unknown-project/settings")
      .send({ worktreeSource: { branchFromDefault: true, pullLatest: true } });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
    expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("returns 500 when updateProjectSettings throws", async () => {
    vi.mocked(projectRegistry.updateProjectSettings).mockImplementation(() => {
      throw new Error("Disk full");
    });

    const res = await request(app)
      .put("/test-project/settings")
      .send({ worktreeSource: { branchFromDefault: true, pullLatest: true } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Disk full");
  });
});
