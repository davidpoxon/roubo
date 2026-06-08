// Server-side spec discovery + manual-path validation for the TestBench (#416).
//
// Two responsibilities, both confined to a single registered project's repoPath:
//   - discoverSpecs(repoPath): enumerate every `.specifications/<slug>/test-cases.json`
//     under the repo, validate each candidate against the published contract, and
//     return the slug + absolute path + case count for the ones that parse.
//   - validateManualPath(repoPath, rawPath): validate a single user-supplied path
//     (the FR-003 manual escape hatch), constrained to live inside the repo.
//
// Path-safety (NFR-001): every filesystem path is resolved through resolveWithin /
// resolveWithinRoots before any fs call, and the spec slug is re-validated through
// the SPEC_SLUG_RE allowlist (assertSafeIdentifier). A path that escapes repoPath,
// or a slug carrying a separator/traversal segment, is rejected before it reaches
// disk. This module never writes; it only reads-and-validates.

import fs from "node:fs";
import path from "node:path";
import {
  assertSafeIdentifier,
  resolveWithin,
  resolveWithinRoots,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";
import { validateTestCases } from "@roubo/shared/testbench-contracts";

// One discovered, contract-valid spec: the slug naming its `.specifications/<slug>/`
// folder, the absolute path to its test-cases.json, and the number of cases in it.
export interface DiscoveredSpec {
  slug: string;
  path: string;
  caseCount: number;
}

// A spec folder that HAS a test-cases.json which failed to parse or validate
// against the contract. Surfaced distinctly from "no specs at all" so the UI can
// say "found a spec but it does not match the schema, here is why" instead of the
// misleading "No specs found". Carries the human-readable validation errors.
export interface InvalidSpec {
  slug: string;
  path: string;
  errors: string[];
}

// The full discovery result: the usable specs plus the present-but-invalid ones.
// An empty `specs` with a non-empty `invalid` means the repo HAS spec files that
// simply did not validate (a schema mismatch), which is a fundamentally different
// state from a repo with no `.specifications` at all.
export interface SpecDiscovery {
  specs: DiscoveredSpec[];
  invalid: InvalidSpec[];
}

// The shape returned by validateManualPath: on success the resolved slug + count,
// on failure a flat list of human-readable errors (no path/slug fields).
export type ManualPathValidation =
  | { ok: true; slug: string; caseCount: number }
  | { ok: false; errors: string[] };

// Enumerate every `.specifications/<slug>/test-cases.json` under repoPath, sorting
// each into the usable `specs` (parsed + contract-valid) or the present-but-broken
// `invalid` (a test-cases.json that exists but fails JSON parse or contract
// validation, with its errors attached). A missing `.specifications` directory
// yields empty lists (a repo with no specs is not an error). A folder whose slug
// fails the allowlist, or which simply has no test-cases.json, is skipped silently
// (it is not a spec at all). The distinction matters for the UI: a file that
// exists but does not validate deserves an actionable "schema mismatch" message,
// not the misleading "No specs found". Both lists are sorted by slug for
// determinism.
export function discoverSpecs(repoPath: string): SpecDiscovery {
  const empty: SpecDiscovery = { specs: [], invalid: [] };

  let specsRoot: string;
  try {
    specsRoot = resolveWithin(repoPath, ".specifications");
  } catch {
    return empty;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(specsRoot, { withFileTypes: true });
  } catch {
    // No `.specifications/` directory (or unreadable): nothing to discover.
    return empty;
  }

  const specs: DiscoveredSpec[] = [];
  const invalid: InvalidSpec[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const slug = entry.name;
    // Re-validate the slug through the allowlist before building any path with it
    // (a `.`/`..`/separator-bearing directory name can never name a spec).
    try {
      assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
    } catch {
      continue;
    }

    let casesPath: string;
    try {
      casesPath = resolveWithin(repoPath, ".specifications", slug, "test-cases.json");
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(casesPath, "utf8");
    } catch {
      // No test-cases.json in this folder: not a spec (skip silently, not invalid).
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalid.push({ slug, path: casesPath, errors: ["test-cases.json is not valid JSON"] });
      continue;
    }

    const validation = validateTestCases(parsed);
    if (!validation.ok) {
      invalid.push({ slug, path: casesPath, errors: validation.errors });
      continue;
    }

    specs.push({ slug, path: casesPath, caseCount: validation.data.cases.length });
  }

  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  invalid.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, invalid };
}

// Derive the spec slug from a focusedSpecPath, asserting containment in repoPath
// along the way. A focusedSpecPath is an absolute (or repo-relative) path to a
// `.specifications/<slug>/test-cases.json` file; this returns the resolved
// absolute path plus its slug, or throws UnsafePathError when the path escapes the
// repo, is not shaped like a spec path, or carries an unsafe slug. Shared by the
// create + re-point paths so both validate identically. Unlike validateManualPath
// this does NOT read or contract-validate the file (the store does that on the
// next plan load); it only enforces the path-safety invariant.
export function resolveFocusedSpec(
  repoPath: string,
  focusedSpecPath: string,
): { slug: string; resolvedPath: string } {
  if (typeof focusedSpecPath !== "string" || focusedSpecPath.trim().length === 0) {
    throw new UnsafePathError("focusedSpecPath must be a non-empty string");
  }
  const absoluteCandidate = path.isAbsolute(focusedSpecPath)
    ? focusedSpecPath
    : path.resolve(repoPath, focusedSpecPath);
  const contained = resolveWithinRoots([repoPath], absoluteCandidate);
  if (contained === null) {
    throw new UnsafePathError(
      `focusedSpecPath "${focusedSpecPath}" escapes the project repository`,
    );
  }
  const rel = path.relative(path.resolve(repoPath), contained);
  const segments = rel.split(path.sep);
  if (
    segments.length !== 3 ||
    segments[0] !== ".specifications" ||
    segments[2] !== "test-cases.json"
  ) {
    throw new UnsafePathError(
      `focusedSpecPath "${focusedSpecPath}" must point at .specifications/<slug>/test-cases.json inside the project`,
    );
  }
  const slug = segments[1];
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  return { slug, resolvedPath: contained };
}

// Validate a single user-supplied path against repoPath (FR-003). The path must:
//   1. resolve to somewhere strictly inside repoPath (NFR-001 containment),
//   2. sit at `.specifications/<slug>/test-cases.json` with a slug that passes the
//      allowlist,
//   3. read as JSON and validate against the published test-cases contract.
// Any failure returns { ok: false, errors }. On success it returns the resolved
// slug + case count, the same shape discoverSpecs reports per entry.
export function validateManualPath(repoPath: string, rawPath: string): ManualPathValidation {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, errors: ["path must be a non-empty string"] };
  }

  // Containment: resolve the candidate under repoPath and reject any escape. A
  // relative path is resolved against repoPath; an absolute path is accepted only
  // when it already lives inside repoPath.
  const absoluteCandidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoPath, rawPath);
  const contained = resolveWithinRoots([repoPath], absoluteCandidate);
  if (contained === null) {
    return { ok: false, errors: ["path escapes the project repository"] };
  }

  // The candidate must be `<repoPath>/.specifications/<slug>/test-cases.json`.
  const rel = path.relative(path.resolve(repoPath), contained);
  const segments = rel.split(path.sep);
  if (
    segments.length !== 3 ||
    segments[0] !== ".specifications" ||
    segments[2] !== "test-cases.json"
  ) {
    return {
      ok: false,
      errors: ["path must point at .specifications/<slug>/test-cases.json inside the project"],
    };
  }
  const slug = segments[1];
  try {
    assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  } catch (err) {
    return { ok: false, errors: [(err as UnsafePathError).message] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(contained, "utf8");
  } catch {
    return { ok: false, errors: [`No readable test-cases.json at ${rel}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["test-cases.json is not valid JSON"] };
  }

  const validation = validateTestCases(parsed);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  return { ok: true, slug, caseCount: validation.data.cases.length };
}
