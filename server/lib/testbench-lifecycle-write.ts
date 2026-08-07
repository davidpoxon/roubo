// LifecycleWriter, case half (#772, SATCA-FR-019/FR-021, SATCA-NFR-001/NFR-003).
//
// Roubo's FIRST write into a spec's source case file. It sets or clears one
// case's `lifecycle` block in `.specifications/<slug>/test-cases.json` and does
// nothing else: no other case is touched, no sibling key is rewritten, no
// process is spawned, and nothing is committed. The change is left dirty in the
// worktree by design (SATCA-TC-053).
//
// It composes what already exists rather than reimplementing it:
//   - path safety: assertSafeIdentifier(SPEC_SLUG_RE) -> resolveWithin ->
//     assertRealpathWithin, in that order, exactly as the store's planPath and
//     the spec-lifecycle reader's manifestPath apply them (SATCA-NFR-001).
//   - atomic write: writeSpecFile's same-directory temp-and-rename (#406), which
//     also removes the temp when the rename fails, so an interrupted write
//     leaves the original intact with no partial sibling (SATCA-TC-054).
//   - the contract: CaseLifecycleSchema (#764), unchanged here.
//
// Two properties are worth stating because they are easy to lose:
//
//   1. The conflict precondition is NOT the plan hash. `canonicalize` is an
//      allowlist projection that deliberately excludes the lifecycle block
//      (#767), so a lifecycle edit leaves the plan hash byte-identical and the
//      plan hash can never detect a concurrent lifecycle change. The precondition
//      is therefore a SEPARATE sha256 over the raw file bytes
//      (computeCaseFileFingerprint), taken on the read that produced the caller's
//      view and re-checked here against what is on disk now. A mismatch is a
//      conflict: the external edit is preserved and the caller is told to reload
//      (SATCA-TC-056).
//   2. The recorded `schemaVersion` is raised ONLY when the user's own action
//      introduces a lifecycle record, and is never lowered on restore
//      (SATCA-NFR-004). A file already at or beyond v1.2.0 is left alone; a
//      restore never rewrites the version at all.

import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";
import { writeSpecFile } from "./testbench-results-write.js";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  validateTestCases,
  type Case,
  type CaseLifecycle,
} from "@roubo/shared/testbench-contracts";

// The two files a lifecycle write may ever touch (SATCA-TC-059). The shared
// primitive's allowlist is wider by one (it also owns the results sidecar), so
// this narrower pair is asserted here as well: no lifecycle path can reach even
// a permitted sibling it was not meant to write.
export const PERMITTED_LIFECYCLE_FILENAMES = ["test-cases.json", "manifest.json"] as const;

export type PermittedLifecycleFilename = (typeof PERMITTED_LIFECYCLE_FILENAMES)[number];

// The single sink every lifecycle write goes through. It narrows the filename to
// the pair above before handing off to the shared atomic primitive, so
// "only the two permitted filenames are ever written" is a structural property
// of this module rather than caller discipline (SATCA-TC-059).
//
// Today this sink carries the CASE half only. The manifest half landed
// separately in #1166 and does its own same-directory temp-and-rename on a
// hardcoded `manifest.json` (testbench-spec-lifecycle-write.ts), behind the same
// three path-safety barriers but not through here. So `manifest.json` sits in the
// pair above for a future caller rather than a current one; the architecture puts
// both files under one LifecycleWriter, and converging the two sinks is the
// cheapest way to get there.
export function writeLifecycleFile(
  rootPath: string,
  slug: string,
  filename: string,
  data: string,
): string {
  if (!(PERMITTED_LIFECYCLE_FILENAMES as readonly string[]).includes(filename)) {
    throw new UnsafePathError(`Invalid lifecycle filename: ${String(filename)}`);
  }
  return writeSpecFile(rootPath, slug, filename, data);
}

// The spec's case file is missing, unreadable, not valid JSON, or does not match
// the published contract. There is no plan to write into, so this is a
// not-found condition (the route maps it to 404), never a silent create: Roubo
// does not author a spec's case file, it only edits one product-dev wrote.
export class MissingCaseFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCaseFileError";
  }
}

// The named case id is not in the spec's case file (404).
export class CaseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseNotFoundError";
  }
}

// The case file changed on disk between the read that produced the caller's view
// and this write (409). The write is refused and the on-disk file is untouched.
export class CaseLifecycleConflictError extends Error {
  // The fingerprint the file actually carries now, so a caller can reload
  // against a known point rather than guessing.
  readonly actualFingerprint: string;
  constructor(message: string, actualFingerprint: string) {
    super(message);
    this.name = "CaseLifecycleConflictError";
    this.actualFingerprint = actualFingerprint;
  }
}

// sha256 over the RAW file bytes. Distinct from computePlanHash by design: the
// plan hash tracks the testable case body and excludes lifecycle, so it cannot
// serve as a concurrency precondition for a lifecycle edit (see the module
// header). This one changes for any byte that changes, which is exactly what a
// last-writer-wins guard needs.
export function computeCaseFileFingerprint(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// Resolve `.specifications/<slug>/test-cases.json` under rootPath through the
// three barriers, in the order the rest of the TestBench applies them. Throws
// UnsafePathError on an unsafe slug (before any path is built, SATCA-TC-051), a
// lexical escape, or a symlinked spec folder that resolves outside the root
// (SATCA-TC-052).
function caseFilePath(rootPath: string, slug: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(rootPath, ".specifications", slug, "test-cases.json");
  assertRealpathWithin(rootPath, target, "spec plan path");
  return target;
}

// Compare two dotted version strings numerically, segment by segment. Used only
// to answer "is the recorded version already at least 1.2.0?", so a malformed or
// missing value reads as lower and gets raised when a record is introduced.
function isAtLeast(recorded: unknown, minimum: string): boolean {
  if (typeof recorded !== "string") {
    return false;
  }
  const left = recorded.split(".").map((part) => parseInt(part, 10));
  const right = minimum.split(".").map((part) => parseInt(part, 10));
  for (let i = 0; i < right.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (Number.isNaN(a) || a === undefined) {
      return false;
    }
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

// Rebuild a case object without its `lifecycle` key, rather than dynamically
// deleting a computed property off a parsed-JSON object (the #508 pattern).
// Key order for every OTHER key is preserved, so a restore produces the minimal
// diff against what product-dev authored.
function withoutLifecycle(caseObject: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(caseObject).filter(([key]) => key !== "lifecycle"));
}

export interface SetCaseLifecycleResult {
  // The updated case, re-validated against the published contract.
  case: Case;
  // The fingerprint of the file as just written, so a caller can chain a second
  // action without a re-read.
  caseFileFingerprint: string;
  // The `schemaVersion` the file now records. Raised to 1.2.0 only when this
  // write introduced a record into a file that predates it (SATCA-NFR-004).
  schemaVersion: string;
}

// Set (retire / supersede) or clear (restore) one case's lifecycle block.
//
// `lifecycle` is a validated CaseLifecycle to record one, or null to remove the
// record entirely, which is what makes every lifecycle action reversible
// (SATCA-FR-021). `expectedFingerprint` is the computeCaseFileFingerprint of the
// file as the caller last read it; a mismatch raises CaseLifecycleConflictError
// and writes nothing.
//
// Every other case in the file, and every sibling key on the edited case, is
// carried through verbatim: the write mutates the parsed raw document rather
// than re-serialising a schema projection, so nothing the contract does not model
// is silently dropped (SATCA-TC-046).
export function setCaseLifecycle(
  rootPath: string,
  slug: string,
  caseId: string,
  lifecycle: CaseLifecycle | null,
  expectedFingerprint: string,
): SetCaseLifecycleResult {
  const target = caseFilePath(rootPath, slug);

  if (typeof caseId !== "string" || caseId.length === 0) {
    throw new UnsafePathError(`Invalid case id: ${String(caseId)}`);
  }
  if (typeof expectedFingerprint !== "string" || expectedFingerprint.length === 0) {
    throw new UnsafePathError("A case-file fingerprint precondition is required");
  }

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    throw new MissingCaseFileError(`No test-cases.json for spec "${slug}"`);
  }

  // Precondition first: an external edit must be reported before anything else
  // is evaluated, so a conflicting write is refused even when the stale view
  // named a case that no longer exists (SATCA-TC-056).
  const actualFingerprint = computeCaseFileFingerprint(raw);
  if (actualFingerprint !== expectedFingerprint) {
    throw new CaseLifecycleConflictError(
      `test-cases.json for spec "${slug}" changed on disk since it was loaded. Reload the spec and try again.`,
      actualFingerprint,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MissingCaseFileError(`test-cases.json for spec "${slug}" is not valid JSON`);
  }

  const validation = validateTestCases(parsed);
  if (!validation.ok) {
    throw new MissingCaseFileError(
      `test-cases.json for spec "${slug}" failed validation: ${validation.errors.join("; ")}`,
    );
  }

  // Edit the PARSED RAW document, not the validated projection, so key order and
  // anything the schema does not model survive the round-trip untouched.
  const document = parsed as { schemaVersion?: unknown; $schema?: unknown; cases: unknown[] };
  const index = document.cases.findIndex(
    (entry) =>
      typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === caseId,
  );
  if (index === -1) {
    throw new CaseNotFoundError(`Case "${caseId}" is not in spec "${slug}"`);
  }

  const caseObject = document.cases[index] as Record<string, unknown>;
  document.cases[index] =
    lifecycle === null ? withoutLifecycle(caseObject) : { ...caseObject, lifecycle };

  // SATCA-NFR-004: raise the recorded version only when THIS action introduces a
  // record, and only when the file predates v1.2.0. A restore never touches it,
  // so a version is never lowered.
  if (lifecycle !== null && !isAtLeast(document.schemaVersion, TEST_CASES_SCHEMA_VERSION)) {
    document.schemaVersion = TEST_CASES_SCHEMA_VERSION;
    document.$schema = TEST_CASES_SCHEMA_ID;
  }

  // Preserve the file's trailing-newline convention so the diff Roubo leaves in
  // the worktree is the lifecycle change and nothing else.
  const serialized = `${JSON.stringify(document, null, 2)}${raw.endsWith("\n") ? "\n" : ""}`;

  const written = validateTestCases(JSON.parse(serialized));
  if (!written.ok) {
    // Defensive: the only mutation above is a contract-validated lifecycle block,
    // so this cannot fire on a valid input. Refuse rather than write a file the
    // next read would fail open on.
    throw new MissingCaseFileError(
      `Refusing to write an invalid test-cases.json for spec "${slug}": ${written.errors.join("; ")}`,
    );
  }

  writeLifecycleFile(rootPath, slug, "test-cases.json", serialized);

  const updated = written.data.cases.find((entry) => entry.id === caseId);
  return {
    // findIndex above proved the id is present, and the document round-tripped.
    case: updated as Case,
    caseFileFingerprint: computeCaseFileFingerprint(serialized),
    schemaVersion: written.data.schemaVersion,
  };
}
