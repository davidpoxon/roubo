// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useContainers, useAssignContainer, useUnassignContainer } from "./useContainers";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useContainers", () => {
  it("fetches database containers", async () => {
    const containers = [{ id: "abc", name: "sql1", image: "mssql", port: 1433, status: "running" }];
    mockedApi.fetchContainers.mockResolvedValue(containers);
    const { result } = renderHookWithProviders(() => useContainers());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchContainers).toHaveBeenCalled();
    expect(result.current.data).toEqual(containers);
  });
});

describe("useAssignContainer", () => {
  it("calls assignContainer with correct params", async () => {
    const bench = { id: 1 };
    mockedApi.assignContainer.mockResolvedValue(bench as any);
    const { result } = renderHookWithProviders(() => useAssignContainer());
    result.current.mutate({
      projectId: "p1",
      benchId: 1,
      containerId: "abc",
      component: "database",
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.assignContainer).toHaveBeenCalledWith("p1", 1, "abc", "database");
  });
});

describe("useUnassignContainer", () => {
  it("calls unassignContainer with correct params", async () => {
    const bench = { id: 1 };
    mockedApi.unassignContainer.mockResolvedValue(bench as any);
    const { result } = renderHookWithProviders(() => useUnassignContainer());
    result.current.mutate({ projectId: "p1", benchId: 1, component: "database" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.unassignContainer).toHaveBeenCalledWith("p1", 1, "database");
  });
});
