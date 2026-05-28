// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchPlugins: vi.fn(),
    fetchInstalledPlugins: vi.fn(),
  };
});

import * as api from "../lib/api";
import { useInstalledPlugins } from "./useInstalledPlugins";
import { usePlugins } from "./usePlugins";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useInstalledPlugins", () => {
  it("returns the array shape produced by fetchInstalledPlugins", async () => {
    mockedApi.fetchInstalledPlugins.mockResolvedValue([
      { id: "github-com", name: "GitHub.com", status: "enabled" },
    ]);
    const { result } = renderHookWithProviders(() => useInstalledPlugins(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: "github-com", name: "GitHub.com", status: "enabled" },
    ]);
  });

  it("does not fetch while disabled", () => {
    renderHookWithProviders(() => useInstalledPlugins(false));
    expect(mockedApi.fetchInstalledPlugins).not.toHaveBeenCalled();
  });

  // Regression: usePlugins and useInstalledPlugins previously shared the
  // queryKey ["plugins"] but returned different shapes (object vs array). When
  // usePlugins primed the cache from IssueQueuePanel, opening the Choose
  // integration dialog handed SwitchIntegrationDialog the object and crashed
  // with "(r ?? []).filter is not a function". The two hooks must use
  // distinct cache keys so neither inherits the other's data.
  it("uses a cache key isolated from usePlugins", async () => {
    mockedApi.fetchPlugins.mockResolvedValue({ hostApiVersion: "1.0.0", plugins: [] });
    mockedApi.fetchInstalledPlugins.mockResolvedValue([
      { id: "github-com", name: "GitHub.com", status: "enabled" },
    ]);
    const queryClient = makeQueryClient();

    const { result: pluginsResult } = renderHookWithProviders(() => usePlugins(), {
      queryClient,
    });
    await waitFor(() => expect(pluginsResult.current.isSuccess).toBe(true));

    const { result: installedResult } = renderHookWithProviders(() => useInstalledPlugins(true), {
      queryClient,
    });
    await waitFor(() => expect(installedResult.current.isSuccess).toBe(true));

    expect(Array.isArray(installedResult.current.data)).toBe(true);
    expect(installedResult.current.data).toEqual([
      { id: "github-com", name: "GitHub.com", status: "enabled" },
    ]);
    expect(mockedApi.fetchInstalledPlugins).toHaveBeenCalledTimes(1);
  });
});
