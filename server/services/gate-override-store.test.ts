import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;
let mod: typeof import("./gate-override-store.js");
let contract: typeof import("@roubo/shared/gate-overrides-contract");

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gate-override-store-"));
  process.env.ROUBO_PRODUCTION = "1";
  process.env.HOME = tmpHome;
  vi.resetModules();
  mod = await import("./gate-override-store.js");
  contract = await import("@roubo/shared/gate-overrides-contract");
});

afterEach(() => {
  delete process.env.ROUBO_PRODUCTION;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("gate-override-store", () => {
  it("returns an empty document when no file exists", () => {
    const loaded = mod.loadOverrides("my-project");
    expect(loaded.ops).toEqual([]);
    expect(loaded.schemaVersion).toBe(contract.GATE_OVERRIDES_SCHEMA_VERSION);
  });

  it("round-trips a saved document", () => {
    const doc = {
      ...contract.emptyGateOverrides(),
      ops: [{ op: "merge" as const, gateIds: ["WU-001", "WU-002"] }],
    };
    mod.saveOverrides("my-project", doc);
    const loaded = mod.loadOverrides("my-project");
    expect(loaded.ops).toEqual(doc.ops);
  });

  it("removeOverrides leaves no document behind", () => {
    mod.saveOverrides("my-project", {
      ...contract.emptyGateOverrides(),
      ops: [{ op: "merge" as const, gateIds: ["WU-001", "WU-002"] }],
    });
    mod.removeOverrides("my-project");
    expect(mod.loadOverrides("my-project").ops).toEqual([]);
  });

  it("removeOverrides on a missing file is a no-op", () => {
    expect(() => mod.removeOverrides("never-saved")).not.toThrow();
  });

  it("rejects a traversal projectId", () => {
    expect(() => mod.loadOverrides("../escape")).toThrow();
    expect(() => mod.saveOverrides("../escape", contract.emptyGateOverrides())).toThrow();
  });

  it("rejects a dot projectId", () => {
    expect(() => mod.loadOverrides("..")).toThrow();
  });

  it("throws SCHEMA when refusing to save an invalid document", () => {
    expect(() => mod.saveOverrides("my-project", { ops: [] } as never)).toThrow(
      mod.GateOverrideStoreError,
    );
  });

  it("throws PARSE on a corrupt file", () => {
    const dir = path.join(tmpHome, ".roubo", "gate-overrides");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "my-project.json"), "{ not json", "utf8");
    expect(() => mod.loadOverrides("my-project")).toThrow(mod.GateOverrideStoreError);
  });

  it("throws SCHEMA on a present-but-invalid file (not silently empty)", () => {
    const dir = path.join(tmpHome, ".roubo", "gate-overrides");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "my-project.json"),
      JSON.stringify({ $schema: "wrong", schemaVersion: "1.0.0", ops: [] }),
      "utf8",
    );
    expect(() => mod.loadOverrides("my-project")).toThrow(mod.GateOverrideStoreError);
  });
});
