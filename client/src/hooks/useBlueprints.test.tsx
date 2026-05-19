// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useGlobalBlueprints, useBlueprints, useInjectBlueprint } from "./useBlueprints";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useGlobalBlueprints", () => {
  it("calls fetchGlobalBlueprints and returns data", async () => {
    const blueprints = [{ id: "bp1", title: "Blueprint 1" }];
    mockedApi.fetchGlobalBlueprints.mockResolvedValue(blueprints as never);
    const { result } = renderHookWithProviders(() => useGlobalBlueprints());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchGlobalBlueprints).toHaveBeenCalled();
    expect(result.current.data).toEqual(blueprints);
  });
});

describe("useBlueprints", () => {
  it("does not fetch when projectId is undefined", () => {
    const { result } = renderHookWithProviders(() => useBlueprints(undefined));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchBlueprints).not.toHaveBeenCalled();
  });

  it("fetches when projectId is provided", async () => {
    const blueprints = [{ id: "bp2", title: "Project Blueprint" }];
    mockedApi.fetchBlueprints.mockResolvedValue(blueprints as never);
    const { result } = renderHookWithProviders(() => useBlueprints("proj-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchBlueprints).toHaveBeenCalledWith("proj-1");
    expect(result.current.data).toEqual(blueprints);
  });
});

describe("useInjectBlueprint", () => {
  it("calls injectBlueprint with required args", async () => {
    mockedApi.injectBlueprint.mockResolvedValue(undefined as never);
    const { result } = renderHookWithProviders(() => useInjectBlueprint());
    result.current.mutate({ projectId: "p1", benchId: 2, blueprintId: "bp1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.injectBlueprint).toHaveBeenCalledWith("p1", 2, "bp1", undefined);
  });

  it("calls injectBlueprint with optional sessionId", async () => {
    mockedApi.injectBlueprint.mockResolvedValue(undefined as never);
    const { result } = renderHookWithProviders(() => useInjectBlueprint());
    result.current.mutate({
      projectId: "p1",
      benchId: 2,
      blueprintId: "bp1",
      sessionId: "sess-42",
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.injectBlueprint).toHaveBeenCalledWith("p1", 2, "bp1", "sess-42");
  });
});
