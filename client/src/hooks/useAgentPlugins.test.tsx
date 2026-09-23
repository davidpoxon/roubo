// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { CHOICE_PROBE_TIMEOUT_MS } from "@roubo/shared";
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
import {
  PROBE_POLL_INTERVAL_MS,
  PROBE_POLL_MAX_READS,
  useAgentPlugins,
  useSaveAgentConfig,
} from "./useAgentPlugins";

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

describe("useAgentPlugins: choice-probe polling (#1274, APCC-TC-019)", () => {
  it("leaves one poll's headroom between the host's kill and the 5 s bound at the field (APCC-NFR-002, APCC-TC-019)", () => {
    // The field sees the kill on its next read, up to one poll after it lands,
    // so the two together must fit inside the bound the field is held to.
    expect(CHOICE_PROBE_TIMEOUT_MS + PROBE_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
  });

  function agentWith(state: "loading" | "resolved" | "failed") {
    return {
      agents: [
        {
          id: "probed-agent",
          name: "Probed Agent",
          version: "1.0.0",
          status: "enabled",
          available: true,
          configSchema: { type: "object", properties: { model: { type: "string" } } },
          config: {},
          choiceProbes: { model: { state } },
        },
      ],
    };
  }

  it("re-reads the list while a probe is loading and stops once every probe settles", async () => {
    mockedApi.fetchAgentPlugins
      .mockResolvedValueOnce(agentWith("loading") as never)
      .mockResolvedValue(agentWith("failed") as never);

    const { result } = renderHookWithProviders(() => useAgentPlugins());

    await waitFor(
      () => expect(result.current.data?.agents[0]?.choiceProbes?.model?.state).toBe("failed"),
      { timeout: PROBE_POLL_INTERVAL_MS * 3 },
    );
    expect(mockedApi.fetchAgentPlugins).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_INTERVAL_MS * 1.5));
    expect(mockedApi.fetchAgentPlugins).toHaveBeenCalledTimes(2);
  });

  it("still polls a later loading episode after many earlier settled reads", async () => {
    mockedApi.fetchAgentPlugins.mockResolvedValue(agentWith("resolved") as never);

    const queryClient = makeQueryClient();
    const { result } = renderHookWithProviders(() => useAgentPlugins(), { queryClient });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    for (let i = 0; i < PROBE_POLL_MAX_READS + 2; i++) {
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["agent-plugins"] });
      });
    }
    expect(queryClient.getQueryState(["agent-plugins"])?.dataUpdateCount).toBeGreaterThan(
      PROBE_POLL_MAX_READS,
    );

    mockedApi.fetchAgentPlugins
      .mockResolvedValueOnce(agentWith("loading") as never)
      .mockResolvedValue(agentWith("failed") as never);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-plugins"] });
    });
    const callsAtLoading = mockedApi.fetchAgentPlugins.mock.calls.length;

    await waitFor(
      () => expect(result.current.data?.agents[0]?.choiceProbes?.model?.state).toBe("failed"),
      { timeout: PROBE_POLL_INTERVAL_MS * 3 },
    );
    expect(mockedApi.fetchAgentPlugins.mock.calls.length).toBe(callsAtLoading + 1);
  });

  it("does not poll for an unavailable agent, whose probe the server never warms", async () => {
    const payload = agentWith("loading");
    mockedApi.fetchAgentPlugins.mockResolvedValue({
      agents: [
        {
          ...payload.agents[0],
          unavailable: { reason: "plugin-unavailable", message: "The plugin is not running." },
        },
      ],
    } as never);

    const { result } = renderHookWithProviders(() => useAgentPlugins());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_INTERVAL_MS * 1.5));
    expect(mockedApi.fetchAgentPlugins).toHaveBeenCalledTimes(1);
  });

  it("does not poll when no probe is loading", async () => {
    mockedApi.fetchAgentPlugins.mockResolvedValue(agentWith("resolved") as never);

    const { result } = renderHookWithProviders(() => useAgentPlugins());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_INTERVAL_MS * 1.5));
    expect(mockedApi.fetchAgentPlugins).toHaveBeenCalledTimes(1);
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
