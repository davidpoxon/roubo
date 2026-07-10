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
//     resolveWithin(rootPath, '.specifications', slug, ...), so an out-of-repo or
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
// The store exposes plain functions keyed by (rootPath, slug) primitives, the
// lib-level convention testbench-results-write.ts established, so the routes
// (#12) can wrap them. `rootPath` is the worktree root that contains
// `.specifications/`: as of #493 both the plan and the results sidecar are read
// and written under the bench's own worktree (sibling files), and the file no
// longer nests results under a per-bench `benches` map. Routes and UI stay out
// of scope here.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  isUnsafeMapKey,
  resolveWithin,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";
import { writeResults } from "./testbench-results-write.js";
import {
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  TESTBENCH_MIGRATION_GUIDE_PATH,
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
import { canonicalize, canonicalizeCase } from "@roubo/shared/testbench-canonicalize";
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
// root and asserts containment (the CodeQL-recognised sanitizer shape). `rootPath`
// is the worktree root that contains `.specifications/` (#493).
//
// resolveWithin is lexical, so it cannot see an on-disk symlink whose name is a
// valid slug. assertRealpathWithin is a SECOND barrier (mirrors writeResults,
// #416/#427): it realpaths the deepest existing ancestor of the target and
// re-asserts containment against the realpath'd root, so a symlinked
// `.specifications/<slug>` that escapes the repo is rejected before the read sinks
// (readFileSync in readPlanAndResults/mutateCaseResult/reconcile/loadFile) can
// resolve outside rootPath. Folding it here covers all four read call sites in one
// place. The comparison is realpath-to-realpath, so a legitimately symlinked root
// prefix (e.g. macOS /var/folders -> /private/var) still passes.

function planPath(rootPath: string, slug: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(rootPath, ".specifications", slug, "test-cases.json");
  assertRealpathWithin(rootPath, target, "spec plan path");
  return target;
}

function resultsPath(rootPath: string, slug: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(rootPath, ".specifications", slug, "test-results.json");
  assertRealpathWithin(rootPath, target, "spec results path");
  return target;
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

// The discriminated reason a fail-open load returns, so a recovered read can say
// WHY it recovered rather than leaving the caller to guess (NFR-005 version
// mismatch signal). `null` on the happy path. "version-migration-required" is the
// prior-major case: it points at the documented migration path in
// docs/testbench-schema-migrations.md instead of a generic shape error.
export type ResultsRecoveryReason =
  | "missing"
  | "corrupt-json"
  | "future-version"
  | "version-migration-required"
  | "schema-invalid";

// ── Fail-open load of the results sidecar (FR-014/FR-015/AC3) ──
//
// Returns { file, recovered, reason }. The file is null and recovered is true
// when the sidecar is missing, unreadable, not valid JSON, carries a PAST-major
// schema version (a prior major needing migration), fails schema validation, or
// carries a MAJOR schema version greater than the current one. This never throws
// for any of those conditions: a corrupt, prior-major, or future-version file
// must not crash a read. `reason` names WHY the load fell open so callers (and
// NFR-005) can distinguish a version migration from generic corruption; it is
// null on the happy path. (assertSafeIdentifier/resolveWithin path-safety errors
// are raised by the caller before loadFile runs, so they cannot surface here.)
function loadFile(
  rootPath: string,
  slug: string,
): {
  file: TestResultsFile | null;
  recovered: boolean;
  reason: ResultsRecoveryReason | null;
} {
  const target = resultsPath(rootPath, slug);

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    // Missing or unreadable: fail open with a recovery signal so the caller can
    // choose to re-init. There is no prior file, so missing IS a recovered state.
    return { file: null, recovered: true, reason: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON: fail open.
    return { file: null, recovered: true, reason: "corrupt-json" };
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
    return { file: null, recovered: true, reason: "future-version" };
  }

  // Past MAJOR version: a prior-major file (e.g. the v1 per-bench `benches`-map
  // shape before the v2.0.0 flatten) will not match the current strict schema,
  // and the shape difference is a genuine breaking change with a documented
  // migration path (see docs/testbench-schema-migrations.md, NFR-005). Surface a
  // specific version-migration-required signal here, mirroring the future-version
  // guard's placement BEFORE strict schema validation, so the caller gets a
  // legible version-mismatch reason rather than a generic shape error. Still
  // fail-open (never throw): the caller treats the worktree as a clean slate.
  if (!Number.isNaN(storedMajor) && storedMajor < currentResultsMajor()) {
    return { file: null, recovered: true, reason: "version-migration-required" };
  }

  const validation = validateTestResults(parsed);
  if (!validation.ok) {
    // Schema-invalid: fail open.
    return { file: null, recovered: true, reason: "schema-invalid" };
  }

  return { file: validation.data, recovered: false, reason: null };
}

// ── Read-only results loader for discovery (#482) ──
//
// The purpose-named, read-only face of the private fail-open loadFile above, so
// spec discovery can read a spec's results sidecar without reaching into the
// store internals or duplicating the fail-open recovery ladder. Maps loadFile's
// { file, recovered, reason } onto the { file, recoveryReason } contract the
// discovery aggregation consumes: `file` is the validated sidecar (null when
// missing/corrupt/invalid/version-mismatched) and `recoveryReason` names why the
// load fell open (null on a clean read). Like loadFile it never writes and never
// throws for a missing/corrupt/invalid file; the ONLY throw path is the
// path-safety assertion inside resultsPath (a slug that escapes the repo or a
// symlinked sidecar), which discovery wraps in its own per-spec try/catch so one
// bad spec degrades rather than failing the endpoint (TSPF-FR-002).
export function loadResultsFile(
  rootPath: string,
  slug: string,
): { file: TestResultsFile | null; recoveryReason: ResultsRecoveryReason | null } {
  const { file, reason } = loadFile(rootPath, slug);
  return { file, recoveryReason: reason };
}

// Persist a results file atomically (same-directory temp+rename, EXDEV-safe) via
// the #406 write primitive. The slug is re-validated inside writeResults, so this
// path is safe even though the file object itself carries no slug. The published
// CaseResultSchema now declares the per-case `caseCanon` snapshot (#447), so the
// reconcile-stamped field is serialized verbatim and re-validates on the next
// strict read (no fail-open data loss, and the changed/unchanged signal survives
// the round-trip to disk).
function persist(rootPath: string, slug: string, file: TestResultsFile): void {
  writeResults(rootPath, slug, JSON.stringify(file, null, 2));
}

// Build an empty results file. planHash is filled by the caller after the plan is
// hashed (an init always happens in a context where the plan is in hand). As of
// the v2.0.0 flatten (#493), case results sit at the top level of the file (one
// file per worktree), so there is no per-bench `benches` map to seed.
function emptyFile(planHash: string): TestResultsFile {
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash,
    caseResults: {},
    updatedAt: new Date().toISOString(),
  };
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
  // The worktree's recorded results, or null when no results exist yet (or the
  // sidecar was recovered). Shaped as { caseResults, updatedAt } (the API result
  // shape projected from the flattened file body).
  results: BenchResults | null;
  // True when the stored file's planHash differs from the freshly computed hash:
  // the plan has changed since the results were last written (FR-016).
  stale: boolean;
  // The freshly computed sha256 of canonicalize(plan).
  planHash: string;
  // True when the sidecar was missing/corrupt/invalid/future-version and the
  // caller should treat results as a clean slate (AC3 recovery signal).
  recovered: boolean;
  // WHY the sidecar was recovered, when it was (NFR-005 version-mismatch signal).
  // "version-migration-required" points a prior-major file at the migration path
  // in docs/testbench-schema-migrations.md, distinct from generic corruption.
  // Null on a clean read; optional so existing consumers stay compiling.
  recoveryReason?: ResultsRecoveryReason | null;
  // The repo-relative migration-guide path (TESTBENCH_MIGRATION_GUIDE_PATH), set
  // ONLY when recoveryReason is "version-migration-required" so a prior-major
  // recovery names the documented migration path in an observable payload field,
  // not just in source comments (NFR-005). Null for every other reason and on a
  // clean read; optional so existing consumers stay compiling.
  migrationGuide?: string | null;
}

// Project the flattened file body ({ ..., caseResults, updatedAt }) down to the
// { caseResults, updatedAt } result shape the API exposes.
function fileResults(file: TestResultsFile): BenchResults {
  return { caseResults: file.caseResults, updatedAt: file.updatedAt };
}

// Read the source plan (required) and the worktree's results (fail-open).
//
// The plan is required: if test-cases.json is missing or invalid, this throws
// MissingPlanError (NOT fail-open) because there is nothing to test without a
// plan. The results sidecar is fail-open per loadFile.
export function readPlanAndResults(rootPath: string, slug: string): PlanAndResults {
  const planTarget = planPath(rootPath, slug);

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

  const { file, recovered, reason } = loadFile(rootPath, slug);

  // Name the migration path in the payload ONLY for a prior-major recovery
  // (NFR-005), sourced from the shared constant so the pointer cannot drift; null
  // for every other reason and on a clean read.
  const migrationGuide =
    reason === "version-migration-required" ? TESTBENCH_MIGRATION_GUIDE_PATH : null;

  if (file === null) {
    return {
      plan,
      results: null,
      stale: false,
      planHash,
      recovered,
      recoveryReason: reason,
      migrationGuide,
    };
  }

  const stale = file.planHash !== planHash;
  return {
    plan,
    results: fileResults(file),
    stale,
    planHash,
    recovered,
    recoveryReason: reason,
    migrationGuide,
  };
}

// ── Internal mutate helper ──
//
// Loads-or-inits the results file, hashes the plan, applies a mutation to the
// (case-scoped) CaseResult, refreshes the file planHash + updatedAt, persists
// atomically, and returns the mutated CaseResult.
//
// The plan is loaded and validated first (a write against a missing/invalid plan
// throws MissingPlanError, same as a read): we need the plan to hash and to know
// the case's observation set for derivedStatus.
async function mutateCaseResult(
  rootPath: string,
  slug: string,
  caseId: string,
  mutate: (caseResult: CaseResult, author: Author, plan: TestCasesPlan) => void,
): Promise<CaseResult> {
  // caseId is user-controlled and used as a computed object key below
  // (file.caseResults[caseId]). Reject the prototype-polluting keys INLINE,
  // before any lookup, so a crafted "__proto__"/"constructor"/"prototype" id can
  // never mutate Object.prototype (CWE-1321). The guard is inline (not a helper
  // call) so static analysis recognises it as a sanitising barrier on the
  // tainted key.
  if (isUnsafeMapKey(caseId)) {
    throw new UnsafePathError(`Invalid case id: ${String(caseId)}`);
  }
  const safeCaseId = caseId;

  const planTarget = planPath(rootPath, slug);
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

  const identity = await resolveGitIdentity(rootPath);
  const author = toAuthor(identity);

  // Load-or-init: a recovered (missing/corrupt/future) file is replaced with a
  // fresh empty file. The recovery signal is surfaced on reads; a write always
  // proceeds from a clean valid base.
  const { file: loaded } = loadFile(rootPath, slug);
  const file = loaded ?? emptyFile(planHash);

  const caseResult = file.caseResults[safeCaseId] ?? emptyCaseResult();

  mutate(caseResult, author, plan);

  // Stamp the per-case canonical snapshot so the next reconcile can classify
  // this case as unchanged rather than conservatively flagging it changed
  // (issue #504). Reuse canonicalizeCase (the exact projection reconcile() uses)
  // so there is no divergent serialization on the write path. If the case id is
  // not in the plan, leave caseCanon unset: such a mark stays conservatively
  // classified changed.
  const planCase = plan.cases.find((c) => c.id === safeCaseId);
  if (planCase) {
    caseResult.caseCanon = canonicalizeCase(planCase);
  }

  file.caseResults[safeCaseId] = caseResult;
  file.updatedAt = new Date().toISOString();
  file.planHash = planHash;

  persist(rootPath, slug, file);
  return caseResult;
}

// ── Public write API ──

// Upsert or clear an observation mark, recompute the case's derivedStatus,
// persist atomically (FR-012). A null result un-sets the mark entirely (removes
// it from observationMarks) rather than recording a value (#508). Returns the
// updated CaseResult.
export async function markObservation(
  rootPath: string,
  slug: string,
  caseId: string,
  observationId: string,
  result: "pass" | "fail" | null,
): Promise<CaseResult> {
  return mutateCaseResult(rootPath, slug, caseId, (caseResult, author, plan) => {
    if (result === null) {
      // Rebuild the marks map without this observation rather than dynamically
      // deleting a computed key (#508).
      caseResult.observationMarks = Object.fromEntries(
        Object.entries(caseResult.observationMarks).filter(([id]) => id !== observationId),
      );
    } else {
      caseResult.observationMarks[observationId] = {
        result,
        author,
        timestamp: new Date().toISOString(),
      };
    }
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
  rootPath: string,
  slug: string,
  caseId: string,
  text: string,
): Promise<Note> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) {
    throw new Error("Note text must not be empty");
  }

  let appended: Note | undefined;
  await mutateCaseResult(rootPath, slug, caseId, (caseResult, author) => {
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
  rootPath: string,
  slug: string,
  caseId: string,
  override: CaseStatus | null,
): Promise<CaseResult> {
  return mutateCaseResult(rootPath, slug, caseId, (caseResult, author) => {
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

// Reconcile the worktree's recorded results against the current plan (FR-017,
// NFR-003). Delegates classification + the non-destructive next-state build to
// testbench-domain.reconcile.
//
// Without confirm: returns the classification preview only, no write.
// With confirm: persists the reconciled (orphan-not-delete) results and refreshes
// planHash. When purgeOrphans is ALSO true, orphaned results are physically
// dropped via the separate purgeOrphans pure function before persisting.
//
// A file with no recorded results reconciles against an empty result set: the
// classification reports every plan case as added and nothing is orphaned.
export async function reconcile(
  rootPath: string,
  slug: string,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const { plan, planHash } = (() => {
    const planTarget = planPath(rootPath, slug);
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

  const { file: loaded } = loadFile(rootPath, slug);
  const file = loaded ?? emptyFile(planHash);
  const results = fileResults(file);

  const { classification, nextResults } = reconcileDomain(plan, results);

  if (options.confirm !== true) {
    return { classification, applied: false };
  }

  const persisted = options.purgeOrphans === true ? purgeOrphans(nextResults) : nextResults;
  file.caseResults = persisted.caseResults;
  file.updatedAt = new Date().toISOString();
  file.planHash = planHash;
  persist(rootPath, slug, file);

  return { classification, applied: true };
}

// Re-export the path-safety error so callers (routes #12) can distinguish a
// rejected slug from other failures without importing safe-path directly.
export { UnsafePathError };
