// TC-002 (e2e_flow, level 1): load a spec's work-units.json, the real
// validateWorkUnits accepts the valid file and rejects a malformed copy.
//
// The "running system" here is the real validator (shared/work-units-contract.ts),
// not a mock: this test reads fixture files from disk, JSON.parses them, and runs
// the actual validateWorkUnits, walking TC-002's S001 -> S003 step for step.
//
// Drift guard (issue #713 acceptance criteria): each it() is named after its
// TC-002 step id, and every assertion attaches an expected-vs-actual message that
// names the owning slice issue #697 (this unit's blocked_by / covers set, from
// .specifications/verify-gate/issues.json). A red run therefore localizes the
// integration drift to slice #697, the work-units contract + validator.
//
// The fixtures live under shared/__fixtures__/ (where the contract test already
// reads fixtures) rather than in a real .specifications/testbench/ spec folder, so
// a deliberately malformed JSON file never pollutes real spec content. TC-002's
// precondition ("a spec's work-units.json") is realized via the fixture's
// specSlug "testbench".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { validateWorkUnits } from "./work-units-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const validFixturePath = resolve(here, "__fixtures__", "work-units.testbench.json");
const invalidFixturePath = resolve(here, "__fixtures__", "work-units.testbench.invalid.json");

// The owning slice issue from this e2e unit's blocked-by set (#713 -> #697).
const OWNING_SLICE = "#697 (work-units contract + validator)";

describe("TC-002: validate a spec's work-units.json on load", () => {
  it("S001/S002: accepts the valid testbench work-units.json", () => {
    // S001: read the valid work-units.json and JSON.parse it.
    const raw = JSON.parse(readFileSync(validFixturePath, "utf8"));

    // S002: pass the parsed object to validateWorkUnits().
    const result = validateWorkUnits(raw);

    // S002-O01: returns { ok: true, data }.
    expect(
      result.ok,
      `TC-002 step S002 (S002-O01) diverged: expected validateWorkUnits to return ok:true for the valid testbench fixture, got ${JSON.stringify(
        result,
      )}. Owning slice: ${OWNING_SLICE}.`,
    ).toBe(true);

    if (result.ok) {
      // S002-O01: data.specSlug is "testbench".
      expect(
        result.data.specSlug,
        `TC-002 step S002 (S002-O01) diverged: expected data.specSlug "testbench", got "${result.data.specSlug}". Owning slice: ${OWNING_SLICE}.`,
      ).toBe("testbench");

      // S002-O01: data.units is a non-empty array.
      expect(
        result.data.units.length,
        `TC-002 step S002 (S002-O01) diverged: expected data.units to be a non-empty array, got length ${result.data.units.length}. Owning slice: ${OWNING_SLICE}.`,
      ).toBeGreaterThan(0);
    }
  });

  it("S003: rejects the malformed copy (schemaVersion removed) without throwing", () => {
    // S003: read the malformed copy (schemaVersion removed) and JSON.parse it.
    const raw = JSON.parse(readFileSync(invalidFixturePath, "utf8"));

    // S003-O02: no exception is thrown; a discriminated result object is returned.
    let result: ReturnType<typeof validateWorkUnits> | undefined;
    expect(() => {
      result = validateWorkUnits(raw);
    }, `TC-002 step S003 (S003-O02) diverged: expected validateWorkUnits NOT to throw on the malformed copy, but it threw. Owning slice: ${OWNING_SLICE}.`).not.toThrow();

    expect(
      result,
      `TC-002 step S003 (S003-O02) diverged: expected a discriminated result object, got ${JSON.stringify(
        result,
      )}. Owning slice: ${OWNING_SLICE}.`,
    ).toBeDefined();

    // S003-O01: returns { ok: false, errors }.
    expect(
      result?.ok,
      `TC-002 step S003 (S003-O01) diverged: expected validateWorkUnits to return ok:false for the malformed copy, got ${JSON.stringify(
        result,
      )}. Owning slice: ${OWNING_SLICE}.`,
    ).toBe(false);

    if (result && !result.ok) {
      // S003-O01: errors reference the missing schemaVersion field.
      expect(
        result.errors.some((e) => e.includes("schemaVersion")),
        `TC-002 step S003 (S003-O01) diverged: expected errors to reference the missing "schemaVersion" field, got ${JSON.stringify(
          result.errors,
        )}. Owning slice: ${OWNING_SLICE}.`,
      ).toBe(true);
    }
  });
});
