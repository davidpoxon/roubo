// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { ApiError } from "../lib/api";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchPlugins: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    restartPlugin: vi.fn(),
    uninstallPlugin: vi.fn(),
    fetchPluginLogs: vi.fn(),
  };
});
vi.mock("./useToast");

import * as api from "../lib/api";
import { useToast as _useToast } from "./useToast";
import {
  usePlugins,
  useEnablePlugin,
  useDisablePlugin,
  useRestartPlugin,
  useUninstallPlugin,
  usePluginLogs,
} from "./usePlugins";

const mockedApi = vi.mocked(api);
const mockedUseToast = vi.mocked(_useToast);

let addToast: ReturnType<typeof vi.fn>;
beforeEach(() => {
  addToast = vi.fn();
  mockedUseToast.mockReturnValue({
    addToast,
    removeToast: vi.fn(),
  } as unknown as ReturnType<typeof _useToast>);
});

describe("usePlugins", () => {
  it("fetches the plugin list", async () => {
    mockedApi.fetchPlugins.mockResolvedValue({ hostApiVersion: "1.0.0", plugins: [] });
    const { result } = renderHookWithProviders(() => usePlugins());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual({ hostApiVersion: "1.0.0", plugins: [] });
  });
});

describe("useEnablePlugin", () => {
  it("invalidates plugins query on success", async () => {
    mockedApi.enablePlugin.mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useEnablePlugin());
    await act(async () => {
      result.current.mutate("github-com");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.enablePlugin).toHaveBeenCalledWith("github-com");
  });

  it("surfaces ApiError.message via toast", async () => {
    mockedApi.enablePlugin.mockRejectedValue(new ApiError("nope", 409));
    const { result } = renderHookWithProviders(() => useEnablePlugin());
    await act(async () => {
      result.current.mutate("github-com");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(addToast).toHaveBeenCalledWith("nope");
  });

  it("falls back to a generic message for non-ApiError errors", async () => {
    mockedApi.enablePlugin.mockRejectedValue("string-error");
    const { result } = renderHookWithProviders(() => useEnablePlugin());
    await act(async () => {
      result.current.mutate("github-com");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(addToast).toHaveBeenCalledWith("Failed to enable plugin.");
  });
});

describe("useDisablePlugin", () => {
  it("calls disablePlugin and toasts on failure", async () => {
    mockedApi.disablePlugin.mockRejectedValue(new Error("disk full"));
    const { result } = renderHookWithProviders(() => useDisablePlugin());
    await act(async () => {
      result.current.mutate("github-com");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(addToast).toHaveBeenCalledWith("disk full");
  });
});

describe("useRestartPlugin", () => {
  it("calls restartPlugin", async () => {
    mockedApi.restartPlugin.mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useRestartPlugin());
    await act(async () => {
      result.current.mutate("github-com");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.restartPlugin).toHaveBeenCalledWith("github-com");
  });
});

describe("useUninstallPlugin", () => {
  it("calls uninstallPlugin and resolves on success", async () => {
    mockedApi.uninstallPlugin.mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useUninstallPlugin());
    await act(async () => {
      result.current.mutate("acme-issues");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.uninstallPlugin).toHaveBeenCalledWith("acme-issues");
  });

  it("surfaces ApiError.message via toast", async () => {
    mockedApi.uninstallPlugin.mockRejectedValue(new ApiError("plugin in use", 409));
    const { result } = renderHookWithProviders(() => useUninstallPlugin());
    await act(async () => {
      result.current.mutate("acme-issues");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(addToast).toHaveBeenCalledWith("plugin in use");
  });

  it("falls back to a generic message for non-ApiError errors", async () => {
    mockedApi.uninstallPlugin.mockRejectedValue("string-error");
    const { result } = renderHookWithProviders(() => useUninstallPlugin());
    await act(async () => {
      result.current.mutate("acme-issues");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(addToast).toHaveBeenCalledWith("Failed to uninstall plugin.");
  });
});

describe("usePluginLogs", () => {
  it("does not fetch while disabled", async () => {
    mockedApi.fetchPluginLogs.mockResolvedValue({ lines: [] });
    renderHookWithProviders(() => usePluginLogs("github-com", "current", false));
    expect(mockedApi.fetchPluginLogs).not.toHaveBeenCalled();
  });

  it("fetches when enabled and returns lines", async () => {
    mockedApi.fetchPluginLogs.mockResolvedValue({
      lines: [{ ts: "t", source: "stdout", text: "hi" }],
    });
    const { result } = renderHookWithProviders(() => usePluginLogs("github-com", "previous", true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchPluginLogs).toHaveBeenCalledWith("github-com", "previous");
    expect(result.current.data?.lines).toHaveLength(1);
  });
});
