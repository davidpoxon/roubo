import fs from "node:fs";
import path from "node:path";
import { assertSafeIdentifier, resolveWithin, SPEC_SLUG_RE } from "./safe-path.js";

// Spike primitive (#406): proves a CodeQL-clean write of test-results.json,
// using a same-directory temp-then-rename so a cross-device rename (EXDEV) can
// never arise. As of #493 `rootPath` is the bench's own worktree root (the file
// lands as a sibling of test-cases.json under `.specifications/<slug>/`), not the
// registered project repoPath; the sanitizer shape below is unchanged.
//
// The order of operations is load-bearing:
//   1. assertSafeIdentifier(slug, SPEC_SLUG_RE, ...) runs FIRST, before any path
//      is built, so a traversal/separator slug is rejected before any fs call.
//   2. resolveWithin(rootPath, '.specifications', slug, 'test-results.json')
//      joins under the fixed root and asserts containment; this is the shape
//      CodeQL's default js/path-injection suite recognises as a sanitizer, so the
//      resolved target reaches the fs sinks already laundered.
//   3. The temp file lives INSIDE the same `.specifications/<slug>/` directory
//      as the target (not os.tmpdir()), so fs.renameSync is always
//      intra-directory and EXDEV cannot occur. (state.ts atomicWrite is
//      deliberately not reused: its sibling .tmp is only same-FS by luck.)
//
// Returns the resolved absolute target path.
export function writeResults(rootPath: string, slug: string, data: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(rootPath, ".specifications", slug, "test-results.json");
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "test-results.json.tmp");
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  return target;
}
