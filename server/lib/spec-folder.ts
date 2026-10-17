// Resolves the spec folder a Spec Bench focuses on (SB-FR-001). The folder is
// `.specifications/<slug>` inside the project checkout, given as an absolute or
// a repo-relative path. It must stay inside the repository both lexically and
// after symlink resolution, carry a slug that passes the allowlist, and exist as
// a directory. Every failure throws UnsafePathError with a message that names
// `focusedSpecPath`, which the create route returns as its 400.
import fs from "node:fs";
import path from "node:path";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithinRoots,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";

export function resolveSpecFolder(
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
  const segments = path.relative(path.resolve(repoPath), contained).split(path.sep);
  if (segments.length !== 2 || segments[0] !== ".specifications") {
    throw new UnsafePathError(
      `focusedSpecPath "${focusedSpecPath}" must point at a .specifications/<slug> folder inside the project`,
    );
  }
  const slug = segments[1];
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  assertRealpathWithin(repoPath, contained, "focusedSpecPath");
  if (!fs.statSync(contained, { throwIfNoEntry: false })?.isDirectory()) {
    throw new UnsafePathError(`focusedSpecPath "${focusedSpecPath}" does not exist in the project`);
  }
  return { slug, resolvedPath: contained };
}
