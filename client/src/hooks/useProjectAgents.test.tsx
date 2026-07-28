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
    const { result } = renderHookWithProviders(() => useProjectAgents("roubo-development"), {
      queryClient,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedApi.fetchProjectAgents).toHaveBeenCalledWith("roubo-development");
    expect(queryClient.getQueryData(["project-agents", "roubo-development"])).toEqual(PAYLOAD);
  });

  it("returns an empty list cleanly when no agent plugin is installed", async () => {
    mockedApi.fetchProjectAgents.mockResolvedValue({
      agents: [],
      orphanedOverrides: [],
    } as never);

    const { result } = renderHookWithProviders(() => useProjectAgents("roubo-development"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual({ agents: [], orphanedOverrides: [] });
  });

  it("surfaces orphaned overrides alongside the agents (AP-TC-008)", async () => {
    mockedApi.fetchProjectAgents.mockResolvedValue({
      agents: [],
      orphanedOverrides: [{ pluginId: "ghost-agent", reason: "not-installed" }],
    } as never);

    const { result } = renderHookWithProviders(() => useProjectAgents("roubo-development"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.orphanedOverrides).toEqual([
      { pluginId: "ghost-agent", reason: "not-installed" },
    ]);
  });
});

describe("useSaveProjectAgentOverride", () => {
  it("saves against the project and plugin it was scoped to", async () => {
    mockedApi.saveProjectAgentOverride.mockResolvedValue({ overrides: {}, effective: {} } as never);

    const { result } = renderHookWithProviders(() =>
      useSaveProjectAgentOverride("roubo-development", "claude-code"),
    );
    await act(async () => {
      result.current.mutate({ model: "sonnet" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.saveProjectAgentOverride).toHaveBeenCalledWith(
      "roubo-development",
      "claude-code",
      { model: "sonnet" },
    );
  });

  it("invalidates only its own project's query on success", async () => {
    mockedApi.saveProjectAgentOverride.mockResolvedValue({ overrides: {}, effective: {} } as never);

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(
      () => useSaveProjectAgentOverride("roubo-development", "claude-code"),
      { queryClient },
    );
    await act(async () => {
      result.current.mutate({});
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["project-agents", "roubo-development"],
    });
  });

  it("surfaces a rejected override as an error rather than silently succeeding", async () => {
    mockedApi.saveProjectAgentOverride.mockRejectedValue(new Error("Invalid agent configuration"));

    const { result } = renderHookWithProviders(() =>
      useSaveProjectAgentOverride("roubo-development", "claude-code"),
    );
    await act(async () => {
      result.current.mutate({ model: "nonsense" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isSuccess).toBe(false);
  });
});
