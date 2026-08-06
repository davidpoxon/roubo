import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSpecLifecycle } from "./testbench-spec-lifecycle.js";
import { UnsafePathError } from "./safe-path.js";

let repo: string;

function specDir(slug: string): string {
  const dir = path.join(repo, ".specifications", slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(slug: string, manifest: unknown): string {
  const target = path.join(specDir(slug), "manifest.json");
  fs.writeFileSync(
    target,
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
  );
  return target;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lifecycle-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("readSpecLifecycle", () => {
  it("reads an archived record with reason and superseding slug", () => {
    writeManifest("jira-sources-scale", {
      schema_version: 1,
      slug: "jira-sources-scale",
      lifecycle: {
        archived: true,
        reason: "Folded into the integration-plugins spec.",
        supersededBy: "integration-plugins",
      },
    });

    expect(readSpecLifecycle(repo, "jira-sources-scale")).toEqual({
      lifecycle: {
        archived: true,
        reason: "Folded into the integration-plugins spec.",
        supersededBy: "integration-plugins",
      },
      recordError: null,
    });
  });

  it("reads a manifest full of unrelated product-dev keys without complaint", () => {
    writeManifest("testbench", {
      schema_version: 1,
      slug: "testbench",
      title: "TestBench",
      current_stage: "align",
      stages: { prd: { status: "done", artifact: "prd.md" } },
      id_code: "TB",
      id_counters: { FR: 19, NFR: 8 },
      spikes: [{ issue: 408, status: "resolved" }],
      lifecycle: { archived: true },
    });

    const read = readSpecLifecycle(repo, "testbench");
    expect(read.recordError).toBeNull();
    expect(read.lifecycle).toEqual({ archived: true });
  });

  // SATCA-TC-039
  it("reads a spec folder with no manifest as live, with no error", () => {
    specDir("no-manifest");

    expect(readSpecLifecycle(repo, "no-manifest")).toEqual({
      lifecycle: null,
      recordError: null,
    });
  });

  it("reads a spec folder that does not exist at all as live", () => {
    expect(readSpecLifecycle(repo, "never-created")).toEqual({
      lifecycle: null,
      recordError: null,
    });
  });

  // SATCA-TC-040
  it("reads a legacy flow-state.json-only folder as live and never opens that file", () => {
    const dir = specDir("global-bench-limit");
    const legacy = path.join(dir, "flow-state.json");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        last_completed_stage: "breakdown",
        stages_completed: ["interview", "prd"],
        re_interview_log: [],
      }),
    );

    const readFileSync = vi.spyOn(fs, "readFileSync");

    expect(readSpecLifecycle(repo, "global-bench-limit")).toEqual({
      lifecycle: null,
      recordError: null,
    });

    // The legacy file is not merely ignored after parsing; it is never opened,
    // so it cannot be misread as lifecycle state whatever it comes to contain.
    const opened = readFileSync.mock.calls.map(([p]) => String(p));
    expect(opened.some((p) => p.endsWith("flow-state.json"))).toBe(false);
    expect(opened.every((p) => p.endsWith("manifest.json"))).toBe(true);
  });

  it("reads a manifest with no lifecycle key as live", () => {
    writeManifest("stage-tracker-only", { schema_version: 1, current_stage: "prd" });

    expect(readSpecLifecycle(repo, "stage-tracker-only")).toEqual({
      lifecycle: null,
      recordError: null,
    });
  });

  it("reads an unparseable manifest as live rather than hiding the spec", () => {
    writeManifest("broken-json", "{ not json");

    expect(readSpecLifecycle(repo, "broken-json")).toEqual({
      lifecycle: null,
      recordError: null,
    });
  });

  it("reads a non-object manifest as live", () => {
    writeManifest("array-manifest", [{ archived: true }]);

    expect(readSpecLifecycle(repo, "array-manifest")).toEqual({
      lifecycle: null,
      recordError: null,
    });
  });

  // SATCA-TC-041 (reader half): present-but-malformed degrades, never hides.
  it.each([
    [{ archived: false }, "archived"],
    [{ archived: true, reason: "" }, "reason"],
    [{ archived: true, supersededBy: "../escape" }, "supersededBy"],
    [{ archived: true, retired: true }, ""],
    [{ reason: "no flag" }, "archived"],
    ["archived", ""],
  ])("reports a field-named recordError for the malformed record %j", (record, field) => {
    writeManifest("malformed", { schema_version: 1, lifecycle: record });

    const read = readSpecLifecycle(repo, "malformed");
    expect(read.lifecycle).toBeNull();
    expect(read.recordError).not.toBeNull();
    if (field !== "") {
      expect(read.recordError).toContain(field);
    }
  });

  it("treats an explicit null lifecycle as a malformed record, not as live", () => {
    writeManifest("null-lifecycle", { schema_version: 1, lifecycle: null });

    const read = readSpecLifecycle(repo, "null-lifecycle");
    expect(read.lifecycle).toBeNull();
    expect(read.recordError).not.toBeNull();
  });

  it("never writes: the spec folder is untouched by a read", () => {
    const dir = specDir("read-only");
    writeManifest("read-only", { schema_version: 1, lifecycle: { archived: true } });
    const before = fs.readdirSync(dir).sort();
    const bytes = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");

    readSpecLifecycle(repo, "read-only");

    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).toBe(bytes);
  });

  describe("path safety (SATCA-NFR-001)", () => {
    it.each([["../escape"], ["nested/slug"], [".."], ["."], [""], ["Upper"]])(
      "rejects the unsafe slug %j before any fs call",
      (slug) => {
        const readFileSync = vi.spyOn(fs, "readFileSync");
        expect(() => readSpecLifecycle(repo, slug)).toThrow(UnsafePathError);
        expect(readFileSync).not.toHaveBeenCalled();
      },
    );

    it("rejects a non-string slug", () => {
      expect(() => readSpecLifecycle(repo, undefined as unknown as string)).toThrow(
        UnsafePathError,
      );
    });

    it("rejects a manifest.json symlinked outside the repo (realpath barrier)", () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lifecycle-outside-"));
      const foreign = path.join(outside, "manifest.json");
      fs.writeFileSync(foreign, JSON.stringify({ lifecycle: { archived: true } }));
      try {
        fs.symlinkSync(foreign, path.join(specDir("escaping"), "manifest.json"));

        expect(() => readSpecLifecycle(repo, "escaping")).toThrow(UnsafePathError);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("rejects a spec folder symlinked outside the repo (realpath barrier)", () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lifecycle-outside-"));
      fs.writeFileSync(
        path.join(outside, "manifest.json"),
        JSON.stringify({ lifecycle: { archived: true } }),
      );
      try {
        fs.mkdirSync(path.join(repo, ".specifications"), { recursive: true });
        fs.symlinkSync(outside, path.join(repo, ".specifications", "escaping-dir"));

        expect(() => readSpecLifecycle(repo, "escaping-dir")).toThrow(UnsafePathError);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
