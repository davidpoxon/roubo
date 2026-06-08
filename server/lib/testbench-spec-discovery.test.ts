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
      level: "e2e_flow",
      priority: "P0",
      steps: [
        {
          id: "S1",
          instruction: "do",
          observations: [{ id: "O1", expected: "ok" }],
        },
      ],
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
  it("returns an empty list when there is no .specifications directory", () => {
    expect(discoverSpecs(repo)).toEqual([]);
  });

  it("enumerates and validates valid specs, sorted by slug", () => {
    writeSpec("zebra", planFor("zebra", ["TC-001"]));
    writeSpec("alpha", planFor("alpha", ["TC-001", "TC-002"]));

    const specs = discoverSpecs(repo);
    expect(specs.map((s) => s.slug)).toEqual(["alpha", "zebra"]);
    expect(specs[0].caseCount).toBe(2);
    expect(specs[1].caseCount).toBe(1);
    expect(specs[0].path).toBe(path.join(repo, ".specifications", "alpha", "test-cases.json"));
  });

  it("skips folders with no test-cases.json", () => {
    fs.mkdirSync(path.join(repo, ".specifications", "empty"), { recursive: true });
    writeSpec("good", planFor("good", ["TC-001"]));
    expect(discoverSpecs(repo).map((s) => s.slug)).toEqual(["good"]);
  });

  it("skips invalid JSON and schema-invalid specs", () => {
    writeSpec("broken-json", "{not json");
    writeSpec("invalid-schema", { foo: "bar" });
    writeSpec("good", planFor("good", ["TC-001"]));
    expect(discoverSpecs(repo).map((s) => s.slug)).toEqual(["good"]);
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
});
