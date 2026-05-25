import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import type { IntegrationOverride, PersistedState, PluginEnableState } from "@roubo/shared";

// TC-031 / TC-049: integration coverage that runs the migration against a
// real-on-disk pre-plugin ~/.roubo fixture. Only the credential-store boundary
// is stubbed — every other side-effect hits the temp filesystem.

const credentialMocks = {
  set: vi.fn<(p: string, s: string, v: string) => Promise<void>>(),
  deleteSlot: vi.fn<(p: string, s: string) => Promise<void>>(),
  get: vi.fn<(p: string, s: string) => Promise<string | null>>(),
};
vi.mock("./credential-store.js", () => credentialMocks);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, "__fixtures__", "pre-plugin-roubo");

let homeDir: string;
let originalHome: string | undefined;
let mod: typeof import("./migrate.js");

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function scaffoldFixture(): {
  rouboDir: string;
  authPath: string;
  statePath: string;
  projectsPath: string;
  alphaRepo: string;
  betaRepo: string;
} {
  const rouboDir = path.join(homeDir, ".roubo");
  const reposDir = path.join(rouboDir, "repos");
  fs.mkdirSync(rouboDir, { recursive: true });
  copyDir(path.join(FIXTURE_ROOT, "repos"), reposDir);

  const alphaRepo = path.join(reposDir, "alpha");
  const betaRepo = path.join(reposDir, "beta");

  const authPath = path.join(rouboDir, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify(
      {
        githubToken: "ghp_fixture_token",
        username: "alice",
        scopes: ["repo"],
        authorizedAt: "2026-04-01T12:00:00.000Z",
      },
      null,
      2,
    ),
  );

  const projectsPath = path.join(rouboDir, "projects.json");
  fs.writeFileSync(
    projectsPath,
    JSON.stringify(
      {
        projects: [
          { id: "alpha", repoPath: alphaRepo },
          { id: "beta", repoPath: betaRepo },
        ],
      },
      null,
      2,
    ),
  );

  const statePath = path.join(rouboDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ benches: [] }, null, 2));

  return { rouboDir, authPath, statePath, projectsPath, alphaRepo, betaRepo };
}

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(tmpdir(), "roubo-migrate-int-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  process.env.ROUBO_PRODUCTION = "1";

  credentialMocks.set.mockReset().mockResolvedValue(undefined);
  credentialMocks.deleteSlot.mockReset().mockResolvedValue(undefined);
  credentialMocks.get.mockReset().mockResolvedValue(null);

  vi.resetModules();
  mod = await import("./migrate.js");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.ROUBO_PRODUCTION;
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("migrate.run — integration (TC-031, TC-049)", () => {
  it("migrates a real pre-plugin fixture end-to-end and is a no-op on re-run", async () => {
    const fx = scaffoldFixture();

    const outcome = await mod.run();

    expect(outcome.status).toBe("success");

    // state.json bumped + migration recorded.
    const stateAfter = JSON.parse(fs.readFileSync(fx.statePath, "utf-8")) as PersistedState;
    expect(stateAfter.schemaVersion).toBe(1);
    expect(stateAfter.migration?.status).toBe("success");
    expect(stateAfter.migration?.migratedProjectIds).toEqual(["alpha", "beta"]);
    expect(stateAfter.benches).toEqual([]);

    // auth.json deleted.
    expect(fs.existsSync(fx.authPath)).toBe(false);

    // Override files written per project.
    const alphaOverride = YAML.parse(
      fs.readFileSync(path.join(fx.rouboDir, "integrations", "alpha.yaml"), "utf-8"),
    ) as IntegrationOverride;
    expect(alphaOverride).toEqual({
      schemaVersion: 1,
      integration: { plugin: "github-com", sources: { project: ["42"] } },
    });
    const betaOverride = YAML.parse(
      fs.readFileSync(path.join(fx.rouboDir, "integrations", "beta.yaml"), "utf-8"),
    ) as IntegrationOverride;
    expect(betaOverride).toEqual({
      schemaVersion: 1,
      integration: { plugin: "github-com" },
    });

    // Credential store called once with the right args (mocked boundary).
    expect(credentialMocks.set).toHaveBeenCalledTimes(1);
    expect(credentialMocks.set).toHaveBeenCalledWith(
      "github-com",
      "github-token",
      "ghp_fixture_token",
    );

    // WU-046: existing-install seed lands every bundled plugin as enabled.
    const enableStatePath = path.join(fx.rouboDir, "plugins-state.json");
    expect(fs.existsSync(enableStatePath)).toBe(true);
    const enableState = JSON.parse(fs.readFileSync(enableStatePath, "utf-8")) as PluginEnableState;
    expect(enableState).toEqual({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "enabled", ghe: "enabled", "jira-self-hosted": "enabled" },
    });

    // Re-run is a no-op (TC-068): no further fs mutation, no new credential calls.
    const alphaBefore = fs.statSync(path.join(fx.rouboDir, "integrations", "alpha.yaml")).mtimeMs;
    const stateBefore = fs.statSync(fx.statePath).mtimeMs;
    credentialMocks.set.mockClear();

    const second = await mod.run();
    expect(second).toEqual({ status: "noop" });
    expect(credentialMocks.set).not.toHaveBeenCalled();
    expect(fs.statSync(path.join(fx.rouboDir, "integrations", "alpha.yaml")).mtimeMs).toBe(
      alphaBefore,
    );
    expect(fs.statSync(fx.statePath).mtimeMs).toBe(stateBefore);
  });

  it("rolls back when the keyring is unavailable: auth.json kept, schemaVersion not bumped (TC-069)", async () => {
    const fx = scaffoldFixture();
    credentialMocks.set.mockRejectedValueOnce(new Error("keyring-unavailable: dbus not running"));

    const outcome = await mod.run();

    expect(outcome.status).toBe("rolled-back");
    if (outcome.status !== "rolled-back") throw new Error("unreachable");
    expect(outcome.reason).toContain("keyring-unavailable");

    // auth.json still present.
    expect(fs.existsSync(fx.authPath)).toBe(true);
    const authAfter = JSON.parse(fs.readFileSync(fx.authPath, "utf-8"));
    expect(authAfter.githubToken).toBe("ghp_fixture_token");

    // No override files written.
    expect(fs.existsSync(path.join(fx.rouboDir, "integrations", "alpha.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(fx.rouboDir, "integrations", "beta.yaml"))).toBe(false);

    // state.json holds the rolled-back marker WITHOUT a schemaVersion bump.
    const stateAfter = JSON.parse(fs.readFileSync(fx.statePath, "utf-8")) as PersistedState;
    expect(stateAfter.schemaVersion).toBeUndefined();
    expect(stateAfter.migration?.status).toBe("rolled-back");
    expect(stateAfter.migration?.reason).toContain("keyring-unavailable");

    // WU-046: rollback must not leave a half-seeded plugins-state.json behind.
    expect(fs.existsSync(path.join(fx.rouboDir, "plugins-state.json"))).toBe(false);
  });

  it("seeds plugins-state.json with all bundled plugins disabled on a greenfield install (WU-046)", async () => {
    // Greenfield = no auth.json, no projects.json, no state.json schemaVersion.
    const rouboDir = path.join(homeDir, ".roubo");
    fs.mkdirSync(rouboDir, { recursive: true });

    const outcome = await mod.run();

    expect(outcome).toEqual({ status: "noop" });
    expect(credentialMocks.set).not.toHaveBeenCalled();

    const enableStatePath = path.join(rouboDir, "plugins-state.json");
    expect(fs.existsSync(enableStatePath)).toBe(true);
    const enableState = JSON.parse(fs.readFileSync(enableStatePath, "utf-8")) as PluginEnableState;
    expect(enableState).toEqual({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "disabled", ghe: "disabled", "jira-self-hosted": "disabled" },
    });

    // state.json gate also bumped so migrate is a noop next boot.
    const stateAfter = JSON.parse(
      fs.readFileSync(path.join(rouboDir, "state.json"), "utf-8"),
    ) as PersistedState;
    expect(stateAfter.schemaVersion).toBe(1);
  });
});
