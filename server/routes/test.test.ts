import fs from "node:fs";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// Redirect getRouboDir() away from the user's real `~/.roubo` (or
// `~/.roubo-dev/<bench>`) so wipePersistedTestState() targets a throwaway
// tmp directory. resolveRouboDir() caches its result at module-load time;
// without this mock, the suite would wipe real state on any developer
// machine whose shell exports ROUBO_PRODUCTION=1. The tmp dir is placed
// under a `.roubo-dev` segment so the route's path-shape guard accepts it
// as a dev path. The path is computed without `fs`/`os`/`path` so it can run
// inside vi.hoisted before the regular import bindings have been initialised.
const { TEST_TMP_ROOT, TEST_ROUBO_DIR } = vi.hoisted(() => {
  const sep = process.platform === "win32" ? "\\" : "/";
  const tmpRoot = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}${sep}roubo-test-route-${process.pid}-${Date.now()}`;
  const rouboDir = `${tmpRoot}${sep}.roubo-dev${sep}test-bench`;
  return { TEST_TMP_ROOT: tmpRoot, TEST_ROUBO_DIR: rouboDir };
});
// Ensure the tmp dir exists once the regular imports have run. The mock
// factory only needs the path string, so a deferred mkdir is fine.
fs.mkdirSync(TEST_ROUBO_DIR, { recursive: true });

vi.mock("../services/plugin-manager.js", () => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  __test: {
    resetConnectionStatusCache: vi.fn(),
    resetE2EConnectionStateLogTap: vi.fn(),
    getE2EConnectionStateLogTap: vi.fn(() => []),
    setE2EConfig: vi.fn(),
    crashRunningPlugin: vi.fn(() => ({ pid: 12345 })),
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

vi.mock("../services/plugin-enable-state.js", () => ({
  setPluginEnabled: vi.fn(),
  loadEnableState: vi.fn(() => ({
    schemaVersion: 1,
    plugins: {},
    installInitialized: true,
  })),
}));

vi.mock("../services/state.js", () => ({
  removeProject: vi.fn(),
  addBench: vi.fn(),
  getRouboDir: () => TEST_ROUBO_DIR,
}));

vi.mock("../services/integration-overrides.js", () => ({
  saveOverride: vi.fn(),
  removeOverride: vi.fn(),
}));

vi.mock("../services/bench-manager.js", () => ({
  __test: {
    reloadFromState: vi.fn(),
  },
}));

import router from "./test.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";
import * as state from "../services/state.js";
import * as pluginEnableState from "../services/plugin-enable-state.js";
import * as integrationOverrides from "../services/integration-overrides.js";
import { BUNDLED_PLUGIN_IDS } from "@roubo/shared";

const app = express();
app.use(express.json());
app.use("/test", router);

const originalRouboE2E = process.env.ROUBO_E2E;
const originalRouboProduction = process.env.ROUBO_PRODUCTION;

beforeAll(() => {
  delete process.env.ROUBO_E2E;
  // wipePersistedTestState refuses to run when ROUBO_PRODUCTION is set; the
  // route returns 500 instead of 200 in that case. Roubo dev shells often
  // export ROUBO_PRODUCTION=1, so explicitly clear it for the duration of
  // this suite and restore afterwards.
  delete process.env.ROUBO_PRODUCTION;
});

afterAll(() => {
  if (originalRouboE2E === undefined) {
    delete process.env.ROUBO_E2E;
  } else {
    process.env.ROUBO_E2E = originalRouboE2E;
  }
  if (originalRouboProduction === undefined) {
    delete process.env.ROUBO_PRODUCTION;
  } else {
    process.env.ROUBO_PRODUCTION = originalRouboProduction;
  }
  fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
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
  delete process.env.ROUBO_PRODUCTION;
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
    expect(pluginManager.__test.resetE2EConnectionStateLogTap).toHaveBeenCalledTimes(1);
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
    // WU-068 (#159): every bundled plugin id is force-enabled on reset so
    // the project-settings specs can drive the overlay slots.
    // TC-154 (#222): known fixture failure plugins (e.g. broken-plugin) are
    // force-disabled so they don't auto-spawn and crash on every reset.
    const FAILURE_FIXTURE_IDS = ["broken-plugin"];
    expect(pluginEnableState.setPluginEnabled).toHaveBeenCalledTimes(
      BUNDLED_PLUGIN_IDS.length + FAILURE_FIXTURE_IDS.length,
    );
    for (const id of BUNDLED_PLUGIN_IDS) {
      expect(pluginEnableState.setPluginEnabled).toHaveBeenCalledWith(id, true);
    }
    for (const id of FAILURE_FIXTURE_IDS) {
      expect(pluginEnableState.setPluginEnabled).toHaveBeenCalledWith(id, false);
    }

    const order = [
      vi.mocked(migrate.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(githubOauth.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.__test.resetConnectionStatusCache).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.__test.resetE2EConnectionStateLogTap).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.shutdown).mock.invocationCallOrder[0],
      vi.mocked(projectRegistry.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(projectRegistry.initialize).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.__test.setE2EConfig).mock.invocationCallOrder[0],
      vi.mocked(pluginEnableState.setPluginEnabled).mock.invocationCallOrder[0],
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

  // Safety: even though the route is gated on ROUBO_E2E=1, the destructive
  // wipe helper has its own ROUBO_PRODUCTION guard so a deployment that
  // exports both env vars cannot blow away the real `~/.roubo` directory.
  it("returns 500 and does not re-initialize when both ROUBO_E2E and ROUBO_PRODUCTION are set", async () => {
    process.env.ROUBO_E2E = "1";
    process.env.ROUBO_PRODUCTION = "1";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ROUBO_PRODUCTION/);
    expect(consoleSpy).toHaveBeenCalled();
    expect(projectRegistry.initialize).not.toHaveBeenCalled();
    expect(pluginManager.initialize).not.toHaveBeenCalled();
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

  // WU-066 (TC-171/TC-172): when the caller passes `bundledPluginsDisabled:
  // true` the reset writes every bundled plugin id as "disabled" instead of
  // force-enabling them, so the project-load Enable-plugin prompt fires for
  // the next spec. TC-154 (#222): disableFailureFixturePlugins() also fires
  // regardless of the bundledPluginsDisabled flag, so the call count includes
  // those ids (broken-plugin) as well.
  it("writes every bundled plugin id as disabled when bundledPluginsDisabled: true", async () => {
    process.env.ROUBO_E2E = "1";
    const FAILURE_FIXTURE_IDS = ["broken-plugin"];

    const res = await request(app).post("/test/__reset").send({ bundledPluginsDisabled: true });

    expect(res.status).toBe(200);
    expect(pluginEnableState.setPluginEnabled).toHaveBeenCalledTimes(
      BUNDLED_PLUGIN_IDS.length + FAILURE_FIXTURE_IDS.length,
    );
    for (const id of BUNDLED_PLUGIN_IDS) {
      expect(pluginEnableState.setPluginEnabled).toHaveBeenCalledWith(id, false);
    }
    for (const id of FAILURE_FIXTURE_IDS) {
      expect(pluginEnableState.setPluginEnabled).toHaveBeenCalledWith(id, false);
    }
  });

  it("returns 400 when bundledPluginsDisabled is not a boolean", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset").send({ bundledPluginsDisabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bundledPluginsDisabled/);
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
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

  // TC-164: omitting `plugin` registers the fixture project without writing an
  // integration override so the IssueSourceTile renders its UnconfiguredBody
  // variant. Used by the e2e spec that drives the SwitchIntegrationDialog UI
  // to pin a plugin from a truly unconfigured starting state.
  it("registers the fixture project without an override when plugin is omitted", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-no-plugin" });

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe("fixture-no-plugin");
    createdTmpdirs.push(res.body.repoPath);

    expect(projectRegistry.registerProject).toHaveBeenCalledTimes(1);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when plugin is provided but empty", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plugin/);
    expect(projectRegistry.registerProject).not.toHaveBeenCalled();
  });

  it("returns 400 when integrationConfig is provided without plugin", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({
        projectId: "fixture-a",
        integrationConfig: { instance: "https://ghe.example.com" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/integrationConfig requires `plugin`/);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
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

  // TC-164/167/177: an optional `projectRepo` is written under `project.repo`
  // in the generated roubo.yaml so the github-com Configure modal's
  // derived-sources preview can reach its success state.
  it("writes projectRepo under project.repo in the fixture roubo.yaml", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-with-repo", plugin: "github-com", projectRepo: "acme/widgets" });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).toMatch(/^\s{2}repo: acme\/widgets$/m);
  });

  it("omits project.repo when projectRepo is not provided", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-no-repo", plugin: "e2e-stub" });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).not.toMatch(/\brepo:/);
  });

  it("returns 400 when projectRepo is provided but empty", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "github-com", projectRepo: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectRepo/);
    expect(projectRegistry.registerProject).not.toHaveBeenCalled();
  });

  it("merges optional integrationConfig into the saved override alongside plugin", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({
        projectId: "fixture-with-instance",
        plugin: "ghe",
        integrationConfig: {
          instance: "https://ghe.example.com",
          sources: { repo: [{ externalId: "acme/widgets" }] },
        },
      });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    expect(integrationOverrides.saveOverride).toHaveBeenCalledWith("fixture-with-instance", {
      schemaVersion: 1,
      integration: {
        instance: "https://ghe.example.com",
        sources: { repo: [{ externalId: "acme/widgets" }] },
        plugin: "ghe",
      },
    });
  });

  it("returns 400 when integrationConfig is not an object", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-a", plugin: "e2e-stub", integrationConfig: "nope" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/integrationConfig/);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when integrationConfig nests `plugin`", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({
        projectId: "fixture-a",
        plugin: "e2e-stub",
        integrationConfig: { plugin: "ghe" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plugin/);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when integrationConfig fails schema validation", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({
        projectId: "fixture-a",
        plugin: "e2e-stub",
        // pageSize must be a positive integer; -1 fails the schema.
        integrationConfig: { pageSize: -1 },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/integrationConfig failed validation/);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
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

  // TC-161: optional seedBenches input persists PersistedBench rows alongside
  // the fixture project so specs can drive surfaces that depend on a bench
  // pre-dating a later mutation (e.g. the "Issue from previous integration"
  // badge after an integration switch).
  describe("seedBenches option (TC-161)", () => {
    it("persists each seeded bench via state.addBench and reloads bench-manager", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({
          projectId: "tc-161",
          plugin: "github-com",
          seedBenches: [
            {
              assignedIssue: {
                number: 101,
                integrationId: "github-com",
                externalId: "acme/widgets#101",
                title: "Pre-switch bench 1",
              },
            },
            {
              assignedIssue: {
                number: 102,
                integrationId: "github-com",
                externalId: "acme/widgets#102",
                title: "Pre-switch bench 2",
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      createdTmpdirs.push(res.body.repoPath);

      expect(state.addBench).toHaveBeenCalledTimes(2);
      const firstCall = vi.mocked(state.addBench).mock.calls[0][0];
      const secondCall = vi.mocked(state.addBench).mock.calls[1][0];
      expect(firstCall.id).toBe(1);
      expect(firstCall.projectId).toBe("tc-161");
      expect(firstCall.assignedIssue?.integrationId).toBe("github-com");
      expect(firstCall.assignedIssue?.number).toBe(101);
      // Each bench gets its own tmpdir-backed workspacePath so the seeded
      // bench is not flagged as missing by reconcile.
      expect(typeof firstCall.workspacePath).toBe("string");
      expect(firstCall.workspacePath.length).toBeGreaterThan(0);
      expect(secondCall.id).toBe(2);
      expect(secondCall.workspacePath).not.toBe(firstCall.workspacePath);
      expect(fs.existsSync(firstCall.workspacePath)).toBe(true);
      expect(fs.existsSync(secondCall.workspacePath)).toBe(true);
      createdTmpdirs.push(firstCall.workspacePath, secondCall.workspacePath);

      expect(benchManager.__test.reloadFromState).toHaveBeenCalledTimes(1);
    });

    it("does not call bench-manager.reloadFromState when seedBenches is empty", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "fixture-no-seeds", plugin: "e2e-stub", seedBenches: [] });

      expect(res.status).toBe(200);
      createdTmpdirs.push(res.body.repoPath);
      expect(state.addBench).not.toHaveBeenCalled();
      expect(benchManager.__test.reloadFromState).not.toHaveBeenCalled();
    });

    it("returns 400 when seedBenches is not an array", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "fixture-a", plugin: "e2e-stub", seedBenches: "nope" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/seedBenches/);
      expect(state.addBench).not.toHaveBeenCalled();
    });

    it("returns 400 when a seedBenches entry omits assignedIssue.integrationId", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({
          projectId: "fixture-a",
          plugin: "e2e-stub",
          seedBenches: [
            {
              assignedIssue: {
                number: 1,
                externalId: "acme/widgets#1",
                title: "Missing integrationId",
              },
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/integrationId/);
      expect(state.addBench).not.toHaveBeenCalled();
    });

    it("returns 400 when a seedBenches entry has a non-integer number", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({
          projectId: "fixture-a",
          plugin: "e2e-stub",
          seedBenches: [
            {
              assignedIssue: {
                number: 1.5,
                integrationId: "github-com",
                externalId: "acme/widgets#1",
                title: "Bad number",
              },
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/integer/);
      expect(state.addBench).not.toHaveBeenCalled();
    });

    it("rolls back seeded workspace tmpdirs when a later step throws", async () => {
      process.env.ROUBO_E2E = "1";
      // Capture the tmpdir paths the route mints before the throw so we can
      // assert they were rm'd.
      const seededPaths: string[] = [];
      vi.mocked(state.addBench).mockImplementation((bench) => {
        seededPaths.push(bench.workspacePath);
      });
      vi.mocked(benchManager.__test.reloadFromState).mockImplementationOnce(() => {
        throw new Error("reload-boom");
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({
          projectId: "fixture-rollback",
          plugin: "e2e-stub",
          seedBenches: [
            {
              assignedIssue: {
                number: 1,
                integrationId: "github-com",
                externalId: "x#1",
                title: "x",
              },
            },
          ],
        });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("reload-boom");
      expect(seededPaths.length).toBe(1);
      // The rollback path rm'd the seeded workspace tmpdir.
      expect(fs.existsSync(seededPaths[0])).toBe(false);
      consoleSpy.mockRestore();
    });
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

    // Saved during the register call: clear so we can assert the reset
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

  // TC-161: /__reset also rms the per-bench workspace tmpdirs that
  // `seedBenches` minted. wipePersistedTestState() truncates state.json so
  // bench rows themselves are gone after reset, but the on-disk tmpdir would
  // otherwise survive between specs and leak into os.tmpdir() over a run.
  it("removes seeded workspace tmpdirs alongside the fixture repoPath", async () => {
    process.env.ROUBO_E2E = "1";
    const seededPaths: string[] = [];
    vi.mocked(state.addBench).mockImplementation((bench) => {
      seededPaths.push(bench.workspacePath);
    });

    const registered = await request(app)
      .post("/test/__register-fixture-project")
      .send({
        projectId: "fixture-with-seeds",
        plugin: "e2e-stub",
        seedBenches: [
          {
            assignedIssue: {
              number: 1,
              integrationId: "github-com",
              externalId: "acme/widgets#1",
              title: "seed",
            },
          },
        ],
      });
    expect(registered.status).toBe(200);
    createdTmpdirs.push(registered.body.repoPath);
    expect(seededPaths.length).toBe(1);
    expect(fs.existsSync(seededPaths[0])).toBe(true);

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(200);
    expect(fs.existsSync(seededPaths[0])).toBe(false);
  });
});

// TC-153 e2e tap endpoint. Reads the ROUBO_E2E=1-only buffer that mirrors
// every structured connection-state log line emitted by
// `recordConnectionStateTransition`.
describe("GET /test/__connection-state-log", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).get("/test/__connection-state-log");

    expect(res.status).toBe(404);
    expect(pluginManager.__test.getE2EConnectionStateLogTap).not.toHaveBeenCalled();
  });

  it("returns the tap payload when ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";
    const entry = {
      event: "plugin.connection-state.changed" as const,
      pluginId: "e2e-stub",
      previousState: "connected" as const,
      newState: "auth-problem" as const,
      trigger: "ui-recheck",
      at: "2026-05-22T09:00:00.000Z",
    };
    vi.mocked(pluginManager.__test.getE2EConnectionStateLogTap).mockReturnValueOnce([entry]);

    const res = await request(app).get("/test/__connection-state-log");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [entry] });
  });
});

// TC-154 (#222): read-only mirror of plugins-state.json so a spec can assert
// the NFR-024 invariant ("plugin remains in its previous disabled state on
// spawn failure") without poking the filesystem from the test process.
describe("GET /test/__plugin-enable-state", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).get("/test/__plugin-enable-state");

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(pluginEnableState.loadEnableState).not.toHaveBeenCalled();
  });

  it("returns the persisted plugin map when ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(pluginEnableState.loadEnableState).mockReturnValueOnce({
      schemaVersion: 1,
      plugins: { "github-com": "enabled", "broken-plugin": "disabled" },
      installInitialized: true,
    });

    const res = await request(app).get("/test/__plugin-enable-state");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      plugins: { "github-com": "enabled", "broken-plugin": "disabled" },
    });
  });
});

describe("POST /test/__crash-plugin (TC-163, #240)", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).post("/test/__crash-plugin").send({ pluginId: "e2e-stub" });
    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(pluginManager.__test.crashRunningPlugin).not.toHaveBeenCalled();
  });

  it("returns 400 when pluginId is missing", async () => {
    process.env.ROUBO_E2E = "1";
    const res = await request(app).post("/test/__crash-plugin").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kebab-case/);
    expect(pluginManager.__test.crashRunningPlugin).not.toHaveBeenCalled();
  });

  it("returns 400 when pluginId is not kebab-case", async () => {
    process.env.ROUBO_E2E = "1";
    const res = await request(app).post("/test/__crash-plugin").send({ pluginId: "Not_Kebab" });
    expect(res.status).toBe(400);
    expect(pluginManager.__test.crashRunningPlugin).not.toHaveBeenCalled();
  });

  it("returns 200 and the SIGKILLed pid on success", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(pluginManager.__test.crashRunningPlugin).mockReturnValueOnce({ pid: 4242 });
    const res = await request(app).post("/test/__crash-plugin").send({ pluginId: "e2e-stub" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, pid: 4242 });
    expect(pluginManager.__test.crashRunningPlugin).toHaveBeenCalledWith("e2e-stub");
  });

  it("returns 409 when the plugin is not running", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(pluginManager.__test.crashRunningPlugin).mockImplementationOnce(() => {
      throw new Error('Plugin "e2e-stub" is not running (status=disabled)');
    });
    const res = await request(app).post("/test/__crash-plugin").send({ pluginId: "e2e-stub" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not running/);
  });
});
