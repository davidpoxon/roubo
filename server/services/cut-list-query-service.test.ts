import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { CutListQueryService } from "./cut-list-query-service.js";
import { DiskSnapshotStore } from "./disk-snapshot-store.js";

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

beforeEach(() => {
  vi.resetAllMocks();
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
  service = new CutListQueryService({ disk: new DiskSnapshotStore({ baseDir }) });
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
    expect(result.cacheStatus).toBe("disk-miss");
    expect(result.items.map((i) => i.externalId)).toEqual(["1"]);
    expect(result.nextCursor).toBe("next");
  });

  it("serves the persisted snapshot on the next call without re-invoking the plugin (disk-hit)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "cached" })],
      nextCursor: null,
    });
    const input = { cursor: null, pageSize: 50, filters: {} };
    await service.queryFirstOrPage("p1", active, input);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    const second = await service.queryFirstOrPage("p1", active, input);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1); // not re-invoked
    expect(second.cacheStatus).toBe("disk-hit");
    expect(second.items[0].externalId).toBe("cached");
    expect(second.snapshotCapturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("persistence survives a new service instance pointed at the same dir (restart)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "persisted" })],
      nextCursor: null,
    });
    await service.queryFirstOrPage("p1", active, { cursor: null, pageSize: 50, filters: {} });

    const restarted = new CutListQueryService({ disk: new DiskSnapshotStore({ baseDir }) });
    const hit = await restarted.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
    expect(hit.cacheStatus).toBe("disk-hit");
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
    expect(result.cacheStatus).toBe("uncached");
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
    expect(result.cacheStatus).toBe("uncached");
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
    expect(result.cacheStatus).toBe("uncached");
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
    expect(result.cacheStatus).toBe("uncached");
    // Nothing was written for the paginated cursor: a first-page query is still a miss.
    const firstPage = await service.queryFirstOrPage("p1", active, {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
    expect(firstPage.cacheStatus).toBe("disk-miss");
  });

  it("propagates a plugin RPC error (no fallback in the service)", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("boom"));
    await expect(
      service.queryFirstOrPage("p1", active, { cursor: null, pageSize: 50, filters: {} }),
    ).rejects.toThrow("boom");
  });
});
