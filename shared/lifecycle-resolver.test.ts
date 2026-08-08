import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_SUPERSESSION_DEPTH,
  UNRESOLVED_REASONS,
  caseStateOf,
  collectReferencedSlugs,
  isCaseLive,
  isSpecLive,
  parseReplacementPointer,
  resolveCase,
  resolvePlan,
} from "./lifecycle-resolver.js";
import type {
  Resolution,
  ResolverCase,
  ResolverInputs,
  ResolverPlan,
  ResolverSpecLifecycle,
} from "./lifecycle-resolver.js";
import type { Case, TestCasesPlan } from "./testbench-contracts.js";

// ── Fixture corpus ──
//
// The shared corpus spike #763 asks for: one fixture per reason in the closed
// six-value vocabulary, plus both depth boundary rows, the cycle-over-depth
// precedence row, and the spec-state-before-case-state row.

function live(id: string): ResolverCase {
  return { id };
}

function retired(id: string, reason = "Superseded by policy change"): ResolverCase {
  return { id, lifecycle: { state: "retired", reason } };
}

function superseded(id: string, replacement: string): ResolverCase {
  return { id, lifecycle: { state: "superseded", replacement } };
}

function plan(specSlug: string, cases: ResolverCase[]): ResolverPlan {
  return { specSlug, cases };
}

function inputs(
  plans: ResolverPlan[],
  lifecycles: Record<string, ResolverSpecLifecycle> = {},
): ResolverInputs {
  return {
    plans: new Map(plans.map((p) => [p.specSlug, p])),
    specLifecycles: new Map(Object.entries(lifecycles)),
  };
}

function chainIds(resolution: Resolution): string[] {
  return resolution.chain.map((ref) => `${ref.slug}:${ref.caseId}`);
}

// A straight chain of `hops` supersessions off SATCA-TC-000. The final node is
// live when `endsLive`, and otherwise superseded at a further, un-followable id.
function chainPlan(hops: number, endsLive: boolean): ResolverPlan {
  const cases: ResolverCase[] = [];
  for (let i = 0; i < hops; i += 1) {
    cases.push(superseded(`SATCA-TC-${String(i).padStart(3, "0")}`, nodeId(i + 1)));
  }
  cases.push(endsLive ? live(nodeId(hops)) : superseded(nodeId(hops), nodeId(hops + 1)));
  if (!endsLive) cases.push(live(nodeId(hops + 1)));
  return plan("archival", cases);
}

function nodeId(index: number): string {
  return `SATCA-TC-${String(index).padStart(3, "0")}`;
}

describe("the live predicate", () => {
  it("treats an absent lifecycle block as live", () => {
    expect(isCaseLive(live("SATCA-TC-001"))).toBe(true);
    expect(caseStateOf(live("SATCA-TC-001"))).toBe("live");
  });

  it("treats retired and superseded as not live", () => {
    expect(isCaseLive(retired("SATCA-TC-001"))).toBe(false);
    expect(isCaseLive(superseded("SATCA-TC-001", "SATCA-TC-002"))).toBe(false);
    expect(caseStateOf(retired("SATCA-TC-001"))).toBe("retired");
    expect(caseStateOf(superseded("SATCA-TC-001", "SATCA-TC-002"))).toBe("superseded");
  });

  it("reads a bare lifecycle block as well as a case", () => {
    expect(caseStateOf({ state: "retired", reason: "done" })).toBe("retired");
    expect(caseStateOf(undefined)).toBe("live");
  });

  it("treats an absent spec lifecycle record as live (SATCA-FR-017)", () => {
    expect(isSpecLive(undefined)).toBe(true);
    expect(isSpecLive({ archived: true })).toBe(false);
  });
});

describe("the closed reason vocabulary", () => {
  it("has exactly six values and mints no seventh", () => {
    expect(UNRESOLVED_REASONS).toHaveLength(6);
    expect([...UNRESOLVED_REASONS].sort()).toEqual([
      "cycle detected",
      "depth exceeded",
      "target archived",
      "target missing",
      "target not live",
      "target spec not supplied",
    ]);
  });

  it("fixes the depth limit at ten hops with no configuration surface", () => {
    expect(MAX_SUPERSESSION_DEPTH).toBe(10);
  });
});

describe("parseReplacementPointer", () => {
  it("reads a bare pointer as the containing spec's own case", () => {
    expect(parseReplacementPointer("SATCA-TC-004", "archival")).toEqual({
      slug: "archival",
      caseId: "SATCA-TC-004",
    });
  });

  it("reads a slug-qualified pointer", () => {
    expect(parseReplacementPointer("other-spec:SATCA-TC-004", "archival")).toEqual({
      slug: "other-spec",
      caseId: "SATCA-TC-004",
    });
  });

  it("splits on the first colon only, since a slug can carry none", () => {
    expect(parseReplacementPointer("other-spec:A:B", "archival")).toEqual({
      slug: "other-spec",
      caseId: "A:B",
    });
  });

  it("does not mistake a real case id for a qualified pointer", () => {
    // Regression guard: ids in the committed corpus (SATCA-TC-024) carry no
    // colon, so a bare id can never be read as slug-qualified.
    expect(parseReplacementPointer("SATCA-TC-024", "spec-and-test-case-archival").slug).toBe(
      "spec-and-test-case-archival",
    );
  });
});

describe("collectReferencedSlugs", () => {
  it("reports the other specs a plan's pointers reach, distinct and ordered", () => {
    const p = plan("archival", [
      superseded("SATCA-TC-001", "beta:SATCA-TC-100"),
      superseded("SATCA-TC-002", "alpha:SATCA-TC-200"),
      superseded("SATCA-TC-003", "beta:SATCA-TC-101"),
      superseded("SATCA-TC-004", "SATCA-TC-005"),
      retired("SATCA-TC-005"),
      live("SATCA-TC-006"),
    ]);
    expect(collectReferencedSlugs(p)).toEqual(["beta", "alpha"]);
  });

  it("excludes the plan's own slug even when written out in full", () => {
    const p = plan("archival", [superseded("SATCA-TC-001", "archival:SATCA-TC-002")]);
    expect(collectReferencedSlugs(p)).toEqual([]);
  });

  it("returns an empty list for a plan with no supersessions", () => {
    expect(collectReferencedSlugs(plan("archival", [live("SATCA-TC-001")]))).toEqual([]);
  });
});

describe("resolveCase: resolving outcomes", () => {
  it("returns a live case as itself with nothing walked", () => {
    const p = plan("archival", [live("SATCA-TC-001")]);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.status).toBe("live");
    expect(r.resolvedTo).toEqual({ slug: "archival", caseId: "SATCA-TC-001" });
    expect(r.reason).toBeNull();
    expect(chainIds(r)).toEqual(["archival:SATCA-TC-001"]);
  });

  it("treats a retired origin as terminal rather than as a failure", () => {
    const p = plan("archival", [retired("SATCA-TC-001")]);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.status).toBe("retired");
    expect(r.resolvedTo).toBeNull();
    expect(r.reason).toBeNull();
  });

  // SATCA-TC-024
  it("walks a chain to the first live case and reports the chain walked", () => {
    const p = plan("archival", [
      superseded("SATCA-TC-001", "SATCA-TC-002"),
      superseded("SATCA-TC-002", "SATCA-TC-003"),
      live("SATCA-TC-003"),
    ]);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.status).toBe("resolved");
    expect(r.originState).toBe("superseded");
    expect(r.resolvedTo).toEqual({ slug: "archival", caseId: "SATCA-TC-003" });
    expect(r.targetCaseState).toBe("live");
    expect(r.targetSpecState).toBe("live");
    expect(chainIds(r)).toEqual([
      "archival:SATCA-TC-001",
      "archival:SATCA-TC-002",
      "archival:SATCA-TC-003",
    ]);
  });

  it("crosses into a supplied live spec and keeps walking there", () => {
    const origin = plan("archival", [superseded("SATCA-TC-001", "beta:BT-TC-001")]);
    const beta = plan("beta", [superseded("BT-TC-001", "BT-TC-002"), live("BT-TC-002")]);
    const r = resolveCase("archival", origin.cases[0], inputs([origin, beta]));
    expect(r.status).toBe("resolved");
    expect(r.resolvedTo).toEqual({ slug: "beta", caseId: "BT-TC-002" });
    expect(chainIds(r)).toEqual(["archival:SATCA-TC-001", "beta:BT-TC-001", "beta:BT-TC-002"]);
  });
});

describe("resolveCase: the six unresolved reasons", () => {
  // SATCA-TC-027
  it("reports target missing for a pointer at a case in no supplied plan", () => {
    const p = plan("archival", [superseded("SATCA-TC-001", "SATCA-TC-404")]);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.status).toBe("unresolved");
    expect(r.reason).toBe("target missing");
    expect(r.resolvedTo).toBeNull();
    expect(r.targetCaseState).toBeNull();
    expect(r.targetSpecState).toBe("live");
  });

  it("reports target archived for a live case inside an archived spec", () => {
    const origin = plan("archival", [superseded("SATCA-TC-001", "beta:BT-TC-001")]);
    const beta = plan("beta", [live("BT-TC-001")]);
    const r = resolveCase(
      "archival",
      origin.cases[0],
      inputs([origin, beta], { beta: { archived: true, supersededBy: "gamma" } }),
    );
    expect(r.reason).toBe("target archived");
    expect(r.targetCaseState).toBe("live");
    expect(r.targetSpecState).toBe("archived");
    // Remedy hint only: a slug names no case, so it is never walked (#763 AC2).
    expect(r.supersededBy).toBe("gamma");
  });

  it("reports target not live for a retired case in a live spec", () => {
    const p = plan("archival", [
      superseded("SATCA-TC-001", "SATCA-TC-002"),
      retired("SATCA-TC-002"),
    ]);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.reason).toBe("target not live");
    expect(r.targetCaseState).toBe("retired");
    expect(r.targetSpecState).toBe("live");
  });

  // Spec state before case state: no seventh reason (#763 AC3, situation 3).
  it("reports target archived, not target not live, for a retired case in an archived spec", () => {
    const origin = plan("archival", [superseded("SATCA-TC-001", "beta:BT-TC-001")]);
    const beta = plan("beta", [retired("BT-TC-001")]);
    const r = resolveCase(
      "archival",
      origin.cases[0],
      inputs([origin, beta], { beta: { archived: true } }),
    );
    expect(r.reason).toBe("target archived");
    // Both facts survive in the payload, so a preview can name them precisely.
    expect(r.targetCaseState).toBe("retired");
    expect(r.targetSpecState).toBe("archived");
    expect(r.supersededBy).toBeNull();
  });

  it("reports target archived even when the case id does not exist there", () => {
    const origin = plan("archival", [superseded("SATCA-TC-001", "beta:BT-TC-404")]);
    const beta = plan("beta", [live("BT-TC-001")]);
    const r = resolveCase(
      "archival",
      origin.cases[0],
      inputs([origin, beta], { beta: { archived: true } }),
    );
    expect(r.reason).toBe("target archived");
    expect(r.targetCaseState).toBeNull();
  });

  // SATCA-TC-025
  it("reports cycle detected and terminates rather than looping", () => {
    const p = plan("archival", [
      superseded("SATCA-TC-001", "SATCA-TC-002"),
      superseded("SATCA-TC-002", "SATCA-TC-001"),
    ]);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.status).toBe("unresolved");
    expect(r.reason).toBe("cycle detected");
    expect(r.resolvedTo).toBeNull();
    // The visited-set is seeded with the origin, so the loop closing on the head
    // is a cycle rather than a re-walk, and the repeated node is shown.
    expect(chainIds(r)).toEqual([
      "archival:SATCA-TC-001",
      "archival:SATCA-TC-002",
      "archival:SATCA-TC-001",
    ]);
  });

  it("detects a self-pointer as a cycle", () => {
    const p = plan("archival", [superseded("SATCA-TC-001", "SATCA-TC-001")]);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.reason).toBe("cycle detected");
  });

  // SATCA-TC-030
  it("distinguishes a spec the caller did not supply from a missing target", () => {
    const origin = plan("archival", [superseded("SATCA-TC-001", "beta:BT-TC-001")]);
    const r = resolveCase("archival", origin.cases[0], inputs([origin]));
    expect(r.reason).toBe("target spec not supplied");
    expect(r.targetSpecState).toBe("not supplied");
    expect(r.targetCaseState).toBeNull();
    // Same pointer, spec supplied: a different reason entirely.
    const beta = plan("beta", [live("BT-TC-999")]);
    expect(resolveCase("archival", origin.cases[0], inputs([origin, beta])).reason).toBe(
      "target missing",
    );
  });
});

describe("resolveCase: the depth boundary", () => {
  // SATCA-TC-026, lower boundary row.
  it("resolves a chain that reaches a live case on the last permitted hop", () => {
    const p = chainPlan(MAX_SUPERSESSION_DEPTH, true);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.status).toBe("resolved");
    expect(r.reason).toBeNull();
    expect(r.resolvedTo).toEqual({ slug: "archival", caseId: nodeId(MAX_SUPERSESSION_DEPTH) });
    // Origin plus ten landings: depth counts hops followed, not nodes visited.
    expect(r.chain).toHaveLength(MAX_SUPERSESSION_DEPTH + 1);
  });

  // SATCA-TC-026, upper boundary row.
  it("reports depth exceeded for a landing still superseded at the limit", () => {
    const p = chainPlan(MAX_SUPERSESSION_DEPTH, false);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.status).toBe("unresolved");
    expect(r.reason).toBe("depth exceeded");
    expect(r.resolvedTo).toBeNull();
    expect(r.targetCaseState).toBe("superseded");
    expect(r.chain).toHaveLength(MAX_SUPERSESSION_DEPTH + 1);
  });

  it("gives cycle detected precedence over depth exceeded", () => {
    // A chain whose landing at the limit points back at the visited origin:
    // both guards could fire, and the cycle wins (#763 AC1).
    const cases: ResolverCase[] = [];
    for (let i = 0; i < MAX_SUPERSESSION_DEPTH; i += 1) {
      cases.push(superseded(nodeId(i), nodeId(i + 1)));
    }
    cases.push(superseded(nodeId(MAX_SUPERSESSION_DEPTH), nodeId(0)));
    const p = plan("archival", cases);
    const r = resolveCase("archival", p.cases[0], inputs([p]));
    expect(r.reason).toBe("cycle detected");
  });
});

describe("resolvePlan", () => {
  it("resolves every case in the plan's own order", () => {
    const p = plan("archival", [
      superseded("SATCA-TC-001", "SATCA-TC-003"),
      retired("SATCA-TC-002"),
      live("SATCA-TC-003"),
      superseded("SATCA-TC-004", "SATCA-TC-404"),
    ]);
    const results = resolvePlan(p, { plans: new Map() });
    expect(results.map((r) => r.status)).toEqual(["resolved", "retired", "live", "unresolved"]);
    expect(results[3].reason).toBe("target missing");
  });

  it("does not mutate the caller's plan map when it adds the origin plan", () => {
    const supplied = new Map<string, ResolverPlan>();
    const p = plan("archival", [superseded("SATCA-TC-001", "SATCA-TC-002"), live("SATCA-TC-002")]);
    resolvePlan(p, { plans: supplied });
    expect(supplied.size).toBe(0);
  });
});

// SATCA-TC-032
describe("purity: the module performs no input or output of its own", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./lifecycle-resolver.ts", import.meta.url)),
    "utf8",
  );

  it("imports nothing at all, so it can reach no filesystem", () => {
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/^\s*export\s[^;]*\bfrom\b/m);
  });

  it("reads no clock, no randomness, and no ambient process state", () => {
    for (const forbidden of ["require(", "process.", "Date.now", "Math.random", "globalThis"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("resolves cross-spec pointers only from what the caller supplied", () => {
    const origin = plan("archival", [superseded("SATCA-TC-001", "beta:BT-TC-001")]);
    const beta = plan("beta", [live("BT-TC-001")]);
    // The only difference between these two runs is the caller's input map.
    expect(resolveCase("archival", origin.cases[0], inputs([origin])).reason).toBe(
      "target spec not supplied",
    );
    expect(resolveCase("archival", origin.cases[0], inputs([origin, beta])).status).toBe(
      "resolved",
    );
  });
});

// SATCA-TC-034
describe("determinism", () => {
  it("produces deeply equal output for identical inputs and mutates neither", () => {
    const build = () => {
      const origin = plan("archival", [
        superseded("SATCA-TC-001", "beta:BT-TC-001"),
        superseded("SATCA-TC-002", "SATCA-TC-003"),
        retired("SATCA-TC-003"),
        live("SATCA-TC-004"),
      ]);
      const beta = plan("beta", [superseded("BT-TC-001", "BT-TC-002"), live("BT-TC-002")]);
      const gamma = plan("gamma", [live("GM-TC-001")]);
      return inputs([origin, beta, gamma], { gamma: { archived: true, supersededBy: "beta" } });
    };

    const first = build();
    const firstSnapshot = structuredClone({
      plans: [...first.plans.entries()],
      lifecycles: [...(first.specLifecycles ?? new Map()).entries()],
    });

    const originPlan = first.plans.get("archival") as ResolverPlan;
    const runA = resolvePlan(originPlan, first);
    const runB = resolvePlan(originPlan, first);
    expect(runA).toEqual(runB);

    // ... and equal again over a freshly constructed, structurally identical set
    // of inputs, so nothing carries over between runs.
    const second = build();
    expect(resolvePlan(second.plans.get("archival") as ResolverPlan, second)).toEqual(runA);

    expect({
      plans: [...first.plans.entries()],
      lifecycles: [...(first.specLifecycles ?? new Map()).entries()],
    }).toEqual(firstSnapshot);
  });
});

describe("contract compatibility", () => {
  it("accepts the zod-inferred contract shapes structurally", () => {
    // Type-level assertion: the resolver's minimal inputs are satisfied by the
    // canonical testbench-contracts types, so server and client can both pass
    // what they already parse without a conversion layer. Erased at runtime.
    const contractCase: Case = {
      id: "SATCA-TC-001",
      title: "A case",
      area: "verify-gate",
      level: 2,
      type: "functional",
      steps: [],
      tags: [],
      linked_requirement_ids: ["SATCA-FR-009"],
      linked_user_story_ids: [],
      lifecycle: { state: "superseded", replacement: "SATCA-TC-002" },
    };
    const contractPlan: TestCasesPlan = {
      $schema: "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json",
      schemaVersion: "1.2.0",
      specSlug: "archival",
      cases: [contractCase, { ...contractCase, id: "SATCA-TC-002", lifecycle: undefined }],
    };
    const asResolverPlan: ResolverPlan = contractPlan;
    const results = resolvePlan(asResolverPlan, { plans: new Map() });
    expect(results[0].status).toBe("resolved");
    expect(results[0].resolvedTo).toEqual({ slug: "archival", caseId: "SATCA-TC-002" });
  });
});

// ── The shared fixture corpus ──
//
// `lifecycle-pointer-fixtures.json` beside this file is a BYTE-IDENTICAL copy of
// the corpus in `int3nt/ai-agent-marketplace`
// (`plugins/product-dev/references/`), whose `scripts/lifecycle_pointers.py`
// transcribes this module's pointer grammar. The two cannot import each other
// across the repository boundary, so the corpus is what keeps the transcription
// honest: a grammar change here fails this block, which is the signal to land
// the same bytes on the other side.
//
// SHARED is the grammar and only the grammar. Each fixture's `expected` block is
// the split, and both runners assert it. Its `marketplace_only` block is that
// plugin's link-checking outcome (does the pointer address an existing case),
// which is NOT the question this module answers (does a gate obligation
// transfer), so it is deliberately unread here. Asserting it would quietly give
// this module the plugin's semantics: the two genuinely disagree on a pointer
// into an archived spec, which the plugin resolves and `resolveCase` fails
// closed as `target archived`.
//
// The corpus is data. It is copied, never edited here: a new fixture lands as
// identical bytes in both repositories in one change, with `version` bumped.
// Contract: `plugins/product-dev/references/lifecycle-pointer-fixtures.md`
// there. On a grammar disagreement this module wins and the transcription is the
// stale side.
interface CorpusFixture {
  name: string;
  pointer: string;
  owning_slug: string;
  expected: { slug: string; case_id: string };
}

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./lifecycle-pointer-fixtures.json", import.meta.url)),
    "utf8",
  ),
) as { version: string; fixtures: CorpusFixture[] };

describe("the shared fixture corpus", () => {
  it("carries fixtures with unique names", () => {
    expect(corpus.fixtures.length).toBeGreaterThan(0);
    expect(new Set(corpus.fixtures.map((f) => f.name)).size).toBe(corpus.fixtures.length);
  });

  it("agrees with parseReplacementPointer on every fixture, and runs every one", () => {
    let ran = 0;
    for (const fixture of corpus.fixtures) {
      expect(
        parseReplacementPointer(fixture.pointer, fixture.owning_slug),
        `${fixture.name}: parseReplacementPointer disagrees with the corpus`,
      ).toEqual({ slug: fixture.expected.slug, caseId: fixture.expected.case_id });
      ran += 1;
    }
    // The count assertion is the point: an entry can never be silently skipped
    // on this side of the copy.
    expect(ran).toBe(corpus.fixtures.length);
  });

  it("asks this repository for the grammar and nothing else", () => {
    // A resolution key inside `expected` is how the marketplace's link-checking
    // semantics would arrive here unnoticed, so the shape is pinned rather than
    // trusted.
    for (const fixture of corpus.fixtures) {
      expect(Object.keys(fixture.expected).sort(), fixture.name).toEqual(["case_id", "slug"]);
    }
  });
});
