import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ManifestUnreadableError,
  SpecFolderNotFoundError,
  writeSpecLifecycle,
} from "./testbench-spec-lifecycle-write.js";
import { readSpecLifecycle } from "./testbench-spec-lifecycle.js";
import { UnsafePathError } from "./safe-path.js";

// #773, SATCA-FR-020/FR-021, SATCA-TC-047/048/049/050, SATCA-NFR-001/NFR-003.
// The manifest half of the LifecycleWriter, exercised against a real temp repo
// (no fs mocking: the merge-write and the temp-then-rename are the behaviour
// under test, so they run for real).

let repo: string;

function specDir(slug: string): string {
  const dir = path.join(repo, ".specifications", slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestFile(slug: string): string {
  return path.join(repo, ".specifications", slug, "manifest.json");
}

function writeManifest(slug: string, manifest: unknown): string {
  const target = path.join(specDir(slug), "manifest.json");
  fs.writeFileSync(
    target,
    typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return target;
}

function readManifest(slug: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(manifestFile(slug), "utf8")) as Record<string, unknown>;
}

// A realistic product-dev manifest: every key the real
// `.specifications/spec-and-test-case-archival/manifest.json` carries, plus an
// unrecognised custom key no released Roubo knows about (SATCA-TC-049).
function fullManifest(slug: string): Record<string, unknown> {
  return {
    schema_version: 1,
    slug,
    title: "Spec and test-case archival",
    created_at: "2026-08-06T01:07:49Z",
    updated_at: "2026-08-06T10:33:17Z",
    current_stage: "align",
    stages: {
      interview: { status: "done", artifact: "brief.md", updated_at: "2026-08-06T01:07:49Z" },
      prd: { status: "done", artifact: "prd.md", updated_at: "2026-08-06T03:11:02Z" },
    },
    id_counters: { FR: 30, NFR: 8, US: 12, TC: 50 },
    scope: "increment",
    spikes: [{ issue: 781, status: "resolved" }],
    flow_vcs_suppressed: false,
    id_code: "SATCA",
    design_root: "roubo",
    // The unrecognised key: a future product-dev field, or a hand-added one.
    a_key_roubo_has_never_heard_of: { nested: ["values", 42], keep: true },
  };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lifecycle-write-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("writeSpecLifecycle: minimal manifest creation (SATCA-TC-048)", () => {
  it("creates a manifest carrying only the slug, the archived state, and the timestamp", () => {
    specDir("brand-new");
    expect(fs.existsSync(manifestFile("brand-new"))).toBe(false);

    const written = writeSpecLifecycle(repo, "brand-new", { archived: true });

    expect(written).toBe(manifestFile("brand-new"));
    // S001-O01: a manifest now exists in the spec folder.
    expect(fs.existsSync(manifestFile("brand-new"))).toBe(true);

    const manifest = readManifest("brand-new");
    // S001-O02: it records the archived state and the folder slug.
    expect(manifest.slug).toBe("brand-new");
    expect(manifest.lifecycle).toEqual({ archived: true });
    // S001-O03: it asserts NOTHING the application cannot know. Stage progress,
    // id counters, the schema version and the spike list are product-dev's to
    // mint, so exactly three keys are present and no more.
    expect(Object.keys(manifest).sort()).toEqual(["lifecycle", "slug", "updated_at"]);
    expect(typeof manifest.updated_at).toBe("string");
  });

  it("records a reason and a superseding slug when supplied", () => {
    specDir("legacy-thing");

    writeSpecLifecycle(repo, "legacy-thing", {
      archived: true,
      reason: "Folded into the integration-plugins spec.",
      supersededBy: "integration-plugins",
    });

    expect(readManifest("legacy-thing").lifecycle).toEqual({
      archived: true,
      reason: "Folded into the integration-plugins spec.",
      supersededBy: "integration-plugins",
    });
  });

  it("writes a record the reader reads back unchanged", () => {
    specDir("round-trip");

    writeSpecLifecycle(repo, "round-trip", { archived: true, supersededBy: "successor-spec" });

    expect(readSpecLifecycle(repo, "round-trip")).toEqual({
      lifecycle: { archived: true, supersededBy: "successor-spec" },
      recordError: null,
    });
  });
});

describe("writeSpecLifecycle: merge-write key preservation (SATCA-TC-049)", () => {
  it("preserves every pre-existing key, including one it does not recognise", () => {
    const before = fullManifest("spec-and-test-case-archival");
    writeManifest("spec-and-test-case-archival", before);

    writeSpecLifecycle(repo, "spec-and-test-case-archival", {
      archived: true,
      reason: "Shipped in #212, all issues closed",
    });

    const after = readManifest("spec-and-test-case-archival");

    // S001-O01: every pre-existing key is still present and unchanged.
    for (const key of Object.keys(before)) {
      if (key === "updated_at") continue;
      expect(after[key], `key "${key}" survived the merge-write`).toEqual(before[key]);
    }
    // S001-O02: the unrecognised custom key survived verbatim, nested values and all.
    expect(after.a_key_roubo_has_never_heard_of).toEqual({
      nested: ["values", 42],
      keep: true,
    });
    // S001-O03: only the lifecycle record and the timestamp changed.
    expect(after.lifecycle).toEqual({
      archived: true,
      reason: "Shipped in #212, all issues closed",
    });
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "lifecycle"].sort());
  });

  it("does not round-trip the manifest through the lifecycle schema", () => {
    // The narrow record schema is `.strict()`; serializing FROM it would drop
    // every sibling. Assert the counters and the spike list specifically, since
    // those are the keys a schema round-trip would silently eat.
    writeManifest("counters", {
      slug: "counters",
      id_counters: { FR: 30, TC: 50 },
      spikes: [{ issue: 781 }],
    });

    writeSpecLifecycle(repo, "counters", { archived: true });

    const after = readManifest("counters");
    expect(after.id_counters).toEqual({ FR: 30, TC: 50 });
    expect(after.spikes).toEqual([{ issue: 781 }]);
  });

  it("replaces an existing lifecycle record in place rather than merging into it", () => {
    writeManifest("re-archived", {
      slug: "re-archived",
      lifecycle: { archived: true, reason: "an older reason", supersededBy: "old-target" },
    });

    writeSpecLifecycle(repo, "re-archived", { archived: true, reason: "a newer reason" });

    // No stale supersededBy left behind from the previous record.
    expect(readManifest("re-archived").lifecycle).toEqual({
      archived: true,
      reason: "a newer reason",
    });
  });

  it("keeps the file 2-space-indented with a trailing newline, as product-dev writes it", () => {
    writeManifest("formatting", { slug: "formatting", title: "Formatting" });

    writeSpecLifecycle(repo, "formatting", { archived: true });

    const raw = fs.readFileSync(manifestFile("formatting"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "slug": "formatting"');
  });

  it("refuses to clobber a manifest it cannot parse", () => {
    writeManifest("broken", "{ this is not json");

    expect(() => writeSpecLifecycle(repo, "broken", { archived: true })).toThrow(
      ManifestUnreadableError,
    );
    // The reviewer's file is left exactly as it was.
    expect(fs.readFileSync(manifestFile("broken"), "utf8")).toBe("{ this is not json");
  });

  it("refuses to clobber a manifest that is a JSON array", () => {
    writeManifest("arrayed", [1, 2, 3]);

    expect(() => writeSpecLifecycle(repo, "arrayed", { archived: true })).toThrow(
      ManifestUnreadableError,
    );
  });

  it("refuses to clobber a manifest it cannot READ, rather than creating a minimal one", () => {
    // A present-but-unreadable manifest is the dangerous case, and the one an
    // ENOENT-blind catch gets wrong: rename needs only write permission on the
    // DIRECTORY, so treating an EACCES read as "this folder has no manifest"
    // would replace every product-dev key with a three-key minimal file.
    const before = fullManifest("unreadable");
    writeManifest("unreadable", before);
    const target = manifestFile("unreadable");

    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest) => {
      if (p === target) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);

    expect(() => writeSpecLifecycle(repo, "unreadable", { archived: true })).toThrow(
      ManifestUnreadableError,
    );

    vi.restoreAllMocks();
    // Byte-identical: nothing was written, nothing was renamed over it.
    expect(readManifest("unreadable")).toEqual(before);
  });
});

describe("writeSpecLifecycle: reversal (SATCA-TC-050 S003/S004)", () => {
  it("removes the lifecycle key entirely, so the spec reads live again", () => {
    specDir("reversible");

    writeSpecLifecycle(repo, "reversible", { archived: true, reason: "archived by mistake" });
    expect(readSpecLifecycle(repo, "reversible").lifecycle).toEqual({
      archived: true,
      reason: "archived by mistake",
    });

    writeSpecLifecycle(repo, "reversible", null);

    const after = readManifest("reversible");
    // The key is GONE, not set to a false-ish record: absence is the live state.
    expect(Object.prototype.hasOwnProperty.call(after, "lifecycle")).toBe(false);
    expect(readSpecLifecycle(repo, "reversible")).toEqual({ lifecycle: null, recordError: null });
  });

  it("drops the superseding pointer on reversal without touching its siblings", () => {
    const before = fullManifest("superseded-spec");
    writeManifest("superseded-spec", before);

    writeSpecLifecycle(repo, "superseded-spec", { archived: true, supersededBy: "successor" });
    expect(readSpecLifecycle(repo, "superseded-spec").lifecycle?.supersededBy).toBe("successor");

    writeSpecLifecycle(repo, "superseded-spec", null);

    const after = readManifest("superseded-spec");
    expect(Object.prototype.hasOwnProperty.call(after, "lifecycle")).toBe(false);
    expect(after.id_counters).toEqual(before.id_counters);
    expect(after.a_key_roubo_has_never_heard_of).toEqual(before.a_key_roubo_has_never_heard_of);
  });

  it("clearing an already-live spec is a no-op that still leaves a valid manifest", () => {
    writeManifest("never-archived", { slug: "never-archived", current_stage: "prd" });

    writeSpecLifecycle(repo, "never-archived", null);

    const after = readManifest("never-archived");
    expect(Object.prototype.hasOwnProperty.call(after, "lifecycle")).toBe(false);
    expect(after.current_stage).toBe("prd");
  });
});

describe("writeSpecLifecycle: durability (SATCA-NFR-003)", () => {
  it("leaves the previous manifest intact when the write is interrupted", () => {
    const before = fullManifest("interrupted");
    writeManifest("interrupted", before);
    const original = fs.readFileSync(manifestFile("interrupted"), "utf8");

    // Fail at the rename, i.e. after the temp file is fully written. The
    // temp-then-rename is what makes this survivable: the real manifest was
    // never opened for writing.
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated crash during rename");
    });

    expect(() => writeSpecLifecycle(repo, "interrupted", { archived: true })).toThrow(
      "simulated crash during rename",
    );
    expect(fs.readFileSync(manifestFile("interrupted"), "utf8")).toBe(original);
  });

  it("writes its temp file inside the spec folder, so the rename can never cross devices", () => {
    specDir("same-device");
    const seen: string[] = [];
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      file: Parameters<typeof fs.writeFileSync>[0],
      data: Parameters<typeof fs.writeFileSync>[1],
      options?: Parameters<typeof fs.writeFileSync>[2],
    ) => {
      seen.push(String(file));
      return realWrite(file, data, options);
    }) as typeof fs.writeFileSync);

    writeSpecLifecycle(repo, "same-device", { archived: true });

    expect(seen).toEqual([path.join(repo, ".specifications", "same-device", "manifest.json.tmp")]);
  });
});

describe("writeSpecLifecycle: path safety (SATCA-NFR-001)", () => {
  it("rejects a traversal slug before touching the filesystem", () => {
    expect(() => writeSpecLifecycle(repo, "..", { archived: true })).toThrow(UnsafePathError);
    expect(() => writeSpecLifecycle(repo, "../escape", { archived: true })).toThrow(
      UnsafePathError,
    );
    expect(() => writeSpecLifecycle(repo, "nested/slug", { archived: true })).toThrow(
      UnsafePathError,
    );
  });

  it("rejects a spec folder symlinked out of the repository", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lifecycle-outside-"));
    try {
      fs.mkdirSync(path.join(repo, ".specifications"), { recursive: true });
      fs.symlinkSync(outside, path.join(repo, ".specifications", "escaped"), "dir");

      expect(() => writeSpecLifecycle(repo, "escaped", { archived: true })).toThrow(
        UnsafePathError,
      );
      expect(fs.existsSync(path.join(outside, "manifest.json"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to invent a spec folder that does not exist", () => {
    expect(() => writeSpecLifecycle(repo, "no-such-spec", { archived: true })).toThrow(
      SpecFolderNotFoundError,
    );
    expect(fs.existsSync(path.join(repo, ".specifications", "no-such-spec"))).toBe(false);
  });

  it("rejects a record that fails the published schema before writing anything", () => {
    specDir("guarded");

    expect(() =>
      writeSpecLifecycle(repo, "guarded", {
        archived: true,
        supersededBy: "../../etc/passwd",
      } as never),
    ).toThrow(TypeError);
    expect(fs.existsSync(manifestFile("guarded"))).toBe(false);
  });
});
