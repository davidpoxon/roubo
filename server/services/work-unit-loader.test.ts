import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVerifyUnits, WorkUnitsValidationError } from "./work-unit-loader.js";
import {
  WORK_UNITS_SCHEMA_ID,
  WORK_UNITS_SCHEMA_VERSION,
  type Unit,
  type WorkUnitsFile,
} from "@roubo/shared/work-units-contract";

// ── Builders ──

function verifyUnit(id: string, testCaseIds: string[], covers: string[] = []): Unit {
  return {
    id,
    title: `Verify ${id}`,
    type: "task",
    kind: "verify",
    description: "gate",
    acceptance_criteria: [],
    depends_on: [],
    covers,
    implements: {
      requirement_ids: [],
      user_story_ids: [],
      test_case_ids: testCaseIds,
    },
  };
}

function deliveryUnit(id: string): Unit {
  return {
    id,
    title: `Slice ${id}`,
    type: "feature",
    description: "slice",
    acceptance_criteria: [],
    depends_on: [],
    implements: {
      requirement_ids: [],
      user_story_ids: [],
      test_case_ids: [],
    },
  };
}

function envelope(specSlug: string, units: Unit[]): WorkUnitsFile {
  return {
    $schema: WORK_UNITS_SCHEMA_ID,
    schemaVersion: WORK_UNITS_SCHEMA_VERSION,
    specSlug,
    units,
  };
}

let repoPath: string;

function writeWorkUnits(slug: string, raw: string): void {
  const dir = path.join(repoPath, ".specifications", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "work-units.json"), raw, "utf8");
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "work-unit-loader-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("loadVerifyUnits", () => {
  it("returns only the kind:'verify' units, paired with their slug", () => {
    writeWorkUnits(
      "alpha",
      JSON.stringify(
        envelope("alpha", [
          deliveryUnit("WU-001"),
          verifyUnit("WU-100", ["TC-001", "TC-002"], ["WU-001"]),
        ]),
      ),
    );

    const loaded = loadVerifyUnits(repoPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].slug).toBe("alpha");
    expect(loaded[0].unit.id).toBe("WU-100");
    expect(loaded[0].unit.implements.test_case_ids).toEqual(["TC-001", "TC-002"]);
  });

  it("enumerates verify units across every spec folder, sorted by (slug, id)", () => {
    writeWorkUnits("beta", JSON.stringify(envelope("beta", [verifyUnit("WU-200", ["TC-009"])])));
    writeWorkUnits(
      "alpha",
      JSON.stringify(
        envelope("alpha", [verifyUnit("WU-150", ["TC-002"]), verifyUnit("WU-100", ["TC-001"])]),
      ),
    );

    const loaded = loadVerifyUnits(repoPath);
    expect(loaded.map((l) => `${l.slug}:${l.unit.id}`)).toEqual([
      "alpha:WU-100",
      "alpha:WU-150",
      "beta:WU-200",
    ]);
  });

  it("scopes to a single slug when one is given", () => {
    writeWorkUnits("alpha", JSON.stringify(envelope("alpha", [verifyUnit("WU-100", ["TC-001"])])));
    writeWorkUnits("beta", JSON.stringify(envelope("beta", [verifyUnit("WU-200", ["TC-009"])])));

    const loaded = loadVerifyUnits(repoPath, "beta");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].slug).toBe("beta");
    expect(loaded[0].unit.id).toBe("WU-200");
  });

  it("fails open to [] when there is no .specifications directory", () => {
    expect(loadVerifyUnits(repoPath)).toEqual([]);
  });

  it("fails open to [] for a spec folder with no work-units.json", () => {
    fs.mkdirSync(path.join(repoPath, ".specifications", "alpha"), { recursive: true });
    expect(loadVerifyUnits(repoPath)).toEqual([]);
    expect(loadVerifyUnits(repoPath, "alpha")).toEqual([]);
  });

  it("returns [] for a file with only delivery units (no gates)", () => {
    writeWorkUnits("alpha", JSON.stringify(envelope("alpha", [deliveryUnit("WU-001")])));
    expect(loadVerifyUnits(repoPath)).toEqual([]);
  });

  it("throws WorkUnitsValidationError for invalid JSON", () => {
    writeWorkUnits("alpha", "{ not json");
    expect(() => loadVerifyUnits(repoPath, "alpha")).toThrow(WorkUnitsValidationError);
  });

  it("throws WorkUnitsValidationError for a schema-invalid envelope", () => {
    writeWorkUnits("alpha", JSON.stringify({ $schema: WORK_UNITS_SCHEMA_ID, units: [] }));
    let caught: unknown;
    try {
      loadVerifyUnits(repoPath, "alpha");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkUnitsValidationError);
    expect((caught as WorkUnitsValidationError).slug).toBe("alpha");
    expect((caught as WorkUnitsValidationError).errors.length).toBeGreaterThan(0);
  });

  it("throws when a verify unit has an empty test_case_ids (R4)", () => {
    writeWorkUnits("alpha", JSON.stringify(envelope("alpha", [verifyUnit("WU-100", [])])));
    expect(() => loadVerifyUnits(repoPath, "alpha")).toThrow(WorkUnitsValidationError);
  });
});
