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
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "../lib/safe-path.js";
import { validateWorkUnits } from "@roubo/shared/work-units-contract";
import type { Unit } from "@roubo/shared/work-units-contract";
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
  // For an operator-merged synthetic gate (gate-overrides.ts): the real source
  // gates it was merged from, flattened to their filed leaves, each carrying its
  // own tracker manifestation. A merged gate has no single filed issue of its own,
  // so the sign-off / reopen / signed-off computation fans out over these sources
  // (issue #435). Absent on a normally-loaded gate and on a split gate.
  mergedFrom?: readonly VerifyUnit[];
}

// A spec folder whose `work-units.json` EXISTS but failed JSON parse or contract
// validation, so it was skipped by the all-specs load (#371). Carries the slug
// and the human-readable validation errors so the route layer can surface the
// skip to the operator (a warning naming the spec + the failure) instead of the
// error only reaching the server console. This is the reporting side of the #802
// per-spec resilience: one broken spec is still skipped, but no longer silently.
export interface InvalidSpec {
  slug: string;
  errors: string[];
}

// The all-specs load result: the loaded verify units plus any specs whose
// `work-units.json` was present-but-invalid (skipped, with their errors). For the
// single-slug path `invalidSpecs` is always empty: that path stays fail-closed
// and throws rather than collecting a diagnostic.
export interface VerifyUnitsDiagnostics {
  loaded: LoadedVerifyUnit[];
  invalidSpecs: InvalidSpec[];
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
  // resolveWithin is lexical; a valid-slug `.specifications/<slug>` symlink (or a
  // symlinked work-units.json leaf) escaping the repo passes it. The realpath
  // barrier rejects it before the read so the read never resolves outside repoPath
  // (#427). Fail-closed here: the single-slug path throws; the all-specs loop
  // catches the UnsafePathError and skips the escaping entry.
  assertRealpathWithin(repoPath, target, "work-units path");

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

// Read + validate the `work-units.json` for a single slug, returning ALL its
// units (verify and non-verify). Returns [] when the file is absent (fail-open),
// and throws WorkUnitsValidationError when the file exists but is invalid (same
// contract as loadVerifyUnitsForSlug). Used to build the WU- -> test_case_ids
// map a split needs from the non-verify units, and by the gates route to derive
// each gate's upstream `blockedBy` from the local depends_on + covers graph (#433).
export function loadAllUnitsForSlug(repoPath: string, slug: string): Unit[] {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(repoPath, ".specifications", slug, "work-units.json");
  // Symlink-following barrier before the read, matching loadVerifyUnitsForSlug
  // (fail-closed): a symlinked spec dir/leaf escaping the repo is rejected before
  // readFileSync can resolve outside repoPath (#427).
  assertRealpathWithin(repoPath, target, "work-units path");

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
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
  return validation.data.units;
}

// Build the WU- id -> test_case_ids map for a single spec slug, drawn from the
// spec's NON-verify units (a delivery slice's `implements.test_case_ids` is the
// set of cases that slice delivers). A split assigns the source gate's `covers`
// WU- ids to parts; this map resolves each part's gating set (#703, TC-023).
//
// Last-write-wins on a duplicate WU- id (the validator does not enforce id
// uniqueness); a verify unit's own entry is excluded since its test_case_ids is
// a gating set, not a delivery set.
export function buildWorkUnitCaseMap(repoPath: string, slug: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const unit of loadAllUnitsForSlug(repoPath, slug)) {
    if (unit.kind === "verify") {
      continue;
    }
    map.set(unit.id, [...unit.implements.test_case_ids]);
  }
  return map;
}

// Load the verify units (gates) for a registered project's repoPath, each paired
// with the spec slug it lives under. When `slug` is given, only that spec folder
// is read; otherwise every `.specifications/<slug>/work-units.json` is enumerated
// (like discoverSpecs) and the verify units across all of them are concatenated.
//
// Fail-open: an absent or unreadable `.specifications/` directory, and any spec
// folder without a work-units.json, contribute no gates.
//
// Per-spec error handling diverges by path (#802):
//   - single-slug path (`slug` given): a present-but-invalid work-units.json
//     throws WorkUnitsValidationError, surfaced not dropped. This is the fail-
//     closed per-spec contract (NFR-007): asking for one spec's gates must never
//     silently hide that the spec's artifact is broken.
//   - all-specs path (`slug` omitted): one malformed spec must not abort the
//     whole aggregate request. A WorkUnitsValidationError from any single spec is
//     caught, logged once (naming the slug), COLLECTED into `invalidSpecs`, and
//     skipped so the remaining valid specs still load. Other errors propagate.
//
// Returns both the loaded gates and the collected `invalidSpecs` so the route can
// surface the skipped specs to the operator (#371) rather than the error only
// reaching the server console. The single-slug path leaves `invalidSpecs` empty
// (it throws instead of collecting). `loaded` is sorted by (slug, unit id) and
// `invalidSpecs` by slug, for deterministic ordering across calls.
export function loadVerifyUnitsWithDiagnostics(
  repoPath: string,
  slug?: string,
): VerifyUnitsDiagnostics {
  const loaded: LoadedVerifyUnit[] = [];
  const invalidSpecs: InvalidSpec[] = [];

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
      return { loaded, invalidSpecs };
    }

    let entries: fs.Dirent[];
    try {
      // Reject a `.specifications` that is itself a symlink escaping the repo
      // before the readdir enumerates outside repoPath (#427). Fail-open to empty
      // here, consistent with an unreadable directory.
      assertRealpathWithin(repoPath, specsRoot, ".specifications dir");
      entries = fs.readdirSync(specsRoot, { withFileTypes: true });
    } catch {
      // No `.specifications/` directory (or unreadable/escaping): no gates to load.
      return { loaded, invalidSpecs };
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
      // Per-spec resilience (#802): a single malformed work-units.json must not
      // abort the whole aggregate gates request. Catch this spec's validation
      // error, warn once naming the slug, record it in `invalidSpecs` (#371), and
      // skip it so the valid specs load. Non-validation errors still propagate.
      try {
        collect(entry.name);
      } catch (err) {
        if (err instanceof WorkUnitsValidationError) {
          console.warn(`Skipping spec "${err.slug}" in cross-spec gates load: ${err.message}`);
          invalidSpecs.push({ slug: err.slug, errors: err.errors });
          continue;
        }
        // A symlinked spec dir/leaf that escapes the repo (#427): skip it so the
        // read never resolves outside repoPath, consistent with the unsafe-slug
        // skip above. The single-slug path stays fail-closed (it throws).
        if (err instanceof UnsafePathError) {
          continue;
        }
        throw err;
      }
    }
  }

  loaded.sort((a, b) => a.slug.localeCompare(b.slug) || a.unit.id.localeCompare(b.unit.id));
  invalidSpecs.sort((a, b) => a.slug.localeCompare(b.slug));
  return { loaded, invalidSpecs };
}

// Load the verify units (gates) for a project, discarding the per-spec
// diagnostics. A thin delegate over loadVerifyUnitsWithDiagnostics so existing
// callers that only want the gates are untouched; callers that need to surface
// skipped-spec errors (the gates route, #371) use the diagnostics variant.
export function loadVerifyUnits(repoPath: string, slug?: string): LoadedVerifyUnit[] {
  return loadVerifyUnitsWithDiagnostics(repoPath, slug).loaded;
}
