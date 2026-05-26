import fs from "node:fs";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/plugin-manager.js", () => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  __test: {
    resetConnectionStatusCache: vi.fn(),
    resetConnectionStateLog: vi.fn(),
    getConnectionStateLog: vi.fn(() => []),
    setE2EConfig: vi.fn(),
  },
}));

vi.mock("../services/project-registry.js", () => ({
  initialize: vi.fn(),
  registerProject: vi.fn((repoPath: string) => ({
    id: "ignored",
    repoPath,
    config: undefined,
    configValid: true,
    settings: {},
  })),
  unregisterProject: vi.fn(),
  __test: {
    reset: vi.fn(),
  },
}));

vi.mock("../services/migrate.js", () => ({
  __test: {
    reset: vi.fn(),
  },
}));

vi.mock("../services/github-oauth.js", () => ({
  __test: {
    reset: vi.fn(),
  },
}));

vi.mock("../services/state.js", () => ({
  removeProject: vi.fn(),
}));

vi.mock("../services/integration-overrides.js", () => ({
  saveOverride: vi.fn(),
  removeOverride: vi.fn(),
}));

import router from "./test.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";
import * as state from "../services/state.js";
import * as integrationOverrides from "../services/integration-overrides.js";

const app = express();
app.use(express.json());
app.use("/test", router);

const originalRouboE2E = process.env.ROUBO_E2E;

beforeAll(() => {
  delete process.env.ROUBO_E2E;
});

afterAll(() => {
  if (originalRouboE2E === undefined) {
    delete process.env.ROUBO_E2E;
  } else {
    process.env.ROUBO_E2E = originalRouboE2E;
  }
});

function installDefaultRegisterProjectMock(): void {
  vi.mocked(projectRegistry.registerProject).mockImplementation((repoPath: string) => ({
    id: "ignored",
    repoPath,
    config: undefined,
    configValid: true,
    settings: {} as never,
  }));
}

beforeEach(async () => {
  delete process.env.ROUBO_E2E;
  vi.clearAllMocks();
  installDefaultRegisterProjectMock();

  // Wipe the module-level fixtureProjects Map between tests via the same
  // path real callers use. Mocks are cleared again after so assertions see
  // a zero call count.
  process.env.ROUBO_E2E = "1";
  await request(app).post("/test/__reset");
  delete process.env.ROUBO_E2E;
  vi.clearAllMocks();
  installDefaultRegisterProjectMock();
});

// Track tmpdirs the register-fixture route may have created so a failed test
// doesn't leak directories under os.tmpdir(). Populated by the register test
// from the response body, cleared in afterEach.
const createdTmpdirs: string[] = [];
afterEach(() => {
  while (createdTmpdirs.length > 0) {
    const dir = createdTmpdirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
});

describe("POST /test/__reset", () => {
  // TC-177: production-disabled behaviour. The route must be a no-op 404
  // whenever the gate env var isn't set, so that production HTTP probes
  // can't accidentally wipe live state.
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(migrate.__test.reset).not.toHaveBeenCalled();
    expect(githubOauth.__test.reset).not.toHaveBeenCalled();
    expect(pluginManager.__test.resetConnectionStatusCache).not.toHaveBeenCalled();
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
    expect(projectRegistry.__test.reset).not.toHaveBeenCalled();
    expect(projectRegistry.initialize).not.toHaveBeenCalled();
    expect(pluginManager.initialize).not.toHaveBeenCalled();
  });

  it("returns 404 when ROUBO_E2E is set to a value other than '1'", async () => {
    process.env.ROUBO_E2E = "true";

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(404);
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
  });

  // TC-183 (singleton side): when the gate is on, every reset hook fires in
  // the documented order. Order matters because project-registry must be
  // reloaded before plugin-manager re-initializes (plugin discovery sees the
  // new project set).
  it("returns 200 and resets all singletons when ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(migrate.__test.reset).toHaveBeenCalledTimes(1);
    expect(githubOauth.__test.reset).toHaveBeenCalledTimes(1);
    expect(pluginManager.__test.resetConnectionStatusCache).toHaveBeenCalledTimes(1);
    expect(pluginManager.__test.resetConnectionStateLog).toHaveBeenCalledTimes(1);
    expect(pluginManager.shutdown).toHaveBeenCalledTimes(1);
    expect(projectRegistry.__test.reset).toHaveBeenCalledTimes(1);
    expect(projectRegistry.initialize).toHaveBeenCalledTimes(1);
    expect(pluginManager.initialize).toHaveBeenCalledTimes(1);
    // No body: setE2EConfig still fires with null/null so any prior pinning is
    // cleared on a plain reset.
    expect(pluginManager.__test.setE2EConfig).toHaveBeenCalledWith({
      scenario: null,
      now: null,
    });

    const order = [
      vi.mocked(migrate.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(githubOauth.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.__test.resetConnectionStatusCache).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.__test.resetConnectionStateLog).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.shutdown).mock.invocationCallOrder[0],
      vi.mocked(projectRegistry.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(projectRegistry.initialize).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.__test.setE2EConfig).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.initialize).mock.invocationCallOrder[0],
    ];
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });

  it("returns 500 with the error message when a reset step throws", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(pluginManager.shutdown).mockRejectedValueOnce(new Error("boom"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "boom" });
    expect(consoleSpy).toHaveBeenCalledWith("/test/__reset failed:", "boom");
  });

  // WU-063: optional { scenario, now } body pins the stubbed plugin for the
  // next spawn. Validate the happy path, then the validation guards.
  it("forwards a valid { scenario, now } body to plugin-manager.setE2EConfig", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__reset")
      .send({ scenario: "github-com-multi-list", now: "2026-05-21T12:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(pluginManager.__test.setE2EConfig).toHaveBeenCalledWith({
      scenario: "github-com-multi-list",
      now: "2026-05-21T12:00:00.000Z",
    });
  });

  it("returns 400 when scenario is not kebab-case", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset").send({ scenario: "Bad_Name" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kebab-case/);
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
  });

  it("returns 400 when scenario is not a string", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset").send({ scenario: 123 });

    expect(res.status).toBe(400);
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
  });

  it("returns 400 when now is not a parseable ISO string", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset").send({ now: "not-a-date" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ISO-8601/);
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
  });

  it("accepts a body with only scenario or only now", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset").send({ scenario: "only-scenario" });

    expect(res.status).toBe(200);
    expect(pluginManager.__test.setE2EConfig).toHaveBeenCalledWith({
      scenario: "only-scenario",
      now: null,
    });
  });
});

// #232: register a fixture project for one spec, with cleanup folded into
// the existing /test/__reset so successive specs start clean.
describe("POST /test/__register-fixture-project", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "e2e-stub" });

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(projectRegistry.registerProject).not.toHaveBeenCalled();
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when projectId is missing", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__register-fixture-project").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/);
    expect(projectRegistry.registerProject).not.toHaveBeenCalled();
  });

  it("returns 400 when projectId is not kebab-case", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "Bad_Name", plugin: "e2e-stub" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kebab-case/);
  });

  it("returns 400 when plugin is missing", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plugin/);
    expect(projectRegistry.registerProject).not.toHaveBeenCalled();
  });

  // Happy path: a real tmpdir is created, the route hands the path to the
  // mocked registerProject + saveOverride, and returns both to the caller.
  it("returns 200 with { projectId, repoPath } on success", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "e2e-stub" });

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe("fixture-a");
    expect(typeof res.body.repoPath).toBe("string");
    createdTmpdirs.push(res.body.repoPath);

    // The route wrote a .roubo/roubo.yaml into the tmpdir before calling
    // registerProject; verify the file exists since downstream specs depend
    // on this contract.
    expect(fs.existsSync(`${res.body.repoPath}/.roubo/roubo.yaml`)).toBe(true);

    expect(projectRegistry.registerProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(projectRegistry.registerProject).mock.calls[0][0]).toBe(res.body.repoPath);

    expect(integrationOverrides.saveOverride).toHaveBeenCalledTimes(1);
    expect(integrationOverrides.saveOverride).toHaveBeenCalledWith("fixture-a", {
      schemaVersion: 1,
      integration: { plugin: "e2e-stub" },
    });
  });

  it("returns 409 when the same projectId is registered twice without a reset", async () => {
    process.env.ROUBO_E2E = "1";

    const first = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "e2e-stub" });
    expect(first.status).toBe(200);
    createdTmpdirs.push(first.body.repoPath);

    const second = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "e2e-stub" });

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already/);
  });

  // Failure roll-back: when registerProject throws (e.g. invalid roubo.yaml
  // or port conflict), the tmpdir, override, and registry entry are all
  // unwound so a retry can succeed.
  it("rolls back on failure: removes tmpdir + override + registry entry", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(projectRegistry.registerProject).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "e2e-stub" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("boom");
    expect(projectRegistry.unregisterProject).toHaveBeenCalledWith("fixture-a", { force: true });
    expect(integrationOverrides.removeOverride).toHaveBeenCalledWith("fixture-a");
    expect(consoleSpy).toHaveBeenCalledWith("/test/__register-fixture-project failed:", "boom");

    // saveOverride should not have been invoked because registerProject
    // failed before it could run.
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });
});

// #232: /test/__reset cleans up any fixture projects that were registered
// via __register-fixture-project, so the next spec sees a fresh registry.
describe("POST /test/__reset (fixture cleanup)", () => {
  it("removes integration override + persisted project + tmpdir for each fixture", async () => {
    process.env.ROUBO_E2E = "1";

    const registered = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "e2e-stub" });
    expect(registered.status).toBe(200);
    const tmpdir = registered.body.repoPath as string;
    createdTmpdirs.push(tmpdir);
    expect(fs.existsSync(tmpdir)).toBe(true);

    // Saved during the register call — clear so we can assert the reset
    // cleanup separately.
    vi.mocked(integrationOverrides.saveOverride).mockClear();

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(200);
    expect(integrationOverrides.removeOverride).toHaveBeenCalledWith("fixture-a");
    expect(state.removeProject).toHaveBeenCalledWith("fixture-a");
    expect(fs.existsSync(tmpdir)).toBe(false);
  });

  it("does not call fixture cleanup when no fixture projects are registered", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(200);
    expect(integrationOverrides.removeOverride).not.toHaveBeenCalled();
    expect(state.removeProject).not.toHaveBeenCalled();
  });
});

// WU-064: stand-in journal endpoint, removed when #221 (TC-153) ships the
// durable observability logging.
describe("GET /test/__connection-state-log", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).get("/test/__connection-state-log");

    expect(res.status).toBe(404);
    expect(pluginManager.__test.getConnectionStateLog).not.toHaveBeenCalled();
  });

  it("returns the journal payload when ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";
    const entry = {
      pluginId: "e2e-stub",
      previousState: "connected" as const,
      newState: "auth-problem" as const,
      trigger: "ui-recheck",
      at: "2026-05-22T09:00:00.000Z",
    };
    vi.mocked(pluginManager.__test.getConnectionStateLog).mockReturnValueOnce([entry]);

    const res = await request(app).get("/test/__connection-state-log");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [entry] });
  });
});
