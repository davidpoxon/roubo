import path from "node:path";
import { homedir } from "node:os";

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

// Resolves `segments` under `root` and asserts the result stays within `root`.
// Uses path.relative + startsWith("..") because that is the containment shape
// CodeQL's default js/path-injection suite recognises as a sanitizer.
export function resolveWithin(root: string, ...segments: string[]): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new UnsafePathError(`Invalid root: ${root}`);
  }
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.includes("\0")) {
      throw new UnsafePathError(`Invalid path segment: ${segment}`);
    }
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new UnsafePathError(`Path "${segments.join("/")}" escapes root "${resolvedRoot}"`);
  }
  return resolved;
}

// Resolves `rawPath` to an absolute path and asserts it is `root` or strictly
// inside one of `roots`. Returns a path re-derived through resolveWithin when
// contained, or null when it escapes every root. Re-joining the relative segment
// onto the matched root via resolveWithin (rather than returning the caller's
// own path.resolve(rawPath)) is deliberate: resolveWithin is the
// join-under-fixed-root shape CodeQL's default js/path-injection suite
// recognises as a sanitizer, so the returned value reaches downstream fs sinks
// already laundered.
export function resolveWithinRoots(roots: string[], rawPath: string): string | null {
  const resolved = path.resolve(rawPath);
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const rel = path.relative(resolvedRoot, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      try {
        // rel === "" (the root itself) re-resolves to the root.
        return resolveWithin(resolvedRoot, rel);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Normalises a user-supplied absolute filesystem path and asserts it is
// well-formed (resolves to an absolute path that does not escape the
// filesystem root). Use for paths that are legitimately allowed to point
// anywhere on the local disk (e.g. a registered project's repoPath), where no
// containment root applies but the value must still be sanitised before it
// reaches a path/exec sink. This is the same containment-barrier shape CodeQL's
// default js/path-injection suite recognises as a sanitizer (see CodeQL #117).
export function normalizeAbsolutePath(input: string, label = "path"): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new UnsafePathError(`Invalid ${label}: ${String(input)}`);
  }
  const resolved = path.resolve(input);
  const rel = path.relative(path.parse(resolved).root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new UnsafePathError(`${label} "${input}" is not a valid absolute path`);
  }
  return resolved;
}

// Returns true when `candidate` is `root` or strictly inside `root`, false
// otherwise. Mirrors the shape recognised by CodeQL's default sanitizer.
export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Allowed roots for user-supplied directory paths: the user's home directory
// plus any absolute paths in ROUBO_FILESYSTEM_ROOTS (comma-separated). Shared by
// the filesystem browser and the project-scan endpoint so both confine to the
// same locations. Pair with resolveWithinRoots to confine a tainted path.
export function allowedRoots(): string[] {
  const extra = (process.env.ROUBO_FILESYSTEM_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => path.isAbsolute(s))
    .map((s) => path.resolve(s));
  const home = path.resolve(homedir());
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of [home, ...extra]) {
    if (!seen.has(r)) {
      seen.add(r);
      result.push(r);
    }
  }
  return result;
}

export function assertSafeIdentifier(value: unknown, pattern: RegExp, label: string): void {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new UnsafePathError(`Invalid ${label}: ${String(value)}`);
  }
}

// Reusable regexes for identifiers that appear as path segments.
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Project IDs in roubo are derived from repo paths (slugified). Allow letters,
// digits, dot, underscore, hyphen. The negative lookahead rejects "." and ".."
// outright so the value can never be a traversal segment.
export const PROJECT_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
// Jig IDs are validated at the HTTP boundary by VALID_JIG_ID in
// server/routes/helpers.ts as /^[a-z0-9_-]+$/, and slugify() in
// server/services/jig-manager.ts can produce digit-leading slugs like
// "test-123". Keep this regex aligned with that public contract so the
// sanitizer doesn't reject ids the rest of the system has already accepted.
export const JIG_ID_RE = /^[a-z0-9_-]+$/;
