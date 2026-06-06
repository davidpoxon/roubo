// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useSourceOptions } from "./useSourceOptions";
import * as api from "../lib/api";
import type { SourceCandidateItem, SourceOptionsResult } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchSourceOptions: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchSourceOptions);

function item(externalId: string): SourceCandidateItem {
  return { externalId, label: externalId, icon: "project" };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useSourceOptions", () => {
  it("returns the first page and reports hasNextPage from nextCursor", async () => {
    mockedFetch.mockResolvedValueOnce({
      items: [item("PLAT"), item("PAY")],
      nextCursor: "c1",
    } as SourceOptionsResult);

    const { result } = renderHookWithProviders(() =>
      useSourceOptions({ projectId: "p1", category: "project" }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((i) => i.externalId)).toEqual(["PLAT", "PAY"]);
    expect(result.current.hasNextPage).toBe(true);
  });

  it("walks pages via fetchNextPage, flattening items in order with no duplicates", async () => {
    mockedFetch
      .mockResolvedValueOnce({ items: [item("A")], nextCursor: "c1" } as SourceOptionsResult)
      .mockResolvedValueOnce({ items: [item("B")], nextCursor: "c2" } as SourceOptionsResult)
      .mockResolvedValueOnce({ items: [item("C")], nextCursor: null } as SourceOptionsResult);

    const { result } = renderHookWithProviders(() =>
      useSourceOptions({ projectId: "p1", category: "project" }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => {
      result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));

    expect(result.current.items.map((i) => i.externalId)).toEqual(["A", "B", "C"]);
    expect(result.current.hasNextPage).toBe(false);
    // The cursor advanced each page (no page refetched / duplicated).
    expect(mockedFetch.mock.calls.map((c) => c[1].cursor)).toEqual([null, "c1", "c2"]);
  });

  it("debounces rapid search changes into a single request for the latest term", async () => {
    mockedFetch.mockResolvedValue({ items: [], nextCursor: null } as SourceOptionsResult);

    const { rerender } = renderHookWithProviders(
      (props: { search: string }) =>
        useSourceOptions({ projectId: "p1", category: "project", search: props.search }),
      { initialProps: { search: "" } },
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    mockedFetch.mockClear();

    act(() => {
      rerender({ search: "a" });
      rerender({ search: "ab" });
      rerender({ search: "abc" });
    });

    // Within the debounce window, no request has gone out yet.
    expect(mockedFetch).not.toHaveBeenCalled();

    await waitFor(
      () =>
        expect(mockedFetch).toHaveBeenCalledWith("p1", expect.objectContaining({ search: "abc" })),
      { timeout: 2000 },
    );
    // Only the final term was queried; the intermediate keystrokes were dropped.
    expect(mockedFetch.mock.calls.map((c) => c[1].search)).toEqual(["abc"]);
  });

  it("does not query while disabled (scoped-category cascade gate)", async () => {
    mockedFetch.mockResolvedValue({ items: [], nextCursor: null } as SourceOptionsResult);

    renderHookWithProviders(() =>
      useSourceOptions({ projectId: "p1", category: "board", enabled: false }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
