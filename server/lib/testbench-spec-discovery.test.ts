import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverSpecs,
  resolveFocusedSpec,
  validateManualPath,
} from "./testbench-spec-discovery.js";
import { computePlanHash } from "./testbench-store.js";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type CaseStatus,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { UnsafePathError } from "./safe-path.js";

let repo: string;

function planFor(slug: string, caseIds: string[]): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug: slug,
    cases: caseIds.map((id) => ({
      id,
      title: `Case ${id}`,
      area: "test-area",
      level: 1,
      type: "functional",
      priority: "P0",
      steps: [
        {
          id: "S1",
          instruction: "do",
          observations: [{ id: "O1", expected: "ok" }],
        },
      ],
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
    })),
  };
}

function writeSpec(slug: string, plan: unknown): string {
  const dir = path.join(repo, ".specifications", slug);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "test-cases.json");
  fs.writeFileSync(target, typeof plan === "string" ? plan : JSON.stringify(plan, null, 2));
  return target;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "tb-discovery-"));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("discoverSpecs", () => {
  it("returns empty specs and invalid when there is no .specifications directory", () => {
    expect(discoverSpecs(repo)).toEqual({ specs: [], invalid: [] });
  });

  it("enumerates and validates valid specs, sorted by slug", () => {
    writeSpec("zebra", planFor("zebra", ["TC-001"]));
    writeSpec("alpha", planFor("alpha", ["TC-001", "TC-002"]));

    const { specs, invalid } = discoverSpecs(repo);
    expect(invalid).toEqual([]);
    expect(specs.map((s) => s.slug)).toEqual(["alpha", "zebra"]);
    expect(specs[0].caseCount).toBe(2);
    expect(specs[1].caseCount).toBe(1);
    expect(specs[0].path).toBe(path.join(repo, ".specifications", "alpha", "test-cases.json"));
  });

  it("skips folders with no test-cases.json (they are not specs, not invalid)", () => {
    fs.mkdirSync(path.join(repo, ".specifications", "empty"), { recursive: true });
    writeSpec("good", planFor("good", ["TC-001"]));
    const { specs, invalid } = discoverSpecs(repo);
    expect(specs.map((s) => s.slug)).toEqual(["good"]);
    expect(invalid).toEqual([]);
  });

  it("reports present-but-invalid specs (bad JSON, schema mismatch) with errors", () => {
    writeSpec("broken-json", "{not json");
    writeSpec("invalid-schema", { foo: "bar" });
    writeSpec("good", planFor("good", ["TC-001"]));

    const { specs, invalid } = discoverSpecs(repo);
    expect(specs.map((s) => s.slug)).toEqual(["good"]);
    // Both broken files are surfaced (sorted by slug), each with non-empty errors.
    expect(invalid.map((s) => s.slug)).toEqual(["broken-json", "invalid-schema"]);
    expect(invalid[0].errors).toEqual(["test-cases.json is not valid JSON"]);
    expect(invalid[1].errors.length).toBeGreaterThan(0);
    expect(invalid[1].path).toBe(
      path.join(repo, ".specifications", "invalid-schema", "test-cases.json"),
    );
  });

  // #427 (mirrors TC-052): when `.specifications` itself is a symlink escaping the
  // repo, the lexical resolveWithin still yields an in-repo-looking path, but the
  // realpath barrier before readdir rejects it, so the enumeration never resolves
  // outside repoPath (a spec dir sitting outside the repo is not surfaced).
  it("does not enumerate a symlinked .specifications root that escapes the repo (#427)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-discovery-outside-"));
    try {
      // A valid, contract-passing spec sits OUTSIDE the repo, reachable only by
      // following the symlinked `.specifications` root.
      const goodDir = path.join(outside, "good");
      fs.mkdirSync(goodDir);
      fs.writeFileSync(
        path.join(goodDir, "test-cases.json"),
        JSON.stringify(planFor("good", ["TC-001"]), null, 2),
      );
      fs.symlinkSync(outside, path.join(repo, ".specifications"), "dir");

      // The escaping root is not read: discovery is empty rather than surfacing the
      // outside spec.
      expect(discoverSpecs(repo)).toEqual({ specs: [], invalid: [] });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // #427: a real in-repo slug dir whose `test-cases.json` is a symlink escaping the
  // repo is skipped by the per-slug realpath barrier before the read, so the leaf
  // read never resolves outside repoPath.
  it("skips a spec whose test-cases.json is a symlink escaping the repo (#427)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-discovery-leaf-"));
    try {
      fs.writeFileSync(
        path.join(outside, "test-cases.json"),
        JSON.stringify(planFor("evil", ["TC-001"]), null, 2),
      );
      // A real slug dir, but its test-cases.json points outside the repo.
      const evilDir = path.join(repo, ".specifications", "evil");
      fs.mkdirSync(evilDir, { recursive: true });
      fs.symlinkSync(path.join(outside, "test-cases.json"), path.join(evilDir, "test-cases.json"));
      writeSpec("good", planFor("good", ["TC-001"]));

      const { specs, invalid } = discoverSpecs(repo);
      expect(specs.map((s) => s.slug)).toEqual(["good"]);
      expect(invalid).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("validateManualPath", () => {
  it("validates a valid in-repo path", () => {
    const target = writeSpec("testbench", planFor("testbench", ["TC-001", "TC-002"]));
    const result = validateManualPath(repo, target);
    expect(result).toEqual({ ok: true, slug: "testbench", caseCount: 2 });
  });

  it("accepts a repo-relative path", () => {
    writeSpec("testbench", planFor("testbench", ["TC-001"]));
    const result = validateManualPath(repo, ".specifications/testbench/test-cases.json");
    expect(result.ok).toBe(true);
  });

  it("rejects a path that escapes the repo", () => {
    const result = validateManualPath(repo, "/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/escapes/);
  });

  it("rejects a path not shaped like a spec path", () => {
    fs.writeFileSync(path.join(repo, "test-cases.json"), "{}");
    const result = validateManualPath(repo, path.join(repo, "test-cases.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/\.specifications/);
  });

  it("rejects an empty path", () => {
    const result = validateManualPath(repo, "   ");
    expect(result.ok).toBe(false);
  });

  it("reports schema validation errors", () => {
    writeSpec("bad", { $schema: "x", schemaVersion: "1.0.0", specSlug: "bad" });
    const result = validateManualPath(repo, ".specifications/bad/test-cases.json");
    expect(result.ok).toBe(false);
  });

  // #427: a valid-slug spec dir that is a symlink escaping the repo is rejected by
  // the realpath barrier before the file is read, so a plan outside the repo is
  // never validated as an in-repo manual path.
  it("rejects a symlinked spec path that escapes the repo (#427)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-manualpath-outside-"));
    try {
      fs.writeFileSync(
        path.join(outside, "test-cases.json"),
        JSON.stringify(planFor("evil-link", ["TC-001"]), null, 2),
      );
      fs.mkdirSync(path.join(repo, ".specifications"), { recursive: true });
      fs.symlinkSync(outside, path.join(repo, ".specifications", "evil-link"), "dir");

      const result = validateManualPath(repo, ".specifications/evil-link/test-cases.json");
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveFocusedSpec", () => {
  it("derives the slug from a valid focused path", () => {
    const target = path.join(repo, ".specifications", "feat-x", "test-cases.json");
    const { slug, resolvedPath } = resolveFocusedSpec(repo, target);
    expect(slug).toBe("feat-x");
    expect(resolvedPath).toBe(path.resolve(target));
  });

  it("throws when the path escapes the repo", () => {
    expect(() => resolveFocusedSpec(repo, "/etc/passwd")).toThrow(UnsafePathError);
  });

  it("throws when the path is not a spec path", () => {
    expect(() => resolveFocusedSpec(repo, path.join(repo, "foo.json"))).toThrow(UnsafePathError);
  });

  it("throws on an empty path", () => {
    expect(() => resolveFocusedSpec(repo, "")).toThrow(UnsafePathError);
  });

  // #427: a valid-slug spec dir that is a symlink escaping the repo is rejected by
  // the realpath barrier, so a focused path that resolves outside repoPath through
  // a symlink is refused fail-closed rather than accepted.
  it("throws for a symlinked spec path that escapes the repo (#427)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-focused-outside-"));
    try {
      fs.writeFileSync(
        path.join(outside, "test-cases.json"),
        JSON.stringify(planFor("evil-link", ["TC-001"]), null, 2),
      );
      fs.mkdirSync(path.join(repo, ".specifications"), { recursive: true });
      fs.symlinkSync(outside, path.join(repo, ".specifications", "evil-link"), "dir");

      expect(() => resolveFocusedSpec(repo, ".specifications/evil-link/test-cases.json")).toThrow(
        UnsafePathError,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── Per-spec verification aggregation (#482, TSPF-FR-001/FR-002) ──

const TEST_AUTHOR = { name: "Tester", email: "tester@example.com" };
const FIXED_TS = "2026-01-01T00:00:00.000Z";

// Build a minimal CaseResult body: derivedStatus plus an optional statusOverride.
function caseResult(derivedStatus: CaseStatus, override?: CaseStatus): Record<string, unknown> {
  const cr: Record<string, unknown> = {
    observationMarks: {},
    derivedStatus,
    notes: [],
  };
  if (override !== undefined) {
    cr.statusOverride = { status: override, author: TEST_AUTHOR, timestamp: FIXED_TS };
  }
  return cr;
}

// Write a test-results.json sidecar next to a spec's test-cases.json. When
// planHash is omitted it is computed from `plan` so the sidecar hash-matches; pass
// an explicit string to simulate a stale hash.
function writeResults(
  slug: string,
  plan: TestCasesPlan,
  caseResults: Record<string, unknown>,
  planHash?: string,
): string {
  const dir = path.join(repo, ".specifications", slug);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "test-results.json");
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        $schema: TEST_RESULTS_SCHEMA_ID,
        schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
        planHash: planHash ?? computePlanHash(plan),
        caseResults,
        updatedAt: FIXED_TS,
      },
      null,
      2,
    ),
  );
  return target;
}

describe("discoverSpecs verification aggregation (#482)", () => {
  it("carries a verification object on every spec; statusCounts sums to caseCount", () => {
    const plan = planFor("feat", ["TC-001", "TC-002"]);
    writeSpec("feat", plan);

    const { specs } = discoverSpecs(repo);
    expect(specs).toHaveLength(1);
    const v = specs[0].verification;
    // No sidecar yet: every case counts not_started, needs-attention, fail-open flags off.
    expect(v.classification).toBe("needs-attention");
    expect(v.resultsPresent).toBe(false);
    expect(v.resultsValid).toBe(false);
    expect(v.planHashMatch).toBe(false);
    expect(v.aggregationError).toBe(false);
    expect(v.statusCounts).toEqual({
      not_started: 2,
      in_progress: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
    });
    const sum = Object.values(v.statusCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(specs[0].caseCount);
  });

  it("classifies all-passed when a valid hash-matching sidecar has every case passed", () => {
    const plan = planFor("feat", ["TC-001", "TC-002"]);
    writeSpec("feat", plan);
    writeResults("feat", plan, {
      "TC-001": caseResult("passed"),
      "TC-002": caseResult("passed"),
    });

    const v = discoverSpecs(repo).specs[0].verification;
    expect(v.classification).toBe("all-passed");
    expect(v.resultsPresent).toBe(true);
    expect(v.resultsValid).toBe(true);
    expect(v.planHashMatch).toBe(true);
    expect(v.recoveryReason).toBeNull();
    expect(v.statusCounts.passed).toBe(2);
  });

  it("honours statusOverride over derivedStatus for effective status", () => {
    const plan = planFor("feat", ["TC-001"]);
    writeSpec("feat", plan);
    // derivedStatus is failed, but the override says passed: the override wins.
    writeResults("feat", plan, { "TC-001": caseResult("failed", "passed") });

    const v = discoverSpecs(repo).specs[0].verification;
    expect(v.statusCounts.passed).toBe(1);
    expect(v.statusCounts.failed).toBe(0);
    expect(v.classification).toBe("all-passed");
  });

  it("counts a plan case absent from caseResults as not_started", () => {
    const plan = planFor("feat", ["TC-001", "TC-002"]);
    writeSpec("feat", plan);
    // Only TC-001 has a recorded result; TC-002 is absent from the sidecar.
    writeResults("feat", plan, { "TC-001": caseResult("passed") });

    const v = discoverSpecs(repo).specs[0].verification;
    expect(v.statusCounts).toEqual({
      not_started: 1,
      in_progress: 0,
      passed: 1,
      failed: 0,
      blocked: 0,
    });
    expect(v.classification).toBe("needs-attention");
  });

  it("ignores caseResults entries for cases no longer in the plan", () => {
    const plan = planFor("feat", ["TC-001"]);
    writeSpec("feat", plan);
    // An orphaned TC-999 result (failed) must not enter the tally nor the sum.
    writeResults("feat", plan, {
      "TC-001": caseResult("passed"),
      "TC-999": caseResult("failed"),
    });

    const { specs } = discoverSpecs(repo);
    const v = specs[0].verification;
    expect(v.statusCounts.passed).toBe(1);
    expect(v.statusCounts.failed).toBe(0);
    const sum = Object.values(v.statusCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(specs[0].caseCount);
    expect(v.classification).toBe("all-passed");
  });

  it("classifies needs-attention when the recorded planHash is stale", () => {
    const plan = planFor("feat", ["TC-001"]);
    writeSpec("feat", plan);
    // Every case passed, but the recorded planHash does not match the current plan.
    writeResults("feat", plan, { "TC-001": caseResult("passed") }, "stale-hash-deadbeef");

    const v = discoverSpecs(repo).specs[0].verification;
    expect(v.resultsPresent).toBe(true);
    expect(v.resultsValid).toBe(true);
    expect(v.planHashMatch).toBe(false);
    expect(v.classification).toBe("needs-attention");
  });

  it("fails open on a malformed results file: resultsValid false, needs-attention, spec still listed", () => {
    const plan = planFor("feat", ["TC-001", "TC-002"]);
    writeSpec("feat", plan);
    fs.writeFileSync(
      path.join(repo, ".specifications", "feat", "test-results.json"),
      "{ this is not valid json",
    );

    const { specs } = discoverSpecs(repo);
    expect(specs.map((s) => s.slug)).toEqual(["feat"]);
    const v = specs[0].verification;
    // A sidecar exists on disk (present) but does not parse (invalid); fail-open,
    // not an aggregation throw.
    expect(v.resultsPresent).toBe(true);
    expect(v.resultsValid).toBe(false);
    expect(v.planHashMatch).toBe(false);
    expect(v.aggregationError).toBe(false);
    expect(v.recoveryReason).toBe("corrupt-json");
    expect(v.classification).toBe("needs-attention");
    // With no readable file every plan case defaults to not_started (sum preserved).
    expect(v.statusCounts.not_started).toBe(2);
  });

  it("treats a zero-case plan as all-passed only under a valid hash-matching sidecar", () => {
    const plan = planFor("empty", []);
    writeSpec("empty", plan);
    // Matching-hash, empty results: vacuously all-passed.
    writeResults("empty", plan, {});

    const spec = discoverSpecs(repo).specs[0];
    expect(spec.caseCount).toBe(0);
    const v = spec.verification;
    expect(v.classification).toBe("all-passed");
    expect(v.statusCounts).toEqual({
      not_started: 0,
      in_progress: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
    });
  });

  it("does not treat a zero-case plan with no sidecar as all-passed", () => {
    writeSpec("empty", planFor("empty", []));

    const v = discoverSpecs(repo).specs[0].verification;
    expect(v.resultsPresent).toBe(false);
    expect(v.classification).toBe("needs-attention");
  });

  // TSPF-FR-002 mandatory symlink-escape fixture: a sidecar symlinked outside the
  // repo makes the store's path-safety assertion throw; the per-spec catch degrades
  // ONLY that spec (aggregationError true, needs-attention) while the endpoint still
  // lists every spec.
  it("degrades only the spec whose results sidecar symlinks outside the repo (#482)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-verify-escape-"));
    try {
      const evilPlan = planFor("evil", ["TC-001"]);
      writeSpec("evil", evilPlan);
      // A well-formed results file living OUTSIDE the repo, reachable only via the
      // symlinked sidecar.
      fs.writeFileSync(
        path.join(outside, "test-results.json"),
        JSON.stringify(
          {
            $schema: TEST_RESULTS_SCHEMA_ID,
            schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
            planHash: computePlanHash(evilPlan),
            caseResults: { "TC-001": caseResult("passed") },
            updatedAt: FIXED_TS,
          },
          null,
          2,
        ),
      );
      fs.symlinkSync(
        path.join(outside, "test-results.json"),
        path.join(repo, ".specifications", "evil", "test-results.json"),
      );

      // A healthy neighbour spec aggregates normally.
      const goodPlan = planFor("good", ["TC-001"]);
      writeSpec("good", goodPlan);
      writeResults("good", goodPlan, { "TC-001": caseResult("passed") });

      const { specs } = discoverSpecs(repo);
      // The endpoint returns every spec (no omission, no throw), sorted by slug.
      expect(specs.map((s) => s.slug)).toEqual(["evil", "good"]);

      const evil = specs[0].verification;
      expect(evil.aggregationError).toBe(true);
      expect(evil.classification).toBe("needs-attention");
      expect(evil.resultsPresent).toBe(false);
      expect(evil.resultsValid).toBe(false);
      expect(evil.planHashMatch).toBe(false);
      expect(evil.recoveryReason).toBeNull();
      // Safe-default tally still sums to caseCount.
      expect(evil.statusCounts.not_started).toBe(1);

      const good = specs[1].verification;
      expect(good.aggregationError).toBe(false);
      expect(good.classification).toBe("all-passed");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("performs zero writes: no sidecar is created and an existing one is untouched", () => {
    const noResultsPlan = planFor("no-results", ["TC-001"]);
    writeSpec("no-results", noResultsPlan);

    const withResultsPlan = planFor("with-results", ["TC-001"]);
    writeSpec("with-results", withResultsPlan);
    const resultsPath = writeResults("with-results", withResultsPlan, {
      "TC-001": caseResult("passed"),
    });
    const before = fs.readFileSync(resultsPath);

    discoverSpecs(repo);

    // Discovery created no sidecar for the spec that lacked one.
    expect(
      fs.existsSync(path.join(repo, ".specifications", "no-results", "test-results.json")),
    ).toBe(false);
    // And left the existing sidecar byte-identical.
    expect(fs.readFileSync(resultsPath).equals(before)).toBe(true);
  });
});
