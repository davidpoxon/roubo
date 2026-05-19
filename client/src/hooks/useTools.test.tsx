// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useTools, useExecuteTool } from "./useTools";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useTools", () => {
  it("calls fetchTools with projectId and benchId", async () => {
    const tools = [
      {
        name: "Open Project",
        icon: "globe",
        type: "browser" as const,
        url: "http://localhost:3000",
        enabled: true,
        requiresUserPicker: false,
      },
    ];
    mockedApi.fetchTools.mockResolvedValue(tools);
    const { result } = renderHookWithProviders(() => useTools("a1", 1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchTools).toHaveBeenCalledWith("a1", 1);
    expect(result.current.data).toEqual(tools);
  });
});

describe("useExecuteTool", () => {
  it("calls executeTool with projectId, benchId, and index", async () => {
    const launchResult = { success: true };
    mockedApi.executeTool.mockResolvedValue(launchResult);
    const { result } = renderHookWithProviders(() => useExecuteTool());
    result.current.mutate({ projectId: "a1", benchId: 1, index: 0 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.executeTool).toHaveBeenCalledWith("a1", 1, 0, undefined);
  });

  it("forwards userName when provided", async () => {
    const launchResult = { success: true };
    mockedApi.executeTool.mockResolvedValue(launchResult);
    const { result } = renderHookWithProviders(() => useExecuteTool());
    result.current.mutate({ projectId: "a1", benchId: 1, index: 0, userName: "Alice" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.executeTool).toHaveBeenCalledWith("a1", 1, 0, "Alice");
  });
});
