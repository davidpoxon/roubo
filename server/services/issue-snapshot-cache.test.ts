import { afterEach, describe, expect, it } from "vitest";
import type { ListIssuesParams, PaginatedIssues } from "@roubo/shared";
import { clearAll, clearSnapshot, getSnapshot, recordSnapshot } from "./issue-snapshot-cache.js";

function makeIssue(externalId: string, title: string) {
  return {
    integrationId: "e2e-stub",
    externalId,
    externalUrl: `https://example.test/${externalId}`,
    title,
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2026-05-27T00:00:00.000Z",
    raw: null,
  };
}

function makeResponse(overrides: Partial<PaginatedIssues> = {}): PaginatedIssues {
  return {
    items: [makeIssue("e2e-stub#1", "first")],
    nextCursor: null,
    ...overrides,
  };
}

function makeParams(overrides: Partial<ListIssuesParams> = {}): ListIssuesParams {
  return {
    sources: [{ kind: "repo", externalId: "foo/bar" }],
    cursor: null,
    pageSize: 50,
    ...overrides,
  };
}

afterEach(() => {
  clearAll();
});

describe("issue-snapshot-cache (FR-014)", () => {
  it("records a first-page snapshot and returns it", () => {
    const response = makeResponse();
    recordSnapshot("e2e-stub", "p1", makeParams(), response, "E2E Stub", true);
    const snapshot = getSnapshot("e2e-stub", "p1", makeParams());
    expect(snapshot).toBeDefined();
    expect(snapshot?.response.items).toEqual(response.items);
    expect(snapshot?.pluginName).toBe("E2E Stub");
    expect(snapshot?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores non-first-page responses (no cache for cursor > 0)", () => {
    recordSnapshot("e2e-stub", "p1", makeParams(), makeResponse(), "E2E Stub", false);
    expect(getSnapshot("e2e-stub", "p1", makeParams())).toBeUndefined();
  });

  it("isolates the cached copy from later mutations on the source response", () => {
    const response = makeResponse();
    recordSnapshot("e2e-stub", "p1", makeParams(), response, "E2E Stub", true);
    response.items[0].title = "mutated";
    const snapshot = getSnapshot("e2e-stub", "p1", makeParams());
    expect(snapshot?.response.items[0].title).toBe("first");
  });

  it("strips stale markers from the cached copy so reads start clean", () => {
    const response = makeResponse({
      stale: true,
      snapshotCapturedAt: "2026-01-01T00:00:00.000Z",
    });
    recordSnapshot("e2e-stub", "p1", makeParams(), response, "E2E Stub", true);
    const snapshot = getSnapshot("e2e-stub", "p1", makeParams());
    expect(snapshot?.response.stale).toBeUndefined();
    expect(snapshot?.response.snapshotCapturedAt).toBeUndefined();
  });

  it("overwrites the snapshot when a newer first page arrives for the same key", () => {
    recordSnapshot("e2e-stub", "p1", makeParams(), makeResponse(), "E2E Stub", true);
    const newer = makeResponse({ items: [makeIssue("e2e-stub#2", "second")] });
    recordSnapshot("e2e-stub", "p1", makeParams(), newer, "E2E Stub", true);
    const snapshot = getSnapshot("e2e-stub", "p1", makeParams());
    expect(snapshot?.response.items[0].externalId).toBe("e2e-stub#2");
  });

  it("isolates snapshots per projectId so two projects sharing one plugin do not cross-pollute", () => {
    const responseA = makeResponse({ items: [makeIssue("a#1", "from A")] });
    const responseB = makeResponse({ items: [makeIssue("b#1", "from B")] });
    recordSnapshot("e2e-stub", "p-a", makeParams(), responseA, "E2E Stub", true);
    recordSnapshot("e2e-stub", "p-b", makeParams(), responseB, "E2E Stub", true);
    expect(getSnapshot("e2e-stub", "p-a", makeParams())?.response.items[0].externalId).toBe("a#1");
    expect(getSnapshot("e2e-stub", "p-b", makeParams())?.response.items[0].externalId).toBe("b#1");
  });

  it("isolates snapshots per filters so a filtered read does not poison an unfiltered fallback", () => {
    const filtered = makeParams({ filters: { labels: ["bug"] } });
    const unfiltered = makeParams();
    const filteredResponse = makeResponse({ items: [makeIssue("bug#1", "bug only")] });
    const unfilteredResponse = makeResponse({ items: [makeIssue("any#1", "anything")] });
    recordSnapshot("e2e-stub", "p1", filtered, filteredResponse, "E2E Stub", true);
    recordSnapshot("e2e-stub", "p1", unfiltered, unfilteredResponse, "E2E Stub", true);
    expect(getSnapshot("e2e-stub", "p1", filtered)?.response.items[0].externalId).toBe("bug#1");
    expect(getSnapshot("e2e-stub", "p1", unfiltered)?.response.items[0].externalId).toBe("any#1");
  });

  it("isolates snapshots per sources", () => {
    const sourcesA = makeParams({ sources: [{ kind: "repo", externalId: "foo/a" }] });
    const sourcesB = makeParams({ sources: [{ kind: "repo", externalId: "foo/b" }] });
    recordSnapshot(
      "e2e-stub",
      "p1",
      sourcesA,
      makeResponse({ items: [makeIssue("a#1", "from a")] }),
      "E2E Stub",
      true,
    );
    recordSnapshot(
      "e2e-stub",
      "p1",
      sourcesB,
      makeResponse({ items: [makeIssue("b#1", "from b")] }),
      "E2E Stub",
      true,
    );
    expect(getSnapshot("e2e-stub", "p1", sourcesA)?.response.items[0].externalId).toBe("a#1");
    expect(getSnapshot("e2e-stub", "p1", sourcesB)?.response.items[0].externalId).toBe("b#1");
  });

  it("clearSnapshot drops every entry for the plugin across projects and filters", () => {
    recordSnapshot("plugin-a", "p1", makeParams(), makeResponse(), "A", true);
    recordSnapshot(
      "plugin-a",
      "p2",
      makeParams({ filters: { labels: ["bug"] } }),
      makeResponse(),
      "A",
      true,
    );
    recordSnapshot("plugin-b", "p1", makeParams(), makeResponse(), "B", true);
    clearSnapshot("plugin-a");
    expect(getSnapshot("plugin-a", "p1", makeParams())).toBeUndefined();
    expect(
      getSnapshot("plugin-a", "p2", makeParams({ filters: { labels: ["bug"] } })),
    ).toBeUndefined();
    expect(getSnapshot("plugin-b", "p1", makeParams())).toBeDefined();
  });

  it("clearAll drops every cached snapshot", () => {
    recordSnapshot("plugin-a", "p1", makeParams(), makeResponse(), "A", true);
    recordSnapshot("plugin-b", "p2", makeParams(), makeResponse(), "B", true);
    clearAll();
    expect(getSnapshot("plugin-a", "p1", makeParams())).toBeUndefined();
    expect(getSnapshot("plugin-b", "p2", makeParams())).toBeUndefined();
  });
});
