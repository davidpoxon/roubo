import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../services/project-registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/project-registry.js")>();
  return {
    ...original,
    getProjects: vi.fn(),
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    getProject: vi.fn(),
    reloadConfig: vi.fn(),
    checkPortConflictsForConfig: vi.fn(),
  };
});
vi.mock("../services/config-parser.js");
vi.mock("../services/repo-scanner.js");
vi.mock("../services/state.js");
vi.mock("../services/github.js");
vi.mock("../services/plugin-manager.js", () => ({ invoke: vi.fn() }));
vi.mock("../services/active-plugin.js", () => ({ resolveActivePlugin: vi.fn() }));
vi.mock("../services/plugin-activation.js", () => ({
  ensurePluginActivated: vi.fn().mockResolvedValue(undefined),
  forgetProjectActivation: vi.fn(),
  forgetPluginActivation: vi.fn(),
  resolveSources: vi.fn().mockReturnValue([{ kind: "repo", externalId: "foo/bar" }]),
}));
// Keep the real GITHUB_FAMILY_PLUGIN_IDS so the family roster stays a single
// source of truth; stub only the side-effecting derivation calls.
vi.mock("../services/derive-github-sources.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/derive-github-sources.js")>()),
  deriveAndPersistGithubSources: vi.fn().mockResolvedValue(null),
  deriveGithubSources: vi.fn(),
}));

import router from "./projects.js";
import * as projectRegistry from "../services/project-registry.js";
import { ProjectRegistryError } from "../services/project-registry.js";
import { parseConfig, validateConfigObject } from "../services/config-parser.js";
import { scanRepo } from "../services/repo-scanner.js";
import { atomicWrite } from "../services/state.js";
import * as githubService from "../services/github.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as activePlugin from "../services/active-plugin.js";
import * as pluginActivation from "../services/plugin-activation.js";
import * as deriveGithubSourcesService from "../services/derive-github-sources.js";
import { GitHubError } from "../services/github-error.js";

const app = express();
app.use(express.json());
app.use("/", router);

describe("GET /", () => {
  it("returns projects array", async () => {
    const projects = [{ id: "project", name: "My Project", repoPath: "/path" }];
    vi.mocked(projectRegistry.getProjects).mockReturnValue(projects as any);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(projects);
  });
});

describe("POST /", () => {
  it("returns 400 when repoPath is missing", async () => {
    const res = await request(app).post("/").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("repoPath is required");
  });

  it("returns 201 with registered project on success", async () => {
    const registered = { id: "project", name: "My Project", repoPath: "/repo" };
    vi.mocked(projectRegistry.registerProject).mockReturnValue(registered as any);

    const res = await request(app).post("/").send({ repoPath: "/repo" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(registered);
  });

  it("returns 409 for DUPLICATE error", async () => {
    vi.mocked(projectRegistry.registerProject).mockImplementation(() => {
      throw new ProjectRegistryError("Already registered", "DUPLICATE");
    });

    const res = await request(app).post("/").send({ repoPath: "/repo" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE");
  });

  it("returns 409 for PORT_CONFLICT error", async () => {
    vi.mocked(projectRegistry.registerProject).mockImplementation(() => {
      throw new ProjectRegistryError("Port conflict", "PORT_CONFLICT");
    });

    const res = await request(app).post("/").send({ repoPath: "/repo" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PORT_CONFLICT");
  });

  it("returns 400 for INVALID_CONFIG error", async () => {
    vi.mocked(projectRegistry.registerProject).mockImplementation(() => {
      throw new ProjectRegistryError("Invalid config", "INVALID_CONFIG");
    });

    const res = await request(app).post("/").send({ repoPath: "/repo" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CONFIG");
  });
});

describe("POST /check-config", () => {
  // /check-config confines repoPath to the allowed roots (home +
  // ROUBO_FILESYSTEM_ROOTS), so the happy-path fixtures must resolve inside the
  // user's home directory.
  const insideHome = path.join(os.homedir(), "repo");
  const outsideHome = path.resolve(os.homedir(), "..", "..", "outside-roubo-check-config-test");

  it("returns 400 when repoPath is missing", async () => {
    const res = await request(app).post("/check-config").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("repoPath is required");
  });

  it("returns 403 when repoPath escapes the allowed roots", async () => {
    const existsSpy = vi.spyOn(fs, "existsSync");

    const res = await request(app).post("/check-config").send({ repoPath: outsideHome });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Path is outside the allowed roots");
    expect(existsSpy).not.toHaveBeenCalled();
    expect(parseConfig).not.toHaveBeenCalled();
  });

  it("returns hasConfig:false when directory not found", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app).post("/check-config").send({ repoPath: insideHome });
    expect(res.status).toBe(200);
    expect(res.body.hasConfig).toBe(false);
    expect(res.body.error).toBe("Directory not found");
  });

  it("returns hasConfig:true, configValid:false when yaml is invalid", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(parseConfig).mockReturnValue({
      valid: false,
      errors: ["Missing required field: project.name"],
    } as any);
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);

    const res = await request(app).post("/check-config").send({ repoPath: insideHome });
    expect(res.status).toBe(200);
    expect(res.body.hasConfig).toBe(true);
    expect(res.body.configValid).toBe(false);
    expect(res.body.alreadyRegistered).toBe(false);
    expect(res.body.error).toBe("Missing required field: project.name");
  });

  it("returns alreadyRegistered:true with project when yaml is invalid but project is registered", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(parseConfig).mockReturnValue({
      valid: false,
      errors: ["Missing required field: project.name"],
    } as any);
    const existingProject = {
      id: "my-app",
      repoPath: insideHome,
      configValid: false,
      settings: {
        worktreeSource: { branchFromDefault: true, pullLatest: true },
      },
    };
    vi.mocked(projectRegistry.getProjects).mockReturnValue([existingProject] as any);

    const res = await request(app).post("/check-config").send({ repoPath: insideHome });
    expect(res.status).toBe(200);
    expect(res.body.hasConfig).toBe(true);
    expect(res.body.configValid).toBe(false);
    expect(res.body.alreadyRegistered).toBe(true);
    expect(res.body.project.id).toBe("my-app");
  });

  it("returns hasConfig:true for valid config", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(parseConfig).mockReturnValue({
      valid: true,
      config: {
        project: {
          name: "test-project",
          displayName: "Test Project",
        },
        ports: {},
        benches: { max: 3 },
      },
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).post("/check-config").send({ repoPath: insideHome });
    expect(res.status).toBe(200);
    expect(res.body.hasConfig).toBe(true);
    expect(res.body.configValid).toBe(true);
    expect(res.body.projectName).toBe("test-project");
    expect(res.body.alreadyRegistered).toBe(false);
  });

  it("returns preview with per-port entries for multi-port config", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(parseConfig).mockReturnValue({
      valid: true,
      config: {
        project: { name: "atlas", displayName: "Atlas" },
        ports: {
          server: { base: 5300 },
          client: { base: 5301 },
        },
        benches: { max: 4 },
      },
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).post("/check-config").send({ repoPath: insideHome });
    expect(res.status).toBe(200);
    expect(res.body.preview).toEqual({
      name: "atlas",
      displayName: "Atlas",
      ports: [
        { name: "server", base: 5300 },
        { name: "client", base: 5301 },
      ],
      benchCap: 4,
    });
  });

  // The handler touches the user-supplied directory off disk (fs.existsSync +
  // parseConfig), so it is rate-limited (CodeQL js/missing-rate-limiting #39).
  // Asserting the draft-7 RateLimit headers proves the limiter is wired onto
  // the route.
  it("attaches RateLimit response headers (limiter is mounted)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app).post("/check-config").send({ repoPath: insideHome });
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("POST /scan", () => {
  // /scan confines repoPath to the allowed roots (home + ROUBO_FILESYSTEM_ROOTS),
  // so the happy-path fixtures must resolve inside the user's home directory.
  const insideHome = path.join(os.homedir(), "repo");
  const missingInsideHome = path.join(os.homedir(), "nonexistent");
  const outsideHome = path.resolve(os.homedir(), "..", "..", "outside-roubo-scan-test");

  it("returns 400 when repoPath is missing", async () => {
    const res = await request(app).post("/scan").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("repoPath is required");
  });

  it("returns 403 when repoPath escapes the allowed roots", async () => {
    const existsSpy = vi.spyOn(fs, "existsSync");

    const res = await request(app).post("/scan").send({ repoPath: outsideHome });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Path is outside the allowed roots");
    expect(existsSpy).not.toHaveBeenCalled();
    expect(scanRepo).not.toHaveBeenCalled();
  });

  it("returns 404 when directory not found", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app).post("/scan").send({ repoPath: missingInsideHome });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(`Directory not found: ${missingInsideHome}`);
  });

  it("returns 200 with scan result on success", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const scanResult = { type: "node", services: [] };
    vi.mocked(scanRepo).mockResolvedValue(scanResult as any);

    const res = await request(app).post("/scan").send({ repoPath: insideHome });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(scanResult);
    expect(scanRepo).toHaveBeenCalledWith(insideHome);
  });

  it("returns 500 when scanRepo throws", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(scanRepo).mockRejectedValue(new Error("scan failed"));

    const res = await request(app).post("/scan").send({ repoPath: insideHome });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("scan failed");
  });
});

describe("POST /validate-config", () => {
  it("returns 400 when config is missing", async () => {
    const res = await request(app).post("/validate-config").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("config is required");
  });

  it("returns valid:true for valid config", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.mocked(projectRegistry.checkPortConflictsForConfig).mockReturnValue([]);

    const res = await request(app)
      .post("/validate-config")
      .send({ config: { project: { name: "test" } } });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toEqual([]);
  });

  it("returns errors array when config is invalid", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: false,
      errors: ["project.name: is required", "missing field"],
      fieldErrors: [
        { path: "project.name", message: "is required" },
        { path: "", message: "missing field" },
      ],
    } as any);

    const res = await request(app).post("/validate-config").send({ config: {} });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual([
      { path: "project.name", message: "is required" },
      { path: "", message: "missing field" },
    ]);
  });

  it("returns valid:false when port conflicts exist", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.mocked(projectRegistry.checkPortConflictsForConfig).mockReturnValue([
      {
        port: 3000,
        service: "web",
        conflictingProject: "other-project",
        conflictingService: "api",
      },
    ] as any);

    const res = await request(app)
      .post("/validate-config")
      .send({ config: { project: { name: "test" } } });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.portConflicts).toHaveLength(1);
  });
});

describe("POST /save-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when fields are missing", async () => {
    const res = await request(app).post("/save-config").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("repoPath and config are required");
  });

  it("returns 400 when config is invalid", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: false,
      errors: ["project.name: is required"],
      fieldErrors: [{ path: "project.name", message: "is required" }],
    } as any);

    const res = await request(app).post("/save-config").send({ repoPath: "/repo", config: {} });
    expect(res.status).toBe(400);
    // Top-level message names the offending field rather than a bare "Invalid config".
    expect(res.body.error).toBe("Invalid config: project.name needs attention");
    expect(res.body.errors).toEqual([{ path: "project.name", message: "is required" }]);
    expect(res.body.details).toEqual(["project.name: is required"]);
  });

  it("names every failing field in the top-level message", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: false,
      errors: ["project.displayName: Invalid input", "layout.type: Invalid input"],
      fieldErrors: [
        { path: "project.displayName", message: "Invalid input" },
        { path: "layout.type", message: "Invalid input" },
      ],
    } as any);

    const res = await request(app).post("/save-config").send({ repoPath: "/repo", config: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid config: project.displayName, layout.type need attention");
  });

  it("falls back to the generic message when there are no field-level errors", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: false,
      errors: ["Found legacy top-level `blueprints:` key."],
    } as any);

    const res = await request(app).post("/save-config").send({ repoPath: "/repo", config: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid config");
    expect(res.body.details).toEqual(["Found legacy top-level `blueprints:` key."]);
  });

  it("returns 200 with path and config on success", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const config = { project: { name: "test" } };
    const res = await request(app).post("/save-config").send({ repoPath: "/repo", config });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/repo/.roubo/roubo.yaml");
    expect(res.body.config).toEqual(config);
    expect(fs.mkdirSync).toHaveBeenCalledWith("/repo/.roubo", {
      recursive: true,
    });
    expect(atomicWrite).toHaveBeenCalled();
  });

  it("reloads registry when project is already registered", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test",
    } as any);
    vi.mocked(projectRegistry.reloadConfig).mockReturnValue({
      id: "test",
    } as any);

    const config = { project: { name: "test" } };
    await request(app).post("/save-config").send({ repoPath: "/repo", config });
    expect(projectRegistry.reloadConfig).toHaveBeenCalledWith("test");
  });

  it("still returns 200 when reloadConfig throws after successful save", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test",
    } as any);
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => {
      throw new Error("reload failed");
    });

    const config = { project: { name: "test" } };
    const res = await request(app).post("/save-config").send({ repoPath: "/repo", config });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/repo/.roubo/roubo.yaml");
  });

  it("does not reload registry when project is not yet registered", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const config = { project: { name: "new-project" } };
    await request(app).post("/save-config").send({ repoPath: "/repo", config });
    expect(projectRegistry.reloadConfig).not.toHaveBeenCalled();
  });

  // The handler writes roubo.yaml to disk, so it is rate-limited (CodeQL
  // js/missing-rate-limiting #41). Asserting the draft-7 RateLimit headers
  // proves the limiter is wired onto the route.
  it("attaches RateLimit response headers (limiter is mounted)", async () => {
    vi.mocked(validateConfigObject).mockReturnValue({ valid: true, config: {} } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .post("/save-config")
      .send({ repoPath: "/repo", config: { project: { name: "test" } } });
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("POST /:projectId/reload-config", () => {
  it("returns 200 with updated project on success", async () => {
    const project = { id: "my-project", repoPath: "/repo", configValid: true };
    vi.mocked(projectRegistry.reloadConfig).mockReturnValue(project as any);

    const res = await request(app).post("/my-project/reload-config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(project);
    expect(projectRegistry.reloadConfig).toHaveBeenCalledWith("my-project");
  });

  it("returns 404 for NOT_FOUND error", async () => {
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => {
      throw new ProjectRegistryError("Project not found", "NOT_FOUND");
    });

    const res = await request(app).post("/missing-project/reload-config");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 400 for non-NOT_FOUND ProjectRegistryError", async () => {
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => {
      throw new ProjectRegistryError("Invalid config", "INVALID_CONFIG");
    });

    const res = await request(app).post("/my-project/reload-config");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CONFIG");
  });

  it("returns 500 for generic errors", async () => {
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => {
      throw new Error("Unexpected error");
    });

    const res = await request(app).post("/my-project/reload-config");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Unexpected error");
  });
});

describe("DELETE /:projectId", () => {
  it("returns 204 on success", async () => {
    vi.mocked(projectRegistry.unregisterProject).mockReturnValue(undefined as any);

    const res = await request(app).delete("/project");
    expect(res.status).toBe(204);
    expect(projectRegistry.unregisterProject).toHaveBeenCalledWith("project", { force: false });
  });

  it("passes force=true through to unregisterProject", async () => {
    vi.mocked(projectRegistry.unregisterProject).mockReturnValue(undefined as any);

    const res = await request(app).delete("/project?force=true");
    expect(res.status).toBe(204);
    expect(projectRegistry.unregisterProject).toHaveBeenCalledWith("project", { force: true });
  });

  it("returns 404 for NOT_FOUND error", async () => {
    vi.mocked(projectRegistry.unregisterProject).mockImplementation(() => {
      throw new ProjectRegistryError("Not found", "NOT_FOUND");
    });

    const res = await request(app).delete("/project");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 409 for HAS_BENCHES error", async () => {
    vi.mocked(projectRegistry.unregisterProject).mockImplementation(() => {
      throw new ProjectRegistryError("Has active benches", "HAS_BENCHES");
    });

    const res = await request(app).delete("/project");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HAS_BENCHES");
  });

  it("returns 500 when generic Error is thrown", async () => {
    vi.mocked(projectRegistry.unregisterProject).mockImplementation(() => {
      throw new Error("unexpected error");
    });

    const res = await request(app).delete("/project");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("unexpected error");
  });
});

describe("GET /:projectId/config", () => {
  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project/config");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found");
  });

  it("returns 400 when config is invalid", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project",
      configValid: false,
      configError: "Bad config",
    } as any);

    const res = await request(app).get("/project/config");
    expect(res.status).toBe(400);
    expect(res.body.configValid).toBe(false);
    // fieldErrors defaults to an empty array when the project carries none.
    expect(res.body.fieldErrors).toEqual([]);
  });

  // Issue #399: an invalid component binding surfaces its path-keyed field
  // errors on the config-load response.
  it("returns 400 with path-keyed fieldErrors for an invalid component binding", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project",
      configValid: false,
      configError: "components.backend.config.port: must be number",
      fieldErrors: [
        {
          path: "components.backend.config.port",
          message: "must be number",
        },
      ],
    } as any);

    const res = await request(app).get("/project/config");
    expect(res.status).toBe(400);
    expect(res.body.configValid).toBe(false);
    expect(res.body.fieldErrors).toEqual([
      { path: "components.backend.config.port", message: "must be number" },
    ]);
  });

  it("returns 200 with config on success", async () => {
    const config = { project: { name: "test" } };
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project",
      configValid: true,
      config,
    } as any);

    const res = await request(app).get("/project/config");
    expect(res.status).toBe(200);
    expect(res.body.config).toEqual(config);
    expect(res.body.configValid).toBe(true);
  });
});

describe("GET /:projectId/config/raw", () => {
  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project/config/raw");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found");
  });

  it("returns 200 with yaml string on success", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project",
      repoPath: "/repo",
    } as any);
    vi.spyOn(fs, "readFileSync").mockReturnValue("project:\n  name: test");

    const res = await request(app).get("/project/config/raw");
    expect(res.status).toBe(200);
    expect(res.body.yaml).toBe("project:\n  name: test");
  });

  it("returns 404 when config file not found on disk", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project",
      repoPath: "/repo",
    } as any);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const res = await request(app).get("/project/config/raw");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Config file not found on disk");
  });

  // The handler reads roubo.yaml off disk, so it is rate-limited (CodeQL
  // js/missing-rate-limiting #42). Asserting the draft-7 RateLimit headers
  // proves the limiter is wired onto the route.
  it("attaches RateLimit response headers (limiter is mounted)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project",
      repoPath: "/repo",
    } as any);
    vi.spyOn(fs, "readFileSync").mockReturnValue("project:\n  name: test");

    const res = await request(app).get("/project/config/raw");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("GET /github-projects", () => {
  it("returns 400 when repo query param is missing", async () => {
    const res = await request(app).get("/github-projects");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("repo query parameter is required");
  });

  it("returns 200 with projects array on success", async () => {
    const projects = [{ number: 1, title: "Project Alpha" }];
    vi.mocked(githubService.fetchProjects).mockResolvedValue(projects);

    const res = await request(app).get("/github-projects?repo=org/repo");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(projects);
  });

  it("returns 500 when service throws", async () => {
    vi.mocked(githubService.fetchProjects).mockRejectedValue(new Error("GITHUB_TOKEN not set"));

    const res = await request(app).get("/github-projects?repo=org/repo");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("GITHUB_TOKEN not set");
  });
});

describe("GET /:projectId/projects", () => {
  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project/projects");
    expect(res.status).toBe(404);
  });

  it("returns projects for registered project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    const projects = [{ number: 1, title: "Project Alpha" }];
    vi.mocked(githubService.fetchProjects).mockResolvedValue(projects);

    const res = await request(app).get("/project/projects");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(projects);
    expect(githubService.fetchProjects).toHaveBeenCalledWith("org/repo");
  });
});

describe("GET /:projectId/issue-types", () => {
  beforeEach(() => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });
  });

  it("returns not-connected when no active integration plugin is configured", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, reason: "not-connected", types: [] });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns the active plugin's listIssueTypes output mapped to a string list of names, with security categories appended for github-family plugins (TC-033, TC-096)", async () => {
    // The plugin returns IssueTypeOption[] ({id, name}); the host flattens to
    // names before responding so the client sees `types: string[]` per the
    // declared ProjectIssueTypesV2Response contract. For github-com / ghe the
    // host also appends the three alert-category issue types so the
    // blueprint-by-issue-type UI can target them (WU-035 / FR-049).
    vi.mocked(pluginManager.invoke).mockResolvedValue([
      { id: "T_1", name: "Bug" },
      { id: "T_2", name: "Feature" },
      { id: "T_3", name: "Epic" },
    ]);
    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      types: [
        "Bug",
        "Feature",
        "Epic",
        "security-code-scanning",
        "security-secret-scanning",
        "security-dependabot",
      ],
    });
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "listIssueTypes", {
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });
  });

  it("appends security categories for the ghe plugin (TC-096)", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "ghe",
      integrationId: "ghe",
      pageSize: 50,
    });
    vi.mocked(pluginManager.invoke).mockResolvedValue([{ id: "T_1", name: "Bug" }]);
    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([
      "Bug",
      "security-code-scanning",
      "security-secret-scanning",
      "security-dependabot",
    ]);
  });

  it("does NOT append security categories for non-github-family plugins (TC-096)", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "jira-self-hosted",
      integrationId: "jira-self-hosted",
      pageSize: 50,
    });
    vi.mocked(pluginManager.invoke).mockResolvedValue([{ id: "T_1", name: "Story" }]);
    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual(["Story"]);
  });

  it("dedupes when listIssueTypes already includes a security category name (TC-096)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue([
      { id: "T_1", name: "Bug" },
      { id: "T_2", name: "security-dependabot" },
    ]);
    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([
      "Bug",
      "security-dependabot",
      "security-code-scanning",
      "security-secret-scanning",
    ]);
  });

  it("maps plugin-not-enabled to 503", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(
      Object.assign(new Error("disabled"), { code: "plugin-not-enabled" }),
    );
    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("plugin-not-enabled");
    expect(res.body.error).toBe("disabled");
  });

  it("returns 502 rpc-error when ensurePluginActivated rejects", async () => {
    vi.mocked(pluginActivation.ensurePluginActivated).mockRejectedValueOnce(
      new Error("bad config"),
    );
    vi.mocked(pluginManager.invoke).mockClear();
    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "bad config", code: "rpc-error", params: {} });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });
});

describe("PUT /:projectId/config/raw", () => {
  const VALID_YAML = `project:\n  name: nova\n  type: single\n  defaultBranch: main\n  displayName: Nova\nlayout:\n  root: .\ncomponents:\n  backend:\n    image: node@20\n    port: 3000\nports:\n  backend:\n    base: 3000\nbenches:\n  max: 3\ntools: []\n`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).put("/missing-project/config/raw").send({ yaml: VALID_YAML });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found");
  });

  it("returns 400 when yaml body is not a string", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      repoPath: "/repo",
    } as any);

    const res = await request(app)
      .put("/test/config/raw")
      .send({ yaml: { nested: "object" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("yaml must be a string");
  });

  it("returns 400 with yamlError when YAML is syntactically invalid", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      repoPath: "/repo",
    } as any);

    const res = await request(app).put("/test/config/raw").send({ yaml: "{ invalid: yaml: : bad" });
    expect(res.status).toBe(400);
    expect(res.body.yamlError).toBeDefined();
    expect(res.body.yamlError.line).toBeTypeOf("number");
    expect(res.body.yamlError.message).toBeTypeOf("string");
  });

  it("returns 400 with errors array when config fails schema validation", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      repoPath: "/repo",
    } as any);
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: false,
      errors: ["project.name: is required"],
      fieldErrors: [{ path: "project.name", message: "is required" }],
    } as any);

    const res = await request(app)
      .put("/test/config/raw")
      .send({ yaml: "project:\n  type: single\n" });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ path: "project.name", message: "is required" }]);
    expect(res.body.details).toEqual(["project.name: is required"]);
  });

  it("persists raw YAML verbatim and calls reloadConfig on success", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      repoPath: "/repo",
    } as any);
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.reloadConfig).mockReturnValue({} as any);

    const res = await request(app).put("/test/config/raw").send({ yaml: VALID_YAML });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/repo/.roubo/roubo.yaml");
    expect(fs.mkdirSync).toHaveBeenCalledWith("/repo/.roubo", {
      recursive: true,
    });
    expect(atomicWrite).toHaveBeenCalledWith("/repo/.roubo/roubo.yaml", VALID_YAML);
    expect(projectRegistry.reloadConfig).toHaveBeenCalledWith("test");
  });

  it("still returns 200 when reloadConfig throws after successful write", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      repoPath: "/repo",
    } as any);
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => {
      throw new Error("reload failed");
    });

    const res = await request(app).put("/test/config/raw").send({ yaml: VALID_YAML });
    expect(res.status).toBe(200);
    expect(res.body.path).toBeDefined();
  });

  it("returns 500 when atomicWrite throws", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      repoPath: "/repo",
    } as any);
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockImplementation(() => {
      throw new Error("disk full");
    });

    const res = await request(app).put("/test/config/raw").send({ yaml: VALID_YAML });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("disk full");
  });

  // Alert #43 (js/missing-rate-limiting): the config-write surface is fronted
  // by a per-route express-rate-limit middleware. A successful PUT carries the
  // draft-7 RateLimit headers, proving the limiter is wired onto the route.
  it("attaches RateLimit response headers (limiter is mounted)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      repoPath: "/repo",
    } as any);
    vi.mocked(validateConfigObject).mockReturnValue({
      valid: true,
      config: {},
    } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.reloadConfig).mockReturnValue({} as any);

    const res = await request(app).put("/test/config/raw").send({ yaml: VALID_YAML });
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

// WU-057: the three fields move to the plugin tab. These tests cover the
// new GET/PUT /integration/fields routes plus the deprecation-warning shim
// on the legacy /config/raw PUT.
describe("GET /:projectId/integration/fields", () => {
  it("returns the three fields plus layoutType", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test",
      repoPath: "/repo",
      config: {
        project: {
          name: "x",
          displayName: "X",
          repo: "acme/x",
          github: { project: 9 },
        },
        layout: { type: "meta-repo", submodules: { a: "apps/a" } },
        components: {},
        benches: { max: 5 },
      },
      configValid: true,
      settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    } as any);
    const res = await request(app).get("/test/integration/fields");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      repo: "acme/x",
      githubProject: 9,
      submodules: { a: "apps/a" },
      layoutType: "meta-repo",
    });
  });

  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get("/missing/integration/fields");
    expect(res.status).toBe(404);
  });
});

describe("PUT /:projectId/integration/fields", () => {
  beforeEach(() => {
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => ({}) as any);
    vi.mocked(validateConfigObject).mockReturnValue({ valid: true } as any);
  });

  it("persists field updates and returns the new shape", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test",
      repoPath: "/repo",
      config: {
        project: { name: "x", displayName: "X", repo: "acme/old" },
        layout: { type: "single-repo" },
        components: {},
        benches: { max: 5 },
      },
      configValid: true,
      settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    } as any);
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });

    const res = await request(app).put("/test/integration/fields").send({ repo: "acme/new" });
    expect(res.status).toBe(200);
    expect(atomicWrite).toHaveBeenCalled();
    expect(deriveGithubSourcesService.deriveAndPersistGithubSources).toHaveBeenCalledWith("test");
  });

  it("still returns 200 when derivation rejects (best-effort hook)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test",
      repoPath: "/repo",
      config: {
        project: { name: "x", displayName: "X", repo: "acme/old" },
        layout: { type: "single-repo" },
        components: {},
        benches: { max: 5 },
      },
      configValid: true,
      settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    } as any);
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });
    // The route calls deriveAndPersistGithubSources with `void`, so a rejection
    // here must not surface as a 500 to the caller.
    vi.mocked(deriveGithubSourcesService.deriveAndPersistGithubSources).mockRejectedValueOnce(
      new Error("plugin offline"),
    );
    // Swallow the unhandled-rejection warning the test runner would otherwise
    // print for the deliberately-rejected promise.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).put("/test/integration/fields").send({ repo: "acme/new" });
    expect(res.status).toBe(200);
    consoleWarn.mockRestore();
  });

  it("returns 409 when there is no active plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test",
      repoPath: "/repo",
      config: {
        project: { name: "x", displayName: "X" },
        layout: { type: "single-repo" },
        components: {},
        benches: { max: 5 },
      },
      configValid: true,
      settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    } as any);
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).put("/test/integration/fields").send({ repo: "acme/new" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_ACTIVE_PLUGIN");
  });

  it("rejects malformed payloads with 400", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test",
      repoPath: "/repo",
      config: {
        project: { name: "x", displayName: "X" },
        layout: { type: "single-repo" },
        components: {},
        benches: { max: 5 },
      },
      configValid: true,
      settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    } as any);
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });
    const res = await request(app)
      .put("/test/integration/fields")
      .send({ githubProject: "not-a-number" } as any);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD");
  });
});

describe("GET /:projectId/integration/derived-sources", () => {
  it("returns the preview shape from deriveGithubSources", async () => {
    vi.mocked(deriveGithubSourcesService.deriveGithubSources).mockResolvedValue({
      sources: {},
      preview: {
        repos: ["acme/demo"],
        projects: [{ externalId: "acme/#1", label: "Planning" }],
        alertsRequested: ["code-scanning", "secret-scanning", "dependabot"],
      },
    });

    const res = await request(app).get("/test/integration/derived-sources");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      repos: ["acme/demo"],
      projects: [{ externalId: "acme/#1", label: "Planning" }],
      alertsRequested: ["code-scanning", "secret-scanning", "dependabot"],
    });
  });

  it("returns 500 with an UNKNOWN code when derivation throws a generic error", async () => {
    vi.mocked(deriveGithubSourcesService.deriveGithubSources).mockRejectedValue(
      new Error("no project"),
    );

    const res = await request(app).get("/test/integration/derived-sources");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "no project", code: "UNKNOWN", params: {} });
  });

  it("surfaces an actionable GitHubError with its status, code, and params", async () => {
    vi.mocked(deriveGithubSourcesService.deriveGithubSources).mockRejectedValue(
      new GitHubError("ORG_APPROVAL_REQUIRED", "needs approval", 403, { owner: "acme" }),
    );

    const res = await request(app).get("/test/integration/derived-sources");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "needs approval",
      code: "ORG_APPROVAL_REQUIRED",
      params: { owner: "acme" },
    });
  });
});

describe("PUT /:projectId/config/raw deprecation shim (WU-057)", () => {
  const PLUGIN_FIELDS_YAML = [
    "project:",
    '  name: "x"',
    '  displayName: "X"',
    '  repo: "acme/x"',
    "layout:",
    '  type: "single-repo"',
    "benches:",
    "  max: 5",
    "components: {}",
    "",
  ].join("\n");

  it("logs a deprecation warning when the legacy PUT writes plugin-owned fields", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({ repoPath: "/repo" } as any);
    vi.mocked(validateConfigObject).mockReturnValue({ valid: true, config: {} } as any);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.mocked(atomicWrite).mockReturnValue(undefined as any);
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => ({}) as any);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(app).put("/test/config/raw").send({ yaml: PLUGIN_FIELDS_YAML });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/deprecated.*plugin-owned/));
    warn.mockRestore();
  });
});
