import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
  reloadConfig: vi.fn(),
}));

vi.mock("../services/state.js", () => ({
  atomicWrite: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realReadFileSync = actual.default.readFileSync as (...args: unknown[]) => unknown;
  return {
    default: {
      ...actual.default,
      // Scope the stub to the project roubo.yaml only; delegate every other path
      // to the real implementation. A blanket stub that returns a constant for
      // all reads corrupts unrelated fs access in the request pipeline, which
      // makes express-rate-limit emit a spurious X-Forwarded-For validation
      // warning once the overrides limiter is mounted on the PUT route.
      readFileSync: vi.fn((path: unknown, ...rest: unknown[]): unknown =>
        typeof path === "string" && path.endsWith("roubo.yaml")
          ? "benches:\n  max: 3\n"
          : realReadFileSync(path, ...rest),
      ),
      mkdirSync: vi.fn(),
    },
  };
});

vi.mock("yaml", () => ({
  parse: vi.fn().mockReturnValue({}),
  stringify: vi.fn().mockReturnValue("benches:\n  max: 3\n"),
}));

import router from "./benches-settings.js";
import * as projectRegistry from "../services/project-registry.js";
import * as state from "../services/state.js";
import * as YAML from "yaml";

const app = express();
app.use(express.json());
app.use("/", router);

const MOCK_PROJECT = {
  id: "project-1",
  repoPath: "/repo/path",
  config: {
    project: { name: "project", displayName: "My Project" },
    benches: { max: 3 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectRegistry.getProject).mockReturnValue(MOCK_PROJECT as never);
  vi.mocked(YAML.parse).mockReturnValue({ benches: { max: 3 } });
  vi.mocked(YAML.stringify).mockReturnValue("benches:\n  max: 3\n");
  vi.mocked(state.atomicWrite).mockReturnValue(undefined);
  vi.mocked(projectRegistry.reloadConfig).mockReturnValue({} as never);
});

describe("GET /:projectId/benches/overrides", () => {
  it("returns all nulls when no bench overrides are set", async () => {
    const res = await request(app).get("/project-1/benches/overrides");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforceIssueDependencies: null,
    });
  });

  it("returns set values when overrides exist in project config", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      ...MOCK_PROJECT,
      config: {
        ...MOCK_PROJECT.config,
        benches: {
          max: 3,
          enforceIssueDependencies: false,
        },
      },
    } as never);
    const res = await request(app).get("/project-1/benches/overrides");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforceIssueDependencies: false,
    });
  });

  it("returns 404 when project is not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get("/nonexistent/benches/overrides");
    expect(res.status).toBe(404);
  });
});

describe("PUT /:projectId/benches/overrides", () => {
  it("sets enforceIssueDependencies to true and persists", async () => {
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: true });
    expect(res.status).toBe(200);
    expect(res.body.enforceIssueDependencies).toBe(true);
    expect(state.atomicWrite).toHaveBeenCalled();
    expect(projectRegistry.reloadConfig).toHaveBeenCalledWith("project-1");
    const dumped = vi.mocked(YAML.stringify).mock.calls[0][0] as Record<string, unknown>;
    expect((dumped.benches as Record<string, unknown>).enforceIssueDependencies).toBe(true);
  });

  it("removes enforceIssueDependencies key when null is sent, preserving other benches fields", async () => {
    vi.mocked(YAML.parse).mockReturnValue({
      benches: { max: 3, enforceIssueDependencies: true },
    });
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: null });
    expect(res.status).toBe(200);
    expect(res.body.enforceIssueDependencies).toBe(null);
    const dumped = vi.mocked(YAML.stringify).mock.calls[0][0] as Record<string, unknown>;
    const benches = dumped.benches as Record<string, unknown>;
    expect(benches.max).toBe(3);
    expect("enforceIssueDependencies" in benches).toBe(false);
  });

  it("no-ops gracefully when null is sent and no benches section exists", async () => {
    vi.mocked(YAML.parse).mockReturnValue({ jigs: {} });
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: null });
    expect(res.status).toBe(200);
    expect(state.atomicWrite).not.toHaveBeenCalled();
  });

  it("returns 404 when project is not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app)
      .put("/nonexistent/benches/overrides")
      .send({ enforceIssueDependencies: true });
    expect(res.status).toBe(404);
  });

  it("returns 400 when a field is a string instead of boolean", async () => {
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/boolean/);
  });

  it("returns 400 when a field is a number instead of boolean", async () => {
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/boolean/);
  });

  it("returns 200 and skips disk write when body is empty", async () => {
    const res = await request(app).put("/project-1/benches/overrides").send({});
    expect(res.status).toBe(200);
    expect(state.atomicWrite).not.toHaveBeenCalled();
  });

  it("skips disk write and returns all-null when nulling a key that was never set", async () => {
    vi.mocked(YAML.parse).mockReturnValue({});
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforceIssueDependencies: null,
    });
    expect(state.atomicWrite).not.toHaveBeenCalled();
  });

  it("returns 500 when atomicWrite throws", async () => {
    vi.mocked(state.atomicWrite).mockImplementation(() => {
      throw new Error("Disk full");
    });
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Disk full");
  });

  it("treats non-object YAML root as empty config", async () => {
    vi.mocked(YAML.parse).mockReturnValue("just a string");
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: true });
    expect(res.status).toBe(200);
    const dumped = vi.mocked(YAML.stringify).mock.calls[0][0] as Record<string, unknown>;
    expect((dumped.benches as Record<string, unknown>).enforceIssueDependencies).toBe(true);
  });

  it("succeeds even when reloadConfig throws", async () => {
    vi.mocked(projectRegistry.reloadConfig).mockImplementation(() => {
      throw new Error("reload failed");
    });
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: true });
    expect(res.status).toBe(200);
  });

  // The PUT handler reads/writes roubo.yaml on disk, so it is rate-limited
  // (CodeQL js/missing-rate-limiting #35). Asserting the draft-7 RateLimit
  // headers proves the limiter is wired onto the route.
  it("attaches RateLimit response headers (limiter is mounted)", async () => {
    const res = await request(app)
      .put("/project-1/benches/overrides")
      .send({ enforceIssueDependencies: true });
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});
