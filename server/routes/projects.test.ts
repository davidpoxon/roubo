import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";

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

import router from "./projects.js";
import * as projectRegistry from "../services/project-registry.js";
import { ProjectRegistryError } from "../services/project-registry.js";
import { parseConfig, validateConfigObject } from "../services/config-parser.js";
import { scanRepo } from "../services/repo-scanner.js";
import { atomicWrite } from "../services/state.js";
import * as githubService from "../services/github.js";

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
  it("returns 400 when repoPath is missing", async () => {
    const res = await request(app).post("/check-config").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("repoPath is required");
  });

  it("returns hasConfig:false when directory not found", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app).post("/check-config").send({ repoPath: "/nonexistent" });
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

    const res = await request(app).post("/check-config").send({ repoPath: "/repo" });
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
      repoPath: "/repo",
      configValid: false,
      settings: {
        worktreeSource: { branchFromDefault: true, pullLatest: true },
      },
    };
    vi.mocked(projectRegistry.getProjects).mockReturnValue([existingProject] as any);

    const res = await request(app).post("/check-config").send({ repoPath: "/repo" });
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
          type: "web",
        },
        ports: {},
        benches: { max: 3 },
      },
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).post("/check-config").send({ repoPath: "/repo" });
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
        project: { name: "atlas", displayName: "Atlas", type: "web" },
        ports: {
          server: { base: 5300 },
          client: { base: 5301 },
        },
        benches: { max: 4 },
      },
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).post("/check-config").send({ repoPath: "/repo" });
    expect(res.status).toBe(200);
    expect(res.body.preview).toEqual({
      name: "atlas",
      displayName: "Atlas",
      type: "web",
      ports: [
        { name: "server", base: 5300 },
        { name: "client", base: 5301 },
      ],
      benchCap: 4,
    });
  });
});

describe("POST /scan", () => {
  it("returns 400 when repoPath is missing", async () => {
    const res = await request(app).post("/scan").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("repoPath is required");
  });

  it("returns 404 when directory not found", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await request(app).post("/scan").send({ repoPath: "/nonexistent" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Directory not found: /nonexistent");
  });

  it("returns 200 with scan result on success", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const scanResult = { type: "node", services: [] };
    vi.mocked(scanRepo).mockResolvedValue(scanResult as any);

    const res = await request(app).post("/scan").send({ repoPath: "/repo" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(scanResult);
  });

  it("returns 500 when scanRepo throws", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(scanRepo).mockRejectedValue(new Error("scan failed"));

    const res = await request(app).post("/scan").send({ repoPath: "/repo" });
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
    expect(res.body.error).toBe("Invalid config");
    expect(res.body.errors).toEqual([{ path: "project.name", message: "is required" }]);
    expect(res.body.details).toEqual(["project.name: is required"]);
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
  it("returns 404 when project is not registered", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 404 when project has no repo configured", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: {} },
    } as any);

    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(404);
  });

  it("returns not-connected when github token is missing", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.getGithubToken).mockReturnValue(undefined);

    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: false,
      reason: "not-connected",
      types: [],
    });
    expect(githubService.fetchIssueTypes).not.toHaveBeenCalled();
  });

  it("returns issue types when repo is configured", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.getGithubToken).mockReturnValue("ghp_token");
    const response = {
      configured: true,
      types: [{ id: "it-1", name: "Bug", color: "#d73a4a" }],
    };
    vi.mocked(githubService.fetchIssueTypes).mockResolvedValue(response);

    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(response);
    expect(githubService.fetchIssueTypes).toHaveBeenCalledWith("org/repo");
  });

  it("returns none-defined response from fetcher transparently", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.getGithubToken).mockReturnValue("ghp_token");
    vi.mocked(githubService.fetchIssueTypes).mockResolvedValue({
      configured: false,
      reason: "none-defined",
      types: [],
    });

    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.reason).toBe("none-defined");
  });

  it("returns 401 with NOT_CONNECTED code when fetchIssueTypes throws despite token being present", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.getGithubToken).mockReturnValue("ghp_token");
    const notConnected = Object.assign(new Error("GitHub is not connected"), {
      code: "NOT_CONNECTED",
      status: 401,
    });
    vi.mocked(githubService.fetchIssueTypes).mockRejectedValue(notConnected);

    const res = await request(app).get("/project/issue-types");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("NOT_CONNECTED");
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
});
