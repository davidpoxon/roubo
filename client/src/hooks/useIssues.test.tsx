// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
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
  it("returns the first page issues with hasNextPage true when nextCursor is non-null", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1"), makeIssue("2")],
      nextCursor: "c1",
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.issues.map((i) => i.externalId)).toEqual(["1", "2"]);
    expect(result.current.hasNextPage).toBe(true);
  });

  it("walks through pages via fetchNextPage, flattening items in order", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        items: [makeIssue("1")],
        nextCursor: "c1",
      } as PaginatedIssues)
      .mockResolvedValueOnce({
        items: [makeIssue("2")],
        nextCursor: "c2",
      } as PaginatedIssues)
      .mockResolvedValueOnce({
        items: [makeIssue("3")],
        nextCursor: null,
      } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(2));

    await act(async () => {
      result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(3));

    expect(result.current.issues.map((i) => i.externalId)).toEqual(["1", "2", "3"]);
    expect(result.current.hasNextPage).toBe(false);
  });

  it("exposes stalled when any returned page reports it", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [makeIssue("1")],
      nextCursor: null,
      stalled: true,
    } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stalled).toBe(true);
  });

  it("sums excludedCount across fetched pages, treating absence as zero (#358)", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        items: [makeIssue("1")],
        nextCursor: "c1",
        excludedCount: 2,
      } as PaginatedIssues)
      .mockResolvedValueOnce({
        items: [makeIssue("2")],
        nextCursor: null,
      } as PaginatedIssues);

    const { result } = renderHookWithProviders(() => useIssues("p1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.excludedCount).toBe(2);

    await act(async () => {
      result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.issues).toHaveLength(2));
    // Second page reported no count; the total stays at the first page's 2.
    expect(result.current.excludedCount).toBe(2);
  });

  it("defaults excludedCount to zero when no page reports one (#358)", async () => {
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
