// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useGlobalJigs, useJigs, useInjectJig } from "./useJigs";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useGlobalJigs", () => {
  it("calls fetchGlobalJigs and returns data", async () => {
    const jigs = [{ id: "bp1", title: "Jig 1" }];
    mockedApi.fetchGlobalJigs.mockResolvedValue(jigs as never);
    const { result } = renderHookWithProviders(() => useGlobalJigs());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchGlobalJigs).toHaveBeenCalled();
    expect(result.current.data).toEqual(jigs);
  });
});

describe("useJigs", () => {
  it("does not fetch when projectId is undefined", () => {
    const { result } = renderHookWithProviders(() => useJigs(undefined));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchJigs).not.toHaveBeenCalled();
  });

  it("fetches when projectId is provided", async () => {
    const jigs = [{ id: "bp2", title: "Project Jig" }];
    mockedApi.fetchJigs.mockResolvedValue(jigs as never);
    const { result } = renderHookWithProviders(() => useJigs("proj-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchJigs).toHaveBeenCalledWith("proj-1");
    expect(result.current.data).toEqual(jigs);
  });
});

describe("useInjectJig", () => {
  it("calls injectJig with required args", async () => {
    mockedApi.injectJig.mockResolvedValue(undefined as never);
    const { result } = renderHookWithProviders(() => useInjectJig());
    result.current.mutate({ projectId: "p1", benchId: 2, jigId: "bp1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.injectJig).toHaveBeenCalledWith("p1", 2, "bp1", undefined);
  });

  it("calls injectJig with optional sessionId", async () => {
    mockedApi.injectJig.mockResolvedValue(undefined as never);
    const { result } = renderHookWithProviders(() => useInjectJig());
    result.current.mutate({
      projectId: "p1",
      benchId: 2,
      jigId: "bp1",
      sessionId: "sess-42",
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.injectJig).toHaveBeenCalledWith("p1", 2, "bp1", "sess-42");
  });
});
