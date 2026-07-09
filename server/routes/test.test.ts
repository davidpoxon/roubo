import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { resolveWithin, resolveWithinRoots } from "../lib/safe-path.js";

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

// The router installs an express-rate-limit middleware (120 req/min/IP). This
// suite fires well over 120 requests in a single Vitest window, so without
// stubbing the limiter later tests start returning 429. Replace it with a
// pass-through middleware; the limiter's presence is asserted by CodeQL on the
// source, not exercised here.
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/plugin-manager.js", () => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  // #313 (CPHM-TC-041): the genuine offline first-run seed the
  // /test/__seed-fresh-launch route drives. Mocked so the unit suite asserts the
  // route wiring (env override, snapshot, idempotency) without running the real
  // installer; per-test impls simulate a seed install into the env-pointed tmp
  // user root.
  seedFromBundled: vi.fn().mockResolvedValue(undefined),
  SEED_PLUGIN_IDS: ["github-com", "process", "database"],
  __test: {
    resetConnectionStatusCache: vi.fn(),
    resetE2EConnectionStateLogTap: vi.fn(),
    getE2EConnectionStateLogTap: vi.fn(() => []),
    setE2EConfig: vi.fn(),
    crashRunningPlugin: vi.fn(() => ({ pid: 12345 })),
    // Resolve the marker path under whatever ROUBO_USER_PLUGINS_DIR the route set
    // (the throwaway tmp user root), mirroring the real seedMarkerPath().
    seedMarkerPath: vi.fn(() =>
      path.join(process.env.ROUBO_USER_PLUGINS_DIR ?? "", ".seed-version.json"),
    ),
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
  getProject: vi.fn(),
  updateProjectSettings: vi.fn(),
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
  // #574: the /test/__seed-notice route reads + rewrites state.json via these.
  // Default to an empty state; tests that assert the merge override loadState.
  loadState: vi.fn(() => ({ benches: [] })),
  saveState: vi.fn(),
}));

vi.mock("../services/integration-overrides.js", () => ({
  saveOverride: vi.fn(),
  removeOverride: vi.fn(),
}));

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
  __test: {
    reloadFromState: vi.fn(),
  },
}));

// #568: the singleton the /test/__set-cut-list-disk-cache route toggles and
// /test/__reset restores. Mocked so the unit suite asserts the route wiring
// without touching the real DiskSnapshotStore.
vi.mock("../services/cut-list-query-service.js", () => ({
  cutListQueryService: {
    setDiskCacheEnabled: vi.fn(),
    restoreBypassDefault: vi.fn(),
  },
}));

// #314 (CPHM-TC-051): the catalog-client seam the /test/__set-marketplace-reachable
// route flips and /test/__reset restores. Mocked so the unit suite asserts the
// route wiring without running the real client (ed25519 keygen + a cache write).
// The fake echoes the resolved source so the route's surfaced `source` is testable.
vi.mock("../services/catalog-client.js", () => ({
  __setE2EMarketplaceReachable: vi.fn(async (reachable: boolean) =>
    reachable ? "network" : "seed",
  ),
}));

import router, { isE2eRateLimitExempt } from "./test.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";
import * as state from "../services/state.js";
import * as pluginEnableState from "../services/plugin-enable-state.js";
import * as integrationOverrides from "../services/integration-overrides.js";
import { cutListQueryService } from "../services/cut-list-query-service.js";
import * as catalogClient from "../services/catalog-client.js";
import { BUNDLED_PLUGIN_IDS, ONLY_TO_DO_NOTICE_MARKER } from "@roubo/shared";

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
    // TC-001 (#438): the bench-manager Map is re-hydrated from the wiped
    // state.json so a previous spec's real-create bench cannot survive a reset.
    expect(benchManager.__test.reloadFromState).toHaveBeenCalledTimes(1);
    // #568: the cut-list disk-cache bypass is restored to its env default so a
    // prior spec's /test/__set-cut-list-disk-cache toggle cannot leak the warm
    // path into the next spec.
    expect(cutListQueryService.restoreBypassDefault).toHaveBeenCalledTimes(1);
    // #314 (CPHM-TC-051): the marketplace catalog client is restored to its
    // reachable (network) default so a prior spec's offline toggle cannot leak an
    // "unreachable" state into the next spec.
    expect(catalogClient.__setE2EMarketplaceReachable).toHaveBeenCalledWith(true);
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
    const FAILURE_FIXTURE_IDS = ["broken-plugin", "errored-component-stub"];
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

  // The persistent first-page cut-list snapshot cache (`issue-snapshots/`,
  // written by DiskSnapshotStore) survives a process restart by design, so a
  // reset must wipe it: otherwise a snapshot written by one scenario would be
  // served as a disk-hit to a later scenario sharing the same cache key,
  // rendering stale or wrong issues across specs.
  it("removes the issue-snapshots cache directory on reset", async () => {
    process.env.ROUBO_E2E = "1";
    const snapshotsDir = path.join(TEST_ROUBO_DIR, "issue-snapshots");
    fs.mkdirSync(path.join(snapshotsDir, "some-project"), { recursive: true });
    fs.writeFileSync(path.join(snapshotsDir, "some-project", "abc.json"), "{}");
    expect(fs.existsSync(snapshotsDir)).toBe(true);

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(200);
    expect(fs.existsSync(snapshotsDir)).toBe(false);
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
  // those ids (broken-plugin, errored-component-stub) as well.
  it("writes every bundled plugin id as disabled when bundledPluginsDisabled: true", async () => {
    process.env.ROUBO_E2E = "1";
    const FAILURE_FIXTURE_IDS = ["broken-plugin", "errored-component-stub"];

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

// #574: stamp the only-to-do default-change notice marker (FR-018, issue #558)
// with a real ISO timestamp so the OnlyToDoNoticeBanner renders for the e2e
// upgrade-banner journey (TC-047). /test/__reset truncates state.json, so the
// marker is otherwise absent; this route writes it directly.
describe("POST /test/__seed-notice", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).post("/test/__seed-notice");

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(state.saveState).not.toHaveBeenCalled();
  });

  it("returns 404 when ROUBO_E2E is set to a value other than '1'", async () => {
    process.env.ROUBO_E2E = "true";

    const res = await request(app).post("/test/__seed-notice");

    expect(res.status).toBe(404);
    expect(state.saveState).not.toHaveBeenCalled();
  });

  it("stamps the marker with a fixed default ISO timestamp when no body is sent", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__seed-notice");

    expect(res.status).toBe(200);
    expect(res.body.marker).toBe(ONLY_TO_DO_NOTICE_MARKER);
    expect(res.body.at).toBe("2026-06-01T12:00:00.000Z");
    expect(state.saveState).toHaveBeenCalledTimes(1);
    expect(state.saveState).toHaveBeenCalledWith({
      benches: [],
      notices: { [ONLY_TO_DO_NOTICE_MARKER]: "2026-06-01T12:00:00.000Z" },
    });
  });

  it("stamps the marker with the supplied ISO timestamp and preserves existing state", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(state.loadState).mockReturnValueOnce({
      benches: [],
      schemaVersion: 3,
      notices: { "other-notice": "2026-01-01T00:00:00.000Z" },
    });

    const res = await request(app)
      .post("/test/__seed-notice")
      .send({ at: "2026-07-04T08:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.at).toBe("2026-07-04T08:00:00.000Z");
    expect(state.saveState).toHaveBeenCalledWith({
      benches: [],
      schemaVersion: 3,
      notices: {
        "other-notice": "2026-01-01T00:00:00.000Z",
        [ONLY_TO_DO_NOTICE_MARKER]: "2026-07-04T08:00:00.000Z",
      },
    });
  });

  it("returns 400 when at is the 'seeded' sentinel (which the banner never surfaces)", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__seed-notice").send({ at: "seeded" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/seeded/);
    expect(state.saveState).not.toHaveBeenCalled();
  });

  it("returns 400 when at is not a parseable ISO-8601 string", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__seed-notice").send({ at: "not-a-date" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ISO-8601/);
    expect(state.saveState).not.toHaveBeenCalled();
  });

  it("returns 400 when at is a non-string", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__seed-notice").send({ at: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty string/);
    expect(state.saveState).not.toHaveBeenCalled();
  });

  it("returns 500 and logs when saveState throws", async () => {
    process.env.ROUBO_E2E = "1";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(state.saveState).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const res = await request(app).post("/test/__seed-notice");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("disk full");
    expect(consoleSpy).toHaveBeenCalledWith("/test/__seed-notice failed:", "disk full");
    consoleSpy.mockRestore();
  });
});

// #568: toggle the cut-list disk-cache bypass so the warm-snapshot drift guard
// (CLI-TC-017) can reach the disk path the harness bypasses by default.
describe("POST /test/__set-cut-list-disk-cache", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).post("/test/__set-cut-list-disk-cache").send({ enabled: true });

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(cutListQueryService.setDiskCacheEnabled).not.toHaveBeenCalled();
  });

  it("enables the disk cache and returns 200 when ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__set-cut-list-disk-cache").send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: true });
    expect(cutListQueryService.setDiskCacheEnabled).toHaveBeenCalledWith(true);
  });

  it("re-bypasses the disk cache when enabled is false", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__set-cut-list-disk-cache").send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: false });
    expect(cutListQueryService.setDiskCacheEnabled).toHaveBeenCalledWith(false);
  });

  it("returns 400 when enabled is not a boolean", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__set-cut-list-disk-cache").send({ enabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "enabled must be a boolean" });
    expect(cutListQueryService.setDiskCacheEnabled).not.toHaveBeenCalled();
  });

  it("returns 400 when enabled is missing", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__set-cut-list-disk-cache").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "enabled must be a boolean" });
    expect(cutListQueryService.setDiskCacheEnabled).not.toHaveBeenCalled();
  });
});

// #314 (CPHM-TC-051): flip the marketplace catalog client between reachable
// (network) and unreachable (degrade to cache/seed) so the offline-journey e2e
// can walk offline -> install-paused -> reconnect without real network.
describe("POST /test/__set-marketplace-reachable", () => {
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app)
      .post("/test/__set-marketplace-reachable")
      .send({ reachable: false });

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(catalogClient.__setE2EMarketplaceReachable).not.toHaveBeenCalled();
  });

  it("flips to unreachable and surfaces the resolved source when ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__set-marketplace-reachable")
      .send({ reachable: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, reachable: false, source: "seed" });
    expect(catalogClient.__setE2EMarketplaceReachable).toHaveBeenCalledWith(false);
  });

  it("flips back to reachable and surfaces the network source", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__set-marketplace-reachable")
      .send({ reachable: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, reachable: true, source: "network" });
    expect(catalogClient.__setE2EMarketplaceReachable).toHaveBeenCalledWith(true);
  });

  it("returns 400 when reachable is not a boolean", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__set-marketplace-reachable")
      .send({ reachable: "yes" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "reachable must be a boolean" });
    expect(catalogClient.__setE2EMarketplaceReachable).not.toHaveBeenCalled();
  });

  it("returns 400 when reachable is missing", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__set-marketplace-reachable").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "reachable must be a boolean" });
    expect(catalogClient.__setE2EMarketplaceReachable).not.toHaveBeenCalled();
  });
});

// #313 (CPHM-TC-041): drive a genuine offline first-run seed of the default
// plugins and report the installed set + idempotency marker, so the
// fresh-launch-seed-journey drift guard can assert the integrated seed run
// matches the authoritative case.
describe("POST /test/__seed-fresh-launch", () => {
  const SEED_IDS_SORTED = ["database", "github-com", "process"];
  // Tmp user roots / seed dirs the route minted, captured from the seed mock so
  // the block rms them (the route also tracks them for /__reset cleanup).
  const sandboxDirs: string[] = [];

  // Launder the env-derived sandbox path (the throwaway tmp user root / seed dir
  // the route minted under os.tmpdir() and exported via ROUBO_USER_PLUGINS_DIR /
  // ROUBO_SEED_DIR) through the repo's path-containment sanitizer before it
  // reaches an fs sink. Reading process.env back is a tainted source to CodeQL's
  // js/path-injection suite; resolveWithinRoots confines the value to os.tmpdir()
  // and re-derives it through resolveWithin, the barrier shape CodeQL recognises.
  // Returns null when the value is unset or escapes the tmp root.
  function sanitizeSandboxDir(raw: string | undefined): string | null {
    if (!raw) return null;
    return resolveWithinRoots([os.tmpdir()], raw);
  }

  // Simulate plugin-manager.seedFromBundled: install the three defaults into the
  // env-pointed tmp user root and write the idempotency marker, unless the marker
  // already exists (idempotent: a relaunch is a no-op that leaves it untouched).
  function simulateSeed(): void {
    const root = sanitizeSandboxDir(process.env.ROUBO_USER_PLUGINS_DIR);
    if (!root) return;
    const markerPath = resolveWithin(root, ".seed-version.json");
    if (fs.existsSync(markerPath)) return;
    for (const id of ["github-com", "process", "database"]) {
      const dir = resolveWithin(root, id);
      fs.mkdirSync(resolveWithin(dir, "dist"), { recursive: true });
      fs.writeFileSync(resolveWithin(dir, "roubo-plugin.yaml"), `id: ${id}\n`, "utf-8");
      fs.writeFileSync(resolveWithin(dir, "dist", "index.js"), "module.exports = {};\n", "utf-8");
    }
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        seedVersion: 1,
        seededAt: "2026-01-01T00:00:00.000Z",
        seededIds: ["github-com", "process", "database"],
      }),
      "utf-8",
    );
  }

  beforeEach(() => {
    vi.mocked(pluginManager.seedFromBundled).mockImplementation(async () => {
      const userRoot = sanitizeSandboxDir(process.env.ROUBO_USER_PLUGINS_DIR);
      const seedDir = sanitizeSandboxDir(process.env.ROUBO_SEED_DIR);
      if (userRoot) sandboxDirs.push(userRoot);
      if (seedDir) sandboxDirs.push(seedDir);
      simulateSeed();
    });
  });

  afterEach(() => {
    while (sandboxDirs.length > 0) {
      const dir = sandboxDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  });

  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).post("/test/__seed-fresh-launch");

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(pluginManager.seedFromBundled).not.toHaveBeenCalled();
  });

  it("returns 400 when relaunch is not a boolean", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__seed-fresh-launch").send({ relaunch: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/relaunch/);
    expect(pluginManager.seedFromBundled).not.toHaveBeenCalled();
  });

  it("returns 409 when relaunch is requested without a prior fresh launch", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__seed-fresh-launch").send({ relaunch: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no prior fresh launch/);
    expect(pluginManager.seedFromBundled).not.toHaveBeenCalled();
  });

  it("seeds exactly the three defaults on a fresh launch and restores the env", async () => {
    process.env.ROUBO_E2E = "1";
    const prevUserDir = process.env.ROUBO_USER_PLUGINS_DIR;
    const prevSeedDir = process.env.ROUBO_SEED_DIR;

    const res = await request(app).post("/test/__seed-fresh-launch").send({});

    expect(res.status).toBe(200);
    expect([...res.body.seedSet].sort()).toEqual(SEED_IDS_SORTED);
    expect(res.body.seededNow).toBe(true);
    expect(res.body.installed.map((p: { id: string }) => p.id)).toEqual(SEED_IDS_SORTED);
    for (const record of res.body.installed) {
      expect(record.manifestId).toBe(record.id);
      expect(record.hasEntry).toBe(true);
    }
    expect(res.body.marker.present).toBe(true);
    expect(res.body.marker.seedVersion).toBe(1);
    expect([...res.body.marker.seededIds].sort()).toEqual(SEED_IDS_SORTED);

    // The env override never leaks past the call (NFR-018).
    expect(process.env.ROUBO_USER_PLUGINS_DIR).toBe(prevUserDir);
    expect(process.env.ROUBO_SEED_DIR).toBe(prevSeedDir);
  });

  it("does not re-seed on a relaunch (idempotent: marker present and unchanged)", async () => {
    process.env.ROUBO_E2E = "1";

    const first = await request(app).post("/test/__seed-fresh-launch").send({});
    expect(first.status).toBe(200);
    expect(first.body.seededNow).toBe(true);

    const relaunch = await request(app).post("/test/__seed-fresh-launch").send({ relaunch: true });

    expect(relaunch.status).toBe(200);
    expect(relaunch.body.seededNow).toBe(false);
    expect(relaunch.body.marker.present).toBe(true);
    expect(relaunch.body.marker.seededAt).toBe(first.body.marker.seededAt);
    expect(relaunch.body.installed.map((p: { id: string }) => p.id)).toEqual(SEED_IDS_SORTED);
  });

  it("returns 500, logs, and restores the env when the seed throws", async () => {
    process.env.ROUBO_E2E = "1";
    const prevUserDir = process.env.ROUBO_USER_PLUGINS_DIR;
    const prevSeedDir = process.env.ROUBO_SEED_DIR;
    vi.mocked(pluginManager.seedFromBundled).mockImplementationOnce(async () => {
      const userRoot = process.env.ROUBO_USER_PLUGINS_DIR;
      const seedDir = process.env.ROUBO_SEED_DIR;
      if (userRoot) sandboxDirs.push(userRoot);
      if (seedDir) sandboxDirs.push(seedDir);
      throw new Error("seed boom");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).post("/test/__seed-fresh-launch").send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("seed boom");
    expect(consoleSpy).toHaveBeenCalledWith("/test/__seed-fresh-launch failed:", "seed boom");
    expect(process.env.ROUBO_USER_PLUGINS_DIR).toBe(prevUserDir);
    expect(process.env.ROUBO_SEED_DIR).toBe(prevSeedDir);
    consoleSpy.mockRestore();
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

  // CP-TC-028 (#626): an optional `componentPlugin` binds a `deploy` component
  // to the named component plugin in the generated roubo.yaml, alongside the
  // default `app` process component. The component-plugin e2e drift guard uses
  // this to register a project whose `deploy` component resolves to the
  // imperative `clasp-deploy-stub` plugin.
  it("binds a deploy component to the componentPlugin in the fixture roubo.yaml", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-deploy", componentPlugin: "clasp-deploy-stub" });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).toMatch(/^\s{2}deploy:$/m);
    expect(yaml).toMatch(/^\s{6}id: clasp-deploy-stub$/m);
  });

  it("omits the deploy component when componentPlugin is not provided", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-no-deploy", plugin: "e2e-stub" });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).not.toMatch(/^\s{2}deploy:$/m);
  });

  it("returns 400 when componentPlugin is not kebab-case", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-bad-component", componentPlugin: "Bad_Id" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/componentPlugin/);
    expect(projectRegistry.registerProject).not.toHaveBeenCalled();
  });

  // CLI-TC-062 (#573): an optional `portBase` lets a spec that registers two
  // fixture projects at once give each a non-overlapping port range so the
  // allocator does not reject the second one.
  it("writes a custom portBase into the fixture roubo.yaml", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-port-base", plugin: "e2e-stub", portBase: 39200 });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).toMatch(/^\s{4}base: 39200$/m);
  });

  it("defaults the fixture port base to 39100 when portBase is omitted", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-default-port", plugin: "e2e-stub" });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).toMatch(/^\s{4}base: 39100$/m);
  });

  it("returns 400 when portBase is not a positive integer", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-bad-port", plugin: "e2e-stub", portBase: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/portBase/);
    expect(projectRegistry.registerProject).not.toHaveBeenCalled();
  });

  // TC-032 (#708): an optional `enforceIssueDependencies` turns the host's hard
  // start-gate ON at the project level by writing
  // `benches.enforceIssueDependencies: true` into the fixture roubo.yaml. The
  // start-gate e2e drives the blocked -> allowed journey against it.
  it("writes enforceIssueDependencies: true under benches when the option is true", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-enforce", plugin: "e2e-stub", enforceIssueDependencies: true });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).toMatch(/^\s{2}enforceIssueDependencies: true$/m);
  });

  it("omits enforceIssueDependencies from the fixture roubo.yaml when not provided", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app)
      .post("/test/__register-fixture-project")
      .send({ projectId: "fixture-no-enforce", plugin: "e2e-stub" });

    expect(res.status).toBe(200);
    createdTmpdirs.push(res.body.repoPath);

    const yaml = fs.readFileSync(`${res.body.repoPath}/.roubo/roubo.yaml`, "utf-8");
    expect(yaml).not.toMatch(/enforceIssueDependencies/);
  });

  it("returns 400 when enforceIssueDependencies is not a boolean", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__register-fixture-project").send({
      projectId: "fixture-bad-enforce",
      plugin: "e2e-stub",
      enforceIssueDependencies: "yes",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/enforceIssueDependencies/);
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

    it("rolls back seeded workspace tmpdirs when a later step throws (seedBenches)", async () => {
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

  // TC-001 (#438): optional seedSpecs writes `.specifications/<slug>/test-cases.json`
  // into the fixture repo so TestBench spec discovery + the create flow run
  // against real files; optional gitInit makes the repo a real git repository so
  // a spec-bound worktree can be provisioned without an origin remote.
  describe("seedSpecs + gitInit options (TC-001, #438)", () => {
    const PLAN = {
      $schema: "https://roubo.dev/schema/testbench/test-cases/v1.0.0.json",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      cases: [],
    };

    it("writes each seeded spec's test-cases.json under .specifications/<slug>/", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "tc-001", seedSpecs: [{ slug: "testbench", testCases: PLAN }] });

      expect(res.status).toBe(200);
      createdTmpdirs.push(res.body.repoPath);

      const specPath = `${res.body.repoPath}/.specifications/testbench/test-cases.json`;
      expect(fs.existsSync(specPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(specPath, "utf-8"))).toEqual(PLAN);
    });

    it("does not write any spec files when seedSpecs is omitted", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "tc-001-no-specs" });

      expect(res.status).toBe(200);
      createdTmpdirs.push(res.body.repoPath);
      expect(fs.existsSync(`${res.body.repoPath}/.specifications`)).toBe(false);
    });

    it("git-inits + commits the repo and pins worktreeSource away from fetch when gitInit: true", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({
          projectId: "tc-001-git",
          gitInit: true,
          seedSpecs: [{ slug: "testbench", testCases: PLAN }],
        });

      expect(res.status).toBe(200);
      createdTmpdirs.push(res.body.repoPath);

      // A real git repo with one commit was created.
      expect(fs.existsSync(`${res.body.repoPath}/.git`)).toBe(true);

      // worktreeSource was pinned to local HEAD so provisioning needs no remote.
      expect(projectRegistry.updateProjectSettings).toHaveBeenCalledTimes(1);
      const settings = vi.mocked(projectRegistry.updateProjectSettings).mock.calls[0][1];
      expect(settings.worktreeSource).toEqual({ branchFromDefault: false, pullLatest: false });
    });

    it("does not git-init or update settings when gitInit is omitted", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "tc-001-no-git" });

      expect(res.status).toBe(200);
      createdTmpdirs.push(res.body.repoPath);
      expect(fs.existsSync(`${res.body.repoPath}/.git`)).toBe(false);
      expect(projectRegistry.updateProjectSettings).not.toHaveBeenCalled();
    });

    it("returns 400 when seedSpecs is not an array", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "tc-001", seedSpecs: "nope" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/seedSpecs/);
      expect(projectRegistry.registerProject).not.toHaveBeenCalled();
    });

    it("returns 400 when a seedSpecs entry has a non-kebab-case slug", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "tc-001", seedSpecs: [{ slug: "Bad_Slug", testCases: PLAN }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/slug/);
      expect(projectRegistry.registerProject).not.toHaveBeenCalled();
    });

    it("returns 400 when a seedSpecs entry omits testCases", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "tc-001", seedSpecs: [{ slug: "testbench" }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/testCases/);
      expect(projectRegistry.registerProject).not.toHaveBeenCalled();
    });

    it("returns 400 when gitInit is not a boolean", async () => {
      process.env.ROUBO_E2E = "1";

      const res = await request(app)
        .post("/test/__register-fixture-project")
        .send({ projectId: "tc-001", gitInit: "yes" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/gitInit/);
      expect(projectRegistry.registerProject).not.toHaveBeenCalled();
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

// TC-043 (#440): the two TestBench harness endpoints. As of #493 they resolve the
// focused spec directory from the bench's OWN WORKTREE (bench.workspacePath),
// while the slug is still derived from the registered project repoPath + the
// bench's focusedSpecPath (mirroring the live TestBench routes). The tests seed a
// real tmp worktree with a `.specifications/<slug>/test-cases.json`, keep a
// separate repoPath that anchors focusedSpecPath, and point getProject / getBench
// at both. `specDir` is the worktree's spec dir, where all spec-file IO lands.
describe("TestBench harness endpoints (#440)", () => {
  const SLUG = "testbench";
  const PROJECT_ID = "tc-043-fixture";
  const BENCH_ID = 1;

  let repoPath: string;
  let workspacePath: string;
  let specDir: string;

  function seedRepo(planJson: string): void {
    repoPath = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "tb-"));
    // focusedSpecPath anchors against repoPath, so the slug derives from a spec
    // dir under the repo (resolveFocusedSpec checks structure, not existence).
    fs.mkdirSync(path.join(repoPath, ".specifications", SLUG), { recursive: true });
    // The bench's worktree is where the live route (and now the harness) reads the
    // plan and reads/writes the results sidecar (#493). Seed the plan there.
    workspacePath = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "tb-wt-"));
    specDir = path.join(workspacePath, ".specifications", SLUG);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "test-cases.json"), planJson, "utf-8");
  }

  const VALID_PLAN = JSON.stringify({
    $schema: "https://roubo.dev/schema/testbench/test-cases/v1.0.0.json",
    schemaVersion: "1.0.0",
    specSlug: SLUG,
    cases: [
      {
        id: "TC-A",
        title: "A",
        level: "1",
        priority: "P0",
        steps: [{ id: "S1", instruction: "do", observations: [{ id: "O1", expected: "ok" }] }],
      },
    ],
  });

  function pointMocksAtRepo(): void {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: PROJECT_ID,
      repoPath,
      config: {} as never,
      configValid: true,
      settings: {} as never,
    } as never);
    vi.mocked(benchManager.getBench).mockReturnValue({
      id: BENCH_ID,
      projectId: PROJECT_ID,
      variant: "testbench",
      workspacePath,
      // focusedSpecPath anchors against repoPath (slug derivation), so it points
      // at the repo's spec dir, not the worktree where IO lands (#493).
      focusedSpecPath: path.join(repoPath, ".specifications", SLUG, "test-cases.json"),
    } as never);
  }

  afterEach(() => {
    if (repoPath) {
      fs.rmSync(repoPath, { recursive: true, force: true });
      repoPath = "";
    }
    if (workspacePath) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      workspacePath = "";
    }
  });

  describe("POST /test/__rewrite-spec-cases", () => {
    it("returns 404 when ROUBO_E2E is unset", async () => {
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: PROJECT_ID, benchId: BENCH_ID, testCases: { a: 1 } });
      expect(res.status).toBe(404);
      expect(res.text).toBe("");
    });

    it("overwrites the focused spec's test-cases.json on the happy path", async () => {
      seedRepo(VALID_PLAN);
      pointMocksAtRepo();
      process.env.ROUBO_E2E = "1";

      const nextPlan = { ...JSON.parse(VALID_PLAN), specSlug: SLUG, cases: [] };
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: PROJECT_ID, benchId: BENCH_ID, testCases: nextPlan });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const onDisk = JSON.parse(fs.readFileSync(path.join(specDir, "test-cases.json"), "utf-8"));
      expect(onDisk.cases).toEqual([]);
    });

    it("returns 400 when projectId is malformed", async () => {
      process.env.ROUBO_E2E = "1";
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: "Bad_Id", benchId: BENCH_ID, testCases: {} });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/projectId/);
    });

    it("returns 400 when testCases is not an object", async () => {
      process.env.ROUBO_E2E = "1";
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: PROJECT_ID, benchId: BENCH_ID, testCases: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/testCases/);
    });

    it("returns 404 when the project is unknown", async () => {
      vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
      process.env.ROUBO_E2E = "1";
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: PROJECT_ID, benchId: BENCH_ID, testCases: {} });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/);
    });

    it("returns 400 when the bench is not a testbench", async () => {
      seedRepo(VALID_PLAN);
      vi.mocked(projectRegistry.getProject).mockReturnValue({
        id: PROJECT_ID,
        repoPath,
        config: {} as never,
        configValid: true,
        settings: {} as never,
      } as never);
      vi.mocked(benchManager.getBench).mockReturnValue({
        id: BENCH_ID,
        projectId: PROJECT_ID,
        variant: "standard",
      } as never);
      process.env.ROUBO_E2E = "1";
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: PROJECT_ID, benchId: BENCH_ID, testCases: {} });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a testbench/);
    });

    it("returns 400 when the focusedSpecPath escapes the repository", async () => {
      seedRepo(VALID_PLAN);
      vi.mocked(projectRegistry.getProject).mockReturnValue({
        id: PROJECT_ID,
        repoPath,
        config: {} as never,
        configValid: true,
        settings: {} as never,
      } as never);
      // A testbench whose focusedSpecPath points outside the project repo: the
      // resolveFocusedSpec containment barrier rejects it, exercising the
      // "Invalid focusedSpecPath" branch of resolveBenchSpecDir (the
      // security-relevant path-traversal rejection). A non-blank workspacePath is
      // supplied so resolution reaches the slug barrier rather than the earlier
      // blank-workspace 400 (#493).
      vi.mocked(benchManager.getBench).mockReturnValue({
        id: BENCH_ID,
        projectId: PROJECT_ID,
        variant: "testbench",
        workspacePath,
        focusedSpecPath: "/etc/passwd",
      } as never);
      process.env.ROUBO_E2E = "1";
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: PROJECT_ID, benchId: BENCH_ID, testCases: {} });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid focusedSpecPath/);
    });

    it("returns 500 and logs when the write fails", async () => {
      seedRepo(VALID_PLAN);
      pointMocksAtRepo();
      process.env.ROUBO_E2E = "1";
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      const res = await request(app)
        .post("/test/__rewrite-spec-cases")
        .send({ projectId: PROJECT_ID, benchId: BENCH_ID, testCases: { specSlug: SLUG } });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("disk full");
      expect(consoleSpy).toHaveBeenCalledWith("/test/__rewrite-spec-cases failed:", "disk full");
      writeSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe("GET /test/__read-spec-results", () => {
    it("returns 404 when ROUBO_E2E is unset", async () => {
      const res = await request(app).get(
        `/test/__read-spec-results?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
      );
      expect(res.status).toBe(404);
      expect(res.text).toBe("");
    });

    it("returns null results + the source checksum when no sidecar exists", async () => {
      seedRepo(VALID_PLAN);
      pointMocksAtRepo();
      process.env.ROUBO_E2E = "1";
      const res = await request(app).get(
        `/test/__read-spec-results?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.results).toBeNull();
      expect(res.body.casesChecksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns the parsed sidecar when one exists", async () => {
      seedRepo(VALID_PLAN);
      pointMocksAtRepo();
      // v2.0.0 flattened shape (#493): caseResults + updatedAt at the top level,
      // no per-bench `benches` map. The harness reads and returns the sidecar
      // verbatim, so this fixture documents the contract the e2e spec now asserts.
      const resultsFile = {
        $schema: "x",
        schemaVersion: "2.0.0",
        planHash: "abc",
        caseResults: {},
        updatedAt: "2026-06-08T09:00:00.000Z",
      };
      fs.writeFileSync(
        path.join(specDir, "test-results.json"),
        JSON.stringify(resultsFile),
        "utf-8",
      );
      process.env.ROUBO_E2E = "1";
      const res = await request(app).get(
        `/test/__read-spec-results?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual(resultsFile);
    });

    it("returns 400 when benchId is not a positive integer", async () => {
      process.env.ROUBO_E2E = "1";
      const res = await request(app).get(
        `/test/__read-spec-results?projectId=${PROJECT_ID}&benchId=0`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/benchId/);
    });

    it("returns 404 when the bench is unknown", async () => {
      seedRepo(VALID_PLAN);
      vi.mocked(projectRegistry.getProject).mockReturnValue({
        id: PROJECT_ID,
        repoPath,
        config: {} as never,
        configValid: true,
        settings: {} as never,
      } as never);
      vi.mocked(benchManager.getBench).mockReturnValue(undefined);
      process.env.ROUBO_E2E = "1";
      const res = await request(app).get(
        `/test/__read-spec-results?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Bench not found/);
    });

    it("returns 500 and logs when reading the source plan fails", async () => {
      seedRepo(VALID_PLAN);
      pointMocksAtRepo();
      process.env.ROUBO_E2E = "1";
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // Force the source-plan read (the second readFileSync, after the results
      // read returns null via its own try/catch) to throw.
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("read error");
      });
      const res = await request(app).get(
        `/test/__read-spec-results?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
      );
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("read error");
      expect(consoleSpy).toHaveBeenCalledWith("/test/__read-spec-results failed:", "read error");
      readSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });
});

// #567 (CLI-TC-001): the warm-restart drift guard reads the persisted cut-list
// snapshot file through this route to assert the S003 on-disk invariants (mode
// 0600, no credential/token fields). The state mock points getRouboDir() at the
// throwaway TEST_ROUBO_DIR, so these tests write real snapshot files under
// `<TEST_ROUBO_DIR>/issue-snapshots/<projectId>/` and read them back.
describe("GET /test/__read-cut-list-cache-file (#567)", () => {
  const CACHE_PROJECT_ID = "e2e-cut-list-refresh";
  const snapshotsRoot = path.join(TEST_ROUBO_DIR, "issue-snapshots");

  function projectDir(projectId: string): string {
    return path.join(snapshotsRoot, projectId);
  }

  function seedSnapshot(projectId: string, content: unknown, mode = 0o600): string {
    const dir = projectDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "deadbeef.json");
    fs.writeFileSync(file, JSON.stringify(content), "utf-8");
    fs.chmodSync(file, mode);
    return file;
  }

  afterEach(() => {
    fs.rmSync(snapshotsRoot, { recursive: true, force: true });
  });

  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).get(
      `/test/__read-cut-list-cache-file?projectId=${CACHE_PROJECT_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.text).toBe("");
  });

  it("returns the file path, 0600 mode, and parsed content when ROUBO_E2E=1", async () => {
    const content = {
      cacheSchemaVersion: 1,
      response: { items: [{ externalId: "acme/widgets#301" }] },
    };
    const file = seedSnapshot(CACHE_PROJECT_ID, content, 0o600);
    process.env.ROUBO_E2E = "1";
    const res = await request(app).get(
      `/test/__read-cut-list-cache-file?projectId=${CACHE_PROJECT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(file);
    expect(res.body.mode).toBe(0o600);
    expect(res.body.content).toEqual(content);
  });

  it("masks the reported mode to the permission bits (0o777)", async () => {
    seedSnapshot(CACHE_PROJECT_ID, { ok: true }, 0o640);
    process.env.ROUBO_E2E = "1";
    const res = await request(app).get(
      `/test/__read-cut-list-cache-file?projectId=${CACHE_PROJECT_ID}`,
    );
    expect(res.status).toBe(200);
    // The mode must carry only permission bits, so a non-0600 file is observable
    // by the spec (which asserts exactly 0o600).
    expect(res.body.mode).toBe(0o640);
    expect(res.body.mode & ~0o777).toBe(0);
  });

  it("returns 400 when projectId fails the allowlist", async () => {
    process.env.ROUBO_E2E = "1";
    const res = await request(app).get("/test/__read-cut-list-cache-file?projectId=..");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/);
  });

  it("returns 400 when projectId is missing", async () => {
    process.env.ROUBO_E2E = "1";
    const res = await request(app).get("/test/__read-cut-list-cache-file");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/);
  });

  it("returns 404 when no snapshot exists for the project", async () => {
    process.env.ROUBO_E2E = "1";
    const res = await request(app).get(
      `/test/__read-cut-list-cache-file?projectId=${CACHE_PROJECT_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No cut-list snapshot/);
  });

  it("returns 500 and logs when the snapshot file is unreadable JSON", async () => {
    const dir = projectDir(CACHE_PROJECT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deadbeef.json"), "{ not json", "utf-8");
    process.env.ROUBO_E2E = "1";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).get(
      `/test/__read-cut-list-cache-file?projectId=${CACHE_PROJECT_ID}`,
    );
    expect(res.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalledWith(
      "/test/__read-cut-list-cache-file failed:",
      expect.any(String),
    );
    consoleSpy.mockRestore();
  });
});

// #466: the rate-limiter skip predicate. This suite mocks express-rate-limit to
// a pass-through (see the top of the file), so it can't exercise the real skip
// wiring; instead we assert the predicate directly. The predicate is the ONLY
// thing gating the exemption, so covering its truth table protects both the e2e
// exemption (ROUBO_E2E=1 must skip) and production (anything else must not skip,
// keeping the limiter live on the 404 surface).
describe("isE2eRateLimitExempt (rate-limiter skip predicate)", () => {
  // Save/restore ROUBO_E2E locally, mirroring the file's originalRouboE2E
  // pattern, so setting it here never leaks into a later test.
  const savedRouboE2E = process.env.ROUBO_E2E;
  afterEach(() => {
    if (savedRouboE2E === undefined) {
      delete process.env.ROUBO_E2E;
    } else {
      process.env.ROUBO_E2E = savedRouboE2E;
    }
  });

  it("returns true when ROUBO_E2E === '1'", () => {
    process.env.ROUBO_E2E = "1";
    expect(isE2eRateLimitExempt()).toBe(true);
  });

  it("returns false when ROUBO_E2E is unset", () => {
    delete process.env.ROUBO_E2E;
    expect(isE2eRateLimitExempt()).toBe(false);
  });

  it("returns false when ROUBO_E2E is set to a non-'1' value", () => {
    process.env.ROUBO_E2E = "true";
    expect(isE2eRateLimitExempt()).toBe(false);
  });
});
