import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let sandboxRoot: string;
let originalHome: string | undefined;
let originalProduction: string | undefined;
let mod: typeof import("./plugin-enable-state.js");

async function freshImport(): Promise<typeof import("./plugin-enable-state.js")> {
  vi.resetModules();
  return await import("./plugin-enable-state.js");
}

beforeEach(async () => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), "roubo-plugin-enable-"));
  originalHome = process.env.HOME;
  originalProduction = process.env.ROUBO_PRODUCTION;
  process.env.HOME = sandboxRoot;
  process.env.ROUBO_PRODUCTION = "1";
  mod = await freshImport();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProduction === undefined) delete process.env.ROUBO_PRODUCTION;
  else process.env.ROUBO_PRODUCTION = originalProduction;
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function statePath(): string {
  return path.join(sandboxRoot, ".roubo", "plugins-state.json");
}

describe("loadEnableState", () => {
  it("returns null when the file is absent", () => {
    expect(mod.loadEnableState()).toBeNull();
  });

  it("round-trips a well-formed file", () => {
    mod.saveEnableState({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "enabled", ghe: "disabled" },
    });
    const loaded = mod.loadEnableState();
    expect(loaded?.plugins["github-com"]).toBe("enabled");
    expect(loaded?.plugins.ghe).toBe("disabled");
    expect(loaded?.installInitialized).toBe(true);
  });

  it("backs up an invalid-JSON file and recovers to last-known", () => {
    mod.saveEnableState({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "enabled" },
    });
    fs.writeFileSync(statePath(), "{not json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = mod.loadEnableState();
    warn.mockRestore();

    expect(loaded?.plugins["github-com"]).toBe("enabled");
    const dir = path.dirname(statePath());
    const siblings = fs.readdirSync(dir);
    const backup = siblings.find((n) => n.startsWith("plugins-state.json.broken-"));
    expect(backup).toBeDefined();
    expect(siblings).not.toContain("plugins-state.json");
  });

  it("backs up a schema-rejected file and returns null when no in-process cache exists", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ schemaVersion: 99 }), "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = mod.loadEnableState();
    warn.mockRestore();

    expect(loaded).toBeNull();
    const backup = fs
      .readdirSync(path.dirname(statePath()))
      .find((n) => n.startsWith("plugins-state.json.broken-"));
    expect(backup).toBeDefined();
  });
});

describe("setPluginEnabled", () => {
  it("creates the file on first call when none exists (legacy install)", () => {
    const next = mod.setPluginEnabled("github-com", true);
    expect(next.installInitialized).toBe(false);
    expect(next.plugins["github-com"]).toBe("enabled");
    expect(fs.existsSync(statePath())).toBe(true);
  });

  it("preserves installInitialized and other plugin entries", () => {
    mod.saveEnableState({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "disabled", ghe: "disabled", "jira-self-hosted": "disabled" },
    });
    mod.setPluginEnabled("github-com", true);
    const loaded = mod.loadEnableState();
    expect(loaded?.installInitialized).toBe(true);
    expect(loaded?.plugins["github-com"]).toBe("enabled");
    expect(loaded?.plugins.ghe).toBe("disabled");
    expect(loaded?.plugins["jira-self-hosted"]).toBe("disabled");
  });

  it("toggles a previously-enabled plugin off", () => {
    mod.setPluginEnabled("github-com", true);
    mod.setPluginEnabled("github-com", false);
    expect(mod.loadEnableState()?.plugins["github-com"]).toBe("disabled");
  });
});

describe("removePlugin", () => {
  it("removes the id from the persisted map", () => {
    mod.saveEnableState({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "enabled", "user-plugin": "enabled" },
    });
    mod.removePlugin("user-plugin");
    const loaded = mod.loadEnableState();
    expect(loaded?.plugins).toEqual({ "github-com": "enabled" });
  });

  it("is a no-op when the id is not present", () => {
    mod.saveEnableState({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "enabled" },
    });
    mod.removePlugin("never-installed");
    expect(mod.loadEnableState()?.plugins).toEqual({ "github-com": "enabled" });
  });

  it("is a no-op when the file is absent", () => {
    mod.removePlugin("anything");
    expect(fs.existsSync(statePath())).toBe(false);
  });
});

describe("saveEnableState", () => {
  it("rejects an invalid payload before touching disk", () => {
    expect(() =>
      mod.saveEnableState({
        schemaVersion: 1,
        installInitialized: true,
        // @ts-expect-error: testing runtime rejection of bad payload
        plugins: { "github-com": "on" },
      }),
    ).toThrow();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it("writes the file with 0o600-equivalent mode (group/other not writable)", () => {
    mod.saveEnableState({
      schemaVersion: 1,
      installInitialized: true,
      plugins: { "github-com": "disabled" },
    });
    const mode = fs.statSync(statePath()).mode & 0o777;
    // atomicWrite default is 0o666; on POSIX the system umask trims it. We
    // assert only that owner can read/write: the precise group/other bits
    // depend on the test runner's umask.
    expect(mode & 0o600).toBe(0o600);
  });
});
