// Regression guard (issue #799): every committed `.specifications/<slug>/work-units.json`
// that is in the work-units envelope format must satisfy the real strict contract
// (shared/work-units-contract.ts).
//
// The defect in #799 was a committed spec file (component-plugins-hosted-marketplace)
// that stored numeric `tracker.ref`, `tracker.blocked_by_refs[]`, and `covers[]` values
// where the canonical model (.specifications/verify-gate/work-unit-model.md) and the strict
// contract both require strings. The existing on-load e2e test only exercises fixtures under
// shared/__fixtures__/, so the malformed real spec file reached main unguarded. This test
// closes that gap by validating every real envelope-format spec file, guarding all current
// and future ones against the same defect class.
//
// Scope: only files in the versioned envelope format are validated, identified by a top-level
// object whose `$schema` is WORK_UNITS_SCHEMA_ID. That is exactly the format validateWorkUnits
// targets and the "5 spec files" the issue counts. A handful of older specs predate the
// work-units.json envelope migration and carry a different (top-level array) shape; they are
// not consumed through validateWorkUnits and are intentionally out of this guard's scope.
// A numeric-ref defect like #799 never alters `$schema`, so envelope files remain fully
// covered by this guard.
//
// The glob root is derived robustly from this file's location: shared/ sits one level below
// the repo root, so the spec folder is resolved relative to the repo root regardless of cwd.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateWorkUnits, WORK_UNITS_SCHEMA_ID } from "./work-units-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const specsRoot = resolve(repoRoot, ".specifications");

function isEnvelopeFormat(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as { $schema?: unknown }).$schema === WORK_UNITS_SCHEMA_ID
  );
}

// Discover every committed envelope-format `.specifications/<slug>/work-units.json`.
function discoverWorkUnitsFiles(): { slug: string; path: string }[] {
  if (!existsSync(specsRoot)) return [];
  return readdirSync(specsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ slug: entry.name, path: join(specsRoot, entry.name, "work-units.json") }))
    .filter((candidate) => existsSync(candidate.path))
    .filter((candidate) => isEnvelopeFormat(JSON.parse(readFileSync(candidate.path, "utf8"))));
}

const specFiles = discoverWorkUnitsFiles();

describe("committed work-units.json files satisfy the strict contract", () => {
  it("discovers at least one committed envelope-format work-units.json", () => {
    expect(
      specFiles.length,
      `expected to find at least one envelope-format .specifications/<slug>/work-units.json under ${specsRoot}, found none`,
    ).toBeGreaterThan(0);
  });

  it.each(specFiles)("$slug: validateWorkUnits returns ok:true", ({ slug, path }) => {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const result = validateWorkUnits(raw);
    expect(
      result.ok,
      `committed spec "${slug}" (${path}) failed the strict work-units contract: ${
        result.ok ? "" : JSON.stringify(result.errors, null, 2)
      }`,
    ).toBe(true);
  });
});
