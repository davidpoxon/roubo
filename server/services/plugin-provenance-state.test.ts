import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Issue #558 / CPHMTP-FR-005 AC4: the ledger that remembers which marketplace
// source a plugin was installed from. Mirrors plugin-consent-state.test.ts: a
// sandboxed HOME per test, and a fresh module import so the in-process lastKnown
// cache never leaks between cases.

let sandboxRoot: string;
let originalHome: string | undefined;
let originalProduction: string | undefined;
let mod: typeof import("./plugin-provenance-state.js");

async function freshImport(): Promise<typeof import("./plugin-provenance-state.js")> {
  vi.resetModules();
  return await import("./plugin-provenance-state.js");
}

beforeEach(async () => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), "roubo-plugin-provenance-"));
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
  return path.join(sandboxRoot, ".roubo", "plugins-provenance.json");
}

const ACME = {
  pluginId: "database",
  sourceId: "marketplace-acme-example-1a2b3c4d",
  sourceUrl: "https://marketplace.acme.example/catalog.json",
  unverified: true,
};

describe("loadProvenanceState", () => {
  it("returns null when the file is absent", () => {
    expect(mod.loadProvenanceState()).toBeNull();
  });

  it("round-trips a well-formed file", () => {
    mod.recordProvenance(ACME);
    expect(mod.loadProvenanceState()).toMatchObject({
      schemaVersion: 1,
      plugins: { database: { sourceId: ACME.sourceId, unverified: true } },
    });
  });

  it("backs up and recovers from a corrupt file", async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await freshImport();

    // No prior in-memory snapshot, so a corrupt file reads as "nothing recorded"
    // rather than throwing and taking the plugin registry down with it.
    expect(fresh.loadProvenanceState()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt"));
    const backups = fs
      .readdirSync(path.dirname(statePath()))
      .filter((f) => f.startsWith("plugins-provenance.json.broken-"));
    expect(backups).toHaveLength(1);
  });

  it("backs up a file whose shape the schema rejects", async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ schemaVersion: 99, plugins: {} }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await freshImport();
    expect(fresh.loadProvenanceState()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("schema rejected"));
  });
});

describe("getProvenance", () => {
  it("returns null for a plugin with no row", () => {
    // Absent means first-party / verified, which is why installs predating this
    // ledger need no migration.
    expect(mod.getProvenance("database")).toBeNull();
  });

  it("returns null for a plugin id absent from a populated file", () => {
    mod.recordProvenance(ACME);
    expect(mod.getProvenance("github-com")).toBeNull();
  });

  it("returns the recorded row", () => {
    mod.recordProvenance(ACME);
    expect(mod.getProvenance("database")).toMatchObject({
      pluginId: "database",
      sourceId: ACME.sourceId,
      sourceUrl: ACME.sourceUrl,
      unverified: true,
    });
  });

  it("does not treat inherited Object properties as rows", () => {
    mod.recordProvenance(ACME);
    // A prototype-chain lookup would answer for "constructor"; the row map must
    // only ever report ids actually written to it.
    expect(mod.getProvenance("constructor")).toBeNull();
  });
});

describe("recordProvenance", () => {
  it("stamps an installedAt timestamp", () => {
    const record = mod.recordProvenance(ACME);
    expect(Date.parse(record.installedAt)).not.toBeNaN();
  });

  it("records a first-party choice as verified", () => {
    mod.recordProvenance({
      pluginId: "database",
      sourceId: "first-party",
      sourceUrl: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
      unverified: false,
    });
    expect(mod.getProvenance("database")?.unverified).toBe(false);
  });

  it("re-stamps an existing row rather than merging (an update re-chooses)", () => {
    mod.recordProvenance(ACME);
    mod.recordProvenance({ ...ACME, sourceId: "other", sourceUrl: "https://o.example/c.json" });
    expect(mod.getProvenance("database")).toMatchObject({
      sourceId: "other",
      sourceUrl: "https://o.example/c.json",
    });
  });

  it("keeps other plugins' rows intact", () => {
    mod.recordProvenance(ACME);
    mod.recordProvenance({ ...ACME, pluginId: "redis" });
    expect(mod.getProvenance("database")).not.toBeNull();
    expect(mod.getProvenance("redis")).not.toBeNull();
  });

  it("persists across a fresh module load", async () => {
    mod.recordProvenance(ACME);
    const fresh = await freshImport();
    // The point of the ledger: a record rebuilt from disk in a later process
    // still knows which source it came from.
    expect(fresh.getProvenance("database")?.sourceId).toBe(ACME.sourceId);
  });
});

describe("removeProvenance", () => {
  it("drops the row", () => {
    mod.recordProvenance(ACME);
    mod.removeProvenance("database");
    expect(mod.getProvenance("database")).toBeNull();
  });

  it("leaves other rows intact", () => {
    mod.recordProvenance(ACME);
    mod.recordProvenance({ ...ACME, pluginId: "redis" });
    mod.removeProvenance("database");
    expect(mod.getProvenance("redis")).not.toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    mod.recordProvenance(ACME);
    expect(() => mod.removeProvenance("ghost")).not.toThrow();
    expect(mod.getProvenance("database")).not.toBeNull();
  });

  it("is a no-op when no file exists", () => {
    expect(() => mod.removeProvenance("database")).not.toThrow();
  });
});
