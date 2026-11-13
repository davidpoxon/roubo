// The thin server file-IO service for the test-results.json sidecar (#457).
//
// This module composes already-landed building blocks rather than reimplementing
// them:
//   - path safety: resolveWithin + assertSafeIdentifier/SPEC_SLUG_RE (safe-path)
//   - validation + version: validateTestCases/validateTestResults +
//     TEST_RESULTS_SCHEMA_VERSION (testbench-contracts)
//   - staleness hash: canonicalize (testbench-canonicalize) + node:crypto sha256
//   - state + reconcile: deriveStatus/reconcile/purgeOrphans (testbench-domain)
//   - authors: resolveGitIdentity (git-helpers, #427)
//   - atomic write: writeResults same-directory temp+rename (#428)
//   - case lifecycle write: setCaseLifecycle (testbench-lifecycle-write, #1167)
//
// Contracts honoured here:
//   - NFR-001: every fs path flows through assertSafeIdentifier(slug) then
//     resolveWithin(rootPath, '.specifications', slug, ...), so an out-of-repo or
//     traversal slug is rejected before any fs call.
//   - FR-014/FR-015/AC3: the results sidecar read is FAIL-OPEN: a missing,
//     corrupt, schema-invalid, or future-major-version file yields a recovery
//     signal (recovered: true) and a null results view, never a throw.
//   - FR-016: the server hashes canonicalize(plan) with sha256 and compares it to
//     the stored planHash to flag staleness. The stored planHash claims that every
//     recorded result is current, so a write stamps the current hash only when no
//     live recorded case is then left without a current result (#1407; see
//     stampedPlanHash below). The hash covers the TESTABLE plan,
//     not the whole file: canonicalize excludes the v1.2.0 lifecycle block, so
//     retiring or superseding a case never marks recorded results stale (#1160).
//     See computePlanHash below for the semantics and their consequence. One of
//     them is that restoring a case leaves the hash as it was, so a read also
//     judges each live case by its own caseCanon and reports a case restored
//     with an old result as stale under a matching hash (#1696).
//   - AC4 (amended by #1167): no RESULTS write ever touches test-cases.json, so
//     marking, overriding, noting, and reconciling still leave the source plan
//     byte-identical. The absolute form of that invariant ("the source
//     test-cases.json is never written here") no longer holds: setCaseLifecycle
//     below writes the case file, and it is the ONLY function in this module that
//     does. It writes exactly one case's `lifecycle` block, under a raw-bytes
//     conflict precondition, and never as a side effect of a results write.
//   - FR-012/AC5: marks, overrides, and notes are stamped with the resolved git
//     identity, falling back to the sentinel author when git identity is unset.
//   - NFR-003: reconcile is orphan-not-delete; physical deletion only happens when
//     purgeOrphans is explicitly requested.
//
// The store exposes plain functions keyed by (rootPath, slug) primitives, the
// lib-level convention testbench-results-write.ts established, so the routes
// (#12) can wrap them. `rootPath` is the worktree root that contains
// `.specifications/`: as of #494 both the plan and the results sidecar are read
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
  CaseLifecycleConflictError,
  CaseNotFoundError,
  computeCaseFileFingerprint,
  MissingCaseFileError,
  setCaseLifecycle as writeCaseLifecycle,
  type SetCaseLifecycleResult,
} from "./testbench-lifecycle-write.js";
import {
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  TESTBENCH_MIGRATION_GUIDE_PATH,
  validateTestCases,
  validateTestResults,
  type Author,
  type BenchResults,
  type CaseLifecycle,
  type CaseResult,
  type CaseStatus,
  type Note,
  type StatusOverride,
  type TestCasesPlan,
  type TestResultsFile,
} from "@roubo/shared/testbench-contracts";
import { canonicalize, canonicalizeCase } from "@roubo/shared/testbench-canonicalize";
import type { GateResults } from "@roubo/shared/gate-evaluator";
import {
  currentResultCaseIds,
  deriveStatus,
  noncurrentLiveCaseIds,
  purgeOrphans,
  reconcile as reconcileDomain,
  staleResultCaseIds,
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
// is the worktree root that contains `.specifications/` (#494).
//
// resolveWithin is lexical, so it cannot see an on-disk symlink whose name is a
// valid slug. assertRealpathWithin is a SECOND barrier (mirrors writeResults,
// #895/#427): it realpaths the deepest existing ancestor of the target and
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
//
// This is a hash of the TESTABLE plan, NOT of test-cases.json. As of #1160 what it
// leaves out explicitly covers the v1.2.0 lifecycle bookkeeping (#1158): canonicalize
// is an allowlist projection and never sees `lifecycle`, so retiring or superseding
// a case leaves this hash byte-identical. A lifecycle-only edit therefore changes
// no `stale` flag, prompts no stale-results warning, and moves no verify gate to
// `stale`. That is deliberate: one retirement must not invalidate every recorded
// result for the spec. Genuine content edits (title, level, preconditions, steps,
// observations) still change the hash, so real staleness is still detected.
//
// The consequence to keep in mind: because retiring a case is invisible here, and
// because evaluateGate honours the lifecycle block as of #1164, a retired case stops
// being unresolved and a verify gate can move from pending to passed with no
// staleness prompt at all. The gate surface is what must show lifecycle exclusions
// explicitly; the hash will not flag them.
// Locked by testbench-store.test.ts, testbench-domain.test.ts, and
// gate-evaluator.test.ts (SATCA-TC-055).
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
  "missing" | "corrupt-json" | "future-version" | "version-migration-required" | "schema-invalid";

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

// ── Read-only results loader for discovery (#936) ──
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
// the #428 write primitive. The slug is re-validated inside writeResults, so this
// path is safe even though the file object itself carries no slug. The published
// CaseResultSchema now declares the per-case `caseCanon` snapshot (#489), so the
// reconcile-stamped field is serialized verbatim and re-validates on the next
// strict read (no fail-open data loss, and the changed/unchanged signal survives
// the round-trip to disk).
function persist(rootPath: string, slug: string, file: TestResultsFile): void {
  writeResults(rootPath, slug, JSON.stringify(file, null, 2));
}

// Build an empty results file. planHash is filled by the caller after the plan is
// hashed (an init always happens in a context where the plan is in hand). As of
// the v2.0.0 flatten (#494), case results sit at the top level of the file (one
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
  // the plan has changed since every recorded result was current (FR-016). A
  // write under stale results keeps the old planHash while any live recorded case
  // still holds a result judged against an older body (#1407), so this stays true
  // until each of them is judged again. Also true under a matching planHash while
  // a live recorded case holds a caseCanon that is not its current body, such as
  // a case restored with an old result (#1696; noncurrentLiveCaseIds).
  stale: boolean;
  // The recorded case ids whose result is current for this plan
  // (currentResultCaseIds): under a matching planHash every recorded id except
  // those whose recorded caseCanon names another body, else only those whose
  // caseCanon matches the case's current body. Empty when `results` is null. This
  // is what lets staleness be judged per case on the read side: a gate is stale
  // only while one of its own gating cases is missing from it (#1407).
  currentCaseIds: string[];
  // The freshly computed sha256 of canonicalize(plan).
  planHash: string;
  // sha256 over the RAW test-cases.json bytes this read saw (#1167). Distinct
  // from planHash, which excludes the lifecycle block by construction (#1160) and
  // therefore cannot detect a concurrent lifecycle edit. A lifecycle write echoes
  // this value back as its precondition, so an edit made outside the app between
  // load and write is reported as a conflict rather than silently overwritten
  // (SATCA-TC-056). Optional so existing consumers stay compiling.
  caseFileFingerprint?: string;
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

// The gate evaluator's view of a read. `readPlanAndResults` strips the stored
// planHash from `results` and reports the freshness comparison as `stale`, while
// the evaluator decides staleness from `results.planHash !== currentPlanHash`. So
// the planHash threaded here reflects the store's verdict: the live hash when
// fresh, a guaranteed-mismatching sentinel when stale. Passing the live hash on
// both sides would leave the staleness rung unreachable for a results-present
// gate, letting stale all-passed results read as `passed`, a fail-closed
// regression (VG-NFR-007). The `currency` names the cases whose result is current
// for this plan even under a stale file, so a gate is stale only while one of its
// own gating cases is not among them (#1407). A file whose planHash matches but
// that holds a non-current live case reads as stale too (#1696), so the sentinel
// makes the evaluator judge by `currency`. Null when no results are recorded.
export function toGateResults(
  loaded: Pick<PlanAndResults, "results" | "planHash" | "stale" | "currentCaseIds">,
): GateResults {
  if (loaded.results === null) return null;
  return {
    ...loaded.results,
    planHash: loaded.stale ? `${loaded.planHash}::stale` : loaded.planHash,
    currency: { planHash: loaded.planHash, caseIds: loaded.currentCaseIds },
  };
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
  // Taken from the same bytes this read parsed, so the fingerprint a caller
  // echoes back names exactly the file state it was shown (#1167).
  const caseFileFingerprint = computeCaseFileFingerprint(planRaw);

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
      currentCaseIds: [],
      planHash,
      caseFileFingerprint,
      recovered,
      recoveryReason: reason,
      migrationGuide,
    };
  }

  const fileFresh = file.planHash === planHash;
  const stale = !fileFresh || noncurrentLiveCaseIds(plan, file.caseResults, true).length > 0;
  return {
    plan,
    results: fileResults(file),
    stale,
    currentCaseIds: currentResultCaseIds(plan, file.caseResults, fileFresh),
    planHash,
    caseFileFingerprint,
    recovered,
    recoveryReason: reason,
    migrationGuide,
  };
}

// The planHash a write stamps (#1407). The file planHash claims that every
// recorded result is current, so a write moves it to the current hash when the
// results were already fresh, or when no live recorded case is left without a
// current result (staleResultCaseIds). Otherwise the prior value stays, so one
// write never makes another case's old result read as current.
function stampedPlanHash(
  plan: TestCasesPlan,
  file: TestResultsFile,
  planHash: string,
  priorFresh: boolean,
): string {
  if (priorFresh || staleResultCaseIds(plan, file.caseResults, false).length === 0) {
    return planHash;
  }
  return file.planHash;
}

// The sha256 hex of a case's canonical body, as a mark records it
// (ObservationMark.caseCanonHash, #1696).
function canonHash(canon: string): string {
  return createHash("sha256").update(canon, "utf8").digest("hex");
}

// Whether a result holds a verdict apart from any override: a mark, a machine
// verification, or a derivedStatus other than not_started (the other writer of
// test-results.json can record a verdict as a derivedStatus plus verification
// with no marks).
function holdsVerdict(result: CaseResult): boolean {
  return (
    Object.keys(result.observationMarks).length > 0 ||
    result.verification !== undefined ||
    result.derivedStatus !== "not_started"
  );
}

// The body that a case's verdict was judged against before a write, for a new
// override to record: the prior override's record when it has one; the current
// body when the case's result was current under a fresh file; null when it is
// not known (a prior override with no record, or no snapshot); else the prior
// snapshot.
function verdictBodyBefore(
  priorOverride: StatusOverride | undefined,
  priorCanon: string | undefined,
  currentCanon: string | undefined,
  caseFresh: boolean,
): string | null {
  if (priorOverride?.verdictCanon !== undefined) return priorOverride.verdictCanon;
  if (caseFresh && currentCanon !== undefined) return currentCanon;
  if (priorOverride !== undefined) return null;
  return priorCanon ?? null;
}

// What a mutation may read besides the case result it changes.
interface MutateContext {
  author: Author;
  plan: TestCasesPlan;
  // The hash of the case's current canonical body; undefined when the case id
  // is not in the plan.
  currentCanonHash: string | undefined;
  // Whether the case's result was current before the write, so a mark that
  // records no body of its own counts as judged against the current one (#1696).
  caseCurrentBefore: boolean;
}

// ── Internal mutate helper ──
//
// Loads-or-inits the results file, hashes the plan, applies a mutation to the
// (case-scoped) CaseResult, refreshes updatedAt and (by the stampedPlanHash rule)
// the file planHash, persists atomically, and returns the mutated CaseResult.
//
// The mutation returns whether it DETERMINES the case: a set override does, and
// so does a mark write (a mark or a clear) that leaves every observation of the
// case with a mark judged against the current body (#1696; see markObservation);
// a note, an override clear, or a mark write that leaves an old mark behind does
// not. When the case's result is current under a fresh file (`caseFresh`: the
// file planHash matches and the case records no other body), every write stamps
// the case's caseCanon, as before (#505). Otherwise, as under stale results
// (#1407), after the write:
//   - a case that holds no verdict (no mark, no override, no machine
//     verification, and a not_started derivedStatus) is stamped: nothing in it
//     was judged against an older body;
//   - a determination is stamped, unless a prior statusOverride survives the
//     write (the override stays the effective status, judged against the body
//     it was made on);
//   - any other write keeps the prior snapshot, except an override clear.
//
// An override records, as its verdictCanon, the body that the verdict under it
// was judged against, and a determination made under the override moves that
// record to the current body. Clearing an override that leaves a verdict behind
// restores the record as the case's caseCanon (or drops caseCanon when the body
// is not known), so the verdict reads as current only when it is. When the file
// was fresh and the restored body is not the current one, the file planHash is
// emptied, so no reader takes the file as current. Under stale results, a case
// whose override stands over an older verdict also holds the old planHash
// (staleResultCaseIds).
//
// The plan is loaded and validated first (a write against a missing/invalid plan
// throws MissingPlanError, same as a read): we need the plan to hash and to know
// the case's observation set for derivedStatus.
async function mutateCaseResult(
  rootPath: string,
  slug: string,
  caseId: string,
  mutate: (caseResult: CaseResult, context: MutateContext) => boolean,
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
  const priorFresh = file.planHash === planHash;

  const caseResult = file.caseResults[safeCaseId] ?? emptyCaseResult();
  const priorOverride = caseResult.statusOverride;
  const priorCanon = caseResult.caseCanon;
  const verdictBefore = holdsVerdict(caseResult);
  const planCase = plan.cases.find((c) => c.id === safeCaseId);
  const currentCanon = planCase === undefined ? undefined : canonicalizeCase(planCase);
  // Whether the case's own result is current under a fresh file (#1696): a
  // recorded caseCanon that names another body is stale whatever the file says.
  const caseFresh = priorFresh && (priorCanon === undefined || priorCanon === currentCanon);
  // Whether the case's result is current before the write, by either file state.
  const caseCurrentBefore =
    currentCanon !== undefined && (caseFresh || priorCanon === currentCanon);

  const determines = mutate(caseResult, {
    author,
    plan,
    currentCanonHash: currentCanon === undefined ? undefined : canonHash(currentCanon),
    caseCurrentBefore,
  });

  const override = caseResult.statusOverride;
  const overrideSurvives = priorOverride !== undefined && override === priorOverride;
  const overrideCleared = priorOverride !== undefined && override === undefined;
  const verdictAfter = holdsVerdict(caseResult);

  // Keep the record of the body that the verdict under an override was judged
  // against (StatusOverride.verdictCanon, #1407).
  if (override !== undefined && override !== priorOverride) {
    // A new override: record the body of the verdict it now stands over.
    const body = verdictBefore
      ? verdictBodyBefore(priorOverride, priorCanon, currentCanon, caseFresh)
      : undefined;
    if (body !== undefined) override.verdictCanon = body;
  } else if (overrideSurvives && override !== undefined) {
    if (!verdictAfter) {
      delete override.verdictCanon;
    } else if (determines && currentCanon !== undefined) {
      // A determination under the override judges the case against the current
      // body, the same as a determination stamps caseCanon.
      override.verdictCanon = currentCanon;
    }
  }

  // Stamp the per-case canonical snapshot so the next reconcile can classify
  // this case as unchanged rather than conservatively flagging it changed
  // (#505), and so the case's result reads as current under stale results
  // (#1407). Reuse canonicalizeCase (the exact projection reconcile() uses)
  // so there is no divergent serialization on the write path. If the case id is
  // not in the plan, leave caseCanon unset: such a mark stays conservatively
  // classified changed. Otherwise the snapshot follows the rule above.
  let restale = false;
  if (currentCanon !== undefined && overrideCleared && verdictAfter) {
    const body = priorOverride.verdictCanon;
    if (body === undefined) {
      // An override with no record: under fresh results everything is current,
      // as before; under stale results the verdict's body is not known.
      if (caseFresh) caseResult.caseCanon = currentCanon;
      else delete caseResult.caseCanon;
    } else {
      if (body === null) delete caseResult.caseCanon;
      else caseResult.caseCanon = body;
      // A fresh file says every result is current, which is no longer true when
      // the restored verdict was judged against another body.
      restale = priorFresh && body !== currentCanon;
    }
  } else if (
    currentCanon !== undefined &&
    (caseFresh || (!verdictAfter && override === undefined) || (determines && !overrideSurvives))
  ) {
    caseResult.caseCanon = currentCanon;
  }

  file.caseResults[safeCaseId] = caseResult;
  file.updatedAt = new Date().toISOString();
  // An empty planHash is the value that no reader takes as current: every
  // result is then judged by its own caseCanon.
  file.planHash = restale ? "" : stampedPlanHash(plan, file, planHash, priorFresh);

  persist(rootPath, slug, file);
  return caseResult;
}

// ── Public write API ──

// Upsert or clear an observation mark, recompute the case's derivedStatus,
// persist atomically (FR-012). A null result un-sets the mark entirely (removes
// it from observationMarks) rather than recording a value (#510). Returns the
// updated CaseResult.
export async function markObservation(
  rootPath: string,
  slug: string,
  caseId: string,
  observationId: string,
  result: "pass" | "fail" | null,
): Promise<CaseResult> {
  return mutateCaseResult(rootPath, slug, caseId, (caseResult, context) => {
    const { author, plan, currentCanonHash, caseCurrentBefore } = context;
    if (result === null) {
      // Rebuild the marks map without this observation rather than dynamically
      // deleting a computed key (#510).
      caseResult.observationMarks = Object.fromEntries(
        Object.entries(caseResult.observationMarks).filter(([id]) => id !== observationId),
      );
    } else {
      caseResult.observationMarks[observationId] = {
        result,
        author,
        timestamp: new Date().toISOString(),
        ...(currentCanonHash !== undefined && { caseCanonHash: currentCanonHash }),
      };
    }
    const observationIds = planCaseObservationIds(plan, caseId);
    caseResult.derivedStatus = deriveStatus(observationIds, caseResult.observationMarks);
    // The write determines the case only when every observation now holds a mark
    // judged against the current body (#1696): one new mark beside an old one
    // leaves the case judged against the old body. A mark with no recorded body
    // counts as judged against the case's own, current only when the case was.
    return (
      currentCanonHash !== undefined &&
      observationIds.length > 0 &&
      observationIds.every((id) => {
        const mark = caseResult.observationMarks[id];
        if (mark === undefined) return false;
        return mark.caseCanonHash === undefined
          ? caseCurrentBefore
          : mark.caseCanonHash === currentCanonHash;
      })
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
  await mutateCaseResult(rootPath, slug, caseId, (caseResult, { author }) => {
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
    // A note records a remark, not a determination of the case.
    return false;
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
  return mutateCaseResult(rootPath, slug, caseId, (caseResult, { author }) => {
    if (override === null) {
      // The effective status falls back to the verdict under the override.
      // mutateCaseResult restores the snapshot of the body that verdict was
      // judged against, from the override's verdictCanon.
      delete caseResult.statusOverride;
      return false;
    }
    const next: StatusOverride = {
      status: override,
      author,
      timestamp: new Date().toISOString(),
    };
    caseResult.statusOverride = next;
    return true;
  });
}

// ── Case lifecycle (SATCA-FR-019/FR-021, #1167) ──
//
// The ONE write in this module that touches the source case file. It is a
// deliberate, user-initiated edit to a single case's `lifecycle` block, guarded
// by the raw-bytes fingerprint the caller was shown, and it never happens as a
// side effect of a results write (see the AC4 note in the module header).
//
// Pass a validated CaseLifecycle to retire or supersede, or null to restore
// (removing the record entirely, which is what makes every action reversible).
// Nothing here resolves a git identity or spawns a process: the lifecycle block
// records no author, and the change is left uncommitted in the worktree by
// design (SATCA-TC-053).
//
// Throws MissingCaseFileError (no/invalid plan), CaseNotFoundError (unknown case
// id), CaseLifecycleConflictError (the file changed under the request), or
// UnsafePathError (a slug or fingerprint that fails the barriers).
export function setCaseLifecycle(
  rootPath: string,
  slug: string,
  caseId: string,
  lifecycle: CaseLifecycle | null,
  expectedFingerprint: string,
): SetCaseLifecycleResult {
  return writeCaseLifecycle(rootPath, slug, caseId, lifecycle, expectedFingerprint);
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
// With confirm: persists the reconciled (orphan-not-delete) results and stamps
// planHash by the same rule as a case write (stampedPlanHash, #1407). Under
// stale results a `changed` case keeps the snapshot of the body its marks were
// judged against, so it stays stale and holds the old planHash until it is
// judged again: reconcile preserves its results for re-review, it does not
// accept them as current. When purgeOrphans is ALSO true, orphaned results are
// physically dropped via the separate purgeOrphans pure function before
// persisting.
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
  const priorFresh = file.planHash === planHash;

  const { classification, nextResults } = reconcileDomain(plan, results, { fresh: priorFresh });

  if (options.confirm !== true) {
    return { classification, applied: false };
  }

  const persisted = options.purgeOrphans === true ? purgeOrphans(nextResults) : nextResults;
  file.caseResults = persisted.caseResults;
  file.updatedAt = new Date().toISOString();
  file.planHash = stampedPlanHash(plan, file, planHash, priorFresh);
  persist(rootPath, slug, file);

  return { classification, applied: true };
}

// Re-export the path-safety error so callers (routes #12) can distinguish a
// rejected slug from other failures without importing safe-path directly. The
// lifecycle-write errors ride along for the same reason: the route layer maps
// them to 404 / 404 / 409 without reaching past the store seam (#1167).
export { UnsafePathError, MissingCaseFileError, CaseNotFoundError, CaseLifecycleConflictError };
export type { SetCaseLifecycleResult };
