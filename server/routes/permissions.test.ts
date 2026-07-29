import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/state.js");
vi.mock("../services/project-registry.js");
vi.mock("../services/bench-manager.js", () => ({
  getBenches: vi.fn(),
}));
vi.mock("../services/agent-permissions.js", () => ({
  applyProjectPermissions: vi.fn(),
  describeAgentPermissions: vi.fn(),
}));

import router from "./permissions.js";
import * as state from "../services/state.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as agentPermissions from "../services/agent-permissions.js";

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

  it("dispatches through the agent seam for each active bench and reports counts", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, workspacePath: "/ws/bench-1", status: "active" } as never,
      { id: 2, workspacePath: "/ws/bench-2", status: "idle" } as never,
    ]);
    vi.mocked(agentPermissions.applyProjectPermissions).mockResolvedValue({
      carrier: "agent-plugin",
      written: [],
    });

    const res = await request(app).post("/test-project/permissions/resync");
    const expectedPermissions = { allow: ["Bash(npm test:*)"], deny: [], ask: [] };
    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(agentPermissions.applyProjectPermissions).toHaveBeenCalledTimes(2);
    expect(agentPermissions.applyProjectPermissions).toHaveBeenCalledWith({
      projectId: "test-project",
      benchId: 1,
      workspacePath: "/ws/bench-1",
      permissions: expectedPermissions,
    });
    expect(agentPermissions.applyProjectPermissions).toHaveBeenCalledWith({
      projectId: "test-project",
      benchId: 2,
      workspacePath: "/ws/bench-2",
      permissions: expectedPermissions,
    });
  });

  it("skips benches that are clearing (AP-TC-080)", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, workspacePath: "/ws/bench-1", status: "clearing" } as never,
    ]);

    const res = await request(app).post("/test-project/permissions/resync");
    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.errors).toEqual([]);
    expect(agentPermissions.applyProjectPermissions).not.toHaveBeenCalled();
  });

  it("counts an agent that carries no rules as skipped, not resynced", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, workspacePath: "/ws/bench-1", status: "active" } as never,
    ]);
    vi.mocked(agentPermissions.applyProjectPermissions).mockResolvedValue({
      carrier: "none",
      written: [],
    });

    const res = await request(app).post("/test-project/permissions/resync");
    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it("records per-bench errors without failing the request", async () => {
    vi.mocked(benchManager.getBenches).mockReturnValue([
      { id: 1, workspacePath: "/ws/bench-1", status: "active" } as never,
      { id: 2, workspacePath: "/ws/bench-2", status: "active" } as never,
    ]);
    vi.mocked(agentPermissions.applyProjectPermissions)
      .mockResolvedValueOnce({ carrier: "built-in", written: [] })
      .mockRejectedValueOnce(new Error("No space left"));

    const res = await request(app).post("/test-project/permissions/resync");
    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].benchId).toBe(2);
    expect(res.body.errors[0].message).toBe("No space left");
  });
});

describe("permissions posture and rule guard (AP-FR-016, AP-TC-081)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
    vi.mocked(state.setProjectPermissions).mockReturnValue(undefined);
  });

  it("stores and returns the universal posture", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: [], deny: [], ask: [], posture: "auto-edit" });
    expect(res.status).toBe(200);
    expect(res.body.posture).toBe("auto-edit");
    expect(state.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: [],
      deny: [],
      ask: [],
      posture: "auto-edit",
    });
  });

  it("leaves the posture absent when none is supplied", async () => {
    const res = await request(app).put("/test-project/permissions").send({ allow: [] });
    expect(res.status).toBe(200);
    expect(res.body.posture).toBeUndefined();
  });

  it("returns 400 for an unknown posture", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: [], posture: "yolo" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/posture must be one of/i);
    expect(state.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("rejects a rule with a traversal segment (AP-TC-081)", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: ["Read(../../../../etc/**)"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path segment/i);
    expect(res.body.rule).toBe("Read(../../../../etc/**)");
    expect(state.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("rejects an absolute-path rule in either access-granting group (AP-TC-081)", async () => {
    for (const body of [{ allow: ["Read(/etc/**)"] }, { ask: ["Edit(/var/log/**)"] }]) {
      const res = await request(app).put("/test-project/permissions").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/absolute or home-rooted path/i);
    }
    expect(state.setProjectPermissions).not.toHaveBeenCalled();
  });

  // A deny rule cannot grant reach outside the workspace, only remove it, so
  // guarding it would take away the user's only way to forbid an outside path.
  it("stores an outside-path deny rule rather than rejecting it", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ deny: ["Read(~/.ssh/**)", "Read(../../etc/**)"] });
    expect(res.status).toBe(200);
    expect(state.setProjectPermissions).toHaveBeenCalledWith(
      "test-project",
      expect.objectContaining({ deny: ["Read(~/.ssh/**)", "Read(../../etc/**)"] }),
    );
  });

  it("still accepts ordinary workspace-scoped patterns", async () => {
    const res = await request(app)
      .put("/test-project/permissions")
      .send({ allow: ["Bash(npm run *)", "Read(./**)", "Edit(**/*.ts)", "mcp__*"] });
    expect(res.status).toBe(200);
    expect(state.setProjectPermissions).toHaveBeenCalled();
  });
});

describe("GET /:projectId/permissions/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
  });

  it("reports what the resolved agent honours", async () => {
    vi.mocked(agentPermissions.describeAgentPermissions).mockResolvedValue({
      agentPluginId: "claude-code",
      agentName: "Claude Code",
      postures: ["read-only", "guarded", "auto-edit", "full-auto"],
      rules: true,
      resync: true,
    });

    const res = await request(app).get("/test-project/permissions/capabilities");
    expect(res.status).toBe(200);
    expect(res.body.agentPluginId).toBe("claude-code");
    expect(res.body.rules).toBe(true);
  });

  it("degrades to the built-in carrier when the probe fails", async () => {
    vi.mocked(agentPermissions.describeAgentPermissions).mockRejectedValue(new Error("no rpc"));

    const res = await request(app).get("/test-project/permissions/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agentPluginId: null,
      agentName: null,
      postures: [],
      rules: true,
      resync: true,
    });
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get("/unknown/permissions/capabilities");
    expect(res.status).toBe(404);
  });
});
