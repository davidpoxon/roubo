import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CaseLifecycleConflictError,
  CaseNotFoundError,
  computeCaseFileFingerprint,
  MissingCaseFileError,
  setCaseLifecycle,
  writeLifecycleFile,
} from "./testbench-lifecycle-write.js";
import { UnsafePathError } from "./safe-path.js";
import { TEST_CASES_SCHEMA_VERSION } from "@roubo/shared/testbench-contracts";

// A two-case plan recorded at the pre-lifecycle schema version, so the
// version-raise rule (SATCA-NFR-004) is exercised by the happy path.
function plan(): Record<string, unknown> {
  return {
    $schema: "https://roubo.dev/schema/testbench/test-cases/v1.1.0.json",
    schemaVersion: "1.1.0",
    specSlug: "demo",
    cases: [
      {
        id: "TC-001",
        title: "First case",
        area: "core",
        level: 1,
        type: "functional",
        steps: [
          { id: "S001", instruction: "do it", observations: [{ id: "O01", expected: "ok" }] },
        ],
        tags: ["smoke"],
        linked_requirement_ids: ["FR-001"],
        linked_user_story_ids: [],
      },
      {
        id: "TC-002",
        title: "Second case",
        area: "core",
        level: 2,
        type: "functional",
        steps: [
          { id: "S001", instruction: "do it", observations: [{ id: "O01", expected: "ok" }] },
        ],
        tags: [],
        linked_requirement_ids: ["FR-002"],
        linked_user_story_ids: [],
      },
    ],
  };
}

let repo: string;
let target: string;

function seed(document: Record<string, unknown> | string = plan()): string {
  const dir = path.join(repo, ".specifications", "demo");
  fs.mkdirSync(dir, { recursive: true });
  const raw = typeof document === "string" ? document : `${JSON.stringify(document, null, 2)}\n`;
  target = path.join(dir, "test-cases.json");
  fs.writeFileSync(target, raw);
  return computeCaseFileFingerprint(raw);
}

function read(): Record<string, never> & { cases: { id: string; lifecycle?: unknown }[] } {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-lifecycle-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("setCaseLifecycle (SATCA-TC-046)", () => {
  it("records a retirement on the named case and modifies no other case", () => {
    const fingerprint = seed();
    const before = read();

    const result = setCaseLifecycle(
      repo,
      "demo",
      "TC-001",
      {
        state: "retired",
        reason: "Superseded by the new flow",
      },
      fingerprint,
    );

    const after = read();
    expect(after.cases[0].lifecycle).toEqual({
      state: "retired",
      reason: "Superseded by the new flow",
    });
    // Every other case is byte-identical to what was there before.
    expect(after.cases[1]).toEqual(before.cases[1]);
    expect(result.case.id).toBe("TC-001");
    expect(result.caseFileFingerprint).toBe(
      computeCaseFileFingerprint(fs.readFileSync(target, "utf8")),
    );
  });

  it("records a supersession with its replacement pointer verbatim", () => {
    const fingerprint = seed();
    setCaseLifecycle(
      repo,
      "demo",
      "TC-002",
      {
        state: "superseded",
        replacement: "other-spec:TC-009",
        reason: "Moved",
      },
      fingerprint,
    );

    expect(read().cases[1].lifecycle).toEqual({
      state: "superseded",
      replacement: "other-spec:TC-009",
      reason: "Moved",
    });
  });

  // SATCA-FR-021: every action is reversible, and reversal removes the record.
  it("restores a case by removing the record entirely", () => {
    const first = seed();
    setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, first);

    const second = computeCaseFileFingerprint(fs.readFileSync(target, "utf8"));
    setCaseLifecycle(repo, "demo", "TC-001", null, second);

    const after = read();
    expect(after.cases[0]).not.toHaveProperty("lifecycle");
    expect(Object.keys(after.cases[0])).toEqual(Object.keys(plan().cases[0] as object));
  });

  // SATCA-NFR-004: the recorded version rises only when a record is introduced,
  // and is never lowered by a restore.
  it("raises schemaVersion only when introducing a record, never on restore", () => {
    const first = seed();
    const retired = setCaseLifecycle(
      repo,
      "demo",
      "TC-001",
      { state: "retired", reason: "gone" },
      first,
    );
    expect(retired.schemaVersion).toBe(TEST_CASES_SCHEMA_VERSION);

    const second = computeCaseFileFingerprint(fs.readFileSync(target, "utf8"));
    const restored = setCaseLifecycle(repo, "demo", "TC-001", null, second);
    expect(restored.schemaVersion).toBe(TEST_CASES_SCHEMA_VERSION);
  });

  it("leaves an already-current schemaVersion untouched", () => {
    const current = plan();
    current.schemaVersion = TEST_CASES_SCHEMA_VERSION;
    current.$schema = "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json";
    const fingerprint = seed(current);

    setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, fingerprint);
    expect(read()).toMatchObject({ $schema: current.$schema });
  });

  it("404s on an unknown case id and writes nothing", () => {
    const fingerprint = seed();
    const before = fs.readFileSync(target, "utf8");
    expect(() =>
      setCaseLifecycle(repo, "demo", "TC-999", { state: "retired", reason: "gone" }, fingerprint),
    ).toThrow(CaseNotFoundError);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("refuses a spec with no case file", () => {
    expect(() =>
      setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, "abc"),
    ).toThrow(MissingCaseFileError);
  });

  it("refuses a case file that is not a valid plan", () => {
    const fingerprint = seed("{ not json");
    expect(() =>
      setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, fingerprint),
    ).toThrow(MissingCaseFileError);
  });
});

// SATCA-TC-051: the slug is rejected at identifier validation, before any path is
// built and therefore before any filesystem call.
describe("path safety (SATCA-TC-051)", () => {
  it("rejects a traversal or separator slug before touching the filesystem", () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const mkdirSpy = vi.spyOn(fs, "mkdirSync");

    for (const bad of ["../../etc/evil", "../outside", "a/b", "..", "."]) {
      expect(() =>
        setCaseLifecycle(repo, bad, "TC-001", { state: "retired", reason: "x" }, "fp"),
      ).toThrow(UnsafePathError);
    }

    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, ".specifications"))).toBe(false);
  });

  it("rejects an empty case id and an empty fingerprint", () => {
    const fingerprint = seed();
    expect(() =>
      setCaseLifecycle(repo, "demo", "", { state: "retired", reason: "x" }, fingerprint),
    ).toThrow(UnsafePathError);
    expect(() => setCaseLifecycle(repo, "demo", "TC-001", null, "")).toThrow(UnsafePathError);
  });
});

// SATCA-TC-052: a spec folder that is a symlink out of the project is refused by
// the realpath barrier, and the outside target is untouched.
describe("symlinked spec folder (SATCA-TC-052)", () => {
  it("refuses a symlinked spec folder resolving outside the project", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-outside-"));
    try {
      const specs = path.join(repo, ".specifications");
      fs.mkdirSync(specs, { recursive: true });
      // A valid slug per SPEC_SLUG_RE, but a symlink to a directory outside.
      fs.symlinkSync(outside, path.join(specs, "evil-link"), "dir");
      const outsideFile = path.join(outside, "test-cases.json");
      fs.writeFileSync(outsideFile, `${JSON.stringify(plan(), null, 2)}\n`);
      const before = fs.readFileSync(outsideFile, "utf8");

      expect(() =>
        setCaseLifecycle(
          repo,
          "evil-link",
          "TC-001",
          { state: "retired", reason: "x" },
          computeCaseFileFingerprint(before),
        ),
      ).toThrow(UnsafePathError);

      expect(fs.readFileSync(outsideFile, "utf8")).toBe(before);
      expect(fs.existsSync(`${outsideFile}.tmp`)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// SATCA-TC-053: no lifecycle path spawns a process, so git is never run and the
// change is left uncommitted.
describe("no process is spawned (SATCA-TC-053)", () => {
  it("spawns nothing across retire, supersede, and both reversals", () => {
    const spies = (
      ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const
    ).map((name) => vi.spyOn(child_process, name));

    let fingerprint = seed();
    const actions: Parameters<typeof setCaseLifecycle>[3][] = [
      { state: "retired", reason: "gone" },
      null,
      { state: "superseded", replacement: "TC-002" },
      null,
    ];
    for (const action of actions) {
      const result = setCaseLifecycle(repo, "demo", "TC-001", action, fingerprint);
      fingerprint = result.caseFileFingerprint;
    }

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("leaves the change uncommitted in the worktree", () => {
    const fingerprint = seed();
    const git = (...args: string[]) =>
      child_process.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
    expect(git("status", "--porcelain").trim()).toBe("");

    setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, fingerprint);

    // The write is visible to git as an uncommitted modification: nothing
    // staged it, nothing committed it.
    expect(git("status", "--porcelain")).toContain(".specifications/demo/test-cases.json");
    expect(git("log", "--oneline").trim().split("\n")).toHaveLength(1);
  });
});

// SATCA-TC-054: an interrupted write leaves the original intact, with no partial
// file beside it.
describe("interrupted write (SATCA-TC-054)", () => {
  it("leaves the original intact and no .tmp behind when the rename fails", () => {
    const fingerprint = seed();
    const before = fs.readFileSync(target, "utf8");
    const dir = path.dirname(target);

    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("interrupted");
    });

    expect(() =>
      setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, fingerprint),
    ).toThrow("interrupted");

    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).cases).toHaveLength(2);
    expect(fs.readdirSync(dir)).toEqual(["test-cases.json"]);
  });

  // The temp write is the other half of the failure surface: a disk that fills or
  // errors part-way through it leaves exactly the truncated sibling the rename
  // guard exists to prevent, so it has to be cleaned up on the same path.
  it("leaves the original intact and no .tmp behind when the temp write fails", () => {
    const fingerprint = seed();
    const before = fs.readFileSync(target, "utf8");
    const dir = path.dirname(target);

    const realWriteFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      file: Parameters<typeof fs.writeFileSync>[0],
      data: Parameters<typeof fs.writeFileSync>[1],
      options?: Parameters<typeof fs.writeFileSync>[2],
    ) => {
      // Simulate a write that dies after committing partial bytes to the temp.
      realWriteFileSync(file, "{ truncated", options);
      throw new Error("ENOSPC: no space left on device");
    }) as typeof fs.writeFileSync);

    expect(() =>
      setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, fingerprint),
    ).toThrow("ENOSPC");

    vi.restoreAllMocks();

    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).cases).toHaveLength(2);
    expect(fs.readdirSync(dir)).toEqual(["test-cases.json"]);
  });
});

// SATCA-TC-056: a modification made outside the app between load and write is
// reported as a conflict rather than silently overwritten.
describe("concurrent modification (SATCA-TC-056)", () => {
  it("refuses the write, preserves the external edit, and reports the current fingerprint", () => {
    const stale = seed();

    // Someone edits the file outside the app after the panel loaded it.
    const external = plan();
    (external.cases as Record<string, unknown>[])[1].title = "Edited outside the app";
    const externalRaw = `${JSON.stringify(external, null, 2)}\n`;
    fs.writeFileSync(target, externalRaw);

    let thrown: unknown;
    try {
      setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, stale);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CaseLifecycleConflictError);
    expect((thrown as CaseLifecycleConflictError).actualFingerprint).toBe(
      computeCaseFileFingerprint(externalRaw),
    );
    expect((thrown as Error).message).toMatch(/reload/i);
    // The external modification survives untouched.
    expect(fs.readFileSync(target, "utf8")).toBe(externalRaw);
  });

  it("accepts the write once the caller reloads and re-sends the current fingerprint", () => {
    seed();
    const current = computeCaseFileFingerprint(fs.readFileSync(target, "utf8"));
    expect(() =>
      setCaseLifecycle(repo, "demo", "TC-001", { state: "retired", reason: "gone" }, current),
    ).not.toThrow();
  });
});

// SATCA-TC-059: no lifecycle write can reach a file outside the resolved spec
// folder, and only the two permitted filenames are ever written.
describe("permitted filenames (SATCA-TC-059)", () => {
  it("refuses every filename outside the permitted pair", () => {
    for (const bad of [
      "test-results.json",
      "../../../etc/passwd",
      "manifest.json.bak",
      "",
      ".env",
    ]) {
      expect(() => writeLifecycleFile(repo, "demo", bad, "x")).toThrow(UnsafePathError);
    }
    expect(fs.existsSync(path.join(repo, ".specifications"))).toBe(false);
  });

  it("writes the permitted pair into the resolved spec folder and nothing else", () => {
    const casesPath = writeLifecycleFile(repo, "demo", "test-cases.json", "{}");
    const manifestPath = writeLifecycleFile(repo, "demo", "manifest.json", "{}");
    const dir = path.join(repo, ".specifications", "demo");

    expect(casesPath).toBe(path.join(dir, "test-cases.json"));
    expect(manifestPath).toBe(path.join(dir, "manifest.json"));
    expect(fs.readdirSync(dir).sort()).toEqual(["manifest.json", "test-cases.json"]);
  });
});
