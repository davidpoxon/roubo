import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PersistedState, PersistedProjects } from "@roubo/shared";

const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
};
vi.mock("node:fs", () => ({ default: fsMocks }));

const stateMocks = {
  getRouboDir: vi.fn(() => "/mock-home/.roubo"),
  loadState: vi.fn(),
  saveState: vi.fn(),
  loadProjects: vi.fn(),
};
vi.mock("./state.js", () => stateMocks);

const configParserMocks = { parseConfig: vi.fn() };
vi.mock("./config-parser.js", () => configParserMocks);

const overrideMocks = { saveOverride: vi.fn() };
vi.mock("./integration-overrides.js", () => overrideMocks);

const credentialMocks = {
  set: vi.fn<(p: string, s: string, v: string) => Promise<void>>(),
  deleteSlot: vi.fn<(p: string, s: string) => Promise<void>>(),
};
vi.mock("./credential-store.js", () => credentialMocks);

const enableStateMocks = { saveEnableState: vi.fn() };
vi.mock("./plugin-enable-state.js", () => enableStateMocks);

let mod: typeof import("./migrate.js");

beforeEach(async () => {
  for (const m of Object.values(fsMocks)) m.mockReset();
  for (const m of Object.values(stateMocks)) m.mockReset();
  stateMocks.getRouboDir.mockReturnValue("/mock-home/.roubo");
  configParserMocks.parseConfig.mockReset();
  overrideMocks.saveOverride.mockReset();
  credentialMocks.set.mockReset();
  credentialMocks.deleteSlot.mockReset();
  enableStateMocks.saveEnableState.mockReset();

  vi.resetModules();
  mod = await import("./migrate.js");
});

function mockState(state: PersistedState): void {
  stateMocks.loadState.mockReturnValue(state);
}

function mockProjects(projects: PersistedProjects): void {
  stateMocks.loadProjects.mockReturnValue(projects);
}

function mockAuth(token: string | null): void {
  const authPath = "/mock-home/.roubo/auth.json";
  fsMocks.existsSync.mockImplementation((p: string) => p === authPath && token !== null);
  if (token !== null) {
    fsMocks.readFileSync.mockImplementation((p: string) => {
      if (p === authPath) {
        return JSON.stringify({
          githubToken: token,
          username: "alice",
          scopes: ["repo"],
          authorizedAt: "2026-05-01T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected readFileSync(${p})`);
    });
  }
}

describe("migrate.run — idempotency (TC-068)", () => {
  it("returns noop and does no I/O when schemaVersion is already bumped", async () => {
    mockState({ benches: [], schemaVersion: 1 });

    const outcome = await mod.run();

    expect(outcome).toEqual({ status: "noop" });
    expect(stateMocks.loadProjects).not.toHaveBeenCalled();
    expect(stateMocks.saveState).not.toHaveBeenCalled();
    expect(credentialMocks.set).not.toHaveBeenCalled();
    expect(overrideMocks.saveOverride).not.toHaveBeenCalled();
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("migrate.run — empty migration", () => {
  it("bumps schemaVersion and returns noop when there is no auth.json and no projects", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [] });
    mockAuth(null);

    const outcome = await mod.run();

    expect(outcome).toEqual({ status: "noop" });
    expect(stateMocks.saveState).toHaveBeenCalledTimes(1);
    expect(stateMocks.saveState.mock.calls[0][0]).toMatchObject({
      benches: [],
      schemaVersion: 1,
    });
    expect(stateMocks.saveState.mock.calls[0][0].migration).toBeUndefined();
    expect(credentialMocks.set).not.toHaveBeenCalled();
    expect(overrideMocks.saveOverride).not.toHaveBeenCalled();
  });
});

describe("migrate.run — success path (TC-031)", () => {
  it("migrates the token to the keyring, writes an override per project, bumps schemaVersion, then deletes auth.json", async () => {
    mockState({ benches: [] });
    mockProjects({
      projects: [{ id: "alpha", repoPath: "/repo/alpha" }],
    });
    mockAuth("ghp_secret_token");
    configParserMocks.parseConfig.mockReturnValue({
      valid: true,
      config: { project: { github: { project: 42 } } },
    });
    credentialMocks.set.mockResolvedValue();

    const outcome = await mod.run();

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.migratedProjectIds).toEqual(["alpha"]);
    expect(outcome.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Keyring write happened before the commit.
    expect(credentialMocks.set).toHaveBeenCalledWith(
      "github-com",
      "github-token",
      "ghp_secret_token",
    );

    // Override file written with the right payload.
    expect(overrideMocks.saveOverride).toHaveBeenCalledWith("alpha", {
      schemaVersion: 1,
      integration: {
        plugin: "github-com",
        sources: { project: ["42"] },
      },
    });

    // Commit point: state.json bumped + migration record set.
    expect(stateMocks.saveState).toHaveBeenCalledTimes(1);
    const committed = stateMocks.saveState.mock.calls[0][0] as PersistedState;
    expect(committed.schemaVersion).toBe(1);
    expect(committed.migration?.status).toBe("success");
    expect(committed.migration?.migratedProjectIds).toEqual(["alpha"]);

    // Post-commit auth.json delete (idempotent fs.unlink).
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith("/mock-home/.roubo/auth.json");

    // No rollback ran; keychain slot must NOT be deleted (the migration just
    // populated it, deleting it would lock the user out).
    expect(credentialMocks.deleteSlot).not.toHaveBeenCalled();
  });

  it("writes a plugin-only override when the project has no github.project field", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [{ id: "alpha", repoPath: "/repo/alpha" }] });
    mockAuth("ghp_secret_token");
    configParserMocks.parseConfig.mockReturnValue({
      valid: true,
      config: { project: {} },
    });
    credentialMocks.set.mockResolvedValue();

    const outcome = await mod.run();

    expect(outcome.status).toBe("success");
    expect(overrideMocks.saveOverride).toHaveBeenCalledWith("alpha", {
      schemaVersion: 1,
      integration: { plugin: "github-com" },
    });
  });

  it("skips a project whose roubo.yaml fails to parse and still migrates the rest", async () => {
    mockState({ benches: [] });
    mockProjects({
      projects: [
        { id: "broken", repoPath: "/repo/broken" },
        { id: "ok", repoPath: "/repo/ok" },
      ],
    });
    mockAuth("ghp_secret_token");
    configParserMocks.parseConfig.mockImplementation((p: string) => {
      if (p === "/repo/broken") return { valid: false, errors: ["missing field"] };
      return { valid: true, config: { project: { github: { project: 7 } } } };
    });
    credentialMocks.set.mockResolvedValue();
    // Warning the user about the skipped project IS the observable behavior
    // here. Mock console.warn to keep test output clean and assert it fired.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await mod.run();

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.migratedProjectIds).toEqual(["ok"]);
    expect(overrideMocks.saveOverride).toHaveBeenCalledTimes(1);
    expect(overrideMocks.saveOverride).toHaveBeenCalledWith("ok", {
      schemaVersion: 1,
      integration: { plugin: "github-com", sources: { project: ["7"] } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('migrate: skipping project "broken"'),
    );
  });

  it("commits successfully even when post-commit auth.json delete fails", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [] });
    mockAuth("ghp_secret_token");
    credentialMocks.set.mockResolvedValue();
    fsMocks.unlinkSync.mockImplementation(() => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await mod.run();

    expect(outcome.status).toBe("success");
    expect(stateMocks.saveState).toHaveBeenCalledTimes(1);
    expect(stateMocks.saveState.mock.calls[0][0]).toMatchObject({ schemaVersion: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auth.json delete failed"), "EACCES");
    warn.mockRestore();
  });
});

describe("migrate.run — rollback path (TC-069)", () => {
  it("rolls back keyring write and leaves auth.json untouched when saveOverride throws", async () => {
    mockState({ benches: [] });
    mockProjects({
      projects: [
        { id: "alpha", repoPath: "/repo/alpha" },
        { id: "beta", repoPath: "/repo/beta" },
      ],
    });
    mockAuth("ghp_secret_token");
    configParserMocks.parseConfig.mockReturnValue({
      valid: true,
      config: { project: { github: { project: 1 } } },
    });
    credentialMocks.set.mockResolvedValue();
    credentialMocks.deleteSlot.mockResolvedValue();
    overrideMocks.saveOverride
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });

    const outcome = await mod.run();

    expect(outcome.status).toBe("rolled-back");
    if (outcome.status !== "rolled-back") throw new Error("unreachable");
    expect(outcome.reason).toContain("disk full");

    // Keyring rolled back.
    expect(credentialMocks.deleteSlot).toHaveBeenCalledWith("github-com", "github-token");
    // First override file rolled back via fs.unlinkSync.
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith("/mock-home/.roubo/integrations/alpha.yaml");

    // schemaVersion NOT bumped — only the rolled-back marker written.
    expect(stateMocks.saveState).toHaveBeenCalledTimes(1);
    const written = stateMocks.saveState.mock.calls[0][0] as PersistedState;
    expect(written.schemaVersion).toBeUndefined();
    expect(written.migration?.status).toBe("rolled-back");

    // auth.json NOT deleted (only override-file rollbacks were unlinked).
    expect(fsMocks.unlinkSync).not.toHaveBeenCalledWith("/mock-home/.roubo/auth.json");
  });

  it("does not bump schemaVersion and records rolled-back when credential-store fails", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [{ id: "alpha", repoPath: "/repo/alpha" }] });
    mockAuth("ghp_secret_token");
    configParserMocks.parseConfig.mockReturnValue({
      valid: true,
      config: { project: { github: { project: 1 } } },
    });
    credentialMocks.set.mockRejectedValue(new Error("keyring-unavailable"));

    const outcome = await mod.run();

    expect(outcome.status).toBe("rolled-back");
    expect(overrideMocks.saveOverride).not.toHaveBeenCalled();
    expect(stateMocks.saveState).toHaveBeenCalledTimes(1);
    const written = stateMocks.saveState.mock.calls[0][0] as PersistedState;
    expect(written.schemaVersion).toBeUndefined();
    expect(written.migration?.status).toBe("rolled-back");
    expect(written.migration?.reason).toContain("keyring-unavailable");
  });

  it("continues to record rolled-back even if a rollback step itself throws", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [{ id: "alpha", repoPath: "/repo/alpha" }] });
    mockAuth("ghp_secret_token");
    configParserMocks.parseConfig.mockReturnValue({
      valid: true,
      config: { project: { github: { project: 1 } } },
    });
    credentialMocks.set.mockResolvedValue();
    credentialMocks.deleteSlot.mockRejectedValue(new Error("rollback boom"));
    overrideMocks.saveOverride.mockImplementation(() => {
      throw new Error("save boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await mod.run();

    expect(outcome.status).toBe("rolled-back");
    expect(stateMocks.saveState).toHaveBeenCalledTimes(1);
    const written = stateMocks.saveState.mock.calls[0][0] as PersistedState;
    expect(written.schemaVersion).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rollback step"), "rollback boom");
    warn.mockRestore();
  });
});

describe("migrate.run — plugins-state.json seed (WU-046 / WU-047)", () => {
  it("seeds all bundled plugins as disabled before bumping schemaVersion on greenfield install", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [] });
    mockAuth(null);

    await mod.run();

    expect(enableStateMocks.saveEnableState).toHaveBeenCalledTimes(1);
    expect(enableStateMocks.saveEnableState).toHaveBeenCalledWith({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "disabled", ghe: "disabled", "jira-self-hosted": "disabled" },
    });

    // Seed must precede state.json commit so a crash between writes leaves
    // the install ready to retry migrate.
    const seedOrder = enableStateMocks.saveEnableState.mock.invocationCallOrder[0];
    const stateOrder = stateMocks.saveState.mock.invocationCallOrder[0];
    expect(seedOrder).toBeLessThan(stateOrder);
  });

  it("does not touch plugins-state.json on existing install (auth present) — FR-059 / TC-118", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [] });
    mockAuth("ghp_secret_token");
    credentialMocks.set.mockResolvedValue();

    const outcome = await mod.run();

    expect(outcome.status).toBe("success");
    expect(enableStateMocks.saveEnableState).not.toHaveBeenCalled();

    // state.json gate still bumped so the migration is idempotent next boot.
    expect(stateMocks.saveState).toHaveBeenCalledTimes(1);
    const committed = stateMocks.saveState.mock.calls[0][0] as PersistedState;
    expect(committed.schemaVersion).toBe(1);
    expect(committed.migration?.status).toBe("success");
  });

  it("does not seed when already migrated (schemaVersion already bumped)", async () => {
    mockState({ benches: [], schemaVersion: 1 });

    await mod.run();

    expect(enableStateMocks.saveEnableState).not.toHaveBeenCalled();
  });

  it("does not seed when migration rolls back", async () => {
    mockState({ benches: [] });
    mockProjects({ projects: [{ id: "alpha", repoPath: "/repo/alpha" }] });
    mockAuth("ghp_secret_token");
    configParserMocks.parseConfig.mockReturnValue({
      valid: true,
      config: { project: { github: { project: 1 } } },
    });
    credentialMocks.set.mockRejectedValue(new Error("keyring-unavailable"));

    const outcome = await mod.run();

    expect(outcome.status).toBe("rolled-back");
    expect(enableStateMocks.saveEnableState).not.toHaveBeenCalled();
  });
});

describe("migrate.getOutcome", () => {
  it("caches the most recent outcome", async () => {
    mockState({ benches: [], schemaVersion: 1 });
    expect(mod.getOutcome()).toBeNull();
    await mod.run();
    expect(mod.getOutcome()).toEqual({ status: "noop" });
  });
});
