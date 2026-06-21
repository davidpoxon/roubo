// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";
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
    fetchConnectionStatus: vi.fn(),
    fetchPluginConsent: vi.fn(),
    grantPluginConsent: vi.fn(),
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
  useConnectionStatus,
  useOpportunisticRecheckOnMount,
  connectionStatusQueryKey,
  useConsentStatus,
  useGrantConsent,
} from "./usePlugins";

const mockedApi = vi.mocked(api);
const mockedUseToast = vi.mocked(_useToast);

let addToast: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
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

describe("useConnectionStatus (WU-050)", () => {
  it("does not fetch while disabled (skips disabled plugins)", () => {
    mockedApi.fetchConnectionStatus.mockResolvedValue({ state: "connected" });
    renderHookWithProviders(() => useConnectionStatus("github-com", false));
    expect(mockedApi.fetchConnectionStatus).not.toHaveBeenCalled();
  });

  it("fetches when enabled and caches the result indefinitely (no refetchInterval)", async () => {
    mockedApi.fetchConnectionStatus.mockResolvedValue({
      state: "connected",
      checkedAt: "2026-05-26T09:00:00.000Z",
    });
    const { result } = renderHookWithProviders(() => useConnectionStatus("github-com", true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchConnectionStatus).toHaveBeenCalledWith("github-com");
    expect(mockedApi.fetchConnectionStatus).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({
      state: "connected",
      checkedAt: "2026-05-26T09:00:00.000Z",
    });
  });
});

describe("useOpportunisticRecheckOnMount (WU-050)", () => {
  it("fires fetchConnectionStatus once per enabled plugin id on mount", async () => {
    mockedApi.fetchConnectionStatus.mockResolvedValue({ state: "connected" });
    renderHookWithProviders(() => useOpportunisticRecheckOnMount(["github-com", "jira"]));
    await waitFor(() => expect(mockedApi.fetchConnectionStatus).toHaveBeenCalledTimes(2));
    expect(mockedApi.fetchConnectionStatus).toHaveBeenCalledWith("github-com");
    expect(mockedApi.fetchConnectionStatus).toHaveBeenCalledWith("jira");
  });

  it("does not fire when the enabled id list is empty", () => {
    renderHookWithProviders(() => useOpportunisticRecheckOnMount([]));
    expect(mockedApi.fetchConnectionStatus).not.toHaveBeenCalled();
  });

  it("populates the same react-query cache key consumed by useConnectionStatus", async () => {
    mockedApi.fetchConnectionStatus.mockResolvedValue({ state: "connected" });
    const queryClient = makeQueryClient();
    renderHookWithProviders(() => useOpportunisticRecheckOnMount(["github-com"]), {
      queryClient,
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(connectionStatusQueryKey("github-com"))).toEqual({
        state: "connected",
      }),
    );
  });

  it("re-fires when the enabled id set changes", async () => {
    mockedApi.fetchConnectionStatus.mockResolvedValue({ state: "connected" });
    const { rerender } = renderHookWithProviders(
      ({ ids }: { ids: string[] }) => useOpportunisticRecheckOnMount(ids),
      { initialProps: { ids: ["github-com"] } },
    );
    await waitFor(() => expect(mockedApi.fetchConnectionStatus).toHaveBeenCalledTimes(1));
    rerender({ ids: ["github-com", "jira"] });
    await waitFor(() => expect(mockedApi.fetchConnectionStatus).toHaveBeenCalledTimes(3));
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

describe("useConsentStatus (issue #615)", () => {
  it("fetches the consent status for a plugin", async () => {
    mockedApi.fetchPluginConsent.mockResolvedValue({
      declared: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
      },
      firstParty: true,
    });
    const { result } = renderHookWithProviders(() => useConsentStatus("db-plugin"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchPluginConsent).toHaveBeenCalledWith("db-plugin");
    expect(result.current.data?.firstParty).toBe(true);
  });

  it("does not fetch while disabled", () => {
    renderHookWithProviders(() => useConsentStatus("db-plugin", false));
    expect(mockedApi.fetchPluginConsent).not.toHaveBeenCalled();
  });
});

describe("useGrantConsent (issue #615)", () => {
  it("posts the acknowledged categories", async () => {
    mockedApi.grantPluginConsent.mockResolvedValue({
      pluginId: "db-plugin",
      acknowledgedCategories: ["docker"],
      consentedAt: "2026-06-21T00:00:00.000Z",
    });
    const { result } = renderHookWithProviders(() => useGrantConsent());
    await act(async () => {
      await result.current.mutateAsync({
        pluginId: "db-plugin",
        acknowledgedCategories: ["docker"],
      });
    });
    expect(mockedApi.grantPluginConsent).toHaveBeenCalledWith("db-plugin", ["docker"]);
  });

  it("surfaces a toast on failure", async () => {
    mockedApi.grantPluginConsent.mockRejectedValue(new ApiError("nope", 500));
    const { result } = renderHookWithProviders(() => useGrantConsent());
    await act(async () => {
      await result.current
        .mutateAsync({ pluginId: "db-plugin", acknowledgedCategories: [] })
        .catch(() => {});
    });
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("nope"));
  });
});
