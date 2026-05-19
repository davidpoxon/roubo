// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useProjectItems, useRefreshProjectItems } from "./useProjectItems";
import type { GitHubProjectItem } from "@roubo/shared";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const mockIssue = {
  number: 1,
  title: "Issue 1",
  body: null,
  state: "open",
  labels: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  commentsCount: 0,
  htmlUrl: "https://github.com/org/repo/issues/1",
};
const mockData: { items: GitHubProjectItem[]; projectTitle: string } = {
  items: [{ issue: mockIssue }],
  projectTitle: "My Project",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useProjectItems", () => {
  it("calls fetchProjectItems with projectId and projectNumber", async () => {
    mockedApi.fetchProjectItems.mockResolvedValue(mockData);
    const { result } = renderHookWithProviders(() => useProjectItems("proj-1", 42));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchProjectItems).toHaveBeenCalledWith("proj-1", 42);
    expect(result.current.data).toEqual(mockData);
  });

  it("is disabled when projectNumber is undefined", async () => {
    const { result } = renderHookWithProviders(() => useProjectItems("proj-1", undefined));
    await act(async () => {});
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchProjectItems).not.toHaveBeenCalled();
  });
});

describe("useRefreshProjectItems", () => {
  it("invalidates project-items queries", async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useRefreshProjectItems(), { queryClient });
    await act(async () => {
      result.current();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["project-items"] });
  });
});
