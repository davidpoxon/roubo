// LifecycleResolver: the single pure owner of every supersession-resolution rule
// (#766, SATCA-FR-009, SATCA-FR-010, SATCA-FR-012). The live predicate, the
// transitive walk, the cycle guard, the depth limit, cross-spec resolution
// against a caller-supplied plan map, and the closed six-value vocabulary of
// unresolved reasons all live here and nowhere else.
//
// Why one module: three consumers resolve the same pointers (the gate evaluator,
// the TestBench rollup, and the authoring-time ReplacementPicker preview). The
// architecture rates duplicating this logic across them a high-severity risk
// against the never-false-pass contract (`verify-gate:NFR-007`), because a picker
// that resolved a pointer one way and a gate that resolved it another would
// surface as an unexplainable stuck gate. So the depth constant lives here, never
// in a caller, and there is no configuration surface for it.
//
// Pure by construction: no imports, no filesystem, no clock, no randomness, no
// mutation of any input. Callers load spec content and thread it in
// (`SATCA-FR-012`); this module only reads what it is handed and returns fresh
// objects, so identical inputs produce deeply equal output (`SATCA-TC-032`,
// `SATCA-TC-034`).
//
// Not a schema. `test-cases.json` lifecycle blocks are already validated by
// `CaseLifecycleSchema` (testbench-contracts.ts) and spec lifecycle subtrees by
// `SpecLifecycleRecordSchema` (spec-lifecycle-schema.ts). This module consumes
// those validated shapes structurally, which is also why it takes the minimal
// shapes it actually reads rather than either of the two parallel `Case`
// definitions `shared/` carries.
//
// The rules below are transcribed from the spike that settled them, not
// re-derived: `.specifications/spec-and-test-case-archival/spikes/
// spike-763-supersession-pointer-resolution-rules.md` (#763).

// ── The depth limit ──
//
// A module constant with no configuration surface (#763 AC1). Depth counts HOPS
// FOLLOWED, not nodes visited: the origin case is depth 0, following its
// replacement pointer lands at depth 1. A chain that reaches a live case on hop
// 10 RESOLVES; only a landing that is still superseded at hop 10, and so would
// require an eleventh hop, returns `depth exceeded`.
export const MAX_SUPERSESSION_DEPTH = 10;

// ── The closed unresolved vocabulary ──
//
// Exhaustive over the failure space and closed: #763 AC3 is explicit that a
// retired case inside an archived spec reports `target archived` rather than
// minting a seventh value, because both `SATCA-FR-010` and `SATCA-FR-029` quote
// this list and widening it would put the PRD behind the resolver.
export type UnresolvedReason =
  | "target missing"
  | "target archived"
  | "target not live"
  | "cycle detected"
  | "depth exceeded"
  | "target spec not supplied";

export const UNRESOLVED_REASONS: readonly UnresolvedReason[] = [
  "target missing",
  "target archived",
  "target not live",
  "cycle detected",
  "depth exceeded",
  "target spec not supplied",
] as const;

// ── Input shapes ──
//
// Structurally minimal on purpose: exactly the fields the walk reads. Both the
// zod-inferred `Case` / `TestCasesPlan` from testbench-contracts.ts and the
// hand-written mirrors in testbench-domain-types.ts satisfy these, so the
// resolver works with either without deepening that duplication.

// Mirrors CaseLifecycleSchema (test-cases schema v1.2.0). Absent means live.
export type ResolverCaseLifecycle =
  | { state: "retired"; reason: string }
  | { state: "superseded"; replacement: string; reason?: string };

export interface ResolverCase {
  id: string;
  lifecycle?: ResolverCaseLifecycle;
}

export interface ResolverPlan {
  specSlug: string;
  cases: readonly ResolverCase[];
}

// Mirrors SpecLifecycleRecord. Only archived specs have a record at all: absence
// is the live state (`SATCA-FR-017`), so a slug missing from the map is live.
export interface ResolverSpecLifecycle {
  archived: true;
  reason?: string;
  supersededBy?: string;
}

export interface ResolverInputs {
  // Every plan the caller loaded, keyed by spec slug. The origin plan should be
  // among them so that bare, same-spec pointers resolve; `resolvePlan` adds it
  // for you. A slug absent from this map yields `target spec not supplied`,
  // which is deliberately distinct from `target missing` (a slug that WAS
  // supplied but carries no such case id).
  plans: ReadonlyMap<string, ResolverPlan>;
  // Archived-spec records keyed by slug. Optional; an omitted map means every
  // supplied spec is live.
  specLifecycles?: ReadonlyMap<string, ResolverSpecLifecycle>;
}

// ── Output shapes ──

// A fully-qualified case reference: the pair the cycle guard's visited-set is
// keyed on.
export interface PointerRef {
  slug: string;
  caseId: string;
}

// A case's own lifecycle state. `live` is the absence of a lifecycle block.
export type CaseState = "live" | "retired" | "superseded";

// A spec's state as far as the walk is concerned. `not supplied` is a statement
// about the caller's inputs, not about the repository.
export type SpecState = "live" | "archived" | "not supplied";

export type ResolutionStatus =
  // The origin case is live; it resolves to itself and nothing was walked.
  | "live"
  // The origin was superseded and the walk reached a live case in a live spec.
  | "resolved"
  // The origin is retired. Terminal by definition (`SATCA-FR-001`: a retired
  // case carries a reason and no pointer), and NOT a failure: the obligation
  // ends rather than transferring, so `reason` stays null.
  | "retired"
  // The walk terminated without reaching a live case. `reason` is set.
  | "unresolved";

export interface Resolution {
  // The case this resolution is about.
  origin: PointerRef;
  // The origin case's own lifecycle state.
  originState: CaseState;
  status: ResolutionStatus;
  // Every node visited, in order, starting with the origin. On a `cycle
  // detected` result the repeated node is appended, so the chain shows the loop.
  chain: readonly PointerRef[];
  // The live case the chain resolved to, or null when it did not resolve.
  resolvedTo: PointerRef | null;
  // One of the six closed reasons, or null when `status` is not "unresolved".
  reason: UnresolvedReason | null;
  // The final landing's own case state, where it could be determined. Null when
  // the landing's spec was not supplied, or when the case id exists in no plan.
  // Carried alongside `reason` so #774's authoring-time preview can say "that
  // specification is archived, and that case is retired within it" without a
  // seventh reason value (#763 AC3).
  targetCaseState: CaseState | null;
  // The final landing's spec state.
  targetSpecState: SpecState;
  // Remedy hint only: the `supersededBy` slug recorded on an archived target
  // spec. Spec-level supersession is NEVER walked, because a slug names no case,
  // so nothing in the data model says which case in the successor spec carries
  // the obligation (#763 AC2).
  supersededBy: string | null;
}

// ── The live predicate ──

// A case is live exactly when it carries no lifecycle block. There is no `live`
// state to record: absence is the live state (`SATCA-FR-001`).
export function isCaseLive(subject: ResolverCase | ResolverCaseLifecycle | undefined): boolean {
  return caseStateOf(subject) === "live";
}

export function caseStateOf(subject: ResolverCase | ResolverCaseLifecycle | undefined): CaseState {
  if (!subject) return "live";
  const lifecycle = "state" in subject ? subject : subject.lifecycle;
  if (!lifecycle) return "live";
  return lifecycle.state;
}

// A spec is live exactly when it has no lifecycle record, per `SATCA-FR-017`.
export function isSpecLive(record: ResolverSpecLifecycle | undefined): boolean {
  return record === undefined;
}

// ── Pointer syntax ──
//
// The one place replacement-pointer syntax is parsed. `CaseLifecycleSchema`
// preserves the pointer verbatim and deliberately never interprets it, and no
// consumer may re-implement this: "TC-004" is a bare, same-spec pointer, and
// "other-spec:TC-004" is slug-qualified.
//
// Split on the FIRST colon. That is unambiguous because a spec slug matches
// SPEC_LIFECYCLE_SLUG_PATTERN (lowercase letters, digits, "-" and "_"), which
// admits no colon, so the first colon can only be the separator.
//
// `containingSlug` is the slug of the spec whose case CARRIES the pointer, which
// is what a bare pointer means. On the first hop that is the origin's slug; on
// later hops it is the slug the walk has reached, so a bare pointer authored in
// a cross-spec landing stays inside that landing's spec.
//
// No normalisation, no trimming: a malformed pointer fails closed against the
// same six reasons rather than being repaired here.
export function parseReplacementPointer(replacement: string, containingSlug: string): PointerRef {
  const separator = replacement.indexOf(":");
  if (separator === -1) {
    return { slug: containingSlug, caseId: replacement };
  }
  return {
    slug: replacement.slice(0, separator),
    caseId: replacement.slice(separator + 1),
  };
}

// ── The referenced-slug collector ──

// Every OTHER spec slug this plan's pointers reach, in first-encounter order
// over the plan's cases. Callers use it to decide what to load, so all callers
// discover the same set by the same rule and cannot diverge on what "supplied"
// means.
//
// Direct references only: a chain that crosses two specs is discovered by asking
// again once the next plan is loaded. The collector is deliberately per-plan,
// because a transitive collector would have to load files to answer, which this
// module never does.
export function collectReferencedSlugs(plan: ResolverPlan): string[] {
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const testCase of plan.cases) {
    const lifecycle = testCase.lifecycle;
    if (!lifecycle || lifecycle.state !== "superseded") continue;
    const pointer = parseReplacementPointer(lifecycle.replacement, plan.specSlug);
    if (pointer.slug === plan.specSlug) continue;
    if (seen.has(pointer.slug)) continue;
    seen.add(pointer.slug);
    slugs.push(pointer.slug);
  }
  return slugs;
}

// ── The walk ──

function visitedKey(ref: PointerRef): string {
  // The slug's own grammar excludes ":" (SPEC_LIFECYCLE_SLUG_PATTERN), so a
  // single colon separator cannot collide between two different pairs.
  return `${ref.slug}:${ref.caseId}`;
}

function findCase(plan: ResolverPlan | undefined, caseId: string): ResolverCase | undefined {
  if (!plan) return undefined;
  return plan.cases.find((entry) => entry.id === caseId);
}

// Resolve one case's supersession chain.
//
// `originCase` is passed alongside its slug rather than looked up, so the entry
// point is total: there is no "the origin does not exist" outcome to represent,
// and the six reasons stay statements about TARGETS, exactly as #763 scopes them.
//
// The origin's own spec state is deliberately NOT a gate here. Whether a case in
// an archived spec is gated at all is a gating-set question owned by
// SpecDiscovery and GateEvaluator; the walk's rules concern targets (#763 AC2).
export function resolveCase(
  originSlug: string,
  originCase: ResolverCase,
  inputs: ResolverInputs,
): Resolution {
  const plans = inputs.plans;
  const specLifecycles = inputs.specLifecycles;

  const origin: PointerRef = { slug: originSlug, caseId: originCase.id };
  const originState = caseStateOf(originCase);
  const chain: PointerRef[] = [origin];

  const originSpecState: SpecState = plans.has(originSlug)
    ? specLifecycles?.get(originSlug) !== undefined
      ? "archived"
      : "live"
    : "not supplied";

  if (originState === "live") {
    return {
      origin,
      originState,
      status: "live",
      chain,
      resolvedTo: origin,
      reason: null,
      targetCaseState: "live",
      targetSpecState: originSpecState,
      supersededBy: null,
    };
  }

  if (originState === "retired") {
    return {
      origin,
      originState,
      status: "retired",
      chain,
      resolvedTo: null,
      reason: null,
      targetCaseState: "retired",
      targetSpecState: originSpecState,
      supersededBy: null,
    };
  }

  const unresolved = (
    reason: UnresolvedReason,
    targetCaseState: CaseState | null,
    targetSpecState: SpecState,
    supersededBy: string | null,
  ): Resolution => ({
    origin,
    originState,
    status: "unresolved",
    chain,
    resolvedTo: null,
    reason,
    targetCaseState,
    targetSpecState,
    supersededBy,
  });

  // The visited-set is seeded with the origin, so a chain that points back at
  // its own head is a cycle rather than a re-walk (#763 AC1).
  const visited = new Set<string>([visitedKey(origin)]);

  let currentSlug = originSlug;
  let currentCase = originCase;
  let hops = 0;

  // Loop invariant: `currentCase` is superseded and carries a pointer to follow,
  // which the entry conditions above and the landing checks below both enforce.
  for (;;) {
    const lifecycle = currentCase.lifecycle;
    if (lifecycle?.state !== "superseded") {
      // Unreachable under the invariant; fail closed rather than resolve.
      return unresolved("target missing", null, "live", null);
    }

    const pointer = parseReplacementPointer(lifecycle.replacement, currentSlug);

    // Guards before the hop, cycle first. `cycle detected` takes precedence over
    // `depth exceeded` wherever both could apply, because re-entry is detected
    // the moment it happens (#763 AC1).
    if (visited.has(visitedKey(pointer))) {
      // Append the repeated node so the reported chain shows the loop closing.
      chain.push(pointer);
      const revisited = findCase(plans.get(pointer.slug), pointer.caseId);
      return unresolved(
        "cycle detected",
        revisited ? caseStateOf(revisited) : null,
        specStateOf(pointer.slug, plans, specLifecycles),
        specLifecycles?.get(pointer.slug)?.supersededBy ?? null,
      );
    }

    if (hops >= MAX_SUPERSESSION_DEPTH) {
      // The landing at the limit is still superseded, so the chain needs an
      // eleventh hop it may not take. The case is NOT dropped: the caller keeps
      // it in the gating set as unresolved (`SATCA-FR-010`).
      return unresolved(
        "depth exceeded",
        "superseded",
        specStateOf(currentSlug, plans, specLifecycles),
        specLifecycles?.get(currentSlug)?.supersededBy ?? null,
      );
    }

    hops += 1;
    chain.push(pointer);
    visited.add(visitedKey(pointer));

    // Landing checks, in the order #763 AC3 fixes: spec state before case state.
    const targetPlan = plans.get(pointer.slug);
    if (!targetPlan) {
      return unresolved("target spec not supplied", null, "not supplied", null);
    }

    const archived = specLifecycles?.get(pointer.slug);
    const targetCase = findCase(targetPlan, pointer.caseId);
    if (archived !== undefined) {
      // Fail closed whatever the target case's own state, and carry that state
      // in the payload so the preview can name both facts (#763 AC2, AC3).
      return unresolved(
        "target archived",
        targetCase ? caseStateOf(targetCase) : null,
        "archived",
        archived.supersededBy ?? null,
      );
    }

    if (!targetCase) {
      return unresolved("target missing", null, "live", null);
    }

    const targetState = caseStateOf(targetCase);
    if (targetState === "retired") {
      // Terminal: a retired case carries no pointer, so there is nothing to walk
      // onward to. Reserved for a retired case in a LIVE spec, which implies a
      // different repair from `target archived` (pick another case in this spec,
      // rather than leave the spec entirely).
      return unresolved("target not live", "retired", "live", null);
    }

    if (targetState === "live") {
      return {
        origin,
        originState,
        status: "resolved",
        chain,
        resolvedTo: pointer,
        reason: null,
        targetCaseState: "live",
        targetSpecState: "live",
        supersededBy: null,
      };
    }

    currentSlug = pointer.slug;
    currentCase = targetCase;
  }
}

function specStateOf(
  slug: string,
  plans: ReadonlyMap<string, ResolverPlan>,
  specLifecycles: ReadonlyMap<string, ResolverSpecLifecycle> | undefined,
): SpecState {
  if (!plans.has(slug)) return "not supplied";
  return specLifecycles?.get(slug) !== undefined ? "archived" : "live";
}

// Resolve every case in a plan, in the plan's own case order.
//
// The origin plan is added to the supplied map when the caller did not include
// it, so bare same-spec pointers resolve. The copy is local: `inputs.plans` is
// never mutated.
export function resolvePlan(plan: ResolverPlan, inputs: ResolverInputs): Resolution[] {
  let plans = inputs.plans;
  if (plans.get(plan.specSlug) !== plan) {
    const merged = new Map(plans);
    merged.set(plan.specSlug, plan);
    plans = merged;
  }
  const effective: ResolverInputs = { plans, specLifecycles: inputs.specLifecycles };
  return plan.cases.map((testCase) => resolveCase(plan.specSlug, testCase, effective));
}
