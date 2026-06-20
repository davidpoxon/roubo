import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfiguredSource, PaginatedIssues } from "@roubo/shared";
import {
  DiskSnapshotStore,
  buildCacheKey,
  hashCacheKey,
  normalizeInstanceEndpoint,
  hashInstanceEndpoint,
  CACHE_SCHEMA_VERSION,
  PER_ENTRY_MAX_BYTES,
  type CacheKeyInput,
  type DiscardLogEvent,
  type DiskCacheEntry,
} from "./disk-snapshot-store.js";

let baseDir: string;
let discards: DiscardLogEvent[];
let store: DiskSnapshotStore;

function makeStore(): DiskSnapshotStore {
  return new DiskSnapshotStore({ baseDir, onDiscard: (e) => discards.push(e) });
}

const baseInput: CacheKeyInput = {
  pluginId: "github-com",
  pluginVersion: "1.0.0",
  instanceEndpoint: null,
  projectId: "p1",
  sources: [{ kind: "repo", externalId: "foo/bar" }],
  filters: { labels: ["bug", "feature"], search: "login" },
  excludedStatusCategories: ["Done"],
  excludedStatuses: ["Closed"],
  sortBy: null,
  sortDir: null,
  pageSize: 50,
};

function response(items: string[] = ["1", "2"]): PaginatedIssues {
  return {
    items: items.map((id) => ({
      integrationId: "github-com",
      externalId: id,
      externalUrl: `https://github.com/org/repo/issues/${id}`,
      title: `Issue ${id}`,
      body: null,
      currentState: "open",
      allowedTransitions: [],
      assignees: [],
      labels: [],
      issueType: null,
      blocks: [],
      blockedBy: [],
      updatedAt: "2024-01-01T00:00:00Z",
      raw: null,
    })),
    nextCursor: "next",
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-disk-cache-"));
  discards = [];
  store = makeStore();
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("normalizeInstanceEndpoint", () => {
  it("lowercases host, keeps scheme, drops a lone trailing slash", () => {
    expect(normalizeInstanceEndpoint("https://Jira-A.Example.com/")).toBe(
      "https://jira-a.example.com",
    );
    expect(normalizeInstanceEndpoint("https://jira-a.example.com")).toBe(
      "https://jira-a.example.com",
    );
  });

  it("collapses a fixed-host plugin (no instance) to the empty canonical form", () => {
    expect(normalizeInstanceEndpoint(null)).toBe("");
    expect(normalizeInstanceEndpoint(undefined)).toBe("");
    expect(normalizeInstanceEndpoint("   ")).toBe("");
  });

  it("never embeds the raw endpoint in the hash and distinguishes instances", () => {
    const a = hashInstanceEndpoint("https://jira-a.example.com");
    const b = hashInstanceEndpoint("https://jira-b.example.com");
    expect(a).not.toContain("jira-a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildCacheKey / hashCacheKey canonicalisation", () => {
  it("is order-insensitive for sources and labels (same hash)", () => {
    const k1 = buildCacheKey(baseInput);
    const reordered: CacheKeyInput = {
      ...baseInput,
      sources: [
        { kind: "repo", externalId: "b/b" },
        { kind: "repo", externalId: "a/a" },
      ],
      filters: { labels: ["feature", "bug"], search: "login" },
    };
    const k2 = buildCacheKey({
      ...reordered,
      sources: [
        { kind: "repo", externalId: "a/a" },
        { kind: "repo", externalId: "b/b" },
      ],
    });
    const k3 = buildCacheKey(reordered);
    // labels reorder must not change the hash
    expect(hashCacheKey(k2)).toBe(hashCacheKey(k3));
    // baseInput differs from the (a/a,b/b) set
    expect(hashCacheKey(k1)).not.toBe(hashCacheKey(k2));
  });

  it("collapses present-but-empty filters identically to absent (null)", () => {
    const withEmpty = buildCacheKey({ ...baseInput, filters: { labels: [], search: "   " } });
    const absent = buildCacheKey({ ...baseInput, filters: undefined });
    expect(withEmpty.filters).toBeNull();
    expect(hashCacheKey(withEmpty)).toBe(hashCacheKey(absent));
  });

  it("dedupes and sorts excluded* and label lists", () => {
    const k = buildCacheKey({
      ...baseInput,
      excludedStatusCategories: ["Done", "Done", "Active"],
      excludedStatuses: ["b", "a", "a"],
      filters: { labels: ["z", "a", "z"] },
    });
    expect(k.excludedStatusCategories).toEqual(["Active", "Done"]);
    expect(k.excludedStatuses).toEqual(["a", "b"]);
    expect(k.filters?.labels).toEqual(["a", "z"]);
  });

  it("embeds the schema version as field 12", () => {
    expect(buildCacheKey(baseInput).cacheSchemaVersion).toBe(CACHE_SCHEMA_VERSION);
  });
});

describe("get/put round-trip and the HIT case", () => {
  it("persists a first page and serves it (survives a fresh store instance / restart)", () => {
    const key = buildCacheKey(baseInput);
    store.put(key, response(["1", "2"]));

    // A brand-new store instance pointed at the same dir = an app restart.
    const restarted = makeStore();
    const hit = restarted.get(key);
    expect(hit).not.toBeNull();
    expect(hit?.response.items.map((i) => i.externalId)).toEqual(["1", "2"]);
    expect(hit?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("HIT: re-issuing the same logical query with reordered sources/labels hits the same file", () => {
    store.put(buildCacheKey(baseInput), response(["a"]));
    const reordered = buildCacheKey({
      ...baseInput,
      sources: [
        { kind: "repo", externalId: "foo/bar" },
        // single source; reorder is trivially the same, so add a label reorder
      ],
      filters: { labels: ["feature", "bug"], search: "login" },
    });
    const hit = store.get(reordered);
    expect(hit?.response.items.map((i) => i.externalId)).toEqual(["a"]);
  });
});

describe("invalidation matrix M1-M12 (each keyed change is a miss, baseline intact)", () => {
  const cases: Array<{ name: string; mutate: (i: CacheKeyInput) => CacheKeyInput }> = [
    { name: "M1 pluginId", mutate: (i) => ({ ...i, pluginId: "gitlab-com" }) },
    { name: "M2 pluginVersion", mutate: (i) => ({ ...i, pluginVersion: "2.0.0" }) },
    {
      name: "M3 instanceHash",
      mutate: (i) => ({ ...i, instanceEndpoint: "https://jira-b.example.com" }),
    },
    { name: "M4 projectId", mutate: (i) => ({ ...i, projectId: "p2" }) },
    {
      name: "M5 sources",
      mutate: (i) => ({ ...i, sources: [{ kind: "repo", externalId: "other/repo" }] }),
    },
    {
      name: "M6 filters",
      mutate: (i) => ({ ...i, filters: { labels: ["different"], search: "login" } }),
    },
    {
      name: "M7 excludedStatusCategories",
      mutate: (i) => ({ ...i, excludedStatusCategories: ["Active"] }),
    },
    { name: "M8 excludedStatuses", mutate: (i) => ({ ...i, excludedStatuses: ["Open"] }) },
    { name: "M9 sortBy", mutate: (i) => ({ ...i, sortBy: "priority" }) },
    { name: "M10 sortDir", mutate: (i) => ({ ...i, sortDir: "desc" }) },
    { name: "M11 pageSize", mutate: (i) => ({ ...i, pageSize: 25 }) },
  ];

  for (const c of cases) {
    it(`${c.name}: changing it misses, baseline entry stays addressable`, () => {
      const baseKey = buildCacheKey(baseInput);
      store.put(baseKey, response(["base"]));
      const changedKey = buildCacheKey(c.mutate(baseInput));

      expect(store.get(changedKey)).toBeNull();
      // baseline intact and still served under its own key
      const base = store.get(baseKey);
      expect(base?.response.items.map((i) => i.externalId)).toEqual(["base"]);
    });
  }

  it("M5: reordering sources alone does NOT miss (canonical sort)", () => {
    const twoSources: ConfiguredSource[] = [
      { kind: "repo", externalId: "a/a" },
      { kind: "repo", externalId: "b/b" },
    ];
    const k1 = buildCacheKey({ ...baseInput, sources: twoSources });
    store.put(k1, response(["x"]));
    const k2 = buildCacheKey({ ...baseInput, sources: [...twoSources].reverse() });
    expect(store.get(k2)?.response.items[0].externalId).toBe("x");
  });

  it("M12: bumping cacheSchemaVersion misses every prior entry at once", () => {
    const baseKey = buildCacheKey(baseInput);
    store.put(baseKey, response());
    // Simulate a schema bump by reading the file under a key whose version differs.
    const bumped = { ...baseKey, cacheSchemaVersion: baseKey.cacheSchemaVersion + 1 };
    expect(store.get(bumped)).toBeNull();
  });
});

describe("load-time rejection rows L1 / L2", () => {
  it("L1: a stored cacheSchemaVersion older than current is a cold miss, file discarded", () => {
    const key = buildCacheKey(baseInput);
    store.put(key, response());
    // Hand-tamper the on-disk entry to an older schema version.
    const file = path.join(baseDir, "p1", `${hashCacheKey(key)}.json`);
    const entry = JSON.parse(fs.readFileSync(file, "utf-8")) as DiskCacheEntry;
    entry.cacheSchemaVersion = CACHE_SCHEMA_VERSION - 1;
    fs.writeFileSync(file, JSON.stringify(entry));

    expect(store.get(key)).toBeNull();
    expect(discards.some((d) => d.trigger === "schema-version-mismatch")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // A fresh put writes a clean file again.
    store.put(key, response(["fresh"]));
    expect(store.get(key)?.response.items[0].externalId).toBe("fresh");
  });

  it("L1: a stored pluginVersion mismatch is a cold miss", () => {
    const key = buildCacheKey(baseInput);
    store.put(key, response());
    const file = path.join(baseDir, "p1", `${hashCacheKey(key)}.json`);
    const entry = JSON.parse(fs.readFileSync(file, "utf-8")) as DiskCacheEntry;
    entry.pluginVersion = "9.9.9";
    fs.writeFileSync(file, JSON.stringify(entry));
    expect(store.get(key)).toBeNull();
    expect(discards.some((d) => d.trigger === "plugin-version-mismatch")).toBe(true);
  });

  it("L2: a corrupt / partial / truncated file is a cold miss, never fatal, fresh file written", () => {
    const key = buildCacheKey(baseInput);
    store.put(key, response());
    const file = path.join(baseDir, "p1", `${hashCacheKey(key)}.json`);
    fs.writeFileSync(file, '{"cacheSchemaVersion":1,"response":'); // truncated JSON

    expect(() => store.get(key)).not.toThrow();
    expect(store.get(key)).toBeNull();
    expect(discards.some((d) => d.trigger === "corrupt")).toBe(true);

    store.put(key, response(["recovered"]));
    expect(store.get(key)?.response.items[0].externalId).toBe("recovered");
  });

  it("L2: invalid-UTF-8 / zeroed bytes are a cold miss, not a throw", () => {
    const key = buildCacheKey(baseInput);
    store.put(key, response());
    const file = path.join(baseDir, "p1", `${hashCacheKey(key)}.json`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x00]));
    expect(() => store.get(key)).not.toThrow();
    expect(store.get(key)).toBeNull();
  });

  it("a starting app with a corrupt file present does not error (get returns null)", () => {
    const key = buildCacheKey(baseInput);
    fs.mkdirSync(path.join(baseDir, "p1"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "p1", `${hashCacheKey(key)}.json`), "not json at all");
    const fresh = makeStore();
    expect(fresh.get(key)).toBeNull();
  });
});

describe("over-age read rejection (7-day max)", () => {
  it("treats an entry older than the max age as a cold miss and discards it", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const key = buildCacheKey(baseInput);
      store.put(key, response());
      // Advance 8 days.
      vi.setSystemTime(new Date("2026-01-09T00:00:00.000Z"));
      expect(store.get(key)).toBeNull();
      expect(discards.some((d) => d.trigger === "over-age")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("security invariants (CLI-NFR-001)", () => {
  it("writes the cache file with mode 0600", () => {
    const key = buildCacheKey(baseInput);
    store.put(key, response());
    const file = path.join(baseDir, "p1", `${hashCacheKey(key)}.json`);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("the serialised entry contains no credential / token field names", () => {
    const key = buildCacheKey(baseInput);
    store.put(key, response());
    const file = path.join(baseDir, "p1", `${hashCacheKey(key)}.json`);
    const raw = fs.readFileSync(file, "utf-8").toLowerCase();
    for (const banned of [
      "token",
      "secret",
      "password",
      "credential",
      "apikey",
      "api_key",
      "bearer",
      "authorization",
    ]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("the on-disk key never embeds the raw instance endpoint", () => {
    const key = buildCacheKey({
      ...baseInput,
      instanceEndpoint: "https://jira-secret.example.com",
    });
    store.put(key, response());
    const file = path.join(baseDir, "p1", `${hashCacheKey(key)}.json`);
    expect(fs.readFileSync(file, "utf-8")).not.toContain("jira-secret");
  });
});

describe("eviction policy (CLI-FR-004)", () => {
  it("per-entry cap: an over-1MB serialised entry is skipped (not persisted), logged", () => {
    const key = buildCacheKey(baseInput);
    const huge = response();
    huge.items[0].body = "x".repeat(PER_ENTRY_MAX_BYTES + 1);
    store.put(key, huge);
    expect(store.get(key)).toBeNull();
    expect(discards.some((d) => d.trigger === "over-entry-cap")).toBe(true);
  });

  it("age sweep on put: an aged entry is removed when a later put runs", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const oldKey = buildCacheKey({ ...baseInput, pageSize: 10 });
      store.put(oldKey, response(["old"]));
      const oldFile = path.join(baseDir, "p1", `${hashCacheKey(oldKey)}.json`);
      expect(fs.existsSync(oldFile)).toBe(true);

      vi.setSystemTime(new Date("2026-01-09T00:00:00.000Z"));
      const newKey = buildCacheKey({ ...baseInput, pageSize: 20 });
      store.put(newKey, response(["new"]));

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(discards.some((d) => d.trigger === "age-swept")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("total-bound LRU: evicts least-recently-used entries by mtime when the bound would be exceeded", () => {
    // Inject a tiny total bound so a couple of entries trip it. Each entry is a
    // few hundred bytes, so a 1500-byte bound holds ~1-2 entries.
    const tiny = new DiskSnapshotStore({
      baseDir,
      onDiscard: (e) => discards.push(e),
      totalMaxBytes: 1500,
    });
    const k1 = buildCacheKey({ ...baseInput, pageSize: 11 });
    const k2 = buildCacheKey({ ...baseInput, pageSize: 12 });
    const k3 = buildCacheKey({ ...baseInput, pageSize: 13 });
    tiny.put(k1, response(["one"]));
    tiny.put(k2, response(["two"]));
    tiny.put(k3, response(["three"]));

    // The oldest entry (k1) was evicted to make room; the newest survives.
    expect(discards.some((d) => d.trigger === "lru-evicted")).toBe(true);
    expect(tiny.get(k3)?.response.items[0].externalId).toBe("three");
    expect(tiny.get(k1)).toBeNull();
  });

  it("under the total bound, no LRU eviction happens", () => {
    const k1 = buildCacheKey({ ...baseInput, pageSize: 11 });
    const k2 = buildCacheKey({ ...baseInput, pageSize: 12 });
    store.put(k1, response(["one"]));
    store.put(k2, response(["two"]));
    expect(store.get(k1)?.response.items[0].externalId).toBe("one");
    expect(store.get(k2)?.response.items[0].externalId).toBe("two");
    expect(discards.some((d) => d.trigger === "lru-evicted")).toBe(false);
  });
});

describe("evictProject / evictPlugin (exposed for the lifecycle slice)", () => {
  it("evictProject removes the whole project subdirectory", () => {
    store.put(buildCacheKey(baseInput), response());
    store.put(buildCacheKey({ ...baseInput, projectId: "p2" }), response());
    store.evictProject("p1");
    expect(store.get(buildCacheKey(baseInput))).toBeNull();
    // p2 untouched
    expect(store.get(buildCacheKey({ ...baseInput, projectId: "p2" }))).not.toBeNull();
    expect(discards.some((d) => d.trigger === "project-evicted" && d.projectId === "p1")).toBe(
      true,
    );
  });

  it("evictProject is a no-op for an unsafe projectId", () => {
    expect(() => store.evictProject("../escape")).not.toThrow();
  });

  it("evictPlugin removes every entry owned by the plugin across projects", () => {
    store.put(buildCacheKey(baseInput), response()); // github-com, p1
    store.put(buildCacheKey({ ...baseInput, projectId: "p2" }), response()); // github-com, p2
    store.put(buildCacheKey({ ...baseInput, pluginId: "gitlab-com" }), response()); // gitlab, p1

    store.evictPlugin("github-com");

    expect(store.get(buildCacheKey(baseInput))).toBeNull();
    expect(store.get(buildCacheKey({ ...baseInput, projectId: "p2" }))).toBeNull();
    expect(store.get(buildCacheKey({ ...baseInput, pluginId: "gitlab-com" }))).not.toBeNull();
    expect(discards.some((d) => d.trigger === "plugin-evicted")).toBe(true);
  });
});

describe("unsafe projectId bypass", () => {
  it("get returns null and put is a no-op for a projectId that fails PROJECT_ID_RE", () => {
    const key = buildCacheKey({ ...baseInput, projectId: "../evil" });
    store.put(key, response());
    expect(store.get(key)).toBeNull();
  });
});
