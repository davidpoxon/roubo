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
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
  resolveWithinRoots,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";
import { validateTestCases } from "@roubo/shared/testbench-contracts";
import type { CaseStatus, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import { computePlanHash, loadResultsFile } from "./testbench-store.js";

// Per-status case tally for one spec (#482). Non-negative integers keyed by the
// five CaseStatus values; the tally is computed over the CURRENT plan's case ids
// only, so it always sums to the spec's caseCount.
export interface SpecStatusCounts {
  not_started: number;
  in_progress: number;
  passed: number;
  failed: number;
  blocked: number;
}

// The read-only, fail-open verification state discovery computes per spec (#482,
// TSPF-FR-001/FR-002). It carries classification inputs, not presentation strings:
//   - classification: "all-passed" iff a readable, schema-valid, hash-matching
//     results sidecar is present AND every current-plan case is effectively
//     passed; everything else (including aggregationError) is "needs-attention".
//   - statusCounts: effective-status tally over the current plan (sums to caseCount).
//   - resultsPresent: a sidecar exists on disk (the loader did not report "missing").
//   - resultsValid: the sidecar parsed and passed schema validation.
//   - planHashMatch: the sidecar's recorded planHash matches computePlanHash(plan).
//   - recoveryReason: why the loader fell open (null on a clean read).
//   - aggregationError: true when the per-spec aggregation threw (e.g. a symlinked
//     sidecar escaping the repo) and this one spec degraded fail-open.
export interface SpecVerification {
  classification: "needs-attention" | "all-passed";
  statusCounts: SpecStatusCounts;
  resultsPresent: boolean;
  resultsValid: boolean;
  planHashMatch: boolean;
  recoveryReason: string | null;
  aggregationError: boolean;
}

// One discovered, contract-valid spec: the slug naming its `.specifications/<slug>/`
// folder, the absolute path to its test-cases.json, the number of cases in it, and
// its read-only per-spec verification state (#482).
export interface DiscoveredSpec {
  slug: string;
  path: string;
  caseCount: number;
  verification: SpecVerification;
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

// A fresh, all-zero status tally.
function zeroStatusCounts(): SpecStatusCounts {
  return { not_started: 0, in_progress: 0, passed: 0, failed: 0, blocked: 0 };
}

// Compute one spec's read-only verification state from its results sidecar and the
// already-parsed, contract-valid plan (#482, TSPF-FR-001/FR-002). Read-only and
// fail-open per spec:
//   - Results IO is delegated to the store's read-only loadResultsFile (the sole
//     owner of test-results.json IO); no plan re-read happens (planHashMatch reuses
//     the already-parsed plan via computePlanHash).
//   - Effective status per case = statusOverride.status ?? derivedStatus; a plan
//     case with no caseResults entry counts as not_started; caseResults entries for
//     cases no longer in the plan are ignored (tally is over current plan ids only).
//   - The whole aggregation is wrapped in try/catch so any throw (notably the
//     loader's path-safety assertion on a symlinked sidecar escaping repoPath)
//     degrades ONLY this spec to { needs-attention, aggregationError: true } and
//     never fails discovery.
function computeVerification(
  repoPath: string,
  slug: string,
  plan: TestCasesPlan,
): SpecVerification {
  try {
    const { file, recoveryReason } = loadResultsFile(repoPath, slug);
    // resultsPresent: a sidecar exists on disk (anything but a "missing" recovery).
    // resultsValid: it parsed and passed schema validation (the loader returned a file).
    const resultsPresent = recoveryReason !== "missing";
    const resultsValid = file !== null;
    const planHashMatch = file !== null && file.planHash === computePlanHash(plan);

    const caseResults = file?.caseResults ?? {};
    const statusCounts = zeroStatusCounts();
    for (const planCase of plan.cases) {
      // A plan case absent from caseResults counts as not_started; orphaned
      // caseResults entries (cases no longer in the plan) are ignored because we
      // iterate the current plan's ids, not the sidecar's keys.
      const caseResult = Object.prototype.hasOwnProperty.call(caseResults, planCase.id)
        ? caseResults[planCase.id]
        : undefined;
      const effective: CaseStatus =
        caseResult?.statusOverride?.status ?? caseResult?.derivedStatus ?? "not_started";
      statusCounts[effective] += 1;
    }

    // all-passed only when a readable, schema-valid, hash-matching sidecar is
    // present AND every current-plan case is effectively passed. A zero-case plan is
    // therefore vacuously all-passed only under such a sidecar. Everything else is
    // needs-attention.
    const allPassed =
      resultsPresent && resultsValid && planHashMatch && statusCounts.passed === plan.cases.length;

    return {
      classification: allPassed ? "all-passed" : "needs-attention",
      statusCounts,
      resultsPresent,
      resultsValid,
      planHashMatch,
      recoveryReason,
      aggregationError: false,
    };
  } catch {
    // Per-spec degrade (TSPF-FR-002): any throw leaves this one spec needs-attention
    // with safe defaults. The tally defaults to every case not_started so statusCounts
    // still sums to caseCount.
    return {
      classification: "needs-attention",
      statusCounts: { ...zeroStatusCounts(), not_started: plan.cases.length },
      resultsPresent: false,
      resultsValid: false,
      planHashMatch: false,
      recoveryReason: null,
      aggregationError: true,
    };
  }
}

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
    // resolveWithin is lexical; assertRealpathWithin follows symlinks so a
    // `.specifications` that is itself a symlink escaping the repo is rejected
    // before the readdir enumerates outside repoPath (#427). A rejection is
    // fail-open to empty here, consistent with an unreadable directory.
    assertRealpathWithin(repoPath, specsRoot, ".specifications dir");
    entries = fs.readdirSync(specsRoot, { withFileTypes: true });
  } catch {
    // No `.specifications/` directory (or unreadable/escaping): nothing to discover.
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
      // A real slug dir whose test-cases.json is a symlink escaping the repo passes
      // the lexical check; the realpath barrier rejects it before the read so the
      // leaf read never resolves outside repoPath. A throwing entry is skipped,
      // consistent with the unsafe-slug skip above (#427).
      assertRealpathWithin(repoPath, casesPath, "spec cases path");
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

    const plan = validation.data;
    specs.push({
      slug,
      path: casesPath,
      caseCount: plan.cases.length,
      // Per-spec, read-only, fail-open verification state (#482). Computed here in
      // the existing loop where the parsed, contract-valid plan is already in hand.
      verification: computeVerification(repoPath, slug, plan),
    });
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
  // resolveWithinRoots is lexical; a valid-slug `.specifications/<slug>` symlink
  // escaping the repo passes it. The realpath barrier rejects it fail-closed
  // (throwing UnsafePathError, matching this function's existing error contract)
  // so a focused path that resolves outside repoPath through a symlink is refused
  // before any downstream read (#427).
  assertRealpathWithin(repoPath, contained, "focusedSpecPath");
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
    // resolveWithinRoots is lexical; a valid-slug `.specifications/<slug>` symlink
    // escaping the repo passes it. The realpath barrier rejects it before the read
    // so the leaf read never resolves outside repoPath, returning the same
    // { ok: false } shape as the other rejections (#427).
    assertRealpathWithin(repoPath, contained, "manual spec path");
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
