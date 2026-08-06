// SpecLifecycleReader: the fail-open, path-safe, READ-ONLY face of a spec's
// lifecycle record (#765, SATCA-FR-013/FR-017, SATCA-NFR-003).
//
// One job: given a project repoPath and a spec slug, answer "is this spec
// archived?" by reading the `lifecycle` subtree of
// `.specifications/<slug>/manifest.json`. It never writes, and it opens exactly
// one file. In particular it NEVER opens `flow-state.json`, the legacy stage
// tracker two spec folders in the roubo-development meta-repo still carry: a
// legacy folder has no manifest, so the read misses and the spec reads as live.
// Legacy tolerance is therefore a property of this module's file selection, not
// of what happens to be in those files today (SATCA-TC-040).
//
// Fail-open ladder, mirroring the store's loadResultsFile:
//   - no manifest.json (or unreadable)      -> live, no error
//   - manifest.json is not valid JSON       -> live, no error (product-dev owns
//                                              that file; Roubo does not get to
//                                              hide a spec over it)
//   - manifest.json has no `lifecycle` key  -> live, no error
//   - `lifecycle` fails validation          -> live, WITH a field-named
//                                              recordError, so the spec stays
//                                              listed and is merely marked as
//                                              carrying an unreadable record
//                                              (SATCA-TC-041)
//
// Path-safety (SATCA-NFR-001, matching the barriers discoverSpecs already
// applies per slug): assertSafeIdentifier(SPEC_SLUG_RE) on the slug, then
// resolveWithin for lexical containment, then assertRealpathWithin so a
// `manifest.json` symlinked out of the repo is refused before the read. Those
// three are fail-CLOSED and throw UnsafePathError, exactly as the store's
// resultsPath does; discovery wraps the call in its own per-spec try/catch so
// one unsafe spec degrades rather than failing the endpoint.

import fs from "node:fs";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
  SPEC_SLUG_RE,
} from "./safe-path.js";
import { validateSpecLifecycle } from "@roubo/shared/spec-lifecycle-schema";
import type { SpecLifecycleRecord } from "@roubo/shared/spec-lifecycle-schema";

// What the reader returns:
//   - lifecycle: the validated record, or null when the spec is live (no
//     manifest, no subtree, or an unreadable manifest).
//   - recordError: why a PRESENT lifecycle subtree could not be read, as a
//     field-named message; null whenever the spec simply has no record.
// A null lifecycle with a non-null recordError is the degraded state: the spec
// is treated as live (never hidden by accident) and flagged.
export interface SpecLifecycleRead {
  lifecycle: SpecLifecycleRecord | null;
  recordError: string | null;
}

// Resolve `.specifications/<slug>/manifest.json` under repoPath, through the
// same three barriers discoverSpecs applies. Throws UnsafePathError on an unsafe
// slug, a lexical escape, or a symlink that resolves outside the repo.
function manifestPath(repoPath: string, slug: string): string {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const target = resolveWithin(repoPath, ".specifications", slug, "manifest.json");
  assertRealpathWithin(repoPath, target, "spec manifest path");
  return target;
}

// Read one spec's lifecycle record. See the module header for the fail-open
// ladder and the throw contract.
export function readSpecLifecycle(repoPath: string, slug: string): SpecLifecycleRead {
  const target = manifestPath(repoPath, slug);

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    // No manifest, or unreadable: the spec is live and this is not an error
    // (SATCA-FR-017). A legacy flow-state.json-only folder lands here.
    return { lifecycle: null, recordError: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The manifest is authored by product-dev, not by Roubo. A parse failure is
    // that toolchain's problem to report; reading it as "archived" or hiding the
    // spec over it would both be wrong, so the spec reads as live.
    return { lifecycle: null, recordError: null };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { lifecycle: null, recordError: null };
  }

  // Pluck ONLY the lifecycle subtree. Every sibling key (schema_version, stages,
  // id_counters, spikes, and whatever product-dev adds next) is ignored by
  // construction, so a manifest carrying unrelated keys validates fine.
  const subtree = (parsed as { lifecycle?: unknown }).lifecycle;
  if (subtree === undefined) {
    // No record: live.
    return { lifecycle: null, recordError: null };
  }

  const validation = validateSpecLifecycle(subtree);
  if (!validation.ok) {
    // Present but malformed: stay live (never hide a spec by accident) and carry
    // the field-named reason so the caller can mark this one spec.
    return { lifecycle: null, recordError: validation.errors.join("; ") };
  }

  return { lifecycle: validation.data, recordError: null };
}
