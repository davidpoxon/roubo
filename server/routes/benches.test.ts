import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/bench-manager.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/bench-manager.js")>();
  return {
    ...original,
    getBenches: vi.fn(),
    createBench: vi.fn(),
    getBench: vi.fn(),
    teardownBench: vi.fn(),
    startAllComponents: vi.fn(),
    stopAllComponents: vi.fn(),
    startComponent: vi.fn(),
    stopComponent: vi.fn(),
    getComponentLogs: vi.fn(),
    queryAuditLog: vi.fn(),
    assignContainer: vi.fn(),
    unassignContainer: vi.fn(),
    cleanupAndRetryBench: vi.fn(),
  };
});

vi.mock("../services/tool-launcher.js", () => ({
  getResolvedTools: vi.fn(),
  executeTool: vi.fn(),
}));

vi.mock("../services/issue-assignment.js", () => ({
  createBenchAndAssignFromIssue: vi.fn(),
}));

vi.mock("./plugin-route-helpers.js", () => ({
  getActivePluginOrRespond: vi.fn(),
  fetchPluginComments: vi.fn(),
  resolveActivePluginQuiet: vi.fn(),
}));

vi.mock("../services/plugin-manager.js", () => ({
  invoke: vi.fn(),
}));

// Keep fetchIssueForStart real so the route's actual prefetch-and-bound path is
// exercised (it calls the mocked pluginManager.invoke / resolveEnforceIssueDependencies);
// only assertGateOpen is stubbed to drive the gate outcomes.
vi.mock("../services/start-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/start-gate.js")>();
  return {
    ...actual,
    assertGateOpen: vi.fn(),
  };
});

vi.mock("../services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(),
}));

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
  resolveEnforceIssueDependencies: vi.fn(),
}));

vi.mock("../services/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/state.js")>();
  return { ...actual, loadSettings: vi.fn() };
});

vi.mock("../services/notification.js", () => ({
  dismissBenchLevelForBench: vi.fn(),
  dismissOne: vi.fn(),
  getNotifications: vi.fn(),
}));

vi.mock("../services/git-state.js", () => ({
  getDirtyState: vi.fn(),
}));

import router from "./benches.js";
import * as benchManager from "../services/bench-manager.js";
import { BenchError } from "../services/bench-manager.js";
import * as toolService from "../services/tool-launcher.js";
import * as issueAssignment from "../services/issue-assignment.js";
import * as projectRegistry from "../services/project-registry.js";
import * as notificationService from "../services/notification.js";
import * as gitState from "../services/git-state.js";
import * as pluginManager from "../services/plugin-manager.js";
import {
  getActivePluginOrRespond,
  fetchPluginComments,
  resolveActivePluginQuiet,
} from "./plugin-route-helpers.js";
import { assertGateOpen } from "../services/start-gate.js";
import { resolveActivePlugin } from "../services/active-plugin.js";
import { ServiceError } from "../services/service-error.js";

const app = express();
app.use(express.json());
app.use("/", router);

describe("GET /:projectId/benches", () => {
  it("returns benches array", async () => {
    const benches = [{ id: 1, projectId: "my-project", branch: "main" }];
    vi.mocked(benchManager.getBenches).mockReturnValue(benches as any);

    const res = await request(app).get("/my-project/benches");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(benches);
    expect(benchManager.getBenches).toHaveBeenCalledWith("my-project");
  });

  it("filters benches by issue number when ?issue= is provided", async () => {
    const allBenches = [
      { id: 1, assignedIssue: { number: 42 } },
      { id: 2, assignedIssue: { number: 99 } },
    ];
    vi.mocked(benchManager.getBenches).mockReturnValue(allBenches as any);

    const res = await request(app).get("/my-project/benches?issue=42");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
  });

  it("excludes alert-backed benches whose alert number collides with the issue (#291)", async () => {
    const allBenches = [
      { id: 1, assignedIssue: { number: 42, externalId: "42" } },
      { id: 2, assignedIssue: { number: 42, externalId: "owner/repo#code-scanning-42" } },
    ];
    vi.mocked(benchManager.getBenches).mockReturnValue(allBenches as any);

    const res = await request(app).get("/my-project/benches?issue=42");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
  });
});

describe("POST /:projectId/benches", () => {
  it("returns 201 on success", async () => {
    const bench = { id: 1, projectId: "my-project", branch: "feature" };
    vi.mocked(benchManager.createBench).mockReturnValue(bench as any);

    const res = await request(app).post("/my-project/benches").send({ branch: "feature" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(bench);
  });

  it("returns 400 for invalid branch name", async () => {
    const res = await request(app).post("/my-project/benches").send({ branch: "..invalid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid branch/i);
  });

  it("returns 404 for PROJECT_NOT_FOUND error", async () => {
    vi.mocked(benchManager.createBench).mockImplementation(() => {
      throw new BenchError("Project not found", "PROJECT_NOT_FOUND");
    });

    const res = await request(app).post("/my-project/benches").send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROJECT_NOT_FOUND");
  });

  it("returns 409 for NO_BENCHES error", async () => {
    vi.mocked(benchManager.createBench).mockImplementation(() => {
      throw new BenchError("No benches available", "NO_BENCHES");
    });

    const res = await request(app).post("/my-project/benches").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_BENCHES");
  });

  it("returns 409 for GLOBAL_CAP_REACHED error", async () => {
    vi.mocked(benchManager.createBench).mockImplementation(() => {
      throw new BenchError(
        "Global bench limit reached: 3 of 3 benches in use.",
        "GLOBAL_CAP_REACHED",
      );
    });

    const res = await request(app).post("/my-project/benches").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GLOBAL_CAP_REACHED");
    expect(res.body.error).toMatch(/3 of 3/);
  });
});

describe("POST /:projectId/benches with variant=testbench", () => {
  const FOCUS = "/repos/my-project/.specifications/testbench/test-cases.json";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a testbench and returns 201", async () => {
    const bench = { id: 2, projectId: "my-project", variant: "testbench", focusedSpecPath: FOCUS };
    vi.mocked(benchManager.createBench).mockReturnValue(bench as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ variant: "testbench", focusedSpecPath: FOCUS });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(bench);
    expect(benchManager.createBench).toHaveBeenCalledWith("my-project", undefined, {
      variant: "testbench",
      focusedSpecPath: FOCUS,
    });
  });

  it("returns 400 when focusedSpecPath is missing", async () => {
    const res = await request(app).post("/my-project/benches").send({ variant: "testbench" });
    expect(res.status).toBe(400);
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });

  it("returns 400 when createBench rejects the path with INVALID_FOCUS", async () => {
    vi.mocked(benchManager.createBench).mockImplementation(() => {
      throw new BenchError("Invalid focusedSpecPath: escapes repo", "INVALID_FOCUS");
    });

    const res = await request(app)
      .post("/my-project/benches")
      .send({ variant: "testbench", focusedSpecPath: "/etc/passwd" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FOCUS");
  });
});

describe("POST /:projectId/benches with externalId (security alert)", () => {
  const alert = {
    integrationId: "github-com",
    externalId: "org/repo#code-scanning-117",
    issueType: "security-code-scanning",
    title: "Bad thing",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // A plugin IS active here, so the #437 no-plugin pre-check is skipped.
    vi.mocked(resolveActivePlugin).mockReturnValue({ pluginId: "github-com" } as any);
    vi.mocked(getActivePluginOrRespond).mockResolvedValue({
      pluginId: "github-com",
      pageSize: 50,
    } as any);
    // Alerts have no comments; the helper returns an empty array.
    vi.mocked(fetchPluginComments).mockResolvedValue([]);
  });

  it("returns 400 for an empty externalId", async () => {
    const res = await request(app).post("/my-project/benches").send({ externalId: "" });
    expect(res.status).toBe(400);
  });

  it("fetches the alert via the plugin and forwards it to createBenchAndAssignFromIssue", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(alert as any);
    const result = { status: "success", bench: { id: 7 }, terminalSessionId: "t" };
    vi.mocked(issueAssignment.createBenchAndAssignFromIssue).mockResolvedValue(result as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "org/repo#code-scanning-117", branchConflictResolution: "new" });

    expect(res.status).toBe(201);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "org/repo#code-scanning-117",
    });
    expect(issueAssignment.createBenchAndAssignFromIssue).toHaveBeenCalledWith(
      "my-project",
      alert,
      [],
      "new",
    );
  });

  it("returns 409 when the alert branch conflicts", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(alert as any);
    vi.mocked(issueAssignment.createBenchAndAssignFromIssue).mockResolvedValue({
      status: "conflict",
    } as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "org/repo#code-scanning-117" });
    expect(res.status).toBe(409);
  });

  it("surfaces a plugin RPC error (e.g. missing scope) instead of a generic 500", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue({
      code: "rpc-error",
      message: "GET .../code-scanning/alerts/117 returned status 403",
    });

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "org/repo#code-scanning-117" });
    expect(res.status).toBe(502);
    expect(issueAssignment.createBenchAndAssignFromIssue).not.toHaveBeenCalled();
  });
});

describe("POST /:projectId/benches with externalId (plugin issue, e.g. Jira)", () => {
  const issue = {
    integrationId: "jira-self-hosted",
    externalId: "PLNRPTGOOG-3782",
    issueType: "Story",
    title: "Add billing dashboard",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // A plugin IS active here, so the #437 no-plugin pre-check is skipped.
    vi.mocked(resolveActivePlugin).mockReturnValue({ pluginId: "jira-self-hosted" } as any);
    vi.mocked(getActivePluginOrRespond).mockResolvedValue({
      pluginId: "jira-self-hosted",
      pageSize: 50,
    } as any);
    vi.mocked(fetchPluginComments).mockResolvedValue([]);
  });

  it("fetches the issue + comments via the plugin and forwards them to createBenchAndAssignFromIssue", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue as any);
    vi.mocked(fetchPluginComments).mockResolvedValue([{ user: "Alice", body: "looks good" }]);
    const result = { status: "success", bench: { id: 8 }, terminalSessionId: "t" };
    vi.mocked(issueAssignment.createBenchAndAssignFromIssue).mockResolvedValue(result as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "PLNRPTGOOG-3782", branchConflictResolution: "new" });

    expect(res.status).toBe(201);
    expect(pluginManager.invoke).toHaveBeenCalledWith("jira-self-hosted", "getIssue", {
      externalId: "PLNRPTGOOG-3782",
    });
    expect(fetchPluginComments).toHaveBeenCalledWith("jira-self-hosted", "PLNRPTGOOG-3782");
    expect(issueAssignment.createBenchAndAssignFromIssue).toHaveBeenCalledWith(
      "my-project",
      issue,
      [{ user: "Alice", body: "looks good" }],
      "new",
    );
  });

  it("still assigns when the comment fetch yields nothing (best-effort, empty comments)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue as any);
    vi.mocked(fetchPluginComments).mockResolvedValue([]);
    vi.mocked(issueAssignment.createBenchAndAssignFromIssue).mockResolvedValue({
      status: "success",
      bench: { id: 8 },
      terminalSessionId: "t",
    } as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "PLNRPTGOOG-3782" });

    expect(res.status).toBe(201);
    expect(issueAssignment.createBenchAndAssignFromIssue).toHaveBeenCalledWith(
      "my-project",
      issue,
      [],
      undefined,
    );
  });

  it("returns 409 when the plugin-issue branch conflicts", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue as any);
    vi.mocked(fetchPluginComments).mockResolvedValue([]);
    vi.mocked(issueAssignment.createBenchAndAssignFromIssue).mockResolvedValue({
      status: "conflict",
    } as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "PLNRPTGOOG-3782" });
    expect(res.status).toBe(409);
  });
});

describe("POST /:projectId/benches with externalId (hard start-gate, #699)", () => {
  const issue = {
    integrationId: "github-com",
    externalId: "owner/repo#42",
    title: "Gated unit",
    blockedBy: ["owner/repo#10"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // A plugin IS active here, so the #437 no-plugin pre-check is skipped.
    vi.mocked(resolveActivePlugin).mockReturnValue({ pluginId: "github-com" } as any);
    vi.mocked(getActivePluginOrRespond).mockResolvedValue({
      pluginId: "github-com",
      pageSize: 50,
    } as any);
    vi.mocked(fetchPluginComments).mockResolvedValue([]);
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue as any);
  });

  it("ON + blocked: returns 409 GATE_BLOCKED naming the gate and creates no bench", async () => {
    vi.mocked(assertGateOpen).mockRejectedValue(
      new ServiceError(
        409,
        "Issue owner/repo#42 is blocked by an unresolved upstream gate: owner/repo#10",
        {
          code: "GATE_BLOCKED",
          blockedBy: ["owner/repo#10"],
        },
      ),
    );

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "owner/repo#42" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GATE_BLOCKED");
    expect(res.body.error).toContain("owner/repo#10");
    expect(assertGateOpen).toHaveBeenCalledWith("my-project", "owner/repo#42", "github-com", {
      prefetchedIssue: issue,
    });
    expect(issueAssignment.createBenchAndAssignFromIssue).not.toHaveBeenCalled();
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });

  it("ON + passed: gate resolves and the bench is created (201)", async () => {
    vi.mocked(assertGateOpen).mockResolvedValue(undefined);
    vi.mocked(issueAssignment.createBenchAndAssignFromIssue).mockResolvedValue({
      status: "success",
      bench: { id: 9 },
      terminalSessionId: "t",
    } as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "owner/repo#42" });

    expect(res.status).toBe(201);
    expect(assertGateOpen).toHaveBeenCalledOnce();
    expect(issueAssignment.createBenchAndAssignFromIssue).toHaveBeenCalled();
  });

  it("OFF: gate is a no-op (resolves) and the bench is created (201)", async () => {
    // With enforcement OFF the gate resolves without consulting blockedBy.
    vi.mocked(assertGateOpen).mockResolvedValue(undefined);
    vi.mocked(issueAssignment.createBenchAndAssignFromIssue).mockResolvedValue({
      status: "success",
      bench: { id: 9 },
      terminalSessionId: "t",
    } as any);

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "owner/repo#42" });

    expect(res.status).toBe(201);
    expect(issueAssignment.createBenchAndAssignFromIssue).toHaveBeenCalled();
  });

  it("ON + indeterminate: fails closed with 409 GATE_INDETERMINATE and creates no bench", async () => {
    vi.mocked(assertGateOpen).mockRejectedValue(
      new ServiceError(
        409,
        "Cannot determine the gate state for issue owner/repo#42 (blocking-read failed); refusing to start (fail-closed)",
        {
          code: "GATE_INDETERMINATE",
        },
      ),
    );

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "owner/repo#42" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GATE_INDETERMINATE");
    expect(issueAssignment.createBenchAndAssignFromIssue).not.toHaveBeenCalled();
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });

  it("ON + prefetch fails: the bounded read fails closed with 409 GATE_INDETERMINATE before the gate runs (#438)", async () => {
    // Enforcement ON: fetchIssueForStart bounds the getIssue prefetch and, on a
    // hung or failing read, throws GATE_INDETERMINATE. That must surface as a
    // clean 409, not be remapped as a 502/504 plugin RPC error, and the gate
    // proper is never reached.
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("plugin hung"));

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "owner/repo#42" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GATE_INDETERMINATE");
    expect(assertGateOpen).not.toHaveBeenCalled();
    expect(issueAssignment.createBenchAndAssignFromIssue).not.toHaveBeenCalled();
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });
});

describe("POST /:projectId/benches with externalId (no active plugin, #437)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No active integration plugin, so the create-and-assign flow runs the gate
    // before getActivePluginOrRespond (#437 / NFR-003 / TC-033).
    vi.mocked(resolveActivePlugin).mockReturnValue(null);
    vi.mocked(fetchPluginComments).mockResolvedValue([]);
  });

  it("ON + no plugin: runs the gate first and fails closed with 409 GATE_INDETERMINATE (no bench)", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(assertGateOpen).mockRejectedValue(
      new ServiceError(
        409,
        "Cannot determine the gate state for issue owner/repo#42 (no active integration plugin); refusing to start (fail-closed)",
        { code: "GATE_INDETERMINATE" },
      ),
    );

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "owner/repo#42" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GATE_INDETERMINATE");
    // The gate runs with no pluginId before the 503 path is ever reached.
    expect(assertGateOpen).toHaveBeenCalledWith("my-project", "owner/repo#42", undefined);
    expect(getActivePluginOrRespond).not.toHaveBeenCalled();
    expect(issueAssignment.createBenchAndAssignFromIssue).not.toHaveBeenCalled();
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });

  it("OFF + no plugin: gate is a no-op and the existing 503 no-active-integration is preserved", async () => {
    // With enforcement OFF the gate resolves without throwing, so the flow falls
    // through to getActivePluginOrRespond which sends the unchanged 503.
    vi.mocked(assertGateOpen).mockResolvedValue(undefined);
    vi.mocked(getActivePluginOrRespond).mockImplementation(async (_projectId, res) => {
      res.status(503).json({
        error: "no-active-integration",
        message: "No integration plugin is configured for this project.",
      });
      return null;
    });

    const res = await request(app)
      .post("/my-project/benches")
      .send({ externalId: "owner/repo#42" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-active-integration");
    expect(issueAssignment.createBenchAndAssignFromIssue).not.toHaveBeenCalled();
    expect(benchManager.createBench).not.toHaveBeenCalled();
  });
});

describe("invalid bench id", () => {
  it("returns 400 for non-numeric bench id on GET", async () => {
    const res = await request(app).get("/my-project/benches/abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 400 for non-numeric bench id on DELETE", async () => {
    const res = await request(app).delete("/my-project/benches/abc");
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric bench id on POST start", async () => {
    const res = await request(app).post("/my-project/benches/abc/start");
    expect(res.status).toBe(400);
  });
});

describe("GET /:projectId/benches/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when bench found", async () => {
    const bench = { id: 1, projectId: "my-project", branch: "main" };
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(false);

    const res = await request(app).get("/my-project/benches/1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
    expect(benchManager.getBench).toHaveBeenCalledWith("my-project", 1);
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).get("/my-project/benches/99");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Bench not found");
  });

  it("enriches assignedIssue with blockedBy (externalId list) from the active plugin when enforcement is enabled", async () => {
    const bench = {
      id: 1,
      projectId: "my-project",
      branch: "main",
      assignedIssue: { number: 42, externalId: "owner/repo#42", title: "Fix bug" },
    };
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(resolveActivePluginQuiet).mockResolvedValue({ pluginId: "github-com" } as any);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ blockedBy: ["owner/repo#5"] } as any);

    const res = await request(app).get("/my-project/benches/1");
    expect(res.status).toBe(200);
    expect(res.body.assignedIssue.blockedBy).toEqual(["owner/repo#5"]);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "owner/repo#42",
    });
  });

  it("returns bench without blockedBy when the plugin reports no blockers", async () => {
    const bench = {
      id: 1,
      projectId: "my-project",
      branch: "main",
      assignedIssue: { number: 42, externalId: "owner/repo#42", title: "Fix bug" },
    };
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(resolveActivePluginQuiet).mockResolvedValue({ pluginId: "github-com" } as any);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ blockedBy: [] } as any);

    const res = await request(app).get("/my-project/benches/1");
    expect(res.status).toBe(200);
    expect(res.body.assignedIssue.blockedBy).toBeUndefined();
  });

  it("returns bench without blockedBy when enforcement is disabled", async () => {
    const bench = {
      id: 1,
      projectId: "my-project",
      branch: "main",
      assignedIssue: { number: 42, externalId: "owner/repo#42", title: "Fix bug" },
    };
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(false);

    const res = await request(app).get("/my-project/benches/1");
    expect(res.status).toBe(200);
    expect(res.body.assignedIssue.blockedBy).toBeUndefined();
    expect(resolveActivePluginQuiet).not.toHaveBeenCalled();
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns bench without blockedBy when no assigned issue", async () => {
    const bench = { id: 1, projectId: "my-project", branch: "main" };
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);

    const res = await request(app).get("/my-project/benches/1");
    expect(res.status).toBe(200);
    expect(res.body.assignedIssue).toBeUndefined();
    expect(resolveActivePluginQuiet).not.toHaveBeenCalled();
  });

  it("returns bench without blockedBy when the plugin getIssue fails (silent best-effort)", async () => {
    const bench = {
      id: 1,
      projectId: "my-project",
      branch: "main",
      assignedIssue: { number: 42, externalId: "owner/repo#42", title: "Fix bug" },
    };
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(resolveActivePluginQuiet).mockResolvedValue({ pluginId: "github-com" } as any);
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("plugin unavailable"));

    const res = await request(app).get("/my-project/benches/1");
    expect(res.status).toBe(200);
    expect(res.body.assignedIssue.blockedBy).toBeUndefined();
  });

  it("returns bench without blockedBy when there is no active plugin", async () => {
    const bench = {
      id: 1,
      projectId: "my-project",
      branch: "main",
      assignedIssue: { number: 42, externalId: "owner/repo#42", title: "Fix bug" },
    };
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(resolveActivePluginQuiet).mockResolvedValue(null);

    const res = await request(app).get("/my-project/benches/1");
    expect(res.status).toBe(200);
    expect(res.body.assignedIssue.blockedBy).toBeUndefined();
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });
});

describe("DELETE /:projectId/benches/:id", () => {
  const mockBench = {
    id: 1,
    projectId: "my-project",
    status: "stopping",
    teardownSteps: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitState.getDirtyState).mockResolvedValue({
      clean: true,
      reasons: [],
    });
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as any);
    vi.mocked(benchManager.teardownBench).mockReturnValue(mockBench as any);
  });

  it("returns 202 with bench body on success (removeWorkspace=false)", async () => {
    const res = await request(app).delete("/my-project/benches/1");
    expect(res.status).toBe(202);
    expect(res.body).toEqual(mockBench);
    expect(benchManager.teardownBench).toHaveBeenCalledWith("my-project", 1, false);
    expect(gitState.getDirtyState).not.toHaveBeenCalled();
  });

  it("passes removeWorkspace=false when query param is false", async () => {
    const res = await request(app).delete("/my-project/benches/1?removeWorkspace=false");
    expect(res.status).toBe(202);
    expect(benchManager.teardownBench).toHaveBeenCalledWith("my-project", 1, false);
    expect(gitState.getDirtyState).not.toHaveBeenCalled();
  });

  it("passes removeWorkspace=true and proceeds when bench is clean", async () => {
    const res = await request(app).delete("/my-project/benches/1?removeWorkspace=true");
    expect(res.status).toBe(202);
    expect(benchManager.teardownBench).toHaveBeenCalledWith("my-project", 1, true);
    expect(gitState.getDirtyState).toHaveBeenCalledWith(mockBench);
  });

  it("returns 409 with bench-dirty code when bench is dirty and force is not set", async () => {
    const reasons = [{ kind: "dirty-worktree", location: "workspace", detail: "1 modified" }];
    vi.mocked(gitState.getDirtyState).mockResolvedValue({
      clean: false,
      reasons: reasons as any,
    });

    const res = await request(app).delete("/my-project/benches/1?removeWorkspace=true");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("bench-dirty");
    expect(res.body.reasons).toEqual(reasons);
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("proceeds with teardown when bench is dirty and force=true", async () => {
    const reasons = [{ kind: "dirty-worktree", location: "workspace", detail: "1 modified" }];
    vi.mocked(gitState.getDirtyState).mockResolvedValue({
      clean: false,
      reasons: reasons as any,
    });

    const res = await request(app).delete("/my-project/benches/1?removeWorkspace=true&force=true");
    expect(res.status).toBe(202);
    expect(benchManager.teardownBench).toHaveBeenCalledWith("my-project", 1, true);
  });

  it("skips dirty check and allows teardown when removeWorkspace=false even if dirty", async () => {
    vi.mocked(gitState.getDirtyState).mockResolvedValue({
      clean: false,
      reasons: [{ kind: "dirty-worktree", location: "workspace", detail: "2 modified" }] as any,
    });

    const res = await request(app).delete("/my-project/benches/1?removeWorkspace=false");
    expect(res.status).toBe(202);
    expect(gitState.getDirtyState).not.toHaveBeenCalled();
    expect(benchManager.teardownBench).toHaveBeenCalledWith("my-project", 1, false);
  });

  it("returns 404 when bench not found with removeWorkspace=true", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).delete("/my-project/benches/1?removeWorkspace=true");
    expect(res.status).toBe(404);
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("returns 500 when getDirtyState throws unexpectedly", async () => {
    vi.mocked(gitState.getDirtyState).mockRejectedValue(new Error("git binary not found"));

    const res = await request(app).delete("/my-project/benches/1?removeWorkspace=true");
    expect(res.status).toBe(500);
    expect(benchManager.teardownBench).not.toHaveBeenCalled();
  });

  it("returns 404 for NOT_FOUND error (removeWorkspace=false path)", async () => {
    vi.mocked(benchManager.teardownBench).mockImplementation(() => {
      throw new BenchError("Bench not found", "NOT_FOUND");
    });

    const res = await request(app).delete("/my-project/benches/1");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("POST /:projectId/benches/:id/start", () => {
  it("returns 200 on success", async () => {
    const bench = { id: 1, projectId: "my-project", status: "provisioning" };
    vi.mocked(benchManager.startAllComponents).mockReturnValue(bench as any);

    const res = await request(app).post("/my-project/benches/1/start");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
  });

  it("returns 400 when BenchError is thrown", async () => {
    vi.mocked(benchManager.startAllComponents).mockImplementation(() => {
      throw new BenchError("Bench not running", "INVALID_STATE");
    });

    const res = await request(app).post("/my-project/benches/1/start");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATE");
    expect(res.body.error).toBe("Bench not running");
  });

  it("returns 500 when generic Error is thrown", async () => {
    vi.mocked(benchManager.startAllComponents).mockImplementation(() => {
      throw new Error("unexpected failure");
    });

    const res = await request(app).post("/my-project/benches/1/start");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("unexpected failure");
  });
});

describe("POST /:projectId/benches/:id/stop", () => {
  it("returns 200 on success", async () => {
    const bench = { id: 1, projectId: "my-project", status: "stopped" };
    vi.mocked(benchManager.stopAllComponents).mockResolvedValue(undefined);
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);

    const res = await request(app).post("/my-project/benches/1/stop");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
  });

  it("returns 400 when BenchError is thrown", async () => {
    vi.mocked(benchManager.stopAllComponents).mockRejectedValue(
      new BenchError("Invalid bench state", "INVALID_STATE"),
    );

    const res = await request(app).post("/my-project/benches/1/stop");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATE");
  });

  it("returns 500 when generic Error is thrown", async () => {
    vi.mocked(benchManager.stopAllComponents).mockRejectedValue(new Error("stop failed"));

    const res = await request(app).post("/my-project/benches/1/stop");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("stop failed");
  });
});

describe("POST /:projectId/benches/:id/components/:name/start", () => {
  it("returns 200 on success", async () => {
    const bench = { id: 1, projectId: "my-project", status: "running" };
    vi.mocked(benchManager.startComponent).mockResolvedValue(undefined);
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);

    const res = await request(app).post("/my-project/benches/1/components/backend/start");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
    expect(benchManager.startComponent).toHaveBeenCalledWith("my-project", 1, "backend");
  });

  it("returns 400 when BenchError is thrown", async () => {
    vi.mocked(benchManager.startComponent).mockRejectedValue(
      new BenchError("Component not found", "COMPONENT_NOT_FOUND"),
    );

    const res = await request(app).post("/my-project/benches/1/components/backend/start");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPONENT_NOT_FOUND");
    expect(res.body.error).toBe("Component not found");
  });

  it("returns 500 when generic Error is thrown", async () => {
    vi.mocked(benchManager.startComponent).mockRejectedValue(new Error("start component failed"));

    const res = await request(app).post("/my-project/benches/1/components/backend/start");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("start component failed");
  });

  // Issue #566 (CPHMTP-FR-008): the missing-plugin resolution rides along with the
  // COMPONENT_NOT_BOUND body so the client can offer install-from-<source> without
  // re-resolving the sources itself.
  it("serialises the missing-plugin resolution payload", async () => {
    const resolution = {
      pluginId: "google-clasp",
      state: "single-source" as const,
      source: { sourceId: "acme-1a2b", label: "marketplace.acme.example", registered: true },
    };
    vi.mocked(benchManager.startComponent).mockRejectedValue(
      new BenchError("not installed; available from ACME", "COMPONENT_NOT_BOUND", resolution),
    );

    const res = await request(app).post("/my-project/benches/1/components/backend/start");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPONENT_NOT_BOUND");
    expect(res.body.resolution).toEqual(resolution);
  });

  // An absent resolution must keep meaning "no install affordance": the key is
  // omitted rather than sent as null, so the client's guard cannot mistake an
  // unenrichable error for an actionable one.
  it("omits the resolution key entirely for an error that carries none", async () => {
    vi.mocked(benchManager.startComponent).mockRejectedValue(
      new BenchError("Component not found", "COMPONENT_NOT_FOUND"),
    );

    const res = await request(app).post("/my-project/benches/1/components/backend/start");
    expect(res.body).not.toHaveProperty("resolution");
  });

  // Issue #617 (AC3): a bound-but-unconsented plugin rides its `consent.pluginId`
  // along with the COMPONENT_NOT_BOUND body so the bench page can open an actionable
  // consent prompt (this route is exactly where the resumed start's consent-gate 400
  // lands). Absent for every other error, so the key is omitted, never null.
  it("serialises the consent payload for a bound-but-unconsented plugin", async () => {
    vi.mocked(benchManager.startComponent).mockRejectedValue(
      new BenchError("has not been consented", "COMPONENT_NOT_BOUND", undefined, {
        pluginId: "google-clasp",
      }),
    );

    const res = await request(app).post("/my-project/benches/1/components/backend/start");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPONENT_NOT_BOUND");
    expect(res.body.consent).toEqual({ pluginId: "google-clasp" });
    expect(res.body).not.toHaveProperty("resolution");
  });
});

describe("POST /:projectId/benches/:id/components/:name/stop", () => {
  it("returns 200 on success", async () => {
    const bench = { id: 1, projectId: "my-project", status: "stopped" };
    vi.mocked(benchManager.stopComponent).mockResolvedValue(undefined);
    vi.mocked(benchManager.getBench).mockReturnValue(bench as any);

    const res = await request(app).post("/my-project/benches/1/components/backend/stop");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
    expect(benchManager.stopComponent).toHaveBeenCalledWith("my-project", 1, "backend");
  });

  it("returns 400 when BenchError is thrown", async () => {
    vi.mocked(benchManager.stopComponent).mockRejectedValue(
      new BenchError("Component not found", "COMPONENT_NOT_FOUND"),
    );

    const res = await request(app).post("/my-project/benches/1/components/backend/stop");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPONENT_NOT_FOUND");
  });

  it("returns 500 when generic Error is thrown", async () => {
    vi.mocked(benchManager.stopComponent).mockRejectedValue(new Error("stop component failed"));

    const res = await request(app).post("/my-project/benches/1/components/backend/stop");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("stop component failed");
  });
});

describe("GET /:projectId/benches/:id/components/:name/logs", () => {
  it("returns structured logs with default tail of 200", async () => {
    const logs = Array.from({ length: 200 }, (_, i) => ({
      source: "stdout" as const,
      text: `line ${i + 51}`,
      ts: new Date(i).toISOString(),
    }));
    vi.mocked(benchManager.getComponentLogs).mockReturnValue(logs);

    const res = await request(app).get("/my-project/benches/1/components/backend/logs");
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(200);
    // Each element is a { source, text, ts } object (FR-014 parity shape).
    expect(res.body.logs[0]).toEqual({
      source: "stdout",
      text: "line 51",
      ts: new Date(0).toISOString(),
    });
    expect(benchManager.getComponentLogs).toHaveBeenCalledWith("my-project", 1, "backend", 200);
  });

  it("returns logs with custom tail query param", async () => {
    const logs = [
      { source: "stdout" as const, text: "line 4", ts: "2026-06-21T00:00:00.000Z" },
      { source: "stderr" as const, text: "line 5", ts: "2026-06-21T00:00:01.000Z" },
    ];
    vi.mocked(benchManager.getComponentLogs).mockReturnValue(logs);

    const res = await request(app).get("/my-project/benches/1/components/backend/logs?tail=2");
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual(logs);
    expect(benchManager.getComponentLogs).toHaveBeenCalledWith("my-project", 1, "backend", 2);
  });
});

describe("GET /:projectId/benches/:id/audit-log", () => {
  const entries = [
    {
      ts: "2026-06-21T00:00:00.000Z",
      pluginId: "github-com",
      benchId: 1,
      method: "host.process.start",
      params: {},
      outcome: "allowed" as const,
    },
    {
      ts: "2026-06-21T00:00:01.000Z",
      pluginId: "github-com",
      benchId: 1,
      method: "host.docker.up",
      params: {},
      outcome: "denied" as const,
    },
  ];

  it("returns recorded entries in chronological order", async () => {
    vi.mocked(benchManager.queryAuditLog).mockReturnValue(entries);

    const res = await request(app).get("/my-project/benches/1/audit-log");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(entries);
    expect(benchManager.queryAuditLog).toHaveBeenCalledWith("my-project", 1, undefined);
  });

  it("passes the pluginId filter through to the query", async () => {
    vi.mocked(benchManager.queryAuditLog).mockReturnValue([entries[0]]);

    const res = await request(app).get("/my-project/benches/1/audit-log?pluginId=github-com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([entries[0]]);
    expect(benchManager.queryAuditLog).toHaveBeenCalledWith("my-project", 1, "github-com");
  });

  it("returns an empty array when no calls have been recorded", async () => {
    vi.mocked(benchManager.queryAuditLog).mockReturnValue([]);

    const res = await request(app).get("/my-project/benches/1/audit-log");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── Tool route tests ──

describe("GET /:projectId/benches/:id/tools", () => {
  it("returns resolved tools", async () => {
    const tools = [
      {
        name: "Web Tool",
        icon: "globe",
        type: "browser",
        url: "https://localhost:5174",
        enabled: true,
      },
    ];
    vi.mocked(toolService.getResolvedTools).mockReturnValue(tools as any);

    const res = await request(app).get("/project/benches/1/tools");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(tools);
    expect(toolService.getResolvedTools).toHaveBeenCalledWith("project", 1);
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(toolService.getResolvedTools).mockImplementation(() => {
      throw new BenchError("Bench not found", "NOT_FOUND");
    });

    const res = await request(app).get("/project/benches/99/tools");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("POST /:projectId/benches/:id/tools/:index/execute", () => {
  it("returns success on tool execution", async () => {
    vi.mocked(toolService.executeTool).mockResolvedValue({ success: true });

    const res = await request(app).post("/project/benches/1/tools/0/execute");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(toolService.executeTool).toHaveBeenCalledWith("project", 1, 0, undefined);
  });

  it("returns 400 when tool execution fails", async () => {
    vi.mocked(toolService.executeTool).mockResolvedValue({
      success: false,
      error: "Disabled",
    });

    const res = await request(app).post("/project/benches/1/tools/0/execute");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Disabled");
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(toolService.executeTool).mockRejectedValue(
      new BenchError("Bench not found", "NOT_FOUND"),
    );

    const res = await request(app).post("/project/benches/99/tools/0/execute");
    expect(res.status).toBe(404);
  });
});

// ── Container assignment route tests ──

describe("POST /:projectId/benches/:id/assign-container", () => {
  it("assigns container and returns bench", async () => {
    const bench = { id: 1, projectId: "project", status: "idle" };
    vi.mocked(benchManager.assignContainer).mockResolvedValue(bench as any);

    const res = await request(app)
      .post("/project/benches/1/assign-container")
      .send({ containerId: "abc123", component: "database" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
    expect(benchManager.assignContainer).toHaveBeenCalledWith("project", 1, "database", "abc123");
  });

  it("returns 400 when containerId or component is missing", async () => {
    const res = await request(app)
      .post("/project/benches/1/assign-container")
      .send({ containerId: "abc123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("containerId and component are required");
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.assignContainer).mockRejectedValue(
      new BenchError("Bench not found", "NOT_FOUND"),
    );

    const res = await request(app)
      .post("/project/benches/99/assign-container")
      .send({ containerId: "abc123", component: "database" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:projectId/benches/:id/assign-container/:component", () => {
  it("unassigns container and returns bench", async () => {
    const bench = { id: 1, projectId: "project", status: "idle" };
    vi.mocked(benchManager.unassignContainer).mockResolvedValue(bench as any);

    const res = await request(app).delete("/project/benches/1/assign-container/database");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
    expect(benchManager.unassignContainer).toHaveBeenCalledWith("project", 1, "database");
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.unassignContainer).mockRejectedValue(
      new BenchError("Bench not found", "NOT_FOUND"),
    );

    const res = await request(app).delete("/project/benches/99/assign-container/database");
    expect(res.status).toBe(404);
  });
});

describe("POST /:projectId/benches/:id/cleanup-and-retry", () => {
  it("returns 200 on success", async () => {
    const bench = { id: 1, projectId: "project", status: "provisioning" };
    vi.mocked(benchManager.cleanupAndRetryBench).mockResolvedValue(bench as any);

    const res = await request(app).post("/project/benches/1/cleanup-and-retry");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bench);
    expect(benchManager.cleanupAndRetryBench).toHaveBeenCalledWith("project", 1);
  });

  it("returns 404 for NOT_FOUND BenchError", async () => {
    vi.mocked(benchManager.cleanupAndRetryBench).mockRejectedValue(
      new BenchError("Bench not found", "NOT_FOUND"),
    );

    const res = await request(app).post("/project/benches/99/cleanup-and-retry");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 409 for INVALID_STATE BenchError", async () => {
    vi.mocked(benchManager.cleanupAndRetryBench).mockRejectedValue(
      new BenchError("Bench is not in an error state", "INVALID_STATE"),
    );

    const res = await request(app).post("/project/benches/1/cleanup-and-retry");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATE");
  });

  it("returns 500 on generic error", async () => {
    vi.mocked(benchManager.cleanupAndRetryBench).mockRejectedValue(new Error("unexpected failure"));

    const res = await request(app).post("/project/benches/1/cleanup-and-retry");
    expect(res.status).toBe(500);
  });

  it("returns 400 for non-numeric bench id", async () => {
    const res = await request(app).post("/project/benches/abc/cleanup-and-retry");
    expect(res.status).toBe(400);
  });
});

// ── Notification route tests ──

describe("DELETE /:projectId/benches/:id/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dismisses bench-level notifications and returns updated array", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ id: 1 } as any);
    vi.mocked(notificationService.getNotifications).mockReturnValue([]);

    const res = await request(app).delete("/my-project/benches/1/notifications");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(notificationService.dismissBenchLevelForBench).toHaveBeenCalledWith({
      id: 1,
    });
    expect(notificationService.getNotifications).toHaveBeenCalledWith({
      id: 1,
    });
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).delete("/my-project/benches/99/notifications");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Bench not found");
    expect(notificationService.dismissBenchLevelForBench).not.toHaveBeenCalled();
  });

  it("returns 400 for non-numeric bench id", async () => {
    const res = await request(app).delete("/my-project/benches/abc/notifications");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /:projectId/benches/:id/notifications/:notificationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dismisses a single notification and returns updated array", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ id: 1 } as any);
    vi.mocked(notificationService.getNotifications).mockReturnValue([]);

    const res = await request(app).delete("/my-project/benches/1/notifications/notif-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(notificationService.dismissOne).toHaveBeenCalledWith({ id: 1 }, "notif-1");
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).delete("/my-project/benches/99/notifications/notif-1");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Bench not found");
    expect(notificationService.dismissOne).not.toHaveBeenCalled();
  });

  it("is idempotent when notification does not exist", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ id: 1 } as any);
    vi.mocked(notificationService.getNotifications).mockReturnValue([]);

    const res = await request(app).delete("/my-project/benches/1/notifications/notif-missing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(notificationService.dismissOne).toHaveBeenCalledWith({ id: 1 }, "notif-missing");
  });

  it("returns 400 for non-numeric bench id", async () => {
    const res = await request(app).delete("/my-project/benches/abc/notifications/notif-1");
    expect(res.status).toBe(400);
  });
});
