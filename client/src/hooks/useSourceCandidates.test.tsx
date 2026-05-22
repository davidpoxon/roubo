// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useSourceCandidates } from "./useSourceCandidates";
import * as api from "../lib/api";
import type { SourceCandidatesResponse } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchSourceCandidates: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchSourceCandidates);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useSourceCandidates", () => {
  it("fetches and returns the response", async () => {
    const response: SourceCandidatesResponse = {
      shape: "multi-list",
      items: [{ externalId: "org/repo", label: "org/repo", icon: "repo" }],
    };
    mockedFetch.mockResolvedValue(response);

    const { result } = renderHookWithProviders(() => useSourceCandidates("proj-1", "github-com"));

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });
    expect(mockedFetch).toHaveBeenCalledWith("proj-1");
  });

  it("does not fetch when projectId is missing", () => {
    renderHookWithProviders(() => useSourceCandidates(undefined, "github-com"));
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("does not fetch when pluginId is null", () => {
    renderHookWithProviders(() => useSourceCandidates("proj-1", null));
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("refetches when pluginId changes (different query key)", async () => {
    mockedFetch.mockResolvedValue({ shape: "multi-list", items: [] });

    const { result, rerender } = renderHookWithProviders(
      ({ pid }: { pid: string }) => useSourceCandidates("proj-1", pid),
      { initialProps: { pid: "github-com" } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    rerender({ pid: "jira-self-hosted" });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
  });
});
