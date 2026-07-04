import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverSpecs,
  resolveFocusedSpec,
  validateManualPath,
} from "./testbench-spec-discovery.js";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
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
