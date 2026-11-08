// Builds the lifecycle view that `evaluateGate` consumes for one spec's plan
// (#1164, SATCA-FR-012). The caller does the I/O through this helper; the
// evaluator does not. The gates route and the delivery read (SB-FR-011) both
// build their lifecycle here, so a retired or superseded case reads the same in a
// gate's state and in the delivery progress.
//
// The resolver's own `collectReferencedSlugs` decides what to pre-load, so the
// gate, the rollup, and the authoring-time picker all discover the same set by the
// same rule and cannot diverge on what "supplied" means. Each referenced spec is
// read from the root `rootOf` gives for it (#910), and a slug that cannot be read
// is simply left out of the map, which the resolver reports as `target spec not
// supplied` rather than as a resolution.
//
// Returns undefined when the plan carries no lifecycle block at all: there is
// nothing to resolve, the evaluator's lifecycle-free path is byte-identical, and
// the common case does no extra I/O.
import type { GateLifecycle } from "./gate-evaluator.js";
import { collectReferencedSlugs, resolvePlan } from "@roubo/shared/lifecycle-resolver";
import type { ResolverPlan, ResolverSpecLifecycle } from "@roubo/shared/lifecycle-resolver";
import type { BenchResults, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import { readPlanAndResults } from "./testbench-store.js";
import { readSpecLifecycle } from "./testbench-spec-lifecycle.js";

// Read one spec's lifecycle record without letting a bad slug or an unreadable
// manifest fail the whole read. `readSpecLifecycle` already fails open for a
// missing / unparseable / invalid manifest; the catch covers the path barriers,
// which throw UnsafePathError for a slug that came out of an author-written
// replacement pointer. Either way the spec reads as live, which is the reader's
// own never-hide-a-spec-by-accident rule.
function readSpecLifecycleSafely(root: string, slug: string): ResolverSpecLifecycle | null {
  try {
    return readSpecLifecycle(root, slug).lifecycle;
  } catch {
    return null;
  }
}

/**
 * The lifecycle resolutions of `plan`, the plan of spec `slug`. `ownRoot` is
 * the root the spec's own manifest is read from, and `rootOf` gives the root
 * each referenced spec's plan, results and manifest are read from.
 */
export function buildPlanLifecycle(
  plan: TestCasesPlan,
  slug: string,
  ownRoot: string,
  rootOf: (referencedSlug: string) => string,
): GateLifecycle | undefined {
  if (!plan.cases.some((testCase) => testCase.lifecycle !== undefined)) {
    return undefined;
  }

  // Keyed by the plan's OWN `specSlug`, which is the slug a bare same-spec pointer
  // is scoped to, so the resolver's internal lookups line up. The folder slug is
  // what the manifest is read from; the two agree in practice.
  const plans = new Map<string, ResolverPlan>([[plan.specSlug, plan]]);
  const specLifecycles = new Map<string, ResolverSpecLifecycle>();
  const resultsBySlug = new Map<string, BenchResults>();

  const ownRecord = readSpecLifecycleSafely(ownRoot, slug);
  if (ownRecord !== null) specLifecycles.set(plan.specSlug, ownRecord);

  for (const referenced of collectReferencedSlugs(plan)) {
    const root = rootOf(referenced);
    try {
      const loaded = readPlanAndResults(root, referenced);
      plans.set(referenced, loaded.plan);
      // Fail-closed (VG-NFR-007): a referenced spec whose recorded results are
      // stale against its own plan contributes no status, so a pointer landing
      // there reads as unresolved rather than borrowing an out-of-date pass.
      if (loaded.results !== null && !loaded.stale) {
        resultsBySlug.set(referenced, loaded.results);
      }
    } catch {
      // Missing, unreadable, invalid, or an unsafe slug: leave it unsupplied.
      continue;
    }
    const record = readSpecLifecycleSafely(root, referenced);
    if (record !== null) specLifecycles.set(referenced, record);
  }

  return { resolutions: resolvePlan(plan, { plans, specLifecycles }), resultsBySlug };
}
