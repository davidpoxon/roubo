// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchAgentPlugins: vi.fn(),
    saveAgentConfig: vi.fn(),
  };
});

import * as api from "../lib/api";
import { useAgentPlugins, useSaveAgentConfig } from "./useAgentPlugins";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAgentPlugins", () => {
  it("fetches the agent plugin list under the agent-plugins query key", async () => {
    const payload = {
      agents: [
        {
          id: "claude-code",
          name: "Claude Code",
          version: "1.0.0",
          status: "enabled",
          available: true,
          configSchema: { type: "object", properties: { model: { type: "string" } } },
          config: { model: "opus" },
        },
      ],
    };
    mockedApi.fetchAgentPlugins.mockResolvedValue(payload as never);

    const queryClient = makeQueryClient();
    const { result } = renderHookWithProviders(() => useAgentPlugins(), { queryClient });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedApi.fetchAgentPlugins).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(payload);
    expect(queryClient.getQueryData(["agent-plugins"])).toEqual(payload);
  });

  it("returns an empty list cleanly when no agent plugins are installed (AP-TC-012)", async () => {
    mockedApi.fetchAgentPlugins.mockResolvedValue({ agents: [] } as never);

    const { result } = renderHookWithProviders(() => useAgentPlugins());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual({ agents: [] });
  });
});

describe("useSaveAgentConfig", () => {
  it("saves against the plugin id it was scoped to, and no other (AP-TC-009)", async () => {
    mockedApi.saveAgentConfig.mockResolvedValue({ config: { model: "opus" } } as never);

    const { result } = renderHookWithProviders(() => useSaveAgentConfig("claude-code"));
    await act(async () => {
      result.current.mutate({ model: "opus" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.saveAgentConfig).toHaveBeenCalledTimes(1);
    expect(mockedApi.saveAgentConfig).toHaveBeenCalledWith("claude-code", { model: "opus" });
  });

  it("invalidates the agent-plugins query on success so every card re-reads", async () => {
    mockedApi.saveAgentConfig.mockResolvedValue({ config: {} } as never);

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useSaveAgentConfig("codex-cli"), {
      queryClient,
    });
    await act(async () => {
      result.current.mutate({ sandbox: "workspace-write" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agent-plugins"] });
  });

  it("surfaces a failed save as an error rather than silently succeeding", async () => {
    mockedApi.saveAgentConfig.mockRejectedValue(new Error("invalid agent configuration"));

    const { result } = renderHookWithProviders(() => useSaveAgentConfig("codex-cli"));
    await act(async () => {
      result.current.mutate({ sandbox: "nonsense" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isSuccess).toBe(false);
  });
});
