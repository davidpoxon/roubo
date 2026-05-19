// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useIssueTypes, useIssueTypeMappings, useUpdateIssueTypeMappings } from "./useIssueTypes";
import * as api from "../lib/api";
import type { ProjectIssueTypesResponse, ProjectIssueTypeMappingsResponse } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchIssueTypes: vi.fn(),
  fetchProjectIssueTypeMappings: vi.fn(),
  updateProjectIssueTypeMappings: vi.fn(),
}));

const mockedFetchIssueTypes = vi.mocked(api.fetchIssueTypes);
const mockedFetchMappings = vi.mocked(api.fetchProjectIssueTypeMappings);
const mockedUpdateMappings = vi.mocked(api.updateProjectIssueTypeMappings);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useIssueTypes", () => {
  it("returns issue types from the API", async () => {
    const response: ProjectIssueTypesResponse = {
      configured: true,
      types: [{ id: "it-1", name: "Bug", color: "#d73a4a" }],
    };
    mockedFetchIssueTypes.mockResolvedValue(response);

    const { result } = renderHookWithProviders(() => useIssueTypes("my-project"));

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });

    expect(mockedFetchIssueTypes).toHaveBeenCalledWith("my-project");
  });

  it("does not fetch when projectId is undefined", () => {
    mockedFetchIssueTypes.mockResolvedValue({
      configured: false,
      reason: "not-connected",
      types: [],
    });

    renderHookWithProviders(() => useIssueTypes(undefined));

    expect(mockedFetchIssueTypes).not.toHaveBeenCalled();
  });

  it("does not fetch when projectId is empty string", () => {
    mockedFetchIssueTypes.mockResolvedValue({
      configured: false,
      reason: "not-connected",
      types: [],
    });

    renderHookWithProviders(() => useIssueTypes(""));

    expect(mockedFetchIssueTypes).not.toHaveBeenCalled();
  });
});

describe("useIssueTypeMappings", () => {
  it("returns mappings from the API", async () => {
    const response: ProjectIssueTypeMappingsResponse = { mappings: { Bug: "debug-bp" } };
    mockedFetchMappings.mockResolvedValue(response);

    const { result } = renderHookWithProviders(() => useIssueTypeMappings("my-project"));

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });

    expect(mockedFetchMappings).toHaveBeenCalledWith("my-project");
  });

  it("does not fetch when projectId is undefined", () => {
    mockedFetchMappings.mockResolvedValue({ mappings: {} });

    renderHookWithProviders(() => useIssueTypeMappings(undefined));

    expect(mockedFetchMappings).not.toHaveBeenCalled();
  });
});

describe("useUpdateIssueTypeMappings", () => {
  it("calls updateProjectIssueTypeMappings with the provided mappings", async () => {
    const mappings = { Bug: "debug-bp", Feature: "feature-bp" };
    const response: ProjectIssueTypeMappingsResponse = { mappings };
    mockedFetchMappings.mockResolvedValue({ mappings: {} });
    mockedUpdateMappings.mockResolvedValue(response);

    const { result } = renderHookWithProviders(() => useUpdateIssueTypeMappings("my-project"));

    await act(async () => {
      result.current.mutate(mappings);
    });

    await waitFor(() => {
      expect(mockedUpdateMappings).toHaveBeenCalledWith("my-project", mappings);
    });
  });

  it("invalidates issue-type-mappings and projects queries on success", async () => {
    const mappings = { Bug: "debug-bp" };
    mockedFetchMappings.mockResolvedValue({ mappings: {} });
    mockedUpdateMappings.mockResolvedValue({ mappings });

    let fetchCallCount = 0;
    mockedFetchMappings.mockImplementation(() => {
      fetchCallCount++;
      return Promise.resolve({ mappings: {} });
    });

    const { result } = renderHookWithProviders(() => ({
      update: useUpdateIssueTypeMappings("my-project"),
      mappings: useIssueTypeMappings("my-project"),
    }));

    await waitFor(() => {
      expect(result.current.mappings.data).toBeDefined();
    });

    const callsBefore = fetchCallCount;

    await act(async () => {
      result.current.update.mutate(mappings);
    });

    await waitFor(() => {
      expect(fetchCallCount).toBeGreaterThan(callsBefore);
    });
  });
});
