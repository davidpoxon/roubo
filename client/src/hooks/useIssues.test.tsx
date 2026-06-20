// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useIssues } from "./useIssues";
import * as api from "../lib/api";
import type { NormalizedIssue, PaginatedIssues } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchIssuesPage: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchIssuesPage);

function makeIssue(externalId: string): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://github.com/org/repo/issues/${externalId}`,
    title: `Issue ${externalId}`,
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
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useIssues", () => {
  it("returns the single page's items and exposes its nextCursor (TC-022)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1"), makeIssue("2")],
      nextCursor: "c1",
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.issues.map((i) => i.externalId)).toEqual(["1", "2"]);
    expect(result.current.nextCursor).toBe("c1");
  });

  it("reports nextCursor null on the last page (Next disabled, TC-025)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("9")],
      nextCursor: null,
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.nextCursor).toBeNull();
  });

  it("passes the supplied cursor into the query function and keys on it (TC-024)", async () => {
    mockedFetch.mockResolvedValue({
      items: [makeIssue("3")],
      nextCursor: null,
    } as PaginatedIssues);

    renderHookWithProviders(() => useIssues("p1", {}, undefined, "cursor-for-page-2"));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(mockedFetch).toHaveBeenCalledWith("p1", {
      cursor: "cursor-for-page-2",
      pageSize: undefined,
      labels: undefined,
      search: undefined,
    });
  });

  it("defaults the cursor to null (page 1) when none is supplied", async () => {
    mockedFetch.mockResolvedValueOnce({ items: [], nextCursor: null } as PaginatedIssues);
    renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(mockedFetch).toHaveBeenCalledWith("p1", {
      cursor: null,
      pageSize: undefined,
      labels: undefined,
      search: undefined,
    });
  });

  it("exposes stalled when the returned page reports it", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: null,
      stalled: true,
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stalled).toBe(true);
  });

  it("exposes stale and snapshotCapturedAt from the page (FR-014)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: null,
      stale: true,
      snapshotCapturedAt: "2024-02-02T03:04:05Z",
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stale).toBe(true);
    expect(result.current.snapshotCapturedAt).toBe("2024-02-02T03:04:05Z");
  });

  it("surfaces cacheStatus from the page for the warm (revalidating) serve (CLI-FR-002)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: null,
      cacheStatus: "revalidating",
      snapshotCapturedAt: "2026-06-01T12:00:00Z",
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.cacheStatus).toBe("revalidating");
  });

  it("defaults cacheStatus to null when the page reports none", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: null,
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.cacheStatus).toBeNull();
  });

  it("reports the page's excludedCount, treating absence as zero (#358)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: "c1",
      excludedCount: 2,
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.excludedCount).toBe(2);
  });

  it("defaults excludedCount to zero when the page reports none (#358)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: null,
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.excludedCount).toBe(0);
  });

  it("surfaces dataUpdatedAt once the first fetch succeeds (CLI-TC-016)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: null,
    } as PaginatedIssues);

    const before = Date.now();
    const { result } = renderHookWithProviders(() => useIssues("p1"));
    // Before any successful fetch, dataUpdatedAt is the React Query default of 0.
    expect(result.current.dataUpdatedAt).toBe(0);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.dataUpdatedAt).toBeGreaterThanOrEqual(before);
  });

  it("exposes isRefetching, false in the idle settled state (CLI-TC-015)", async () => {
    mockedFetch.mockResolvedValue({
      items: [makeIssue("1")],
      nextCursor: null,
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isRefetching).toBe(false);
  });

  it("keeps the previous page's items on a cursor change instead of flashing the skeleton (placeholderData, CLI-NFR-002)", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("page1")],
      nextCursor: "c1",
    } as PaginatedIssues);
    // The next page resolves only after we assert, so the placeholder window is
    // observable: with keepPreviousData the prior items stay rendered and
    // isLoading stays false across the key change (no skeleton flash).
    let resolveSecond: (v: PaginatedIssues) => void = () => {};
    mockedFetch.mockReturnValueOnce(
      new Promise<PaginatedIssues>((resolve) => {
        resolveSecond = resolve;
      }),
    );

    const { result, rerender } = renderHookWithProviders(
      ({ cursor }: { cursor: string | null }) => useIssues("p1", {}, undefined, cursor),
      { initialProps: { cursor: null as string | null } },
    );
    await waitFor(() => expect(result.current.issues.map((i) => i.externalId)).toEqual(["page1"]));

    rerender({ cursor: "c1" });
    // Mid-flight on the new key: previous page still shown, no loading skeleton.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.issues.map((i) => i.externalId)).toEqual(["page1"]);

    resolveSecond({ items: [makeIssue("page2")], nextCursor: null } as PaginatedIssues);
    await waitFor(() => expect(result.current.issues.map((i) => i.externalId)).toEqual(["page2"]));
  });

  it("does not fetch when projectId is undefined", () => {
    renderHookWithProviders(() => useIssues(undefined));
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("forwards filters into the query function call", async () => {
    mockedFetch.mockResolvedValueOnce({ items: [], nextCursor: null } as PaginatedIssues);
    renderHookWithProviders(() => useIssues("p1", { labels: "bug", search: "login" }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(mockedFetch).toHaveBeenCalledWith("p1", {
      cursor: null,
      pageSize: undefined,
      labels: "bug",
      search: "login",
    });
  });
});
