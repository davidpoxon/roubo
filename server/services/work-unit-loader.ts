// Validated loader for the published `work-units.json` artifact (#701, FR-003,
// FR-008, FR-012, architecture.md "WorkUnitLoader" row).
//
// Responsibility: locate every `.specifications/<slug>/work-units.json` under a
// registered project's repoPath, validate each against the published contract
// (`validateWorkUnits` in @roubo/shared/work-units-contract), and return the
// `kind: "verify"` units (the gates). The gate API routes consume these: each
// VerifyUnit's `implements.test_case_ids` is the gating set and `covers` lists
// the WU- ids it spans.
//
// Roubo only validates and reads `work-units.json`; the file is authored by the
// external `breakdown` (architecture.md "Data shapes"). Until breakdown emits
// gates, a project may have no `work-units.json` at all.
//
// Fail-open vs surface-errors (mirrors discoverSpecs):
//   - an absent `.specifications/` directory, an unreadable directory, or a spec
//     folder with no `work-units.json` yields no gates (fail-open to empty): a
//     project with no gates is a normal state, not an error.
//   - a `work-units.json` that EXISTS but fails JSON parse or contract validation
//     is surfaced as a WorkUnitsValidationError: a present-but-broken artifact is
//     a real misconfiguration the operator must see, not silently dropped (which
//     would mask a missing gate, the NFR-007 fail-closed spirit).
//
// Path-safety (NFR-001): every fs path flows through assertSafeIdentifier(slug)
// then resolveWithin(repoPath, '.specifications', slug, ...), so an out-of-repo
// or traversal slug is rejected before any fs call. This module never writes.

import fs from "node:fs";
import { assertSafeIdentifier, resolveWithin, SPEC_SLUG_RE } from "../lib/safe-path.js";
import { validateWorkUnits } from "@roubo/shared/work-units-contract";
import type { VerifyUnit } from "../lib/gate-evaluator.js";

// Raised when a `work-units.json` file is present but fails JSON parse or
// contract validation. Carries the offending slug and the human-readable
// validation errors so the route layer can map it to a 400 (a broken artifact is
// a bad-request-shaped misconfiguration, not a 500).
export class WorkUnitsValidationError extends Error {
  constructor(
    public slug: string,
    public errors: string[],
  ) {
    super(`work-units.json for spec "${slug}" failed validation: ${errors.join("; ")}`);
    this.name = "WorkUnitsValidationError";
  }
}

// A verify unit paired with the spec slug whose `.specifications/<slug>/` folder
// it lives in. The route needs the slug to load that spec's plan + results
// (`readPlanAndResults(repoPath, slug)`) when evaluating the gate.
export interface LoadedVerifyUnit {
  slug: string;
  unit: VerifyUnit;
}

// Read + validate the `work-units.json` for a single slug, returning its verify
// units. Returns [] when the file is absent (fail-open). Throws
// WorkUnitsValidationError when the file exists but is not valid JSON or fails
// the contract.
//
// `slug` is re-validated through the SPEC_SLUG_RE allowlist before any path is
// built, so a traversal/separator-bearing slug is rejected up front.
function loadVerifyUnitsForSlug(repoPath: string, slug: string): VerifyUnit[] {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(repoPath, ".specifications", slug, "work-units.json");

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    // No work-units.json in this folder: no gates here (fail-open, not an error).
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkUnitsValidationError(slug, ["work-units.json is not valid JSON"]);
  }

  const validation = validateWorkUnits(parsed);
  if (!validation.ok) {
    throw new WorkUnitsValidationError(slug, validation.errors);
  }

  // A VerifyUnit is a unit whose durable role is `verify`; its
  // implements.test_case_ids is the gating set (the validator already guarantees
  // it is non-empty for verify units).
  return validation.data.units.filter((unit): unit is VerifyUnit => unit.kind === "verify");
}

// Load the verify units (gates) for a registered project's repoPath, each paired
// with the spec slug it lives under. When `slug` is given, only that spec folder
// is read; otherwise every `.specifications/<slug>/work-units.json` is enumerated
// (like discoverSpecs) and the verify units across all of them are concatenated.
//
// Fail-open: an absent or unreadable `.specifications/` directory, and any spec
// folder without a work-units.json, contribute no gates. A present-but-invalid
// work-units.json throws WorkUnitsValidationError (it is surfaced, not dropped).
//
// The result is sorted by (slug, unit id) for deterministic ordering across
// calls.
export function loadVerifyUnits(repoPath: string, slug?: string): LoadedVerifyUnit[] {
  const loaded: LoadedVerifyUnit[] = [];

  const collect = (specSlug: string): void => {
    for (const unit of loadVerifyUnitsForSlug(repoPath, specSlug)) {
      loaded.push({ slug: specSlug, unit });
    }
  };

  if (slug !== undefined) {
    collect(slug);
  } else {
    let specsRoot: string;
    try {
      specsRoot = resolveWithin(repoPath, ".specifications");
    } catch {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(specsRoot, { withFileTypes: true });
    } catch {
      // No `.specifications/` directory (or unreadable): no gates to load.
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      // Skip a directory whose name is not a valid slug before building any path
      // (a `.`/`..`/separator-bearing directory name can never name a spec).
      try {
        assertSafeIdentifier(entry.name, SPEC_SLUG_RE, "spec slug");
      } catch {
        continue;
      }
      collect(entry.name);
    }
  }

  loaded.sort((a, b) => a.slug.localeCompare(b.slug) || a.unit.id.localeCompare(b.unit.id));
  return loaded;
}
