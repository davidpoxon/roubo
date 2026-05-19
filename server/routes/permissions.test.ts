import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/state.js");
vi.mock("../services/project-registry.js");
vi.mock("../services/bench-manager.js", () => ({
  getBenches: vi.fn(),
}));
vi.mock("../services/claude-settings-local.js", () => ({
  injectPermissions: vi.fn(),
}));

import router from "./permissions.js";
import * as state from "../services/state.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as claudeSettingsLocal from "../services/claude-settings-local.js";

const app = express();
app.use(express.json());
app.use("/", router);

const mockProject = {
  id: "test-project",
  repoPath: "/some/path",
  name: "Test Project",
};

describe("GET /:projectId/permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
  });

  it("returns empty allow/deny/ask when project has no saved permissions", async () => {
    vi.mocked(state.getProjectPermissions).mockReturnValue({
      allow: [],
      deny: [],
      ask: [],
    });

    const res = await request(app).get("/test-project/permissions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("returns saved allow, deny, and ask permissions", async () => {
    vi.mocked(state.getProjectPermissions).mockReturnValue({
      allow: ["tool:Bash", "tool:Read"],
      deny: ["Bash(rm:*)"],
      ask: ["Edit(.env*)"],
    });

    const res = await request(app).get("/test-project/permissions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      allow: ["tool:Bash", "tool:Read"],
      deny: ["Bash(rm:*)"],
      ask: ["Edit(.env*)"],
    });
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/unknown-project/permissions");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
    expect(state.getProjectPermissions).not.toHaveBeenCalled();
  });
});

describe("PUT /:projectId/permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
    vi.mocked(state.setProjectPermissions).mockReturnValue(undefined);
  });

  it("replaces permissions and returns updated list", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: ["tool:Bash"], deny: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: ["tool:Bash"], deny: [], ask: [] });
    expect(state.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: ["tool:Bash"],
      deny: [],
      ask: [],
    });
  });

  it("replaces allow and deny together", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: ["tool:Bash"], deny: ["Bash(rm:*)"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: ["tool:Bash"], deny: ["Bash(rm:*)"], ask: [] });
    expect(state.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: ["tool:Bash"],
      deny: ["Bash(rm:*)"],
      ask: [],
    });
  });

  it("accepts empty allow array and defaults deny and ask to []", async () => {
    const res = await request(app).put("/test-project/permissions").send({ allow: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: [], deny: [], ask: [] });
    expect(state.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: [],
      deny: [],
      ask: [],
    });
  });

  it("accepts body with all fields omitted and defaults to []", async () => {
    const res = await request(app).put("/test-project/permissions").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: [], deny: [], ask: [] });
    expect(state.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: [],
      deny: [],
      ask: [],
    });
  });

  it("accepts body with only deny provided and defaults others to []", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ deny: ["Bash(rm:*)"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: [], deny: ["Bash(rm:*)"], ask: [] });
  });

  it("accepts ask array", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: [], deny: [], ask: ["Edit(.env*)"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: [], deny: [], ask: ["Edit(.env*)"] });
    expect(state.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: [],
      deny: [],
      ask: ["Edit(.env*)"],
    });
  });

  it("returns 400 when allow array exceeds 100 entries", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: Array(101).fill("Bash(*)") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow, deny, and ask must be arrays of strings/i);
    expect(state.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("returns 400 when a rule string exceeds 512 characters", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: ["x".repeat(513)] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow, deny, and ask must be arrays of strings/i);
    expect(state.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("returns 400 when allow is not an array", async () => {
    const res = await request(app).put("/test-project/permissions").send({ allow: "tool:Bash" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow, deny, and ask must be arrays of strings/i);
  });

  it("returns 400 when deny is not an array", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: [], deny: "Bash(rm:*)" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow, deny, and ask must be arrays of strings/i);
  });

  it("returns 400 when ask is not an array", async () => {
    const res = await request(app).put("/test-project/permissions").send({ ask: "Edit(.env*)" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow, deny, and ask must be arrays of strings/i);
  });

  it("returns 400 when body is null", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .set("Content-Type", "application/json")
      .send("null");
    expect(res.status).toBe(400);
    expect(state.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("returns 400 when allow contains non-string elements", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: [123, true] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow, deny, and ask must be arrays of strings/i);
  });

  it("returns 400 when deny contains non-string elements", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: [], deny: [123] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow, deny, and ask must be arrays of strings/i);
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .put("/unknown-project/permissions")
      .send({ allow: ["tool:Bash"], deny: [] });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
    expect(state.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("returns 500 when setProjectPermissions throws", async () => {
    vi.mocked(state.setProjectPermissions).mockImplementation(() => {
      throw new Error("Disk full");
    });

    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: ["tool:Bash"], deny: [] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Disk full");
  });
});

describe("POST /:projectId/permissions/resync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
    vi.mocked(state.getProjectPermissions).mockReturnValue({
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    });
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).post("/unknown/permissions/resync");
    expect(res.status).toBe(404);
  });

  it("calls injectPermissions for each active bench and reports counts", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, workspacePath: "/ws/bench-1", status: "active" } as never,
      { id: 2, workspacePath: "/ws/bench-2", status: "idle" } as never,
    ]);
    vi.mocked(claudeSettingsLocal.injectPermissions).mockReturnValue(undefined);

    const res = await request(app).post("/test-project/permissions/resync");
    const expectedPermissions = { allow: ["Bash(npm test:*)"], deny: [], ask: [] };
    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(claudeSettingsLocal.injectPermissions).toHaveBeenCalledTimes(2);
    expect(claudeSettingsLocal.injectPermissions).toHaveBeenCalledWith(
      "/ws/bench-1",
      expectedPermissions,
    );
    expect(claudeSettingsLocal.injectPermissions).toHaveBeenCalledWith(
      "/ws/bench-2",
      expectedPermissions,
    );
  });

  it("skips benches that are clearing", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, workspacePath: "/ws/bench-1", status: "clearing" } as never,
    ]);

    const res = await request(app).post("/test-project/permissions/resync");
    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(claudeSettingsLocal.injectPermissions).not.toHaveBeenCalled();
  });

  it("records per-bench errors without failing the request", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, workspacePath: "/ws/bench-1", status: "active" } as never,
      { id: 2, workspacePath: "/ws/bench-2", status: "active" } as never,
    ]);
    vi.mocked(claudeSettingsLocal.injectPermissions)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("No space left");
      });

    const res = await request(app).post("/test-project/permissions/resync");
    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].benchId).toBe(2);
    expect(res.body.errors[0].message).toBe("No space left");
  });
});
