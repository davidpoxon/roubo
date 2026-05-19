// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useBrowseDirectory } from "./useFilesystem";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

describe("useBrowseDirectory", () => {
  it("is disabled when enabled is false", () => {
    mockedApi.browseDirectory.mockResolvedValue({} as never);
    const { result } = renderHookWithProviders(() => useBrowseDirectory("/tmp", false, false));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.browseDirectory).not.toHaveBeenCalled();
  });

  it("calls browseDirectory with correct args when enabled", async () => {
    const browseResult = {
      path: "/home",
      entries: [{ name: "proj", path: "/home/proj", hasGit: true }],
    };
    mockedApi.browseDirectory.mockResolvedValue(browseResult as never);
    const { result } = renderHookWithProviders(() => useBrowseDirectory("/home", true, true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.browseDirectory).toHaveBeenCalledWith("/home", true);
    expect(result.current.data).toEqual(browseResult);
  });

  it("passes undefined path when path is undefined", async () => {
    const browseResult = { path: "~", entries: [] };
    mockedApi.browseDirectory.mockResolvedValue(browseResult as never);
    const { result } = renderHookWithProviders(() => useBrowseDirectory(undefined, false, true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.browseDirectory).toHaveBeenCalledWith(undefined, false);
  });
});
