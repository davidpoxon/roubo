import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  validateWorkUnits,
  WORK_UNITS_SCHEMA_ID,
  WORK_UNITS_SCHEMA_VERSION,
  type WorkUnitsFile,
} from "./work-units-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "__fixtures__", "work-units.json");

// A minimal, valid plain unit (no `kind`), used as the base for negative cases
// so each test isolates exactly one violation.
function plainUnit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "WU-001",
    title: "A plain delivery slice",
    type: "feature",
    description: "Do the thing.",
    acceptance_criteria: ["It does the thing"],
    depends_on: [],
    implements: {
      requirement_ids: ["FR-001"],
      user_story_ids: [],
      test_case_ids: [],
    },
    ...overrides,
  };
}

function envelope(units: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    $schema: WORK_UNITS_SCHEMA_ID,
    schemaVersion: WORK_UNITS_SCHEMA_VERSION,
    specSlug: "verify-gate",
    units,
    ...overrides,
  };
}

describe("validateWorkUnits", () => {
  describe("valid envelopes", () => {
    it('accepts the committed fixture carrying a kind:"verify" gate', () => {
      const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
      const result = validateWorkUnits(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const verify = result.data.units.find((u) => u.kind === "verify");
        expect(verify).toBeDefined();
        expect(verify?.implements.test_case_ids.length).toBeGreaterThan(0);
      }
    });

    it('accepts an envelope whose only unit is a kind:"verify" gate', () => {
      const verifyUnit = plainUnit({
        id: "WU-009",
        type: "task",
        kind: "verify",
        depends_on: ["WU-003"],
        covers: ["WU-003"],
        implements: {
          requirement_ids: ["NFR-001"],
          user_story_ids: ["US-008"],
          test_case_ids: ["TC-050"],
        },
      });
      const result = validateWorkUnits(envelope([verifyUnit]));
      expect(result.ok).toBe(true);
    });

    it.each(["github", "ghe", "jira"] as const)(
      "accepts a tracker-agnostic unit with tracker.system %s",
      (system) => {
        const unit = plainUnit({
          tracker: {
            system,
            ref: "ABC-1",
            url: "https://tracker.example/ABC-1",
            blocked_by_refs: [],
          },
        });
        const result = validateWorkUnits(envelope([unit]));
        expect(result.ok).toBe(true);
      },
    );
  });

  describe("invalid envelopes are rejected with field-named errors and never throw", () => {
    it("missing schemaVersion", () => {
      const raw = envelope([plainUnit()]);
      delete (raw as Record<string, unknown>).schemaVersion;
      let result: ReturnType<typeof validateWorkUnits>;
      expect(() => {
        result = validateWorkUnits(raw);
      }).not.toThrow();
      result = validateWorkUnits(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
      }
    });

    it("wrong $schema", () => {
      const raw = envelope([plainUnit()], {
        $schema: "https://roubo.dev/schema/work-units/v9.9.9.json",
      });
      const result = validateWorkUnits(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith("$schema"))).toBe(true);
      }
    });

    it("a unit missing a required field (title)", () => {
      const unit = plainUnit();
      delete (unit as Record<string, unknown>).title;
      const result = validateWorkUnits(envelope([unit]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("units.0.title"))).toBe(true);
      }
    });

    it('a kind:"verify" unit missing implements.test_case_ids', () => {
      const unit = plainUnit({
        kind: "verify",
        implements: {
          requirement_ids: ["NFR-001"],
          user_story_ids: [],
          test_case_ids: [],
        },
      });
      const result = validateWorkUnits(envelope([unit]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("units.0.implements.test_case_ids"))).toBe(
          true,
        );
      }
    });

    it("an unknown extra field on a unit", () => {
      const unit = plainUnit({ bogus: "nope" });
      const result = validateWorkUnits(envelope([unit]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it("an unknown extra field on the envelope", () => {
      const raw = envelope([plainUnit()], { bogus: "nope" });
      const result = validateWorkUnits(raw);
      expect(result.ok).toBe(false);
    });

    it("a non-object input never throws", () => {
      for (const bad of [null, undefined, 42, "x", []] as unknown[]) {
        expect(() => validateWorkUnits(bad)).not.toThrow();
        expect(validateWorkUnits(bad).ok).toBe(false);
      }
    });
  });

  it("returns a typed WorkUnitsFile on success", () => {
    const result = validateWorkUnits(envelope([plainUnit()]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data: WorkUnitsFile = result.data;
      expect(data.$schema).toBe(WORK_UNITS_SCHEMA_ID);
      expect(data.schemaVersion).toBe(WORK_UNITS_SCHEMA_VERSION);
    }
  });
});
