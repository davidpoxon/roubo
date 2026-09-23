// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProjectAgents: vi.fn(),
    saveProjectAgentOverride: vi.fn(),
  };
});

import * as api from "../lib/api";
import { useProjectAgents, useSaveProjectAgentOverride } from "./useProjectAgents";
import { PROBE_POLL_INTERVAL_MS } from "./useAgentPlugins";

const mockedApi = vi.mocked(api);

const PAYLOAD = {
  agents: [
    {
      id: "claude-code",
      name: "Claude Code",
      configSchema: { type: "object", properties: { model: { type: "string" } } },
      appDefaults: { model: "opus" },
      overrides: { model: "sonnet" },
      effective: { model: "sonnet" },
      unavailable: null,
    },
  ],
  orphanedOverrides: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useProjectAgents", () => {
  it("fetches under a query key scoped to the project id", async () => {
    mockedApi.fetchProjectAgents.mockResolvedValue(PAYLOAD as never);

    const queryClient = makeQueryClient();
    const { result } = renderHookWithProviders(() => useProjectAgents("demo"), {
      queryClient,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedApi.fetchProjectAgents).toHaveBeenCalledWith("demo");
    expect(queryClient.getQueryData(["project-agents", "demo"])).toEqual(PAYLOAD);
  });

  it("returns an empty list cleanly when no agent plugin is installed", async () => {
    mockedApi.fetchProjectAgents.mockResolvedValue({
      agents: [],
      orphanedOverrides: [],
    } as never);

    const { result } = renderHookWithProviders(() => useProjectAgents("demo"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual({ agents: [], orphanedOverrides: [] });
  });

  it("surfaces orphaned overrides alongside the agents (AP-TC-008)", async () => {
    mockedApi.fetchProjectAgents.mockResolvedValue({
      agents: [],
      orphanedOverrides: [{ pluginId: "ghost-agent", reason: "not-installed" }],
    } as never);

    const { result } = renderHookWithProviders(() => useProjectAgents("demo"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.orphanedOverrides).toEqual([
      { pluginId: "ghost-agent", reason: "not-installed" },
    ]);
  });
});

describe("useProjectAgents: choice-probe polling (APCC-TC-024)", () => {
  function withProbe(state: "loading" | "resolved" | "failed", unavailable: unknown = null) {
    return {
      ...PAYLOAD,
      agents: [{ ...PAYLOAD.agents[0], unavailable, choiceProbes: { model: { state } } }],
    };
  }

  it("re-reads while a probe is loading and stops once every probe settles", async () => {
    mockedApi.fetchProjectAgents
      .mockResolvedValueOnce(withProbe("loading") as never)
      .mockResolvedValue(withProbe("resolved") as never);

    const { result } = renderHookWithProviders(() => useProjectAgents("demo"));

    await waitFor(
      () => expect(result.current.data?.agents[0]?.choiceProbes?.model?.state).toBe("resolved"),
      { timeout: PROBE_POLL_INTERVAL_MS * 3 },
    );
    expect(mockedApi.fetchProjectAgents).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_INTERVAL_MS * 1.5));
    expect(mockedApi.fetchProjectAgents).toHaveBeenCalledTimes(2);
  });

  it("does not poll for an unavailable agent, whose probe the server never warms", async () => {
    mockedApi.fetchProjectAgents.mockResolvedValue(
      withProbe("loading", { reason: "not-consented", message: "x" }) as never,
    );

    const { result } = renderHookWithProviders(() => useProjectAgents("demo"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_INTERVAL_MS * 1.5));
    expect(mockedApi.fetchProjectAgents).toHaveBeenCalledTimes(1);
  });
});

describe("useSaveProjectAgentOverride", () => {
  it("saves against the project and plugin it was scoped to", async () => {
    mockedApi.saveProjectAgentOverride.mockResolvedValue({ overrides: {}, effective: {} } as never);

    const { result } = renderHookWithProviders(() =>
      useSaveProjectAgentOverride("demo", "claude-code"),
    );
    await act(async () => {
      result.current.mutate({ model: "sonnet" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.saveProjectAgentOverride).toHaveBeenCalledWith("demo", "claude-code", {
      model: "sonnet",
    });
  });

  it("invalidates only its own project's query on success", async () => {
    mockedApi.saveProjectAgentOverride.mockResolvedValue({ overrides: {}, effective: {} } as never);

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(
      () => useSaveProjectAgentOverride("demo", "claude-code"),
      { queryClient },
    );
    await act(async () => {
      result.current.mutate({});
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["project-agents", "demo"],
    });
  });

  it("surfaces a rejected override as an error rather than silently succeeding", async () => {
    mockedApi.saveProjectAgentOverride.mockRejectedValue(new Error("Invalid agent configuration"));

    const { result } = renderHookWithProviders(() =>
      useSaveProjectAgentOverride("demo", "claude-code"),
    );
    await act(async () => {
      result.current.mutate({ model: "nonsense" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isSuccess).toBe(false);
  });
});
