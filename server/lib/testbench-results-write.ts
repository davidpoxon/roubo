import fs from "node:fs";
import path from "node:path";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";

// Spike primitive (#406): proves a CodeQL-clean write of a spec-folder file,
// using a same-directory temp-then-rename so a cross-device rename (EXDEV) can
// never arise. As of #493 `rootPath` is the bench's own worktree root (the file
// lands as a sibling of test-cases.json under `.specifications/<slug>/`), not the
// registered project repoPath; the sanitizer shape below is unchanged.
//
// The order of operations is load-bearing:
//   1. assertSafeIdentifier(slug, SPEC_SLUG_RE, ...) runs FIRST, before any path
//      is built, so a traversal/separator slug is rejected before any fs call.
//   2. resolveWithin(rootPath, '.specifications', slug, <filename>)
//      joins under the fixed root and asserts containment; this is the shape
//      CodeQL's default js/path-injection suite recognises as a sanitizer, so the
//      resolved target reaches the fs sinks already laundered.
//   3. resolveWithin is lexical (path.resolve + path.relative), so it cannot
//      see an on-disk symlink whose name is a valid slug. assertRealpathWithin
//      is a SECOND barrier at the sink: after the directory exists it realpaths
//      it and re-asserts containment against the realpath'd root, rejecting a
//      symlinked `.specifications/<slug>` that escapes the repo (#416, TC-052).
//   4. The temp file lives INSIDE the same `.specifications/<slug>/` directory
//      as the target (not os.tmpdir()), so fs.renameSync is always
//      intra-directory and EXDEV cannot occur. (state.ts atomicWrite is
//      deliberately not reused: its sibling .tmp is only same-FS by luck.)

// The complete set of filenames a write ROUTED THROUGH THIS PRIMITIVE may place
// inside a spec folder (SATCA-NFR-001, SATCA-TC-059). The lifecycle write path
// (#772) generalised it from one hardcoded filename to a parameterised one, so
// for its callers the "only these filenames are ever written" property is
// enforced HERE rather than by every caller remembering to pass a safe value.
// `test-results.json` is the results sidecar Roubo has always owned;
// `test-cases.json` is the case-lifecycle write.
//
// Scope note: this is not yet every Roubo write into a spec folder. The spec
// lifecycle write (#1166) places `manifest.json` via its own temp-and-rename,
// behind the same three path-safety barriers but not through this function, so
// `manifest.json` is listed here for the case-side sink's allowlist rather than
// because that writer passes through. Nothing else is reachable via this
// primitive, whatever a caller passes.
export const PERMITTED_SPEC_FILENAMES = [
  "test-results.json",
  "test-cases.json",
  "manifest.json",
] as const;

export type PermittedSpecFilename = (typeof PERMITTED_SPEC_FILENAMES)[number];

// Write one permitted file into `.specifications/<slug>/` atomically.
//
// The filename is checked against the allowlist BEFORE any path is built, so a
// traversal filename ("../../evil") or an unlisted one never reaches
// resolveWithin, let alone an fs call. If EITHER the temp write or the rename
// fails (an interrupted write, SATCA-TC-054) the temp file is removed and the
// original target is left exactly as it was: no partial or truncated file is
// left in the spec folder. Both sinks sit inside the same try for that reason: a
// temp write that dies part-way (ENOSPC, EIO) leaves exactly the truncated
// sibling this guard exists to prevent, so guarding only the rename would miss
// half the failure surface.
//
// Returns the resolved absolute target path.
export function writeSpecFile(
  rootPath: string,
  slug: string,
  filename: string,
  data: string,
): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  // Narrow the tainted filename to one of the three literals above. The check is
  // an inline includes() on a frozen literal tuple so the value that reaches
  // resolveWithin is provably one of them.
  if (!(PERMITTED_SPEC_FILENAMES as readonly string[]).includes(filename)) {
    throw new UnsafePathError(`Invalid spec filename: ${String(filename)}`);
  }
  const safeFilename = filename;
  const target = resolveWithin(rootPath, ".specifications", slug, safeFilename);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  assertRealpathWithin(rootPath, dir, "spec dir");
  const tmp = path.join(dir, `${safeFilename}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (err) {
    // The rename is the commit point. Until it lands, the target still holds its
    // original bytes; drop the temp so the spec folder is not left carrying a
    // half-written sibling, whether the temp write or the rename was what failed
    // (SATCA-TC-054).
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: a temp we cannot remove must not mask the real failure.
    }
    throw err;
  }
  return target;
}

// The results sidecar write (#406), now a thin delegate over writeSpecFile.
export function writeResults(rootPath: string, slug: string, data: string): string {
  return writeSpecFile(rootPath, slug, "test-results.json", data);
}
