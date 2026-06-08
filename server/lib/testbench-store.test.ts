import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPlanAndResults,
  markObservation,
  appendNote,
  setStatusOverride,
  reconcile,
  computePlanHash,
  MissingPlanError,
  UnsafePathError,
} from "./testbench-store.js";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  TEST_RESULTS_SCHEMA_ID,
  type TestCasesPlan,
  type TestResultsFile,
} from "@roubo/shared/testbench-contracts";
import * as gitHelpers from "../services/git-helpers.js";

// Mock the git identity resolver so author/sentinel stamping is deterministic and
// no real git command runs (also keeps tests fast and offline).
vi.mock("../services/git-helpers.js", () => ({
  resolveGitIdentity: vi.fn(),
}));

const REAL_IDENTITY = { name: "Ada Lovelace", email: "ada@example.com" };
const SENTINEL_IDENTITY = {
  name: "Unknown Author",
  email: "unknown@roubo.local",
  isSentinel: true as const,
};

let repo: string;
const SLUG = "testbench";

function planFor(): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug: SLUG,
    cases: [
      {
        id: "TC-001",
        title: "Login works",
        area: "auth",
        level: 1,
        type: "e2e_flow",
        priority: "P0",
        steps: [
          {
            id: "S1",
            instruction: "Open login",
            observations: [
              { id: "O1", expected: "Form shown" },
              { id: "O2", expected: "Fields focusable" },
            ],
          },
        ],
        tags: ["smoke"],
        linked_requirement_ids: ["FR-001"],
        linked_user_story_ids: [],
      },
    ],
  };
}

function writePlan(plan: TestCasesPlan): void {
  const dir = path.join(repo, ".specifications", SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test-cases.json"), JSON.stringify(plan, null, 2));
}

function planBytes(): Buffer {
  return fs.readFileSync(path.join(repo, ".specifications", SLUG, "test-cases.json"));
}

function resultsFilePath(): string {
  return path.join(repo, ".specifications", SLUG, "test-results.json");
}

function writeRawResults(content: string): void {
  fs.writeFileSync(resultsFilePath(), content);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-store-"));
  vi.mocked(gitHelpers.resolveGitIdentity).mockResolvedValue(REAL_IDENTITY);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("readPlanAndResults", () => {
  // #493: one results file per worktree, case results at the top level (no
  // per-bench keying). The plan + results both resolve under the worktree root.
  it("reads the plan and the worktree's top-level results", async () => {
    writePlan(planFor());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    const view = readPlanAndResults(repo, SLUG);
    expect(view.plan.cases[0].id).toBe("TC-001");
    expect(view.results).not.toBeNull();
    expect(view.results?.caseResults["TC-001"].observationMarks.O1.result).toBe("pass");

    // The sidecar is a sibling of test-cases.json under the same spec folder.
    expect(fs.existsSync(resultsFilePath())).toBe(true);
  });

  // #493: case results live at the top level of the file, not nested under a
  // `benches` map.
  it("writes case results at the top level of the file (no benches map)", async () => {
    writePlan(planFor());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    const file = JSON.parse(fs.readFileSync(resultsFilePath(), "utf8"));
    expect(file.benches).toBeUndefined();
    expect(file.caseResults["TC-001"].observationMarks.O1.result).toBe("pass");
    expect(typeof file.updatedAt).toBe("string");
  });

  // The plan is required: a missing/invalid plan throws (NOT fail-open).
  it("throws MissingPlanError when the plan is absent", () => {
    expect(() => readPlanAndResults(repo, SLUG)).toThrow(MissingPlanError);
  });

  it("throws MissingPlanError when the plan is not valid JSON", () => {
    const dir = path.join(repo, ".specifications", SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "test-cases.json"), "{ not json");
    expect(() => readPlanAndResults(repo, SLUG)).toThrow(MissingPlanError);
  });

  it("throws MissingPlanError when the plan fails schema validation", () => {
    const dir = path.join(repo, ".specifications", SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "test-cases.json"), JSON.stringify({ cases: "nope" }));
    expect(() => readPlanAndResults(repo, SLUG)).toThrow(MissingPlanError);
  });

  // TC-046/047: results read returns null with recovered:true when no sidecar.
  it("returns null results with recovered:true when no sidecar exists", () => {
    writePlan(planFor());
    const view = readPlanAndResults(repo, SLUG);
    expect(view.results).toBeNull();
    expect(view.recovered).toBe(true);
    expect(view.stale).toBe(false);
    expect(view.planHash).toBe(computePlanHash(planFor()));
  });

  // TC-048 (AC3): a corrupt sidecar fails open (recovered:true), never throws.
  it("fails open on a corrupt (non-JSON) sidecar", () => {
    writePlan(planFor());
    writeRawResults("{ totally broken");
    const view = readPlanAndResults(repo, SLUG);
    expect(view.results).toBeNull();
    expect(view.recovered).toBe(true);
  });

  // AC3: a schema-invalid sidecar fails open.
  it("fails open on a schema-invalid sidecar", () => {
    writePlan(planFor());
    writeRawResults(JSON.stringify({ caseResults: "not-a-record" }));
    const view = readPlanAndResults(repo, SLUG);
    expect(view.results).toBeNull();
    expect(view.recovered).toBe(true);
  });

  // AC3: a legacy v1 file (per-bench `benches` map, no top-level caseResults)
  // fails open: the strict v2 contract rejects it, so the loader treats it as a
  // clean slate rather than a lossy round-trip.
  it("fails open on a legacy per-bench (v1) sidecar", () => {
    writePlan(planFor());
    writeRawResults(
      JSON.stringify({
        $schema: TEST_RESULTS_SCHEMA_ID,
        schemaVersion: "1.0.0",
        planHash: "x",
        benches: {},
      }),
    );
    const view = readPlanAndResults(repo, SLUG);
    expect(view.results).toBeNull();
    expect(view.recovered).toBe(true);
  });

  // AC3: a future MAJOR schema version fails open (never a lossy round-trip).
  it("fails open on a future-major-version sidecar", () => {
    writePlan(planFor());
    const future: TestResultsFile = {
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: "99.0.0",
      planHash: "x",
      caseResults: {},
      updatedAt: new Date().toISOString(),
    };
    writeRawResults(JSON.stringify(future));
    const view = readPlanAndResults(repo, SLUG);
    expect(view.results).toBeNull();
    expect(view.recovered).toBe(true);
  });

  // FR-016: the staleness hash flips when the plan changes after results exist.
  it("flags stale when the plan changes after results were written", async () => {
    writePlan(planFor());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    const fresh = readPlanAndResults(repo, SLUG);
    expect(fresh.stale).toBe(false);

    // Mutate the plan's testable body: the stored planHash no longer matches.
    const changed = planFor();
    changed.cases[0].steps[0].observations[0].expected = "Form shown differently";
    writePlan(changed);

    const after = readPlanAndResults(repo, SLUG);
    expect(after.stale).toBe(true);
    expect(after.planHash).toBe(computePlanHash(changed));
  });
});

describe("path safety (NFR-001)", () => {
  // TC-051: traversal slugs are rejected before any fs call.
  it("rejects traversal and dot slugs", () => {
    for (const bad of ["../../etc/evil", "..", ".", "../outside"]) {
      expect(() => readPlanAndResults(repo, bad)).toThrow(UnsafePathError);
    }
  });

  // TC-052: a slug carrying a separator that escapes the repo is rejected.
  it("rejects a slug with a path separator", () => {
    expect(() => readPlanAndResults(repo, "a/b")).toThrow(UnsafePathError);
  });

  // Writers reject too, before any fs mutation.
  it("rejects an unsafe slug on write paths", async () => {
    await expect(markObservation(repo, "../evil", "TC-001", "O1", "pass")).rejects.toThrow(
      UnsafePathError,
    );
    await expect(appendNote(repo, "../evil", "TC-001", "hi")).rejects.toThrow(UnsafePathError);
  });
});

describe("prototype pollution (CWE-1321)", () => {
  // caseId is user-controlled and used as a computed object key
  // (file.caseResults[caseId]). A crafted "__proto__"/"constructor"/"prototype"
  // id must be rejected before any lookup so it can never mutate Object.prototype.
  beforeEach(() => {
    writePlan(planFor());
  });

  it("rejects a prototype-polluting caseId on write paths", async () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      await expect(markObservation(repo, SLUG, bad, "O1", "pass")).rejects.toThrow(UnsafePathError);
      await expect(setStatusOverride(repo, SLUG, bad, "blocked")).rejects.toThrow(UnsafePathError);
      await expect(appendNote(repo, SLUG, bad, "hi")).rejects.toThrow(UnsafePathError);
    }
  });

  it("leaves Object.prototype unpolluted after a rejected write", async () => {
    await expect(markObservation(repo, SLUG, "__proto__", "O1", "pass")).rejects.toThrow(
      UnsafePathError,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("markObservation", () => {
  beforeEach(() => writePlan(planFor()));

  // TC-040: derivedStatus advances as observations are marked.
  it("upserts a mark and recomputes derivedStatus", async () => {
    let result = await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(result.derivedStatus).toBe("in_progress");

    result = await markObservation(repo, SLUG, "TC-001", "O2", "pass");
    expect(result.derivedStatus).toBe("passed");

    // A fail flips it.
    result = await markObservation(repo, SLUG, "TC-001", "O2", "fail");
    expect(result.derivedStatus).toBe("failed");
  });

  // AC5/FR-012: the resolved git identity is stamped on the mark.
  it("stamps the resolved git identity on the mark", async () => {
    const result = await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(result.observationMarks.O1.author).toEqual(REAL_IDENTITY);
    expect(result.observationMarks.O1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // TC-053 (AC5): the sentinel author is used when git identity is unset.
  it("falls back to the sentinel author when git identity is unset", async () => {
    vi.mocked(gitHelpers.resolveGitIdentity).mockResolvedValue(SENTINEL_IDENTITY);
    const result = await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(result.observationMarks.O1.author).toEqual(SENTINEL_IDENTITY);
    expect(result.observationMarks.O1.author.isSentinel).toBe(true);
  });

  // TC-050 (AC3): the atomic write leaves no .tmp behind.
  it("writes atomically and leaves no .tmp sibling", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    const dir = path.join(repo, ".specifications", SLUG);
    const entries = fs.readdirSync(dir).sort();
    expect(entries).toEqual(["test-cases.json", "test-results.json"]);
    expect(fs.existsSync(path.join(dir, "test-results.json.tmp"))).toBe(false);
  });

  // AC4: the source test-cases.json is byte-identical after a write.
  it("never mutates the source plan (byte-identical after write)", async () => {
    const before = planBytes();
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await markObservation(repo, SLUG, "TC-001", "O2", "fail");
    expect(planBytes().equals(before)).toBe(true);
  });

  // A recovered (corrupt) sidecar is replaced cleanly on the next write.
  it("recovers from a corrupt sidecar by reinitialising on write", async () => {
    writeRawResults("{ broken");
    const result = await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(result.observationMarks.O1.result).toBe("pass");
    // The file is now valid and readable.
    const view = readPlanAndResults(repo, SLUG);
    expect(view.recovered).toBe(false);
  });
});

describe("appendNote", () => {
  beforeEach(() => writePlan(planFor()));

  it("appends an immutable note stamped with author, timestamp, and statusAtWrite", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    const note = await appendNote(repo, SLUG, "TC-001", "  Looks good  ");
    expect(note.text).toBe("Looks good");
    expect(note.author).toEqual(REAL_IDENTITY);
    expect(note.statusAtWrite).toBe("in_progress");
    expect(note.id).toMatch(/[0-9a-f-]{36}/);

    const view = readPlanAndResults(repo, SLUG);
    expect(view.results?.caseResults["TC-001"].notes).toHaveLength(1);
  });

  it("captures an override status in statusAtWrite", async () => {
    await setStatusOverride(repo, SLUG, "TC-001", "blocked");
    const note = await appendNote(repo, SLUG, "TC-001", "Blocked by infra");
    expect(note.statusAtWrite).toBe("blocked");
  });

  it("rejects empty or whitespace-only note text", async () => {
    await expect(appendNote(repo, SLUG, "TC-001", "")).rejects.toThrow(/empty/);
    await expect(appendNote(repo, SLUG, "TC-001", "   ")).rejects.toThrow(/empty/);
  });

  it("never mutates the source plan (byte-identical after note)", async () => {
    const before = planBytes();
    await appendNote(repo, SLUG, "TC-001", "a note");
    expect(planBytes().equals(before)).toBe(true);
  });
});

describe("setStatusOverride", () => {
  beforeEach(() => writePlan(planFor()));

  it("sets and clears an override", async () => {
    let result = await setStatusOverride(repo, SLUG, "TC-001", "blocked");
    expect(result.statusOverride?.status).toBe("blocked");
    expect(result.statusOverride?.author).toEqual(REAL_IDENTITY);

    result = await setStatusOverride(repo, SLUG, "TC-001", null);
    expect(result.statusOverride).toBeUndefined();
  });
});

describe("reconcile (NFR-003 orphan-not-delete)", () => {
  beforeEach(() => writePlan(planFor()));

  it("previews classification without writing when confirm is not set", async () => {
    // Author a result for a case, then remove that case from the plan.
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    const before = fs.readFileSync(resultsFilePath(), "utf8");

    const removedPlan = planFor();
    removedPlan.cases = [];
    writePlan(removedPlan);

    const outcome = await reconcile(repo, SLUG);
    expect(outcome.applied).toBe(false);
    expect(outcome.classification.removed).toContain("TC-001");
    // No write occurred.
    expect(fs.readFileSync(resultsFilePath(), "utf8")).toBe(before);
  });

  it("flags orphans without deleting them when confirmed (orphan-not-delete)", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    const removedPlan = planFor();
    removedPlan.cases = [];
    writePlan(removedPlan);

    const outcome = await reconcile(repo, SLUG, { confirm: true });
    expect(outcome.applied).toBe(true);
    expect(outcome.classification.removed).toContain("TC-001");

    // The orphaned result is RETAINED on disk, flagged orphaned.
    const file: TestResultsFile = JSON.parse(fs.readFileSync(resultsFilePath(), "utf8"));
    expect(file.caseResults["TC-001"].orphaned).toBe(true);
    expect(file.caseResults["TC-001"].observationMarks.O1.result).toBe("pass");
  });

  it("physically deletes orphans only when purgeOrphans is explicitly true", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    const removedPlan = planFor();
    removedPlan.cases = [];
    writePlan(removedPlan);

    await reconcile(repo, SLUG, { confirm: true, purgeOrphans: true });
    const file: TestResultsFile = JSON.parse(fs.readFileSync(resultsFilePath(), "utf8"));
    expect(file.caseResults["TC-001"]).toBeUndefined();
  });

  it("classifies plan-only cases as added", async () => {
    const outcome = await reconcile(repo, SLUG);
    expect(outcome.classification.added).toContain("TC-001");
    expect(outcome.classification.removed).toEqual([]);
  });

  it("never mutates the source plan (byte-identical after reconcile)", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    const before = planBytes();
    await reconcile(repo, SLUG, { confirm: true });
    expect(planBytes().equals(before)).toBe(true);
  });

  it("updates planHash on confirmed reconcile", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await reconcile(repo, SLUG, { confirm: true });
    const file: TestResultsFile = JSON.parse(fs.readFileSync(resultsFilePath(), "utf8"));
    expect(file.planHash).toBe(computePlanHash(planFor()));
  });

  // NFR-003 / #447: a confirmed reconcile of a marked, in-plan case persists the
  // per-case caseCanon snapshot testbench-domain stamps, and that file must
  // round-trip through the strict published contract. The contract now declares
  // caseCanon, so the snapshot lands on disk and re-reads cleanly: the
  // changed-vs-unchanged signal survives the round-trip without fail-open data
  // loss.
  it("persists the per-case caseCanon snapshot and re-reads it cleanly after a confirmed reconcile", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await reconcile(repo, SLUG, { confirm: true });

    // The persisted file carries the caseCanon snapshot stamped by reconcile.
    const onDisk = JSON.parse(fs.readFileSync(resultsFilePath(), "utf8"));
    const persistedCanon = onDisk.caseResults["TC-001"].caseCanon;
    expect(typeof persistedCanon).toBe("string");
    expect(persistedCanon.length).toBeGreaterThan(0);

    // The store re-reads it cleanly through the strict contract: results are
    // retained (not recovered-away) and the snapshot survives the round-trip.
    const view = readPlanAndResults(repo, SLUG);
    expect(view.recovered).toBe(false);
    expect(view.results).not.toBeNull();
    expect(view.results?.caseResults["TC-001"].observationMarks.O1.result).toBe("pass");
    expect(view.results?.caseResults["TC-001"].caseCanon).toBe(persistedCanon);
  });
});
