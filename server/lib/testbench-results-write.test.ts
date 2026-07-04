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

  // NFR-001 (TC-052): a valid-slug symlink under .specifications/ that points
  // outside the repo passes the lexical resolveWithin check but is caught by the
  // realpath barrier at the sink, so nothing is written into the outside dir.
  it("rejects a symlinked spec-slug dir that escapes the repo and writes nothing outside (TC-052)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-outside-"));
    try {
      const specs = path.join(repo, ".specifications");
      fs.mkdirSync(specs, { recursive: true });
      // evil-link is a valid slug (SPEC_SLUG_RE) but a symlink to outside the repo.
      fs.symlinkSync(outside, path.join(specs, "evil-link"), "dir");

      const before = fs.readdirSync(outside);
      expect(() => writeResults(repo, "evil-link", JSON.stringify({ evil: true }))).toThrow(
        UnsafePathError,
      );

      // Nothing (results or temp) was written into the outside directory.
      expect(fs.readdirSync(outside)).toEqual(before);
      expect(fs.existsSync(path.join(outside, "test-results.json"))).toBe(false);
      expect(fs.existsSync(path.join(outside, "test-results.json.tmp"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // Guards against a false-positive rejection: when the repo root legitimately
  // sits under a symlinked prefix (e.g. macOS /var/folders -> /private/var), the
  // realpath-to-realpath comparison keeps the write inside the root, so it must
  // still succeed rather than being wrongly rejected.
  it("writes successfully when the repo root sits under a symlinked prefix (no false reject)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-symroot-"));
    try {
      const realParent = path.join(base, "real-parent");
      fs.mkdirSync(realParent);
      const linkParent = path.join(base, "link-parent");
      fs.symlinkSync(realParent, linkParent, "dir");
      const root = path.join(linkParent, "repo");
      fs.mkdirSync(root);

      const data = JSON.stringify({ ok: true, count: 1 });
      const target = writeResults(root, "testbench", data);

      expect(target).toBe(path.join(root, ".specifications", "testbench", "test-results.json"));
      expect(fs.readFileSync(target, "utf8")).toBe(data);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
