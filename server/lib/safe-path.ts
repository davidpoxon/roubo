import path from "node:path";

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

// Returns true when `candidate` is `root` or strictly inside `root`, false
// otherwise. Mirrors the shape recognised by CodeQL's default sanitizer.
export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
