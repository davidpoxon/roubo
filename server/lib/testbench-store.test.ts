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
  TESTBENCH_MIGRATION_GUIDE_PATH,
  type TestCasesPlan,
  type TestResultsFile,
} from "@roubo/shared/testbench-contracts";
import { canonicalizeCase } from "@roubo/shared/testbench-canonicalize";
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
  // #494: one results file per worktree, case results at the top level (no
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

  // #494: case results live at the top level of the file, not nested under a
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
    // NFR-005: the recovery reason names WHY it recovered (here: no prior file).
    expect(view.recoveryReason).toBe("missing");
    // #928: only a prior-major recovery names the migration guide; every
    // other reason (here: missing) leaves it null.
    expect(view.migrationGuide).toBeNull();
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
    expect(view.recoveryReason).toBe("corrupt-json");
    // #928: a generic corruption recovery does not name the migration guide.
    expect(view.migrationGuide).toBeNull();
  });

  // AC3: a schema-invalid sidecar fails open.
  it("fails open on a schema-invalid sidecar", () => {
    writePlan(planFor());
    // Same-major (v2) but structurally invalid: falls through to schema
    // validation, so the reason is schema-invalid, not a version mismatch.
    writeRawResults(JSON.stringify({ schemaVersion: "2.0.0", caseResults: "not-a-record" }));
    const view = readPlanAndResults(repo, SLUG);
    expect(view.results).toBeNull();
    expect(view.recovered).toBe(true);
    expect(view.recoveryReason).toBe("schema-invalid");
  });

  // TC-063 / NFR-005: a prior-major (v1) file (per-bench `benches` map, no
  // top-level caseResults) is caught by the PAST-major guard BEFORE strict
  // validation, so it fails open with a legible version-migration-required
  // signal that points at docs/testbench-schema-migrations.md, not a generic
  // shape error. Still a clean slate (recovered), never a throw.
  it("recovers a prior-major (v1) sidecar with a version-migration-required reason", () => {
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
    expect(view.recoveryReason).toBe("version-migration-required");
    // #928 (AC1/AC3): the observable payload names the documented migration
    // path so a user can find the migration steps, not just the reason token.
    expect(view.migrationGuide).toBe(TESTBENCH_MIGRATION_GUIDE_PATH);
    expect(view.migrationGuide).toBe("docs/testbench-schema-migrations.md");
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
    expect(view.recoveryReason).toBe("future-version");
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

  // #510: a single fail moves the case to failed even before every observation
  // is marked.
  it("derives failed from one fail with other observations still unmarked", async () => {
    const result = await markObservation(repo, SLUG, "TC-001", "O1", "fail");
    expect(result.derivedStatus).toBe("failed");
    expect(result.observationMarks.O2).toBeUndefined();
  });

  // #510: a null result un-sets the mark entirely and recomputes derivedStatus.
  it("clears a mark when result is null and recomputes derivedStatus", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    let result = await markObservation(repo, SLUG, "TC-001", "O2", "pass");
    expect(result.derivedStatus).toBe("passed");

    result = await markObservation(repo, SLUG, "TC-001", "O2", null);
    expect(result.observationMarks.O2).toBeUndefined();
    expect(result.observationMarks.O1.result).toBe("pass");
    expect(result.derivedStatus).toBe("in_progress");

    // Clearing the last mark returns to not_started, and persists to disk.
    result = await markObservation(repo, SLUG, "TC-001", "O1", null);
    expect(result.observationMarks.O1).toBeUndefined();
    expect(result.derivedStatus).toBe("not_started");
    const view = readPlanAndResults(repo, SLUG);
    expect(view.results?.caseResults["TC-001"].observationMarks).toEqual({});
  });

  // #510: clearing an observation that was never marked is a harmless no-op.
  it("is a no-op when clearing an unmarked observation", async () => {
    const result = await markObservation(repo, SLUG, "TC-001", "O1", null);
    expect(result.observationMarks).toEqual({});
    expect(result.derivedStatus).toBe("not_started");
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

  // SATCA-TC-012 / SATCA-NFR-004 (#1158): a spec recorded at the PREVIOUS case
  // schema version is never silently re-versioned. Reading it and marking an
  // observation touches the results sidecar only, so the case file keeps both
  // its bytes and its recorded 1.1.0 version. The version is raised only when a
  // lifecycle record is actually introduced, which no code path does yet.
  it("leaves an untouched v1.1.0 plan byte-identical and at its recorded version", async () => {
    const priorVersionPlan = {
      ...planFor(),
      $schema: "https://roubo.dev/schema/testbench/test-cases/v1.1.0.json",
      schemaVersion: "1.1.0",
    };
    writePlan(priorVersionPlan);
    const before = planBytes();

    const view = readPlanAndResults(repo, SLUG);
    expect(view.plan.schemaVersion).toBe("1.1.0");
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    expect(planBytes().equals(before)).toBe(true);
    expect(JSON.parse(planBytes().toString()).schemaVersion).toBe("1.1.0");
    expect(readPlanAndResults(repo, SLUG).plan.schemaVersion).toBe("1.1.0");
  });

  // A recovered (corrupt) sidecar is replaced cleanly on the next write.
  it("recovers from a corrupt sidecar by reinitialising on write", async () => {
    writeRawResults("{ broken");
    const result = await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(result.observationMarks.O1.result).toBe("pass");
    // The file is now valid and readable.
    const view = readPlanAndResults(repo, SLUG);
    expect(view.recovered).toBe(false);
    // Happy path carries no recovery reason.
    expect(view.recoveryReason ?? null).toBeNull();
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

// A two-case plan, used by the caseCanon write-path / single-edit-isolation
// tests below. TC-001 mirrors planFor(); TC-002 is a second independent case so
// editing one case's body can be shown to leave the other classified unchanged.
function twoCasePlan(): TestCasesPlan {
  const plan = planFor();
  plan.cases = [
    plan.cases[0],
    {
      id: "TC-002",
      title: "Logout works",
      area: "auth",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      steps: [
        {
          id: "S1",
          instruction: "Click logout",
          observations: [{ id: "O1", expected: "Session cleared" }],
        },
      ],
      tags: ["smoke"],
      linked_requirement_ids: ["FR-002"],
      linked_user_story_ids: [],
    },
  ];
  return plan;
}

describe("caseCanon stamping on the write path (#505)", () => {
  beforeEach(() => writePlan(planFor()));

  it("stamps caseCanon equal to canonicalizeCase(planCase) after markObservation", async () => {
    const result = await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(result.caseCanon).toBe(canonicalizeCase(planFor().cases[0]));
  });

  it("stamps caseCanon equal to canonicalizeCase(planCase) after appendNote", async () => {
    // appendNote returns the Note, so read the stamped snapshot back off disk.
    await appendNote(repo, SLUG, "TC-001", "looks good");
    const onDisk = JSON.parse(fs.readFileSync(resultsFilePath(), "utf8"));
    expect(onDisk.caseResults["TC-001"].caseCanon).toBe(canonicalizeCase(planFor().cases[0]));
  });

  it("stamps caseCanon equal to canonicalizeCase(planCase) after setStatusOverride", async () => {
    const result = await setStatusOverride(repo, SLUG, "TC-001", "blocked");
    expect(result.caseCanon).toBe(canonicalizeCase(planFor().cases[0]));
  });

  it("classifies a case marked against the current plan as unchanged on the next reconcile", async () => {
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    // Reconcile against the same (unchanged) plan: the stamped snapshot matches.
    const outcome = await reconcile(repo, SLUG);
    expect(outcome.classification.unchanged).toContain("TC-001");
    expect(outcome.classification.changed).not.toContain("TC-001");
  });

  it("isolates a single edit: editing one case's body re-flags only that case", async () => {
    writePlan(twoCasePlan());
    // Both cases marked against the current plan: both get a snapshot stamped.
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await markObservation(repo, SLUG, "TC-002", "O1", "pass");

    // Edit only TC-001's body.
    const edited = twoCasePlan();
    edited.cases[0].title = "Login works (revised)";
    writePlan(edited);

    const outcome = await reconcile(repo, SLUG);
    expect(outcome.classification.changed).toEqual(["TC-001"]);
    expect(outcome.classification.unchanged).toContain("TC-002");
    expect(outcome.classification.changed).not.toContain("TC-002");
  });

  it("leaves caseCanon unset when the case id is not in the plan", async () => {
    // A mark against a case id absent from the plan: no matching plan case, so
    // the snapshot is not stamped and the mark stays conservatively `changed`.
    const result = await setStatusOverride(repo, SLUG, "TC-999", "blocked");
    expect(result.caseCanon).toBeUndefined();

    const outcome = await reconcile(repo, SLUG);
    // TC-999 has a result but no plan case: it is an orphan, never unchanged.
    expect(outcome.classification.unchanged).not.toContain("TC-999");
  });
});

// #1407: the file planHash claims that every recorded result is current. A write
// under stale results stamps the current hash only when every live recorded case
// then holds a current result, so one mark never makes another case's old result
// read as current.
describe("planHash stamping under stale results (#1407)", () => {
  // Both case bodies edited after both cases were marked under v1.
  function editedTwoCasePlan(): TestCasesPlan {
    const plan = twoCasePlan();
    plan.cases[0].title = "Login works (revised)";
    plan.cases[1].title = "Logout works (revised)";
    return plan;
  }

  function readFile(): TestResultsFile {
    return JSON.parse(fs.readFileSync(resultsFilePath(), "utf8"));
  }

  // TC-001 gets both of its observations marked, so clearing one of them still
  // leaves an old mark behind.
  async function markBothUnderV1(): Promise<string> {
    writePlan(twoCasePlan());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await markObservation(repo, SLUG, "TC-001", "O2", "pass");
    await markObservation(repo, SLUG, "TC-002", "O1", "pass");
    const oldHash = readFile().planHash;
    writePlan(editedTwoCasePlan());
    return oldHash;
  }

  it("keeps a second case stale after one mark on the first", async () => {
    const oldHash = await markBothUnderV1();

    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    expect(readFile().planHash).toBe(oldHash);
    const view = readPlanAndResults(repo, SLUG);
    expect(view.stale).toBe(true);
    expect(view.currentCaseIds).toEqual(["TC-001"]);

    // Judging the second case too leaves no live case without a current result.
    await markObservation(repo, SLUG, "TC-002", "O1", "pass");
    expect(readFile().planHash).toBe(computePlanHash(editedTwoCasePlan()));
    const after = readPlanAndResults(repo, SLUG);
    expect(after.stale).toBe(false);
    expect(after.currentCaseIds).toEqual(["TC-001", "TC-002"]);
  });

  it("does not let a retired case's old result hold the old stamp", async () => {
    await markBothUnderV1();
    const plan = editedTwoCasePlan();
    plan.cases[1].lifecycle = { state: "retired", reason: "Logout was removed" };
    writePlan(plan);

    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(readFile().planHash).toBe(computePlanHash(plan));
  });

  it("does not let an orphan's result hold the old stamp", async () => {
    await markBothUnderV1();
    const plan = editedTwoCasePlan();
    plan.cases = [plan.cases[0]];
    writePlan(plan);

    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(readFile().planHash).toBe(computePlanHash(plan));
  });

  it.each([
    ["a note", () => appendNote(repo, SLUG, "TC-001", "still looks fine")],
    ["a mark clear", () => markObservation(repo, SLUG, "TC-001", "O1", null)],
  ])("keeps the prior caseCanon after %s under stale results", async (_label, write) => {
    await markBothUnderV1();
    const before = readFile().caseResults["TC-001"].caseCanon;

    await write();

    expect(readFile().caseResults["TC-001"].caseCanon).toBe(before);
    expect(readPlanAndResults(repo, SLUG).currentCaseIds).toEqual([]);
  });

  it("restores the verdict's caseCanon when an override clear leaves old marks", async () => {
    writePlan(twoCasePlan());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await setStatusOverride(repo, SLUG, "TC-001", "blocked");
    const v1Canon = canonicalizeCase(twoCasePlan().cases[0]);
    expect(readFile().caseResults["TC-001"].statusOverride?.verdictCanon).toBe(v1Canon);
    writePlan(editedTwoCasePlan());

    await setStatusOverride(repo, SLUG, "TC-001", null);

    expect(readFile().caseResults["TC-001"].caseCanon).toBe(v1Canon);
    const view = readPlanAndResults(repo, SLUG);
    expect(view.stale).toBe(true);
    expect(view.currentCaseIds).toEqual([]);
  });

  it("does not let an override set then cleared under stale results make old marks current", async () => {
    await markBothUnderV1();

    await setStatusOverride(repo, SLUG, "TC-001", "passed");
    expect(readPlanAndResults(repo, SLUG).currentCaseIds).toEqual(["TC-001"]);
    await setStatusOverride(repo, SLUG, "TC-001", null);

    const view = readPlanAndResults(repo, SLUG);
    expect(view.currentCaseIds).toEqual([]);
    expect(view.stale).toBe(true);
  });

  // The other writer of test-results.json records a machine verdict as a
  // derivedStatus plus verification, with no observation marks.
  async function machineVerifyUnderV1(): Promise<void> {
    writePlan(twoCasePlan());
    // Write a result under v1, then reshape it into a machine verdict.
    await appendNote(repo, SLUG, "TC-001", "verified by the suite");
    const file = readFile();
    file.caseResults["TC-001"] = {
      ...file.caseResults["TC-001"],
      observationMarks: {},
      derivedStatus: "passed",
      verification: {
        tier: "b",
        confidence: "high",
        evidence: ["suite report"],
        author: { name: "Verifier", email: "verifier@example.com" },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    };
    fs.writeFileSync(resultsFilePath(), JSON.stringify(file, null, 2));
    writePlan(editedTwoCasePlan());
  }

  it.each([
    ["a note", () => appendNote(repo, SLUG, "TC-001", "looked at it")],
    [
      "an override set then cleared",
      async () => {
        await setStatusOverride(repo, SLUG, "TC-001", "blocked");
        await setStatusOverride(repo, SLUG, "TC-001", null);
      },
    ],
  ])("keeps a machine verdict stale after %s under stale results", async (_label, write) => {
    await machineVerifyUnderV1();
    expect(readPlanAndResults(repo, SLUG).stale).toBe(true);

    await write();

    const view = readPlanAndResults(repo, SLUG);
    expect(view.results?.caseResults["TC-001"].derivedStatus).toBe("passed");
    expect(view.currentCaseIds).toEqual([]);
    expect(view.stale).toBe(true);
  });

  // Only TC-001 is recorded, so it is the last case that can hold the stamp.
  async function markOnlyFirstUnderV1(): Promise<void> {
    writePlan(twoCasePlan());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    writePlan(editedTwoCasePlan());
  }

  it("keeps the file stale while an override stands over an older verdict", async () => {
    await markOnlyFirstUnderV1();

    await setStatusOverride(repo, SLUG, "TC-001", "passed");

    // The override itself is current, so the gate reads it, but the file does
    // not claim that the mark under it is current.
    const view = readPlanAndResults(repo, SLUG);
    expect(view.currentCaseIds).toEqual(["TC-001"]);
    expect(view.stale).toBe(true);

    await setStatusOverride(repo, SLUG, "TC-001", null);

    const after = readPlanAndResults(repo, SLUG);
    expect(after.currentCaseIds).toEqual([]);
    expect(after.stale).toBe(true);
  });

  it("moves the override's record to the current body on a mark made under it", async () => {
    await markOnlyFirstUnderV1();
    await setStatusOverride(repo, SLUG, "TC-001", "blocked");

    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    const current = canonicalizeCase(editedTwoCasePlan().cases[0]);
    expect(readFile().caseResults["TC-001"].statusOverride?.verdictCanon).toBe(current);
    expect(readPlanAndResults(repo, SLUG).stale).toBe(false);

    await setStatusOverride(repo, SLUG, "TC-001", null);

    expect(readFile().caseResults["TC-001"].caseCanon).toBe(current);
    const view = readPlanAndResults(repo, SLUG);
    expect(view.stale).toBe(false);
    expect(view.currentCaseIds).toEqual(["TC-001"]);
  });

  it("empties a fresh planHash when a cleared override restores an older verdict", async () => {
    await markOnlyFirstUnderV1();
    await setStatusOverride(repo, SLUG, "TC-001", "passed");
    // Another writer judged every live case current and stamped the file fresh,
    // leaving the override and its record in place.
    const plan = editedTwoCasePlan();
    const file = readFile();
    file.planHash = computePlanHash(plan);
    fs.writeFileSync(resultsFilePath(), JSON.stringify(file, null, 2));
    expect(readPlanAndResults(repo, SLUG).stale).toBe(false);

    await setStatusOverride(repo, SLUG, "TC-001", null);

    expect(readFile().planHash).toBe("");
    const view = readPlanAndResults(repo, SLUG);
    expect(view.stale).toBe(true);
    expect(view.currentCaseIds).toEqual([]);
  });

  it("keeps a fresh file fresh through an override set and clear", async () => {
    writePlan(twoCasePlan());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await setStatusOverride(repo, SLUG, "TC-001", "blocked");
    await setStatusOverride(repo, SLUG, "TC-001", null);

    expect(readFile().planHash).toBe(computePlanHash(twoCasePlan()));
    expect(readFile().caseResults["TC-001"].caseCanon).toBe(
      canonicalizeCase(twoCasePlan().cases[0]),
    );
  });

  it("stamps a case whose only mark is cleared under stale results", async () => {
    writePlan(twoCasePlan());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    await markObservation(repo, SLUG, "TC-002", "O1", "pass");
    writePlan(editedTwoCasePlan());

    await markObservation(repo, SLUG, "TC-001", "O1", null);

    const result = readFile().caseResults["TC-001"];
    expect(result.derivedStatus).toBe("not_started");
    expect(result.caseCanon).toBe(canonicalizeCase(editedTwoCasePlan().cases[0]));
    expect(readPlanAndResults(repo, SLUG).currentCaseIds).toEqual(["TC-001"]);
  });

  it("stamps an unjudged case on a note under stale results, so it never holds the stamp", async () => {
    // TC-002 is judged under v1; TC-001 has no result at all.
    writePlan(twoCasePlan());
    await markObservation(repo, SLUG, "TC-002", "O1", "pass");
    const plan = twoCasePlan();
    plan.cases[0].title = "Login works (revised)";
    writePlan(plan);

    await appendNote(repo, SLUG, "TC-001", "not started yet");

    // TC-002's body did not change, so with TC-001 stamped no live case is stale.
    expect(readFile().caseResults["TC-001"].caseCanon).toBe(canonicalizeCase(plan.cases[0]));
    expect(readFile().planHash).toBe(computePlanHash(plan));
    expect(readPlanAndResults(repo, SLUG).stale).toBe(false);
  });

  it("keeps the prior caseCanon when a prior override survives a mark", async () => {
    writePlan(twoCasePlan());
    await setStatusOverride(repo, SLUG, "TC-001", "passed");
    const before = readFile().caseResults["TC-001"].caseCanon;
    writePlan(editedTwoCasePlan());

    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    const file = readFile();
    expect(file.caseResults["TC-001"].statusOverride?.status).toBe("passed");
    expect(file.caseResults["TC-001"].caseCanon).toBe(before);
    expect(readPlanAndResults(repo, SLUG).stale).toBe(true);
  });

  it("stamps the current caseCanon when an override is set under stale results", async () => {
    await markBothUnderV1();

    await setStatusOverride(repo, SLUG, "TC-002", "blocked");

    const plan = editedTwoCasePlan();
    expect(readFile().caseResults["TC-002"].caseCanon).toBe(canonicalizeCase(plan.cases[1]));
    expect(readPlanAndResults(repo, SLUG).currentCaseIds).toEqual(["TC-002"]);
  });

  it("leaves a changed case stale through a confirmed reconcile", async () => {
    const oldHash = await markBothUnderV1();
    const oldCanon = readFile().caseResults["TC-001"].caseCanon;

    const outcome = await reconcile(repo, SLUG, { confirm: true });

    expect(outcome.classification.changed).toEqual(["TC-001", "TC-002"]);
    const file = readFile();
    expect(file.caseResults["TC-001"].caseCanon).toBe(oldCanon);
    expect(file.caseResults["TC-001"].observationMarks.O1.result).toBe("pass");
    expect(file.planHash).toBe(oldHash);
    expect(readPlanAndResults(repo, SLUG).stale).toBe(true);
  });

  it("stamps the current hash on a confirmed reconcile once no live case is stale", async () => {
    await markBothUnderV1();
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    // TC-002 leaves the plan: its old result becomes an orphan, which never holds
    // the stamp, so the reconcile write may move it.
    const plan = editedTwoCasePlan();
    plan.cases = [plan.cases[0]];
    writePlan(plan);

    await reconcile(repo, SLUG, { confirm: true });

    expect(readFile().planHash).toBe(computePlanHash(plan));
    expect(readPlanAndResults(repo, SLUG).stale).toBe(false);
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

  // NFR-003 / #489: a confirmed reconcile of a marked, in-plan case persists the
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

// #1160 (SATCA-FR-022, SATCA-TC-055): the v1.2.0 lifecycle block (#1158) is excluded
// from the canonical case body, so the plan hash covers the TESTABLE plan only.
// canonicalize's own suite locks the canonical STRING; these lock the rest of the
// chain: sha256 (computePlanHash), the store's `stale` flag, and reconcile's
// classification. Each assertion is paired with a negative control, so the
// exclusion can never be mistaken for staleness detection having stopped working.
describe("lifecycle exclusion from the plan hash (#1160, SATCA-FR-022)", () => {
  function retiredPlan(): TestCasesPlan {
    const plan = planFor();
    plan.cases[0].lifecycle = { state: "retired", reason: "Login flow was replaced" };
    return plan;
  }

  function supersededPlan(): TestCasesPlan {
    const plan = planFor();
    plan.cases[0].lifecycle = { state: "superseded", replacement: "TC-002" };
    return plan;
  }

  function stepsEditedPlan(): TestCasesPlan {
    const plan = planFor();
    plan.cases[0].steps[0].observations[0].expected = "Form shown differently";
    return plan;
  }

  it("computes an identical plan hash after a case is retired", () => {
    expect(computePlanHash(retiredPlan())).toBe(computePlanHash(planFor()));
  });

  it("computes an identical plan hash after a case is superseded", () => {
    expect(computePlanHash(supersededPlan())).toBe(computePlanHash(planFor()));
  });

  // Negative control: the carve-out is scoped to lifecycle bookkeeping only.
  it("still changes the plan hash when a live case's steps are edited", () => {
    expect(computePlanHash(stepsEditedPlan())).not.toBe(computePlanHash(planFor()));
  });

  it("reads results as not stale after a lifecycle-only rewrite of test-cases.json", async () => {
    writePlan(planFor());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");
    expect(readPlanAndResults(repo, SLUG).stale).toBe(false);

    writePlan(retiredPlan());
    const afterRetire = readPlanAndResults(repo, SLUG);
    expect(afterRetire.stale).toBe(false);
    expect(afterRetire.planHash).toBe(computePlanHash(planFor()));

    writePlan(supersededPlan());
    const afterSupersede = readPlanAndResults(repo, SLUG);
    expect(afterSupersede.stale).toBe(false);
    expect(afterSupersede.planHash).toBe(computePlanHash(planFor()));
  });

  // Negative control: a genuine content edit still flips the store's stale flag.
  it("reads results as stale after a steps rewrite of test-cases.json", async () => {
    writePlan(planFor());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    writePlan(stepsEditedPlan());
    const after = readPlanAndResults(repo, SLUG);
    expect(after.stale).toBe(true);
    expect(after.planHash).toBe(computePlanHash(stepsEditedPlan()));
  });

  it("keeps a retired case classified unchanged by reconcile", async () => {
    writePlan(planFor());
    await markObservation(repo, SLUG, "TC-001", "O1", "pass");

    writePlan(retiredPlan());
    const outcome = await reconcile(repo, SLUG);
    expect(outcome.classification.unchanged).toContain("TC-001");
    expect(outcome.classification.changed).not.toContain("TC-001");
  });
});

// #903: the read sinks resolve `.specifications/<slug>/…` under repoPath through
// the lexical resolveWithin guard, which cannot see an on-disk symlink whose name
// is a valid slug. The path helpers now apply the realpath barrier before the fs
// read, so a symlinked spec dir cannot make a read resolve outside repoPath.
describe("path-safety: symlinked spec dir cannot escape repoPath (#903)", () => {
  // Mirrors TC-052: a valid-slug `.specifications/<slug>` symlink pointing outside
  // the repo passes the lexical check but is rejected by the realpath barrier
  // before the plan is read, so a plan sitting outside the repo is never read.
  it("rejects a symlinked spec dir escaping the repo on read (does not read outside)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-store-outside-"));
    try {
      // A real, valid plan lives OUTSIDE the repo; a followed symlink would reach it.
      fs.writeFileSync(path.join(outside, "test-cases.json"), JSON.stringify(planFor(), null, 2));
      const specs = path.join(repo, ".specifications");
      fs.mkdirSync(specs, { recursive: true });
      fs.symlinkSync(outside, path.join(specs, SLUG), "dir");

      expect(() => readPlanAndResults(repo, SLUG)).toThrow(UnsafePathError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // No-false-reject guard: a repo root under a symlinked prefix (e.g. macOS
  // /var/folders -> /private/var) still reads and writes successfully, because the
  // barrier compares realpath-to-realpath rather than realpath-to-lexical-root.
  it("reads and writes successfully when the repo root sits under a symlinked prefix", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-store-symroot-"));
    try {
      const realParent = path.join(base, "real-parent");
      fs.mkdirSync(realParent);
      const linkParent = path.join(base, "link-parent");
      fs.symlinkSync(realParent, linkParent, "dir");
      const root = path.join(linkParent, "repo");
      const dir = path.join(root, ".specifications", SLUG);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "test-cases.json"), JSON.stringify(planFor(), null, 2));

      expect(readPlanAndResults(root, SLUG).plan.cases[0].id).toBe("TC-001");
      await markObservation(root, SLUG, "TC-001", "O1", "pass");
      const after = readPlanAndResults(root, SLUG);
      expect(after.results?.caseResults["TC-001"].observationMarks.O1.result).toBe("pass");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
