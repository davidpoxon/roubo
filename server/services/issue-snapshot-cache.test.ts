import { afterEach, describe, expect, it } from "vitest";
import type { PaginatedIssues } from "@roubo/shared";
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

afterEach(() => {
  clearAll();
});

describe("issue-snapshot-cache (FR-014)", () => {
  it("records a first-page snapshot and returns it", () => {
    const response = makeResponse();
    recordSnapshot("e2e-stub", response, "E2E Stub", true);
    const snapshot = getSnapshot("e2e-stub");
    expect(snapshot).toBeDefined();
    expect(snapshot?.response.items).toEqual(response.items);
    expect(snapshot?.pluginName).toBe("E2E Stub");
    expect(snapshot?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores non-first-page responses (no cache for cursor > 0)", () => {
    recordSnapshot("e2e-stub", makeResponse(), "E2E Stub", false);
    expect(getSnapshot("e2e-stub")).toBeUndefined();
  });

  it("isolates the cached copy from later mutations on the source response", () => {
    const response = makeResponse();
    recordSnapshot("e2e-stub", response, "E2E Stub", true);
    response.items[0].title = "mutated";
    const snapshot = getSnapshot("e2e-stub");
    expect(snapshot?.response.items[0].title).toBe("first");
  });

  it("strips stale markers from the cached copy so reads start clean", () => {
    const response = makeResponse({
      stale: true,
      snapshotCapturedAt: "2026-01-01T00:00:00.000Z",
    });
    recordSnapshot("e2e-stub", response, "E2E Stub", true);
    const snapshot = getSnapshot("e2e-stub");
    expect(snapshot?.response.stale).toBeUndefined();
    expect(snapshot?.response.snapshotCapturedAt).toBeUndefined();
  });

  it("overwrites the snapshot when a newer first page arrives", () => {
    recordSnapshot("e2e-stub", makeResponse(), "E2E Stub", true);
    const newer = makeResponse({ items: [makeIssue("e2e-stub#2", "second")] });
    recordSnapshot("e2e-stub", newer, "E2E Stub", true);
    const snapshot = getSnapshot("e2e-stub");
    expect(snapshot?.response.items[0].externalId).toBe("e2e-stub#2");
  });

  it("clearSnapshot drops one plugin's cache only", () => {
    recordSnapshot("plugin-a", makeResponse(), "A", true);
    recordSnapshot("plugin-b", makeResponse(), "B", true);
    clearSnapshot("plugin-a");
    expect(getSnapshot("plugin-a")).toBeUndefined();
    expect(getSnapshot("plugin-b")).toBeDefined();
  });

  it("clearAll drops every cached snapshot", () => {
    recordSnapshot("plugin-a", makeResponse(), "A", true);
    recordSnapshot("plugin-b", makeResponse(), "B", true);
    clearAll();
    expect(getSnapshot("plugin-a")).toBeUndefined();
    expect(getSnapshot("plugin-b")).toBeUndefined();
  });
});
