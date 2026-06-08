// The thin server file-IO service for the test-results.json sidecar (#415).
//
// This module composes already-landed building blocks rather than reimplementing
// them:
//   - path safety: resolveWithin + assertSafeIdentifier/SPEC_SLUG_RE (safe-path)
//   - validation + version: validateTestCases/validateTestResults +
//     TEST_RESULTS_SCHEMA_VERSION (testbench-contracts)
//   - staleness hash: canonicalize (testbench-canonicalize) + node:crypto sha256
//   - state + reconcile: deriveStatus/reconcile/purgeOrphans (testbench-domain)
//   - authors: resolveGitIdentity (git-helpers, #427)
//   - atomic write: writeResults same-directory temp+rename (#406)
//
// Contracts honoured here:
//   - NFR-001: every fs path flows through assertSafeIdentifier(slug) then
//     resolveWithin(repoPath, '.specifications', slug, ...), so an out-of-repo or
//     traversal slug is rejected before any fs call.
//   - FR-014/FR-015/AC3: the results sidecar read is FAIL-OPEN: a missing,
//     corrupt, schema-invalid, or future-major-version file yields a recovery
//     signal (recovered: true) and a null results view, never a throw.
//   - FR-016: the server hashes canonicalize(plan) with sha256 and compares it to
//     the stored planHash to flag staleness.
//   - AC4: the source test-cases.json is never written here, so it stays
//     byte-identical after any write or reconcile.
//   - FR-012/AC5: marks, overrides, and notes are stamped with the resolved git
//     identity, falling back to the sentinel author when git identity is unset.
//   - NFR-003: reconcile is orphan-not-delete; physical deletion only happens when
//     purgeOrphans is explicitly requested.
//
// The store exposes plain functions keyed by (repoPath, slug, benchId) primitives,
// the lib-level convention testbench-results-write.ts established, so the routes
// (#12) can wrap them later. Routes and UI stay out of scope here.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  assertSafeIdentifier,
  assertSafeMapKey,
  resolveWithin,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";
import { writeResults } from "./testbench-results-write.js";
import {
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  validateTestCases,
  validateTestResults,
  type Author,
  type BenchResults,
  type CaseResult,
  type CaseStatus,
  type Note,
  type StatusOverride,
  type TestCasesPlan,
  type TestResultsFile,
} from "@roubo/shared/testbench-contracts";
import { canonicalize } from "@roubo/shared/testbench-canonicalize";
import {
  deriveStatus,
  purgeOrphans,
  reconcile as reconcileDomain,
  type ReconcileClassification,
} from "@roubo/shared/testbench-domain";
import { resolveGitIdentity } from "../services/git-helpers.js";

// Raised when the source plan (test-cases.json) is missing or invalid. The plan
// is required: there is nothing to test without it, so reads do NOT fail open on
// a missing/invalid plan (only the results sidecar fails open).
export class MissingPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingPlanError";
  }
}

// ── Internal path helpers (NFR-001) ──
//
// Both helpers run assertSafeIdentifier(slug) FIRST so a traversal/separator slug
// is rejected before any path is built, then resolveWithin joins under the fixed
// repo root and asserts containment (the CodeQL-recognised sanitizer shape).

function planPath(repoPath: string, slug: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  return resolveWithin(repoPath, ".specifications", slug, "test-cases.json");
}

function resultsPath(repoPath: string, slug: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  return resolveWithin(repoPath, ".specifications", slug, "test-results.json");
}

// Compute the staleness hash: sha256 over the deterministic canonical string for
// the plan (FR-016). canonicalize drops $schema/schemaVersion/specSlug and every
// targeting field, so the hash tracks the testable case body only.
export function computePlanHash(plan: TestCasesPlan): string {
  return createHash("sha256").update(canonicalize(plan), "utf8").digest("hex");
}

// The current schema major, parsed once from TEST_RESULTS_SCHEMA_VERSION.
function currentResultsMajor(): number {
  return parseInt(TEST_RESULTS_SCHEMA_VERSION.split(".")[0], 10);
}

// Parse the major component of a stored schemaVersion string. A non-semver or
// empty value yields NaN, which the future-version guard treats as not-future
// (it falls through to schema validation, which will reject a malformed file).
function parseMajor(version: unknown): number {
  if (typeof version !== "string") {
    return NaN;
  }
  return parseInt(version.split(".")[0], 10);
}

// ── Fail-open load of the results sidecar (FR-014/FR-015/AC3) ──
//
// Returns { file, recovered }. The file is null and recovered is true when the
// sidecar is missing, unreadable, not valid JSON, fails schema validation, or
// carries a MAJOR schema version greater than the current one. This never throws
// for any of those conditions: a corrupt or future-version file must not crash a
// read. (assertSafeIdentifier/resolveWithin path-safety errors are raised by the
// caller before loadFile runs, so they cannot surface here.)
function loadFile(
  repoPath: string,
  slug: string,
): { file: TestResultsFile | null; recovered: boolean } {
  const target = resultsPath(repoPath, slug);

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    // Missing or unreadable: fail open with no recovery flag for the plain
    // missing case is wrong (we want a recovery signal so the caller can choose
    // to re-init), so missing IS a recovered state too: there is no prior file.
    return { file: null, recovered: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON: fail open.
    return { file: null, recovered: true };
  }

  // Future MAJOR version: a file written by a newer Roubo could carry fields this
  // build does not understand. Treat it as unreadable (fail open) rather than
  // risk a lossy round-trip. Checked BEFORE schema validation because a
  // future-version file will not match the current strict schema anyway, and the
  // future-version intent is the more specific signal.
  const storedMajor = parseMajor(
    typeof parsed === "object" && parsed !== null
      ? (parsed as { schemaVersion?: unknown }).schemaVersion
      : undefined,
  );
  if (!Number.isNaN(storedMajor) && storedMajor > currentResultsMajor()) {
    return { file: null, recovered: true };
  }

  const validation = validateTestResults(parsed);
  if (!validation.ok) {
    // Schema-invalid: fail open.
    return { file: null, recovered: true };
  }

  return { file: validation.data, recovered: false };
}

// Strip any field the published strict contract does not yet persist before a
// write. testbench-domain.reconcile stamps a per-case `caseCanon` snapshot (used
// for cross-run changed/unchanged classification) onto changed cases, but the
// published CaseResultSchema is `.strict()` and does not declare `caseCanon`
// (aligning the contract to persist it is tracked in #447). Writing it verbatim
// would make the next strict `loadFile` read reject the whole file and fail open,
// silently discarding every recorded result. Dropping it here keeps the file
// round-trippable through strict validation; until #447 lands, a result with no
// stored snapshot is conservatively classified `changed` on reconcile (a
// re-review prompt that loses nothing), the documented safe fallback.
function toContractFile(file: TestResultsFile): TestResultsFile {
  for (const bench of Object.values(file.benches)) {
    for (const caseResult of Object.values(bench.caseResults)) {
      delete (caseResult as { caseCanon?: string }).caseCanon;
    }
  }
  return file;
}

// Persist a results file atomically (same-directory temp+rename, EXDEV-safe) via
// the #406 write primitive. The slug is re-validated inside writeResults, so this
// path is safe even though the file object itself carries no slug. The file is
// reduced to the published-contract shape first, so what lands on disk always
// re-validates (no fail-open data loss on the next read).
function persist(repoPath: string, slug: string, file: TestResultsFile): void {
  writeResults(repoPath, slug, JSON.stringify(toContractFile(file), null, 2));
}

// Build an empty results file. planHash is filled by the caller after the plan is
// hashed (an init always happens in a context where the plan is in hand).
function emptyFile(planHash: string): TestResultsFile {
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash,
    benches: {},
  };
}

// Build an empty bench results bucket.
function emptyBench(): BenchResults {
  return { caseResults: {}, updatedAt: new Date().toISOString() };
}

// Build an empty case result.
function emptyCaseResult(): CaseResult {
  return {
    observationMarks: {},
    derivedStatus: "not_started",
    notes: [],
  };
}

// Convert a resolved git identity into the contract Author shape (FR-012). The
// sentinel flag is carried through only when set, matching AuthorSchema (where
// isSentinel is an optional literal true).
function toAuthor(identity: { name: string; email: string; isSentinel?: boolean }): Author {
  if (identity.isSentinel === true) {
    return { name: identity.name, email: identity.email, isSentinel: true };
  }
  return { name: identity.name, email: identity.email };
}

// Gather every observation id defined across a plan case's steps, so a case's
// derivedStatus can be recomputed from its marks against the plan's observation
// set.
function planCaseObservationIds(plan: TestCasesPlan, caseId: string): string[] {
  const planCase = plan.cases.find((c) => c.id === caseId);
  if (planCase === undefined) {
    return [];
  }
  const ids: string[] = [];
  for (const step of planCase.steps) {
    for (const observation of step.observations) {
      ids.push(observation.id);
    }
  }
  return ids;
}

// ── Public read API ──

export interface PlanAndResults {
  // The validated source plan (required: a read throws if it is missing/invalid).
  plan: TestCasesPlan;
  // This bench's recorded results, or null when no results exist for the bench
  // (or the sidecar was recovered).
  results: BenchResults | null;
  // True when the stored file's planHash differs from the freshly computed hash:
  // the plan has changed since the results were last written (FR-016).
  stale: boolean;
  // The freshly computed sha256 of canonicalize(plan).
  planHash: string;
  // True when the sidecar was missing/corrupt/invalid/future-version and the
  // caller should treat results as a clean slate (AC3 recovery signal).
  recovered: boolean;
}

// Read the source plan (required) and this bench's results (fail-open).
//
// The plan is required: if test-cases.json is missing or invalid, this throws
// MissingPlanError (NOT fail-open) because there is nothing to test without a
// plan. The results sidecar is fail-open per loadFile.
export function readPlanAndResults(
  repoPath: string,
  slug: string,
  benchId: string,
): PlanAndResults {
  // benchId is user-controlled and used as a computed key (file.benches[benchId]).
  // Reject prototype-polluting keys so a "__proto__" id can never read back the
  // Object prototype as if it were a bench's results (CWE-1321).
  assertSafeMapKey(benchId, "bench id");

  const planTarget = planPath(repoPath, slug);

  let planRaw: string;
  try {
    planRaw = fs.readFileSync(planTarget, "utf8");
  } catch {
    throw new MissingPlanError(`No test-cases.json for spec "${slug}"`);
  }

  let planParsed: unknown;
  try {
    planParsed = JSON.parse(planRaw);
  } catch {
    throw new MissingPlanError(`test-cases.json for spec "${slug}" is not valid JSON`);
  }

  const planValidation = validateTestCases(planParsed);
  if (!planValidation.ok) {
    throw new MissingPlanError(
      `test-cases.json for spec "${slug}" failed validation: ${planValidation.errors.join("; ")}`,
    );
  }
  const plan = planValidation.data;
  const planHash = computePlanHash(plan);

  const { file, recovered } = loadFile(repoPath, slug);
  if (file === null) {
    return { plan, results: null, stale: false, planHash, recovered };
  }

  const stale = file.planHash !== planHash;
  const results = file.benches[benchId] ?? null;
  return { plan, results, stale, planHash, recovered };
}

// ── Internal mutate helper ──
//
// Loads-or-inits the results file, hashes the plan, applies a mutation to the
// (case-scoped) CaseResult for one bench, refreshes the file planHash + bench
// updatedAt, persists atomically, and returns the mutated CaseResult.
//
// The plan is loaded and validated first (a write against a missing/invalid plan
// throws MissingPlanError, same as a read): we need the plan to hash and to know
// the case's observation set for derivedStatus.
async function mutateCaseResult(
  repoPath: string,
  slug: string,
  benchId: string,
  caseId: string,
  mutate: (caseResult: CaseResult, author: Author, plan: TestCasesPlan) => void,
): Promise<CaseResult> {
  // benchId and caseId are user-controlled and used as computed object keys
  // below (file.benches[benchId], bench.caseResults[caseId]). Reject the
  // prototype-polluting keys before any lookup so a crafted "__proto__" id can
  // never mutate Object.prototype (CWE-1321).
  assertSafeMapKey(benchId, "bench id");
  assertSafeMapKey(caseId, "case id");

  const planTarget = planPath(repoPath, slug);
  let planParsed: unknown;
  try {
    planParsed = JSON.parse(fs.readFileSync(planTarget, "utf8"));
  } catch {
    throw new MissingPlanError(`No readable test-cases.json for spec "${slug}"`);
  }
  const planValidation = validateTestCases(planParsed);
  if (!planValidation.ok) {
    throw new MissingPlanError(
      `test-cases.json for spec "${slug}" failed validation: ${planValidation.errors.join("; ")}`,
    );
  }
  const plan = planValidation.data;
  const planHash = computePlanHash(plan);

  const identity = await resolveGitIdentity(repoPath);
  const author = toAuthor(identity);

  // Load-or-init: a recovered (missing/corrupt/future) file is replaced with a
  // fresh empty file. The recovery signal is surfaced on reads; a write always
  // proceeds from a clean valid base.
  const { file: loaded } = loadFile(repoPath, slug);
  const file = loaded ?? emptyFile(planHash);

  const bench = file.benches[benchId] ?? emptyBench();
  const caseResult = bench.caseResults[caseId] ?? emptyCaseResult();

  mutate(caseResult, author, plan);

  bench.caseResults[caseId] = caseResult;
  bench.updatedAt = new Date().toISOString();
  file.benches[benchId] = bench;
  file.planHash = planHash;

  persist(repoPath, slug, file);
  return caseResult;
}

// ── Public write API ──

// Upsert an observation mark, recompute the case's derivedStatus, persist
// atomically (FR-012). Returns the updated CaseResult.
export async function markObservation(
  repoPath: string,
  slug: string,
  benchId: string,
  caseId: string,
  observationId: string,
  result: "pass" | "fail",
): Promise<CaseResult> {
  return mutateCaseResult(repoPath, slug, benchId, caseId, (caseResult, author, plan) => {
    caseResult.observationMarks[observationId] = {
      result,
      author,
      timestamp: new Date().toISOString(),
    };
    caseResult.derivedStatus = deriveStatus(
      planCaseObservationIds(plan, caseId),
      caseResult.observationMarks,
    );
  });
}

// Append an immutable note (FR-011). statusAtWrite captures the effective status
// (override ?? derived) at write time. Rejects empty/whitespace-only text.
// Returns the appended Note.
export async function appendNote(
  repoPath: string,
  slug: string,
  benchId: string,
  caseId: string,
  text: string,
): Promise<Note> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) {
    throw new Error("Note text must not be empty");
  }

  let appended: Note | undefined;
  await mutateCaseResult(repoPath, slug, benchId, caseId, (caseResult, author) => {
    const effective: CaseStatus = caseResult.statusOverride?.status ?? caseResult.derivedStatus;
    const note: Note = {
      id: randomUUID(),
      text: trimmed,
      author,
      timestamp: new Date().toISOString(),
      statusAtWrite: effective,
    };
    caseResult.notes.push(note);
    appended = note;
  });

  // appended is always assigned by the mutate callback above.
  return appended as Note;
}

// Set or clear a case's explicit status override (FR-010). Pass null to clear.
// Returns the updated CaseResult.
export async function setStatusOverride(
  repoPath: string,
  slug: string,
  benchId: string,
  caseId: string,
  override: CaseStatus | null,
): Promise<CaseResult> {
  return mutateCaseResult(repoPath, slug, benchId, caseId, (caseResult, author) => {
    if (override === null) {
      delete caseResult.statusOverride;
      return;
    }
    const next: StatusOverride = {
      status: override,
      author,
      timestamp: new Date().toISOString(),
    };
    caseResult.statusOverride = next;
  });
}

// ── Reconcile (NFR-003 orphan-not-delete) ──

export interface ReconcileOptions {
  // Without confirm, reconcile returns the classification preview only and writes
  // nothing.
  confirm?: boolean;
  // Physically drop orphaned results. Applied only when explicitly true, and only
  // when confirm is also true (a preview never deletes).
  purgeOrphans?: boolean;
}

export interface ReconcileOutcome {
  classification: ReconcileClassification;
  // True when nextResults was persisted (confirm was set). A preview returns
  // false.
  applied: boolean;
}

// Reconcile a bench's recorded results against the current plan (FR-017,
// NFR-003). Delegates classification + the non-destructive next-state build to
// testbench-domain.reconcile.
//
// Without confirm: returns the classification preview only, no write.
// With confirm: persists the reconciled (orphan-not-delete) results and refreshes
// planHash. When purgeOrphans is ALSO true, orphaned results are physically
// dropped via the separate purgeOrphans pure function before persisting.
//
// A bench with no recorded results reconciles against an empty BenchResults: the
// classification reports every plan case as added and nothing is orphaned.
export async function reconcile(
  repoPath: string,
  slug: string,
  benchId: string,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  // benchId is user-controlled and used as a computed key (file.benches[benchId]).
  // Reject prototype-polluting keys before any lookup or write (CWE-1321).
  assertSafeMapKey(benchId, "bench id");

  const { plan, planHash } = (() => {
    const planTarget = planPath(repoPath, slug);
    let planParsed: unknown;
    try {
      planParsed = JSON.parse(fs.readFileSync(planTarget, "utf8"));
    } catch {
      throw new MissingPlanError(`No readable test-cases.json for spec "${slug}"`);
    }
    const planValidation = validateTestCases(planParsed);
    if (!planValidation.ok) {
      throw new MissingPlanError(
        `test-cases.json for spec "${slug}" failed validation: ${planValidation.errors.join("; ")}`,
      );
    }
    return { plan: planValidation.data, planHash: computePlanHash(planValidation.data) };
  })();

  const { file: loaded } = loadFile(repoPath, slug);
  const file = loaded ?? emptyFile(planHash);
  const benchResults = file.benches[benchId] ?? emptyBench();

  const { classification, nextResults } = reconcileDomain(plan, benchResults);

  if (options.confirm !== true) {
    return { classification, applied: false };
  }

  const persisted = options.purgeOrphans === true ? purgeOrphans(nextResults) : nextResults;
  persisted.updatedAt = new Date().toISOString();
  file.benches[benchId] = persisted;
  file.planHash = planHash;
  persist(repoPath, slug, file);

  return { classification, applied: true };
}

// Re-export the path-safety error so callers (routes #12) can distinguish a
// rejected slug from other failures without importing safe-path directly.
export { UnsafePathError };
