import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
  reloadConfig: vi.fn(),
}));

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
}));

vi.mock("../services/blueprint-manager.js", () => ({
  listBlueprintsForProject: vi.fn(),
  getBlueprint: vi.fn(),
  resolveBlueprintContent: vi.fn(),
  resolveEffectiveDefaultBlueprint: vi.fn(),
  createProjectBlueprint: vi.fn(),
  updateProjectBlueprint: vi.fn(),
  deleteProjectBlueprint: vi.fn(),
  BlueprintError: class BlueprintError extends Error {
    constructor(
      message: string,
      public code: string,
      public data?: unknown,
    ) {
      super(message);
      this.name = "BlueprintError";
    }
  },
}));

vi.mock("../services/terminal.js", () => ({
  getSessions: vi.fn(),
  writeToSession: vi.fn(),
}));

vi.mock("../services/config-parser.js", () => ({
  buildTemplateContext: vi
    .fn()
    .mockReturnValue({ ports: {}, portHttps: {}, workspace: "/workspace", components: {} }),
  applyContainerOverrides: vi.fn(),
}));

vi.mock("../services/state.js", () => ({
  loadSettings: vi.fn().mockReturnValue({
    theme: "dark",
    blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "feature-dev" },
  }),
  atomicWrite: vi.fn(),
}));

vi.mock("../services/issue-formatting.js", () => ({
  fetchIssueContext: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    default: {
      ...actual.default,
      readFileSync: vi.fn().mockReturnValue(""),
      mkdirSync: vi.fn(),
    },
  };
});

vi.mock("yaml", () => ({
  parse: vi.fn().mockReturnValue({}),
  stringify: vi.fn().mockReturnValue('project:\n  name: "test"\n'),
}));

import router from "./blueprints.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as blueprintManager from "../services/blueprint-manager.js";
import * as terminalService from "../services/terminal.js";
import * as state from "../services/state.js";
import * as issueFormatting from "../services/issue-formatting.js";
import fs from "node:fs";
import * as YAML from "yaml";

const app = express();
app.use(express.json());
app.use("/", router);

const MOCK_PROJECT = {
  id: "project-1",
  name: "My Project",
  repoPath: "/repo/path",
  config: {
    project: { name: "project", displayName: "My Project" },
    components: {},
  },
};

const MOCK_BENCH = {
  id: 1,
  projectId: "project-1",
  status: "live",
  branch: "feature/test",
  workspacePath: "/workspaces/project/bench-1",
  assignedContainers: {},
};

const MOCK_BENCH_WITH_ISSUE = {
  ...MOCK_BENCH,
  assignedIssue: { number: 42, title: "Fix the widget" },
};

const MOCK_PROJECT_WITH_REPO = {
  ...MOCK_PROJECT,
  config: {
    ...MOCK_PROJECT.config,
    project: { ...MOCK_PROJECT.config.project, repo: "owner/repo" },
  },
};

const MOCK_BLUEPRINT_META = {
  id: "feature-dev",
  name: "Feature Development",
  description: "Action a GitHub issue end-to-end",
  icon: "code",
  source: "app",
};

const MOCK_BLUEPRINT_DETAIL = {
  ...MOCK_BLUEPRINT_META,
  content: "You are working on {{bench.branch}}",
  sizeBytes: 100,
  sizeWarning: false,
};

describe("GET /:projectId/blueprints", () => {
  it("returns list of blueprints for a valid project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(blueprintManager.listBlueprintsForProject).mockReturnValue([
      MOCK_BLUEPRINT_META as unknown as ReturnType<
        typeof blueprintManager.listBlueprintsForProject
      >[0],
    ]);

    const res = await request(app).get("/project-1/blueprints");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([MOCK_BLUEPRINT_META]);
    expect(blueprintManager.listBlueprintsForProject).toHaveBeenCalledWith("project-1");
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/unknown-project/blueprints");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  it("returns empty array when project has no blueprints", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(blueprintManager.listBlueprintsForProject).mockReturnValue([]);

    const res = await request(app).get("/project-1/blueprints");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /:projectId/blueprints/:blueprintId", () => {
  it("returns blueprint detail for a valid blueprint", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(blueprintManager.getBlueprint).mockReturnValue(
      MOCK_BLUEPRINT_DETAIL as unknown as ReturnType<typeof blueprintManager.getBlueprint>,
    );

    const res = await request(app).get("/project-1/blueprints/feature-dev");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_BLUEPRINT_DETAIL);
    expect(blueprintManager.getBlueprint).toHaveBeenCalledWith("project-1", "feature-dev");
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/unknown-project/blueprints/feature-dev");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  it("returns 404 when blueprint not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(blueprintManager.getBlueprint).mockReturnValue(null);

    const res = await request(app).get("/project-1/blueprints/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/blueprint not found/i);
  });

  it("returns 400 for blueprintId with path traversal characters", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );

    const res = await request(app).get("/project-1/blueprints/..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid blueprint id/i);
  });

  it("returns 400 for blueprintId with uppercase characters", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );

    const res = await request(app).get("/project-1/blueprints/Feature-Dev");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid blueprint id/i);
  });
});

describe("POST /:projectId/benches/:benchId/inject-blueprint", () => {
  const MOCK_SESSION = {
    id: "session-abc",
    command: "claude",
    status: "live",
    label: "Claude 1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(blueprintManager.getBlueprint).mockReturnValue(
      MOCK_BLUEPRINT_DETAIL as unknown as ReturnType<typeof blueprintManager.getBlueprint>,
    );
    vi.mocked(blueprintManager.resolveBlueprintContent).mockReturnValue(
      "Resolved blueprint content",
    );
    vi.mocked(terminalService.getSessions).mockReturnValue([
      MOCK_SESSION as unknown as ReturnType<typeof terminalService.getSessions>[0],
    ]);
    vi.mocked(terminalService.writeToSession).mockReturnValue(true);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "feature-dev" },
    });
  });

  it("injects blueprint into active Claude session", async () => {
    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      resolvedLength: "Resolved blueprint content".length,
    });
    expect(terminalService.writeToSession).toHaveBeenCalledWith(
      "session-abc",
      "Resolved blueprint content\r",
    );
  });

  it("appends \\r when autoExecute is true", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "feature-dev" },
    });

    await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    const call = vi.mocked(terminalService.writeToSession).mock.calls[0];
    expect(call[1]).toMatch(/\r$/);
  });

  it("does not append \\r when autoExecute is false", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: false, defaultBlueprintId: "feature-dev" },
    });

    await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    const call = vi.mocked(terminalService.writeToSession).mock.calls[0];
    expect(call[1]).not.toMatch(/\r$/);
  });

  it("returns 400 when blueprintId is missing", async () => {
    const res = await request(app).post("/project-1/benches/1/inject-blueprint").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blueprintId/i);
  });

  it("returns 400 for blueprintId with path traversal in body", async () => {
    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "../etc/passwd" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid blueprint id/i);
  });

  it("returns 400 for blueprintId with uppercase in body", async () => {
    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "Feature-Dev" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid blueprint id/i);
  });

  it("returns 400 for invalid bench id", async () => {
    const res = await request(app)
      .post("/project-1/benches/notanumber/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/bench not found/i);
  });

  it("returns 404 when blueprint not found", async () => {
    vi.mocked(blueprintManager.getBlueprint).mockReturnValue(null);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "nonexistent" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/blueprint not found/i);
  });

  it("returns 404 when no active Claude session", async () => {
    vi.mocked(terminalService.getSessions).mockReturnValue([
      {
        id: "session-1",
        command: "bash",
        status: "live",
        label: "Terminal 1",
      } as unknown as ReturnType<typeof terminalService.getSessions>[0],
    ]);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active claude session/i);
  });

  it("returns 404 when Claude session is not live", async () => {
    vi.mocked(terminalService.getSessions).mockReturnValue([
      {
        id: "session-1",
        command: "claude",
        status: "ended",
        label: "Claude 1",
      } as unknown as ReturnType<typeof terminalService.getSessions>[0],
    ]);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active claude session/i);
  });

  it("returns 500 when writeToSession fails", async () => {
    vi.mocked(terminalService.writeToSession).mockReturnValue(false);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to write/i);
  });

  it("injects into specified sessionId when provided", async () => {
    const session2 = { id: "session-new", command: "claude", status: "live", label: "Claude 2" };
    vi.mocked(terminalService.getSessions).mockReturnValue([
      MOCK_SESSION as unknown as ReturnType<typeof terminalService.getSessions>[0],
      session2 as unknown as ReturnType<typeof terminalService.getSessions>[0],
    ]);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev", sessionId: "session-new" });

    expect(res.status).toBe(200);
    expect(terminalService.writeToSession).toHaveBeenCalledWith("session-new", expect.any(String));
  });

  it("returns 404 when specified sessionId does not match any live Claude session", async () => {
    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev", sessionId: "session-nonexistent" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active claude session/i);
  });

  it("falls back to first live Claude session when sessionId is omitted", async () => {
    const session2 = { id: "session-new", command: "claude", status: "live", label: "Claude 2" };
    vi.mocked(terminalService.getSessions).mockReturnValue([
      MOCK_SESSION as unknown as ReturnType<typeof terminalService.getSessions>[0],
      session2 as unknown as ReturnType<typeof terminalService.getSessions>[0],
    ]);

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });

    expect(res.status).toBe(200);
    expect(terminalService.writeToSession).toHaveBeenCalledWith("session-abc", expect.any(String));
  });

  it("passes resolved context to resolveBlueprintContent", async () => {
    await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });

    expect(blueprintManager.resolveBlueprintContent).toHaveBeenCalledWith(
      MOCK_BLUEPRINT_DETAIL.content,
      expect.objectContaining({
        benchBranch: MOCK_BENCH.branch,
        benchId: 1,
        projectName: MOCK_PROJECT.config.project.displayName,
      }),
    );
  });

  it("passes issue variables when bench has assigned issue", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT_WITH_REPO as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH_WITH_ISSUE as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(issueFormatting.fetchIssueContext).mockResolvedValue({
      issueNumber: 42,
      issueTitle: "Fix the widget",
      issueBody: "The widget is broken.",
      issueUrl: "https://github.com/owner/repo/issues/42",
      comments: "## Comments\nformatted",
    });

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });

    expect(res.status).toBe(200);
    expect(issueFormatting.fetchIssueContext).toHaveBeenCalledWith("owner/repo", 42);
    expect(blueprintManager.resolveBlueprintContent).toHaveBeenCalledWith(
      MOCK_BLUEPRINT_DETAIL.content,
      expect.objectContaining({
        issueNumber: 42,
        issueTitle: "Fix the widget",
        issueBody: "The widget is broken.",
        issueUrl: "https://github.com/owner/repo/issues/42",
        comments: "## Comments\nformatted",
      }),
    );
  });

  it("falls back to minimal issue data when GitHub fetch fails", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT_WITH_REPO as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH_WITH_ISSUE as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(issueFormatting.fetchIssueContext).mockRejectedValue(new Error("GitHub API error"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch issue #42"));
    expect(blueprintManager.resolveBlueprintContent).toHaveBeenCalledWith(
      MOCK_BLUEPRINT_DETAIL.content,
      expect.objectContaining({
        issueNumber: 42,
        issueTitle: "Fix the widget",
      }),
    );
    expect(blueprintManager.resolveBlueprintContent).toHaveBeenCalledWith(
      MOCK_BLUEPRINT_DETAIL.content,
      expect.not.objectContaining({
        issueBody: expect.anything(),
        issueUrl: expect.anything(),
        comments: expect.anything(),
      }),
    );
    warnSpy.mockRestore();
  });

  it("does not fetch issue data when bench has no assigned issue", async () => {
    await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });

    expect(issueFormatting.fetchIssueContext).not.toHaveBeenCalled();
  });

  it("does not fetch issue data when project has no repo configured", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH_WITH_ISSUE as unknown as ReturnType<typeof benchManager.getBench>,
    );

    await request(app)
      .post("/project-1/benches/1/inject-blueprint")
      .send({ blueprintId: "feature-dev" });

    expect(issueFormatting.fetchIssueContext).not.toHaveBeenCalled();
  });
});

// ── Project-level blueprint CRUD route tests ──

type BlueprintErrorCtor = new (
  message: string,
  code: string,
  data?: unknown,
) => Error & { code: string; data?: unknown };

function makeProjectBlueprintError(code: string, message = "error", data?: unknown) {
  const Cls = blueprintManager.BlueprintError as unknown as BlueprintErrorCtor;
  return new Cls(message, code, data);
}

const MOCK_BLUEPRINT_DETAIL_PROJECT = {
  id: "my-blueprint",
  name: "My Blueprint",
  description: "A test blueprint",
  icon: "file-text",
  source: "project" as const,
  content: "Hello {{project.name}}",
  sizeBytes: 23,
  sizeWarning: false,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  approxTokens: 10,
};

describe("POST /:projectId/blueprints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
  });

  it("creates a blueprint and returns 201 with source=project", async () => {
    vi.mocked(blueprintManager.createProjectBlueprint).mockReturnValue(
      MOCK_BLUEPRINT_DETAIL_PROJECT,
    );
    const res = await request(app)
      .post("/project-1/blueprints")
      .send({ name: "My Blueprint", description: "A test blueprint", content: "hello" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(MOCK_BLUEPRINT_DETAIL_PROJECT);
    expect(blueprintManager.createProjectBlueprint).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ name: "My Blueprint" }),
    );
  });

  it("returns 404 when project is not registered", async () => {
    vi.mocked(blueprintManager.createProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("NOT_FOUND", "Project 'unknown-project' not found");
    });
    const res = await request(app)
      .post("/unknown-project/blueprints")
      .send({ name: "x", description: "d", content: "c" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns 400 on INVALID_NAME", async () => {
    vi.mocked(blueprintManager.createProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("INVALID_NAME", "name is required");
    });
    const res = await request(app)
      .post("/project-1/blueprints")
      .send({ name: "", description: "d", content: "c" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_NAME" });
  });

  it("returns 400 on INVALID_CONTENT", async () => {
    vi.mocked(blueprintManager.createProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("INVALID_CONTENT", "content exceeds the maximum size");
    });
    const res = await request(app)
      .post("/project-1/blueprints")
      .send({ name: "x", description: "d", content: "too-large" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_CONTENT" });
  });

  it("returns 409 on DUPLICATE_ID", async () => {
    vi.mocked(blueprintManager.createProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("DUPLICATE_ID", "already exists");
    });
    const res = await request(app)
      .post("/project-1/blueprints")
      .send({ name: "My Blueprint", description: "d", content: "c" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DUPLICATE_ID" });
  });

  it("returns 409 on DUPLICATE_NAME", async () => {
    vi.mocked(blueprintManager.createProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("DUPLICATE_NAME", "name already exists");
    });
    const res = await request(app)
      .post("/project-1/blueprints")
      .send({ name: "My Blueprint", description: "d", content: "c" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DUPLICATE_NAME" });
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(blueprintManager.createProjectBlueprint).mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await request(app)
      .post("/project-1/blueprints")
      .send({ name: "x", description: "d", content: "c" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "Internal server error" });
  });
});

describe("PUT /:projectId/blueprints/:blueprintId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
  });

  it("updates a blueprint and returns 200", async () => {
    const updated = { ...MOCK_BLUEPRINT_DETAIL_PROJECT, description: "updated" };
    vi.mocked(blueprintManager.updateProjectBlueprint).mockReturnValue(updated);
    const res = await request(app)
      .put("/project-1/blueprints/my-blueprint")
      .send({ description: "updated" });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("updated");
  });

  it("returns 404 when project is not registered", async () => {
    vi.mocked(blueprintManager.updateProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("NOT_FOUND", "Project 'unknown' not found");
    });
    const res = await request(app)
      .put("/unknown/blueprints/my-blueprint")
      .send({ description: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid blueprint id (path traversal)", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/..%2Fetc%2Fpasswd")
      .send({ description: "x" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for uppercase id", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/Invalid-ID")
      .send({ description: "x" });
    expect(res.status).toBe(400);
  });

  it("returns 400 on RESERVED_ID", async () => {
    vi.mocked(blueprintManager.updateProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("RESERVED_ID", "reserved");
    });
    const res = await request(app).put("/project-1/blueprints/some-id").send({ name: "x" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "RESERVED_ID" });
  });

  it("returns 404 on NOT_FOUND", async () => {
    vi.mocked(blueprintManager.updateProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("NOT_FOUND", "not found");
    });
    const res = await request(app).put("/project-1/blueprints/ghost").send({ content: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 409 on DUPLICATE_NAME", async () => {
    vi.mocked(blueprintManager.updateProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("DUPLICATE_NAME", "name exists");
    });
    const res = await request(app)
      .put("/project-1/blueprints/my-blueprint")
      .send({ name: "Other" });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /:projectId/blueprints/:blueprintId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
  });

  it("deletes a blueprint and returns 204", async () => {
    vi.mocked(blueprintManager.deleteProjectBlueprint).mockReturnValue(undefined);
    const res = await request(app).delete("/project-1/blueprints/my-blueprint");
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("returns 404 when project is not registered", async () => {
    vi.mocked(blueprintManager.deleteProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("NOT_FOUND", "Project 'unknown' not found");
    });
    const res = await request(app).delete("/unknown/blueprints/my-blueprint");
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid blueprint id", async () => {
    const res = await request(app).delete("/project-1/blueprints/Bad-ID");
    expect(res.status).toBe(400);
  });

  it("returns 400 on RESERVED_ID", async () => {
    vi.mocked(blueprintManager.deleteProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("RESERVED_ID", "reserved");
    });
    const res = await request(app).delete("/project-1/blueprints/some-id");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "RESERVED_ID" });
  });

  it("returns 404 on NOT_FOUND", async () => {
    vi.mocked(blueprintManager.deleteProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("NOT_FOUND", "not found");
    });
    const res = await request(app).delete("/project-1/blueprints/ghost");
    expect(res.status).toBe(404);
  });

  it("returns 409 with BLUEPRINT_REFERENCED code and references when blueprint is in use", async () => {
    const refs = [{ type: "project-default", projectId: "project-1", projectName: "My Project" }];
    vi.mocked(blueprintManager.deleteProjectBlueprint).mockImplementation(() => {
      throw makeProjectBlueprintError("REFERENCED", "Blueprint is still referenced", refs);
    });
    const res = await request(app).delete("/project-1/blueprints/in-use");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "BLUEPRINT_REFERENCED",
      references: refs,
    });
  });
});

describe("GET /:projectId/blueprints/default", () => {
  beforeEach(() => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(MOCK_PROJECT as never);
  });

  it("returns the resolved effective default with source", async () => {
    vi.mocked(blueprintManager.resolveEffectiveDefaultBlueprint).mockReturnValue({
      blueprintId: "feature-dev",
      source: "app",
    });
    const res = await request(app).get("/project-1/blueprints/default");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blueprintId: "feature-dev", source: "app" });
  });

  it("returns global source when no override is set", async () => {
    vi.mocked(blueprintManager.resolveEffectiveDefaultBlueprint).mockReturnValue({
      blueprintId: "__global_default__",
      source: "global",
    });
    const res = await request(app).get("/project-1/blueprints/default");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blueprintId: "__global_default__", source: "global" });
  });

  it("returns project source when project default is set", async () => {
    vi.mocked(blueprintManager.resolveEffectiveDefaultBlueprint).mockReturnValue({
      blueprintId: "my-bp",
      source: "project",
    });
    const res = await request(app).get("/project-1/blueprints/default");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blueprintId: "my-bp", source: "project" });
  });

  it("returns 404 when project is not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get("/nonexistent/blueprints/default");
    expect(res.status).toBe(404);
  });
});

describe("PUT /:projectId/blueprints/default", () => {
  beforeEach(() => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      ...MOCK_PROJECT,
      repoPath: "/repo/path",
    } as never);
    vi.mocked(blueprintManager.listBlueprintsForProject).mockReturnValue([
      { ...MOCK_BLUEPRINT_META, id: "feature-dev" },
      { ...MOCK_BLUEPRINT_META, id: "__global_default__" },
    ] as never);
    vi.mocked(fs.readFileSync).mockReturnValue('project:\n  name: "test"\n');
    vi.mocked(YAML.parse).mockReturnValue({ project: { name: "test" } });
    vi.mocked(YAML.stringify).mockReturnValue(
      'project:\n  name: "test"\nblueprints:\n  defaultBlueprint: "feature-dev"\n',
    );
    vi.mocked(state.atomicWrite).mockReturnValue(undefined);
    vi.mocked(projectRegistry.reloadConfig).mockReturnValue({} as never);
  });

  it("sets the project default blueprint when blueprintId is valid", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/default")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blueprintId: "feature-dev" });
    expect(state.atomicWrite).toHaveBeenCalled();
    expect(projectRegistry.reloadConfig).toHaveBeenCalledWith("project-1");
  });

  it("clears the project default blueprint when blueprintId is null", async () => {
    const res = await request(app).put("/project-1/blueprints/default").send({ blueprintId: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blueprintId: null });
    expect(state.atomicWrite).toHaveBeenCalled();
  });

  it("returns 404 when project is not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app)
      .put("/nonexistent/blueprints/default")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when blueprintId has invalid characters", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/default")
      .send({ blueprintId: "My Blueprint!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid blueprint id/i);
  });

  it("returns 400 when blueprintId does not exist in the project blueprint list", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/default")
      .send({ blueprintId: "nonexistent-bp" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("accepts __global_default__ as a valid project default blueprint id", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/default")
      .send({ blueprintId: "__global_default__" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blueprintId: "__global_default__" });
    expect(state.atomicWrite).toHaveBeenCalled();
  });

  it("returns 500 when atomicWrite throws", async () => {
    vi.mocked(state.atomicWrite).mockImplementation(() => {
      throw new Error("Disk full");
    });
    const res = await request(app)
      .put("/project-1/blueprints/default")
      .send({ blueprintId: "feature-dev" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Disk full");
  });
});

describe("GET /:projectId/blueprints/issue-type-mappings", () => {
  it("returns mappings from project config", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      ...MOCK_PROJECT,
      config: {
        ...MOCK_PROJECT.config,
        blueprints: { issueTypeMappings: { Bug: "bug-fix", Feature: "feature-dev" } },
      },
    } as never);

    const res = await request(app).get("/project-1/blueprints/issue-type-mappings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mappings: { Bug: "bug-fix", Feature: "feature-dev" } });
  });

  it("returns empty mappings when no config", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(MOCK_PROJECT as never);

    const res = await request(app).get("/project-1/blueprints/issue-type-mappings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mappings: {} });
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/nonexistent/blueprints/issue-type-mappings");
    expect(res.status).toBe(404);
  });
});

describe("PUT /:projectId/blueprints/issue-type-mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      ...MOCK_PROJECT,
      repoPath: "/repo/path",
    } as never);
    vi.mocked(blueprintManager.listBlueprintsForProject).mockReturnValue([
      { ...MOCK_BLUEPRINT_META, id: "feature-dev" },
      { ...MOCK_BLUEPRINT_META, id: "bug-fix" },
    ] as never);
    vi.mocked(fs.readFileSync).mockReturnValue('project:\n  name: "test"\n');
    vi.mocked(YAML.parse).mockReturnValue({ project: { name: "test" } });
    vi.mocked(YAML.stringify).mockReturnValue(
      "blueprints:\n  issueTypeMappings:\n    Bug: bug-fix\n",
    );
    vi.mocked(state.atomicWrite).mockReturnValue(undefined);
    vi.mocked(projectRegistry.reloadConfig).mockReturnValue({} as never);
  });

  it("persists mappings and returns them", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/issue-type-mappings")
      .send({ mappings: { Bug: "bug-fix", Feature: "feature-dev" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mappings: { Bug: "bug-fix", Feature: "feature-dev" } });
    expect(state.atomicWrite).toHaveBeenCalled();
    expect(projectRegistry.reloadConfig).toHaveBeenCalledWith("project-1");
  });

  it("accepts __global_default__ as a valid blueprint id in mappings", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/issue-type-mappings")
      .send({ mappings: { Bug: "__global_default__" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mappings: { Bug: "__global_default__" } });
  });

  it("prunes issueTypeMappings and blueprints section when mappings is empty", async () => {
    vi.mocked(YAML.parse).mockReturnValue({
      project: { name: "test" },
      blueprints: { issueTypeMappings: { Bug: "bug-fix" } },
    });
    vi.mocked(YAML.stringify).mockReturnValue('project:\n  name: "test"\n');

    const res = await request(app)
      .put("/project-1/blueprints/issue-type-mappings")
      .send({ mappings: {} });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mappings: {} });
    const dumpCall = vi.mocked(YAML.stringify).mock.calls[0][0] as Record<string, unknown>;
    expect(dumpCall).not.toHaveProperty("blueprints");
  });

  it("returns 400 when blueprintId does not exist in the project blueprint list", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/issue-type-mappings")
      .send({ mappings: { Bug: "nonexistent-bp" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when blueprintId has invalid characters", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/issue-type-mappings")
      .send({ mappings: { Bug: "My Blueprint!" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid blueprint id/i);
  });

  it("returns 400 when mappings is not an object", async () => {
    const res = await request(app)
      .put("/project-1/blueprints/issue-type-mappings")
      .send({ mappings: "bad" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/object/i);
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .put("/nonexistent/blueprints/issue-type-mappings")
      .send({ mappings: {} });

    expect(res.status).toBe(404);
  });

  it("returns 500 when atomicWrite throws", async () => {
    vi.mocked(state.atomicWrite).mockImplementation(() => {
      throw new Error("Disk full");
    });

    const res = await request(app)
      .put("/project-1/blueprints/issue-type-mappings")
      .send({ mappings: { Bug: "bug-fix" } });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Disk full");
  });
});
