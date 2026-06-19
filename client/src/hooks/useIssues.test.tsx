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
