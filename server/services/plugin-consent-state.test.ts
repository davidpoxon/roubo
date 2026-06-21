import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let sandboxRoot: string;
let originalHome: string | undefined;
let originalProduction: string | undefined;
let mod: typeof import("./plugin-consent-state.js");

async function freshImport(): Promise<typeof import("./plugin-consent-state.js")> {
  vi.resetModules();
  return await import("./plugin-consent-state.js");
}

beforeEach(async () => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), "roubo-plugin-consent-"));
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
  return path.join(sandboxRoot, ".roubo", "plugins-consent.json");
}

describe("loadConsentState", () => {
  it("returns null when the file is absent", () => {
    expect(mod.loadConsentState()).toBeNull();
  });

  it("round-trips a well-formed file", () => {
    mod.saveConsentState({
      schemaVersion: 1,
      plugins: {
        "db-plugin": {
          pluginId: "db-plugin",
          acknowledgedCategories: ["docker", "ports"],
          consentedAt: "2026-06-21T00:00:00.000Z",
        },
      },
    });
    const loaded = mod.loadConsentState();
    expect(loaded?.plugins["db-plugin"].acknowledgedCategories).toEqual(["docker", "ports"]);
    expect(loaded?.plugins["db-plugin"].consentedAt).toBe("2026-06-21T00:00:00.000Z");
  });

  it("backs up an invalid-JSON file and recovers to last-known", () => {
    mod.saveConsentState({
      schemaVersion: 1,
      plugins: {
        "db-plugin": {
          pluginId: "db-plugin",
          acknowledgedCategories: ["docker"],
          consentedAt: "2026-06-21T00:00:00.000Z",
        },
      },
    });
    fs.writeFileSync(statePath(), "{ not json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = mod.loadConsentState();
    warn.mockRestore();
    // Recovers to the in-memory last-known snapshot.
    expect(loaded?.plugins["db-plugin"].acknowledgedCategories).toEqual(["docker"]);
    // The corrupt file was renamed aside.
    const broken = fs
      .readdirSync(path.dirname(statePath()))
      .filter((f) => f.startsWith("plugins-consent.json.broken-"));
    expect(broken.length).toBe(1);
  });
});

describe("getConsent / hasConsent", () => {
  it("returns null / false for an unconsented plugin", () => {
    expect(mod.getConsent("db-plugin")).toBeNull();
    expect(mod.hasConsent("db-plugin")).toBe(false);
  });

  it("returns the record / true after consent is recorded", () => {
    mod.upsertConsent("db-plugin", ["docker"]);
    const record = mod.getConsent("db-plugin");
    expect(record?.pluginId).toBe("db-plugin");
    expect(record?.acknowledgedCategories).toEqual(["docker"]);
    expect(record?.consentedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mod.hasConsent("db-plugin")).toBe(true);
  });

  it("does not reach an inherited object property for a crafted plugin id", () => {
    expect(mod.getConsent("__proto__")).toBeNull();
    expect(mod.hasConsent("constructor")).toBe(false);
  });
});

describe("upsertConsent", () => {
  it("seeds an empty document on a legacy/absent file and persists the record", () => {
    expect(mod.loadConsentState()).toBeNull();
    const record = mod.upsertConsent("proc-plugin", ["processes"]);
    expect(record.pluginId).toBe("proc-plugin");
    const loaded = mod.loadConsentState();
    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.plugins["proc-plugin"].acknowledgedCategories).toEqual(["processes"]);
  });

  it("overwrites an existing record for the same plugin", () => {
    mod.upsertConsent("db-plugin", ["docker"]);
    mod.upsertConsent("db-plugin", ["docker", "ports"]);
    expect(mod.getConsent("db-plugin")?.acknowledgedCategories).toEqual(["docker", "ports"]);
  });
});

describe("removeConsent", () => {
  it("removes a plugin id and is a no-op for an unknown id", () => {
    mod.upsertConsent("db-plugin", ["docker"]);
    mod.upsertConsent("proc-plugin", ["processes"]);
    mod.removeConsent("db-plugin");
    expect(mod.hasConsent("db-plugin")).toBe(false);
    expect(mod.hasConsent("proc-plugin")).toBe(true);
    // No-op for a plugin that was never consented.
    expect(() => mod.removeConsent("never-seen")).not.toThrow();
  });
});
