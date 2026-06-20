import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedIssue } from "@roubo/shared";

vi.mock("./plugin-manager.js", () => ({
  invoke: vi.fn(),
  getRecord: vi.fn(),
}));

vi.mock("./plugin-activation.js", () => ({
  resolveSources: vi.fn(),
  resolveExclusion: vi.fn(),
  resolveInstanceEndpoint: vi.fn(),
}));

import * as pluginManager from "./plugin-manager.js";
import * as pluginActivation from "./plugin-activation.js";
import {
  CutListQueryService,
  defaultDiscard,
  type CacheObserveEvent,
} from "./cut-list-query-service.js";
import { DiskSnapshotStore } from "./disk-snapshot-store.js";

/**
 * Drain pending microtasks/macrotasks so the fire-and-forget background
 * revalidation (a `void run().catch(...)`) settles before assertions. Two
 * `setImmediate` ticks cover the `await invoke` plus the `.catch` continuation.
 */
async function flushBackground(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const active = { pluginId: "github-com", integrationId: "github-com", pageSize: 50 };

function makeIssue(overrides: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "1",
    externalUrl: "https://github.com/org/repo/issues/1",
    title: "Issue",
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
    ...overrides,
  };
}

let baseDir: string;
let service: CutListQueryService;
let observed: CacheObserveEvent[];
let onObserve: (e: CacheObserveEvent) => void;

beforeEach(() => {
  vi.resetAllMocks();
  observed = [];
  onObserve = (e) => observed.push(e);
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-cls-"));
  vi.mocked(pluginActivation.resolveSources).mockReturnValue([
    { kind: "repo", externalId: "foo/bar" },
  ]);
  vi.mocked(pluginActivation.resolveExclusion).mockReturnValue({
    excludedStatusCategories: [],
    excludedStatuses: [],
  });
  vi.mocked(pluginActivation.resolveInstanceEndpoint).mockReturnValue(null);
  vi.mocked(pluginManager.getRecord).mockReturnValue({
    id: "github-com",
    status: "enabled",
    manifest: { name: "GitHub.com", version: "1.0.0" },
  } as unknown as ReturnType<typeof pluginManager.getRecord>);
  service = new CutListQueryService({
    disk: new DiskSnapshotStore({ baseDir }),
    bypassDisk: false,
    onObserve,
  });
});

afterEach(async () => {
  // Let any fire-and-forget background revalidation settle before the next test
  // resets the mocks, so a late `.catch` never runs against torn-down state.
  await flushBackground();
});

describe("buildListParams", () => {
  it("resolves sources + exclusion and drops empty filters", () => {
    vi.mocked(pluginActivation.resolveExclusion).mockReturnValue({
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed"],
    });
    const params = service.buildListParams("p1", { cursor: null, pageSize: 50, filters: {} });
    expect(params).toEqual({
      sources: [{ kind: "repo", externalId: "foo/bar" }],
      cursor: null,
      pageSize: 50,
      filters: undefined,
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed"],
    });
  });

  it("forwards non-empty filters", () => {
    const params = service.buildListParams("p1", {
      cursor: null,
      pageSize: 50,
      filters: { labels: ["bug"], search: "x" },
    });
    expect(params.filters).toEqual({ labels: ["bug"], search: "x" });
  });
});

describe("queryFirstOrPage delegation + disk miss/hit", () => {
  it("on a disk miss, invokes listIssues with the resolved params and reports disk-miss", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "1" })],
      nextCursor: "next",
    });
    const result = await service.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: { labels: ["bug"] },
    });
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "listIssues", {
      sources: [{ kind: "repo", externalId: "foo/bar" }],
      cursor: null,
      pageSize: 50,
      filters: { labels: ["bug"] },
      excludedStatusCategories: [],
      excludedStatuses: [],
    });
    expect(result.cacheStatus).toBe("miss");
    expect(result.items.map((i) => i.externalId)).toEqual(["1"]);
    expect(result.nextCursor).toBe("next");
  });

  it("serves the persisted snapshot on the next call (cacheStatus revalidating) without an extra synchronous invoke", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "cached" })],
      nextCursor: null,
    });
    const input = { cursor: null, pageSize: 50, filters: {} };
    await service.queryFirstOrPage("p1", active, input);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    const second = await service.queryFirstOrPage("p1", active, input);
    // The snapshot is served synchronously from disk; the background
    // revalidation invoke is fire-and-forget and runs after this resolves.
    expect(second.cacheStatus).toBe("revalidating");
    expect(second.items[0].externalId).toBe("cached");
    expect(second.snapshotCapturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("persistence survives a new service instance pointed at the same dir (restart)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "persisted" })],
      nextCursor: null,
    });
    await service.queryFirstOrPage("p1", active, { cursor: null, pageSize: 50, filters: {} });

    const restarted = new CutListQueryService({
      disk: new DiskSnapshotStore({ baseDir }),
      bypassDisk: false,
      onObserve,
    });
    const hit = await restarted.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
    expect(hit.cacheStatus).toBe("revalidating");
    expect(hit.items[0].externalId).toBe("persisted");
  });

  // FR-014 regression: the disk cache must not shadow the route's in-memory
  // errored/disabled stale-fallback. When the plugin is not `enabled`, a
  // first-page request must skip the disk read and run the live RPC (which on a
  // real errored plugin throws, so the route's catch serves the in-memory
  // snapshot with `stale: true`). If the disk-hit were served here instead, the
  // response would carry no `stale` marker and the client could never surface
  // the stale banner.
  it("does not serve a disk-hit when the plugin is errored: re-invokes so the route's in-memory fallback owns the stale serve", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "warm" })],
      nextCursor: null,
    });
    const input = { cursor: null, pageSize: 50, filters: {} };
    // First call (enabled) populates the disk snapshot.
    await service.queryFirstOrPage("p1", active, input);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    // Plugin goes errored. The next first-page call must NOT short-circuit on
    // the disk snapshot; it must re-invoke the RPC.
    vi.mocked(pluginManager.getRecord).mockReturnValue({
      id: "github-com",
      status: "errored",
      manifest: { name: "GitHub.com", version: "1.0.0" },
    } as unknown as ReturnType<typeof pluginManager.getRecord>);

    const result = await service.queryFirstOrPage("p1", active, input);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2); // re-invoked, not disk-served
    expect(result.cacheStatus).toBe("miss");
  });

  it("does not serve a disk-hit when the plugin is disabled", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "warm" })],
      nextCursor: null,
    });
    const input = { cursor: null, pageSize: 50, filters: {} };
    await service.queryFirstOrPage("p1", active, input);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    vi.mocked(pluginManager.getRecord).mockReturnValue({
      id: "github-com",
      status: "disabled",
      manifest: { name: "GitHub.com", version: "1.0.0" },
    } as unknown as ReturnType<typeof pluginManager.getRecord>);

    const result = await service.queryFirstOrPage("p1", active, input);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
    expect(result.cacheStatus).toBe("miss");
  });

  // With bypassDisk on (the ROUBO_E2E=1 default), the persistent disk snapshot
  // is never read or written: every first-page query goes straight to the live
  // RPC. This neutralises cross-scenario persistence inside the single-server
  // e2e harness, where a snapshot left by one spec could otherwise be served to
  // a later spec sharing the same cache key.
  it("bypasses the disk cache entirely when bypassDisk is set (e2e default)", async () => {
    const bypassed = new CutListQueryService({
      disk: new DiskSnapshotStore({ baseDir }),
      bypassDisk: true,
    });
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "live" })],
      nextCursor: null,
    });
    const input = { cursor: null, pageSize: 50, filters: {} };

    const first = await bypassed.queryFirstOrPage("p1", active, input);
    expect(first.cacheStatus).toBe("miss");
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    // A second identical first-page call re-invokes the RPC: nothing was
    // persisted, so there is no disk-hit to serve.
    const second = await bypassed.queryFirstOrPage("p1", active, input);
    expect(second.cacheStatus).toBe("miss");
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
    expect(second.snapshotCapturedAt).toBeUndefined();
  });
});

// #568: the runtime bypass toggle the ROUBO_E2E-gated
// `/test/__set-cut-list-disk-cache` route drives so the warm-snapshot journey
// (CLI-TC-017) can reach the disk path the harness bypasses by default, and the
// `restoreBypassDefault` the route's `/test/__reset` calls so a toggled spec
// never leaks the warm path into the next one. These assert the real method
// bodies (the route's own unit suite mocks the whole service, so it never runs
// them) via the observable disk hit/miss behaviour the rest of this file uses.
describe("runtime disk-cache toggle (setDiskCacheEnabled / restoreBypassDefault)", () => {
  const input = { cursor: null, pageSize: 50, filters: {} };

  it("setDiskCacheEnabled(true) un-bypasses the disk so the next first-page query persists and warm-serves", async () => {
    const svc = new CutListQueryService({
      disk: new DiskSnapshotStore({ baseDir }),
      bypassDisk: true,
      onObserve,
    });
    svc.setDiskCacheEnabled(true);
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "warm" })],
      nextCursor: null,
    });

    const first = await svc.queryFirstOrPage("p1", active, input);
    expect(first.cacheStatus).toBe("miss");
    const second = await svc.queryFirstOrPage("p1", active, input);
    expect(second.cacheStatus).toBe("revalidating");
    expect(second.items[0].externalId).toBe("warm");
  });

  it("setDiskCacheEnabled(false) re-bypasses the disk so every first-page query is a fresh miss", async () => {
    const svc = new CutListQueryService({
      disk: new DiskSnapshotStore({ baseDir }),
      bypassDisk: false,
      onObserve,
    });
    svc.setDiskCacheEnabled(false);
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "live" })],
      nextCursor: null,
    });

    const first = await svc.queryFirstOrPage("p1", active, input);
    expect(first.cacheStatus).toBe("miss");
    const second = await svc.queryFirstOrPage("p1", active, input);
    expect(second.cacheStatus).toBe("miss");
    expect(second.snapshotCapturedAt).toBeUndefined();
  });

  it("restoreBypassDefault() re-derives the bypass from ROUBO_E2E: bypassed when '1', un-bypassed otherwise", async () => {
    const prev = process.env.ROUBO_E2E;
    try {
      vi.mocked(pluginManager.invoke).mockResolvedValue({
        items: [makeIssue({ externalId: "x" })],
        nextCursor: null,
      });

      // ROUBO_E2E=1: restore bypasses the disk, so the second query re-misses.
      process.env.ROUBO_E2E = "1";
      const e2e = new CutListQueryService({
        disk: new DiskSnapshotStore({ baseDir }),
        bypassDisk: false,
        onObserve,
      });
      e2e.restoreBypassDefault();
      expect((await e2e.queryFirstOrPage("p1", active, input)).cacheStatus).toBe("miss");
      expect((await e2e.queryFirstOrPage("p1", active, input)).cacheStatus).toBe("miss");

      // ROUBO_E2E unset: restore leaves the disk active, so the second query warm-serves.
      delete process.env.ROUBO_E2E;
      const local = new CutListQueryService({
        disk: new DiskSnapshotStore({ baseDir }),
        bypassDisk: true,
        onObserve,
      });
      local.restoreBypassDefault();
      expect((await local.queryFirstOrPage("p2", active, input)).cacheStatus).toBe("miss");
      expect((await local.queryFirstOrPage("p2", active, input)).cacheStatus).toBe("revalidating");
    } finally {
      if (prev === undefined) delete process.env.ROUBO_E2E;
      else process.env.ROUBO_E2E = prev;
    }
  });
});

describe("dedup + stall-detection parity with prior route behaviour", () => {
  it("dedupes items within a page by (integrationId, externalId) (TC-023)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [
        makeIssue({ externalId: "10" }),
        makeIssue({ externalId: "10" }),
        makeIssue({ externalId: "11" }),
      ],
      nextCursor: "n2",
    });
    const result = await service.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
    expect(result.items.map((i) => i.externalId)).toEqual(["10", "11"]);
  });

  it("marks stalled and nulls nextCursor when the plugin echoes the request cursor (TC-071)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "1" })],
      nextCursor: "same",
    });
    const result = await service.queryFirstOrPage("p1", active, {
      cursor: "same",
      pageSize: 50,
      filters: {},
    });
    expect(result.stalled).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.cacheStatus).toBe("miss");
  });

  it("does not mark stalled when the cursor changes even if items repeat", async () => {
    const dup = makeIssue({ externalId: "5" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [dup, dup],
      nextCursor: "different",
    });
    const result = await service.queryFirstOrPage("p1", active, {
      cursor: "before",
      pageSize: 50,
      filters: {},
    });
    expect(result.stalled).toBeUndefined();
    expect(result.nextCursor).toBe("different");
    expect(result.items).toHaveLength(1);
  });

  it("forwards warnings and excludedCount", async () => {
    const warning = { category: "code-scanning", sourceExternalId: "foo/bar", cause: "x" };
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [],
      nextCursor: null,
      warnings: [warning],
      excludedCount: 3,
    });
    const result = await service.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
    expect(result.warnings).toEqual([warning]);
    expect(result.excludedCount).toBe(3);
  });
});

describe("first-page-only persistence", () => {
  it("a paginated request (cursor set) bypasses the disk cache entirely", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "p2" })],
      nextCursor: null,
    });
    const result = await service.queryFirstOrPage("p1", active, {
      cursor: "page-2",
      pageSize: 50,
      filters: {},
    });
    expect(result.cacheStatus).toBe("miss");
    // Nothing was written for the paginated cursor: a first-page query is still a miss.
    const firstPage = await service.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
    expect(firstPage.cacheStatus).toBe("miss");
  });

  it("propagates a plugin RPC error (no fallback in the service)", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("boom"));
    await expect(
      service.queryFirstOrPage("p1", active, { cursor: null, pageSize: 50, filters: {} }),
    ).rejects.toThrow("boom");
  });
});

// CLI-FR-002 / CLI-TC-001, CLI-TC-014: stale-while-revalidate serving.
describe("stale-while-revalidate background revalidation", () => {
  const input = { cursor: null, pageSize: 50, filters: {} };

  it("fires a background revalidation on a disk-hit and overwrites the snapshot with fresh data", async () => {
    // First call: cold miss persists the original snapshot.
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      items: [makeIssue({ externalId: "original" })],
      nextCursor: null,
    });
    await service.queryFirstOrPage("p1", active, input);

    // Second call: warm serve returns the original immediately, and the
    // background revalidation fetches fresher data.
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      items: [makeIssue({ externalId: "fresh" })],
      nextCursor: null,
    });
    const warm = await service.queryFirstOrPage("p1", active, input);
    expect(warm.cacheStatus).toBe("revalidating");
    expect(warm.items[0].externalId).toBe("original");

    // Let the fire-and-forget revalidation settle, then a third warm serve must
    // see the fresher snapshot the background write produced.
    await flushBackground();
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);

    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      items: [makeIssue({ externalId: "ignored" })],
      nextCursor: null,
    });
    const third = await service.queryFirstOrPage("p1", active, input);
    expect(third.items[0].externalId).toBe("fresh");
  });

  it("emits an NFR-009 observability event for the warm (revalidating) serve and the cold miss", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "x" })],
      nextCursor: null,
    });
    await service.queryFirstOrPage("p1", active, input);
    await service.queryFirstOrPage("p1", active, input);
    await flushBackground();

    expect(observed).toContainEqual({
      kind: "cache",
      status: "miss",
      pluginId: "github-com",
      projectId: "p1",
    });
    expect(observed).toContainEqual({
      kind: "cache",
      status: "revalidating",
      pluginId: "github-com",
      projectId: "p1",
    });
  });

  it("swallows a background revalidation rejection: no throw into the request, logged and discarded (CLI-TC-014)", async () => {
    // Seed the snapshot.
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      items: [makeIssue({ externalId: "warm" })],
      nextCursor: null,
    });
    await service.queryFirstOrPage("p1", active, input);

    // The warm serve fires a revalidation that rejects. The served request must
    // still resolve normally, and the rejection must be caught and logged.
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(new Error("revalidate boom"));
    const warm = await service.queryFirstOrPage("p1", active, input);
    expect(warm.cacheStatus).toBe("revalidating");
    expect(warm.items[0].externalId).toBe("warm");

    await flushBackground();
    expect(observed).toContainEqual({
      kind: "revalidate-failed",
      pluginId: "github-com",
      projectId: "p1",
      message: "revalidate boom",
    });
  });

  it("does not fire a background revalidation under bypassDisk (e2e)", async () => {
    const bypassed = new CutListQueryService({
      disk: new DiskSnapshotStore({ baseDir }),
      bypassDisk: true,
      onObserve,
    });
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "live" })],
      nextCursor: null,
    });
    await bypassed.queryFirstOrPage("p1", active, input);
    await bypassed.queryFirstOrPage("p1", active, input);
    await flushBackground();
    // Two live calls, one per query; no extra background revalidation invoke.
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
    expect(observed.some((e) => e.kind === "revalidate-failed")).toBe(false);
    expect(observed.some((e) => e.kind === "cache" && e.status === "revalidating")).toBe(false);
  });
});

// CLI-NFR-009: the default observability sink logs without leaking secrets. The
// source intentionally calls console.* here, so spy + assert (per repo rules)
// rather than letting it emit into test stdout.
describe("default observability sink", () => {
  it("logs cache state via console.info and revalidation failures via console.warn, with no credential material", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const defaulted = new CutListQueryService({
      disk: new DiskSnapshotStore({ baseDir }),
      bypassDisk: false,
    });
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      items: [makeIssue({ externalId: "seed" })],
      nextCursor: null,
    });
    await defaulted.queryFirstOrPage("p1", active, { cursor: null, pageSize: 50, filters: {} });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("cache miss"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("plugin=github-com"));

    // Warm serve + failing revalidation drives the console.warn path.
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(new Error("nope"));
    await defaulted.queryFirstOrPage("p1", active, { cursor: null, pageSize: 50, filters: {} });
    await flushBackground();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("background revalidation failed"));

    // No credential/token material in any logged line.
    const lines = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
    for (const line of lines) {
      expect(line).not.toMatch(/token|secret|credential|password/i);
    }
    info.mockRestore();
    warn.mockRestore();
  });

  // CLI-NFR-009 / CLI-TC-006: a corrupt cache file is discarded as a cold miss
  // and the store's discard event reaches the service's discard sink (here a
  // spy standing in for the singleton's `defaultDiscard`). Proves the wiring
  // path: store discard -> service onDiscard sink.
  it("routes a corrupt-file discard to the configured discard sink as a cold miss", async () => {
    const discards: Array<{ trigger: string; pluginId: string; projectId: string }> = [];
    const wired = new CutListQueryService({
      disk: new DiskSnapshotStore({ baseDir, onDiscard: (e) => discards.push(e) }),
      bypassDisk: false,
      onObserve,
    });
    // Seed a valid snapshot.
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      items: [makeIssue({ externalId: "seed" })],
      nextCursor: null,
    });
    await wired.queryFirstOrPage("p1", active, { cursor: null, pageSize: 50, filters: {} });

    // Corrupt every persisted entry file so the next read discards it. The
    // store is pointed at `baseDir` directly, so a project's entries live under
    // `baseDir/<projectId>` (the `issue-snapshots` segment only exists on the
    // default ~/.roubo path).
    const snapDir = path.join(baseDir, "p1");
    for (const f of fs.readdirSync(snapDir)) {
      fs.writeFileSync(path.join(snapDir, f), "{ this is not valid json");
    }

    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      items: [makeIssue({ externalId: "refetched" })],
      nextCursor: null,
    });
    const result = await wired.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
    // Cold miss, no throw, repopulated from the live RPC.
    expect(result.cacheStatus).toBe("miss");
    expect(result.items[0].externalId).toBe("refetched");
    expect(discards).toContainEqual({
      trigger: "corrupt",
      pluginId: "github-com",
      projectId: "p1",
    });
  });

  // CLI-NFR-009: defaultDiscard (the singleton's store sink) logs the discard
  // trigger + plugin/project identity only, never credentials. A `corrupt`
  // discard logs at warn; routine evictions at info. The source intentionally
  // calls console.*, so spy + assert rather than emit into test stdout.
  it("defaultDiscard logs corrupt at warn and evictions at info, with no credential material", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    defaultDiscard({ trigger: "corrupt", pluginId: "github-com", projectId: "p1" });
    defaultDiscard({ trigger: "plugin-evicted", pluginId: "github-com", projectId: "p1" });
    defaultDiscard({ trigger: "project-evicted", pluginId: "unknown", projectId: "p1" });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("discard corrupt plugin=github-com"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("discard plugin-evicted"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("discard project-evicted"));

    const lines = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
    for (const line of lines) {
      expect(line).not.toMatch(/token|secret|credential|password/i);
    }
    warn.mockRestore();
    info.mockRestore();
  });
});

// CLI-FR-004 / CLI-NFR-001: lifecycle eviction delegates. The service exposes
// thin public evictPlugin/evictProject that forward to the private disk store;
// the lifecycle owners (plugin-manager, project-registry) call these.
describe("lifecycle eviction delegates", () => {
  it("evictPlugin forwards to the disk store", () => {
    const disk = new DiskSnapshotStore({ baseDir });
    const spy = vi.spyOn(disk, "evictPlugin");
    const svc = new CutListQueryService({ disk, bypassDisk: false, onObserve });
    svc.evictPlugin("github-com");
    expect(spy).toHaveBeenCalledWith("github-com");
  });

  it("evictProject forwards to the disk store", () => {
    const disk = new DiskSnapshotStore({ baseDir });
    const spy = vi.spyOn(disk, "evictProject");
    const svc = new CutListQueryService({ disk, bypassDisk: false, onObserve });
    svc.evictProject("p1");
    expect(spy).toHaveBeenCalledWith("p1");
  });
});

// CLI-FR-004 / CLI-NFR-001: integration reconfiguration needs no explicit
// eviction hook. The cache key folds in instanceHash + sources, so changing the
// configured instance or sources self-invalidates to a cold miss (the prior
// key's snapshot is never read).
describe("integration reconfiguration self-invalidates via the cache key", () => {
  const input = { cursor: null, pageSize: 50, filters: {} };

  it("a changed instance endpoint yields a miss, not the prior snapshot", async () => {
    vi.mocked(pluginActivation.resolveInstanceEndpoint).mockReturnValue("https://ghe.example.com");
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "instance-a" })],
      nextCursor: null,
    });
    await service.queryFirstOrPage("p1", active, input);

    // Reconfigure the integration to a different instance: the key changes, so
    // the next first-page query misses rather than serving instance-a's warm
    // snapshot.
    vi.mocked(pluginActivation.resolveInstanceEndpoint).mockReturnValue("https://ghe.other.com");
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "instance-b" })],
      nextCursor: null,
    });
    const after = await service.queryFirstOrPage("p1", active, input);
    expect(after.cacheStatus).toBe("miss");
    expect(after.items[0].externalId).toBe("instance-b");
  });

  it("changed sources yield a miss, not the prior snapshot", async () => {
    vi.mocked(pluginActivation.resolveSources).mockReturnValue([
      { kind: "repo", externalId: "org/one" },
    ]);
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "sources-a" })],
      nextCursor: null,
    });
    await service.queryFirstOrPage("p1", active, input);

    vi.mocked(pluginActivation.resolveSources).mockReturnValue([
      { kind: "repo", externalId: "org/two" },
    ]);
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "sources-b" })],
      nextCursor: null,
    });
    const after = await service.queryFirstOrPage("p1", active, input);
    expect(after.cacheStatus).toBe("miss");
    expect(after.items[0].externalId).toBe("sources-b");
  });
});
