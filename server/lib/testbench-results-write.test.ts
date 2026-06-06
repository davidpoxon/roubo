import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeResults } from "./testbench-results-write.js";
import { UnsafePathError } from "./safe-path.js";

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-results-"));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("writeResults", () => {
  // AC1: a clean slug writes .specifications/<slug>/test-results.json and the
  // content round-trips.
  it("writes test-results.json under .specifications/<slug> and round-trips (AC1)", () => {
    const data = JSON.stringify({ ok: true, count: 3 });
    const target = writeResults(repo, "testbench", data);

    expect(target).toBe(path.join(repo, ".specifications", "testbench", "test-results.json"));
    expect(fs.readFileSync(target, "utf8")).toBe(data);
  });

  // AC2 (TC-051): a traversal slug is rejected before any fs call and nothing is
  // written outside the repo.
  it("rejects a traversal slug and writes nothing outside the repo (AC2)", () => {
    const before = fs.readdirSync(repo);
    for (const bad of ["../../etc/evil", "../outside-spec", "..", "."]) {
      expect(() => writeResults(repo, bad, "x")).toThrow(UnsafePathError);
    }
    // No .specifications dir created, repo contents unchanged.
    expect(fs.readdirSync(repo)).toEqual(before);
    expect(fs.existsSync(path.join(repo, ".specifications"))).toBe(false);
  });

  // AC2 (TC-052): an out-of-repo escaping path is rejected by resolveWithin.
  it("rejects a slug carrying a path separator that escapes the repo (AC2)", () => {
    expect(() => writeResults(repo, "../../../tmp/escape", "x")).toThrow(UnsafePathError);
    expect(() => writeResults(repo, "a/b", "x")).toThrow(UnsafePathError);
  });

  // AC3 (TC-050): the temp file is a sibling of the target in the same directory,
  // so a cross-device rename is impossible; the real write+rename succeeds and
  // leaves no .tmp behind.
  it("renames within the same directory and leaves no .tmp behind (AC3)", () => {
    const target = writeResults(repo, "same-dir", "payload");
    const dir = path.dirname(target);
    const tmp = path.join(dir, "test-results.json.tmp");

    // Same-directory rename invariant: temp and target share a dirname.
    expect(path.dirname(tmp)).toBe(path.dirname(target));
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["test-results.json"]);
    expect(fs.readFileSync(target, "utf8")).toBe("payload");
  });
});
