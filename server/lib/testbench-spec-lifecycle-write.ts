// LifecycleWriter, manifest half (#773, SATCA-FR-020/FR-021, SATCA-NFR-001/
// NFR-003): the ONLY writer of a spec's `lifecycle` subtree, and the write
// counterpart of the read-only testbench-spec-lifecycle.ts.
//
// The architecture names one LifecycleWriter owning both the case file and the
// manifest. Case-level writes are a parallel slice, so this module lands the
// manifest half alone, sized so the case half can join it later without
// restructuring.
//
// Two rules govern everything below.
//
// 1. MERGE-WRITE, never serialize-from-schema. The manifest is authored and
//    owned by the `product-dev` toolchain; Roubo is a second writer of ONE
//    subtree of it. So the existing file is read as an untyped object, spread,
//    and only the `lifecycle` key (plus `updated_at`) is touched. Nothing is
//    round-tripped through a zod parse, which would silently strip
//    `id_counters`, `spikes`, `id_code`, `design_root`, and whatever
//    product-dev adds next (SATCA-TC-049). Precedent:
//    server/services/claude-settings-local.ts.
//
// 2. THE MINIMAL MANIFEST ASSERTS ONLY WHAT ROUBO KNOWS. When the spec folder
//    carries no manifest at all, the created file is exactly
//    `{ slug, lifecycle, updated_at }`. No `schema_version`, no
//    `current_stage`, no `stages`, no `id_counters`: minting those is
//    product-dev's job, and inventing them here would be a lie about a stage
//    the reviewer never ran (SATCA-TC-048).
//
// Reversal is the same write with `lifecycle` deleted. That is what
// absence-means-live buys (`archived: z.literal(true)` in the #765 schema):
// restoring a spec is a key deletion, not a state flag flipped to false.
//
// Path-safety mirrors the reader's manifestPath() exactly, so read and write can
// never disagree about which file they touch: assertSafeIdentifier(SPEC_SLUG_RE)
// on the slug BEFORE any path is built, then resolveWithin for lexical
// containment, then assertRealpathWithin so a `.specifications/<slug>` symlinked
// out of the repo is refused before the write. All three are fail-CLOSED and
// throw UnsafePathError.
//
// Durability copies testbench-results-write.ts verbatim: the temp file lives
// INSIDE `.specifications/<slug>/`, so fs.renameSync is always intra-directory
// and EXDEV cannot arise. state.ts's generic atomicWrite is deliberately not
// reused, for the reason its own comment gives. An interrupted write therefore
// leaves the previous manifest intact rather than a truncated one
// (SATCA-NFR-003).
//
// The writer never invokes git. The change is left uncommitted in the worktree
// by design, for the reviewer to inspect and commit themselves.

import fs from "node:fs";
import path from "node:path";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
  SPEC_SLUG_RE,
} from "./safe-path.js";
import { validateSpecLifecycle } from "@roubo/shared/spec-lifecycle-schema";
import type { SpecLifecycleRecord } from "@roubo/shared/spec-lifecycle-schema";

// The spec folder named by the slug does not exist under `.specifications/`.
// Distinct from a path-safety refusal: the request was well-formed, there is
// simply no such spec to archive. The writer never creates the folder, because
// a manifest for a folder with no test-cases.json would not be a spec.
export class SpecFolderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecFolderNotFoundError";
  }
}

// A manifest exists but could not be parsed as a JSON object. The write is
// REFUSED rather than clobbering it: merging is the whole contract, and there is
// nothing to merge into. Overwriting here would destroy exactly the keys
// SATCA-TC-049 exists to protect. Note this diverges from the READER, which
// fails open on the same file (a spec Roubo cannot read stays listed and live);
// failing open is right for a read and wrong for a write.
export class ManifestUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestUnreadableError";
  }
}

// The manifest's own timestamps are second-precision ISO-Z (product-dev writes
// e.g. "2026-08-06T10:33:17Z"), so the refreshed `updated_at` matches rather
// than introducing a second format into a file with one.
function isoSecondsZ(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

// Resolve `.specifications/<slug>/manifest.json` under repoPath through the same
// three barriers the reader's manifestPath applies. Throws UnsafePathError on an
// unsafe slug, a lexical escape, or a symlink resolving outside the repo.
function manifestPath(repoPath: string, slug: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(repoPath, ".specifications", slug, "manifest.json");
  assertRealpathWithin(repoPath, target, "spec manifest path");
  return target;
}

// Read the manifest as an untyped object, or null when the folder has none.
// Throws ManifestUnreadableError when a file IS present but is not a JSON
// object, so the merge never silently degrades into a clobber.
function readManifestObject(target: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // A manifest IS there, we just cannot read it (EACCES, EISDIR, ELOOP).
      // Renaming over it needs only write permission on the DIRECTORY, so
      // falling through to the minimal-creation branch would clobber every
      // product-dev key with a three-key file. Refuse, exactly as an
      // unparseable manifest is refused below.
      throw new ManifestUnreadableError(
        `manifest.json in .specifications/${path.basename(path.dirname(target))}/ could not be read; refusing to overwrite it`,
      );
    }
    // Genuinely no manifest: the minimal-creation branch.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestUnreadableError(
      `manifest.json in .specifications/${path.basename(path.dirname(target))}/ is not valid JSON; refusing to overwrite it`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ManifestUnreadableError(
      `manifest.json in .specifications/${path.basename(path.dirname(target))}/ is not a JSON object; refusing to overwrite it`,
    );
  }
  // JSON.parse creates own data properties (it never invokes setters), and
  // object spread copies them the same way, so a `__proto__` key in the source
  // survives the round-trip as data rather than polluting Object.prototype.
  return parsed as Record<string, unknown>;
}

// Set (or, with `record === null`, clear) one spec's lifecycle record, merging
// into whatever manifest is already there and creating a minimal one when the
// folder has none. Returns the resolved absolute path that was written.
//
// Throws UnsafePathError (unsafe slug / escape / symlink),
// SpecFolderNotFoundError (no such spec folder), or ManifestUnreadableError (a
// present manifest that is not a JSON object). A record that fails the published
// schema is rejected before anything is written, so the writer can never emit a
// shape the reader would reject.
export function writeSpecLifecycle(
  repoPath: string,
  slug: string,
  record: SpecLifecycleRecord | null,
): string {
  if (record !== null) {
    const validation = validateSpecLifecycle(record);
    if (!validation.ok) {
      throw new TypeError(`Invalid spec lifecycle record: ${validation.errors.join("; ")}`);
    }
  }

  const target = manifestPath(repoPath, slug);
  const dir = path.dirname(target);
  assertRealpathWithin(repoPath, dir, "spec dir");

  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    throw new SpecFolderNotFoundError(`No spec folder .specifications/${slug}/ in this project`);
  }
  if (!dirStat.isDirectory()) {
    throw new SpecFolderNotFoundError(`No spec folder .specifications/${slug}/ in this project`);
  }

  const existing = readManifestObject(target);

  // The minimal manifest asserts only what Roubo can know: the folder slug and
  // the state the reviewer just chose. Everything else stays product-dev's to
  // mint (SATCA-TC-048 S001-O03).
  const next: Record<string, unknown> = existing === null ? { slug } : { ...existing };

  if (record === null) {
    // Reversal: the key is REMOVED, not set to a false-ish record. Absence is
    // the live state, so a restored spec's manifest is indistinguishable from
    // one that was never archived.
    delete next.lifecycle;
  } else {
    next.lifecycle = record;
  }
  // The one non-lifecycle key the writer mutates (SATCA-TC-049 S001-O03 admits
  // the timestamp alongside the lifecycle record).
  next.updated_at = isoSecondsZ();

  // Same-directory temp-then-rename: EXDEV is impossible, and an interrupted
  // write leaves the previous manifest intact (SATCA-NFR-003).
  const tmp = path.join(dir, "manifest.json.tmp");
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}
