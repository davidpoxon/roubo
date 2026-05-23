import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/jig-manager.js", () => ({
  listGlobalJigs: vi.fn(),
  createAppJig: vi.fn(),
  getAppJig: vi.fn(),
  updateAppJig: vi.fn(),
  deleteAppJig: vi.fn(),
  resolveJigContent: vi.fn((content: string) =>
    content.replace("{{bench.branch}}", "feature/resolved"),
  ),
  JigError: class JigError extends Error {
    constructor(
      message: string,
      public code: string,
      public data?: unknown,
    ) {
      super(message);
      this.name = "JigError";
    }
  },
}));

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
}));

vi.mock("../services/jig-preview.js", () => ({
  buildPreviewContext: vi.fn(async () => ({
    ports: { server: 4000 },
    portHttps: { server: false },
    workspace: "/real/workspace",
    components: {},
    benchId: 2,
    benchBranch: "feature/real-branch",
    projectName: "My Project",
  })),
  getSampleResolveContext: vi.fn(() => ({
    ports: { server: 3000 },
    portHttps: { server: false },
    workspace: "~/.roubo/workspaces/my-app/bench-1",
    components: {},
    benchId: 1,
    benchBranch: "feature/my-change",
    projectName: "my-app",
    issueNumber: 42,
    issueTitle: "Fix login bug",
    issueBody: "Sample body",
    issueUrl: "https://github.com/org/repo/issues/42",
    comments: "",
  })),
  findUnresolvedVariables: vi.fn(() => []),
}));

import router from "./app-jigs.js";
import * as jigManager from "../services/jig-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as jigPreview from "../services/jig-preview.js";

const app = express();
app.use(express.json({ limit: "210kb" }));
app.use("/", router);

const MOCK_META = {
  id: "my-jig",
  name: "My Jig",
  description: "A test jig",
  icon: "file-text",
  source: "app" as const,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  approxTokens: 10,
};

const MOCK_DETAIL = {
  ...MOCK_META,
  content: "Hello {{project.name}}",
  sizeBytes: 23,
  sizeWarning: false,
};

type JigErrorCtor = new (
  message: string,
  code: string,
  data?: unknown,
) => Error & { code: string; data?: unknown };

function makeJigError(code: string, message = "error", data?: unknown) {
  const Cls = jigManager.JigError as unknown as JigErrorCtor;
  return new Cls(message, code, data);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /", () => {
  it("returns the list of global jigs", async () => {
    vi.mocked(jigManager.listGlobalJigs).mockReturnValue([MOCK_META]);
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([MOCK_META]);
  });
});

describe("POST /", () => {
  it("creates a jig and returns 201", async () => {
    vi.mocked(jigManager.createAppJig).mockReturnValue(MOCK_DETAIL);
    const res = await request(app)
      .post("/")
      .send({ name: "My Jig", description: "A test jig", content: "hello" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(MOCK_DETAIL);
  });

  it("returns 400 when name is missing", async () => {
    vi.mocked(jigManager.createAppJig).mockImplementation(() => {
      throw makeJigError("INVALID_NAME", "name is required");
    });
    const res = await request(app).post("/").send({ name: "", description: "d", content: "c" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_NAME" });
  });

  it("returns 400 when content is too large", async () => {
    vi.mocked(jigManager.createAppJig).mockImplementation(() => {
      throw makeJigError("INVALID_CONTENT", "content exceeds the maximum size");
    });
    const res = await request(app)
      .post("/")
      .send({ name: "x", description: "d", content: "too-large-content" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_CONTENT" });
  });

  it("returns 409 on duplicate id", async () => {
    vi.mocked(jigManager.createAppJig).mockImplementation(() => {
      throw makeJigError("DUPLICATE_ID", "already exists");
    });
    const res = await request(app)
      .post("/")
      .send({ name: "My Jig", description: "d", content: "c" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DUPLICATE_ID" });
  });

  it("returns 409 on duplicate name", async () => {
    vi.mocked(jigManager.createAppJig).mockImplementation(() => {
      throw makeJigError("DUPLICATE_NAME", "name already exists");
    });
    const res = await request(app)
      .post("/")
      .send({ name: "My Jig", description: "d", content: "c" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DUPLICATE_NAME" });
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(jigManager.createAppJig).mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await request(app).post("/").send({ name: "x", description: "d", content: "c" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "Internal server error" });
  });
});

describe("GET /:id", () => {
  it("returns a jig by id", async () => {
    vi.mocked(jigManager.getAppJig).mockReturnValue(MOCK_DETAIL);
    const res = await request(app).get("/my-jig");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_DETAIL);
  });

  it("returns the embedded global default for __global_default__", async () => {
    vi.mocked(jigManager.getAppJig).mockReturnValue({
      ...MOCK_DETAIL,
      id: "__global_default__",
    });
    const res = await request(app).get("/__global_default__");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("__global_default__");
  });

  it("returns 404 when jig not found", async () => {
    vi.mocked(jigManager.getAppJig).mockReturnValue(null);
    const res = await request(app).get("/ghost");
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid id with path-traversal characters", async () => {
    const res = await request(app).get("/..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
  });

  it("returns 400 for uppercase id", async () => {
    const res = await request(app).get("/MyJig");
    expect(res.status).toBe(400);
  });
});

describe("PUT /:id", () => {
  it("updates a jig and returns it", async () => {
    const updated = { ...MOCK_DETAIL, description: "updated" };
    vi.mocked(jigManager.updateAppJig).mockReturnValue(updated);
    const res = await request(app).put("/my-jig").send({ description: "updated" });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("updated");
  });

  it("returns 400 for invalid id", async () => {
    const res = await request(app).put("/Invalid-ID").send({ description: "x" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when reserved id is updated", async () => {
    vi.mocked(jigManager.updateAppJig).mockImplementation(() => {
      throw makeJigError("RESERVED_ID", "reserved");
    });
    const res = await request(app).put("/some-id").send({ name: "x" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "RESERVED_ID" });
  });

  it("returns 404 when jig does not exist", async () => {
    vi.mocked(jigManager.updateAppJig).mockImplementation(() => {
      throw makeJigError("NOT_FOUND", "not found");
    });
    const res = await request(app).put("/ghost").send({ content: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 409 on name conflict", async () => {
    vi.mocked(jigManager.updateAppJig).mockImplementation(() => {
      throw makeJigError("DUPLICATE_NAME", "name exists");
    });
    const res = await request(app).put("/my-jig").send({ name: "Other" });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /:id", () => {
  it("deletes a jig and returns 204", async () => {
    vi.mocked(jigManager.deleteAppJig).mockReturnValue(undefined);
    const res = await request(app).delete("/my-jig");
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("returns 400 for invalid id", async () => {
    const res = await request(app).delete("/Bad-ID");
    expect(res.status).toBe(400);
  });

  it("returns 404 when jig not found", async () => {
    vi.mocked(jigManager.deleteAppJig).mockImplementation(() => {
      throw makeJigError("NOT_FOUND", "not found");
    });
    const res = await request(app).delete("/ghost");
    expect(res.status).toBe(404);
  });

  it("returns 400 when trying to delete the reserved default", async () => {
    vi.mocked(jigManager.deleteAppJig).mockImplementation(() => {
      throw makeJigError("RESERVED_ID", "reserved");
    });
    const res = await request(app).delete("/some-id");
    expect(res.status).toBe(400);
  });

  it("returns 409 with references when jig is in use", async () => {
    const refs = [{ type: "app-default" }];
    vi.mocked(jigManager.deleteAppJig).mockImplementation(() => {
      throw makeJigError("REFERENCED", "Jig is still referenced", refs);
    });
    const res = await request(app).delete("/in-use");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "JIG_REFERENCED",
      references: refs,
    });
  });
});

describe("POST /preview", () => {
  beforeEach(() => {
    vi.mocked(jigPreview.findUnresolvedVariables).mockReturnValue([]);
  });

  it("uses sample context when no projectId/benchId provided", async () => {
    const res = await request(app).post("/preview").send({ content: "hello world" });
    expect(res.status).toBe(200);
    expect(jigPreview.getSampleResolveContext).toHaveBeenCalled();
    expect(jigPreview.buildPreviewContext).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ resolved: expect.any(String), unresolvedVariables: [] });
  });

  it("uses sample context when project/bench not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app)
      .post("/preview")
      .send({ content: "hello", projectId: "missing", benchId: 99 });
    expect(res.status).toBe(200);
    expect(jigPreview.getSampleResolveContext).toHaveBeenCalled();
    expect(jigPreview.buildPreviewContext).not.toHaveBeenCalled();
  });

  it("uses sample context when bench not found for project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({ id: "proj-1", config: {} } as never);
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);
    const res = await request(app)
      .post("/preview")
      .send({ content: "hello", projectId: "proj-1", benchId: 99 });
    expect(res.status).toBe(200);
    expect(jigPreview.getSampleResolveContext).toHaveBeenCalled();
  });

  it("builds real context when project and bench exist", async () => {
    const mockProject = { id: "proj-1", config: {} };
    const mockBench = { id: 2, projectId: "proj-1", branch: "feature/real" };
    vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject as never);
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as never);
    const res = await request(app)
      .post("/preview")
      .send({ content: "hello", projectId: "proj-1", benchId: 2 });
    expect(res.status).toBe(200);
    expect(jigPreview.buildPreviewContext).toHaveBeenCalledWith(mockProject, mockBench);
    expect(jigPreview.getSampleResolveContext).not.toHaveBeenCalled();
  });

  it("returns 400 when content is missing", async () => {
    const res = await request(app).post("/preview").send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "content is required" });
  });

  it("returns 400 when content is an empty string", async () => {
    const res = await request(app).post("/preview").send({ content: "" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "content is required" });
  });

  it("falls back to sample context when projectId is not a string", async () => {
    const res = await request(app)
      .post("/preview")
      .send({ content: "hello", projectId: 123, benchId: 2 });
    expect(res.status).toBe(200);
    expect(jigPreview.getSampleResolveContext).toHaveBeenCalled();
    expect(jigPreview.buildPreviewContext).not.toHaveBeenCalled();
  });

  it("returns 400 when content exceeds 200 KB", async () => {
    const res = await request(app)
      .post("/preview")
      .send({ content: "x".repeat(200 * 1024 + 1) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: /200 KB/ });
  });

  it("includes unresolvedVariables from findUnresolvedVariables", async () => {
    vi.mocked(jigPreview.findUnresolvedVariables).mockReturnValue(["{{ports.server}}"]);
    const res = await request(app).post("/preview").send({ content: "port is {{ports.server}}" });
    expect(res.status).toBe(200);
    expect(res.body.unresolvedVariables).toEqual(["{{ports.server}}"]);
  });
});
