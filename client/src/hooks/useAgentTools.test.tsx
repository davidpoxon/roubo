// @vitest-environment jsdom
//
// Issue #672: the app-scoped resolved-preset query the Settings agent tools
// listing reads its advisory `degraded` field from. The cases here pin the one
// thing a component test cannot, because it mocks this hook: that the query is
// keyed on the default agent, so the degrade verdict is re-derived when the
// default moves rather than kept from the previous answer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { AgentPresetsResponse, SettingsResponse } from "@roubo/shared";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchSettings: vi.fn(), fetchAppAgentPresets: vi.fn() };
});

import * as api from "../lib/api";
import { useAppAgentPresets } from "./useAgentTools";

const mockedApi = vi.mocked(api);

function settings(defaultAgentPluginId?: string): SettingsResponse {
  return {
    theme: "dark",
    jigs: {
      autoInject: false,
      autoExecute: false,
      ...(defaultAgentPluginId !== undefined && { defaultAgentPluginId }),
    },
  } as SettingsResponse;
}

/** Plain `Agent` plus a degraded `Agent (Plan)`, as the server would resolve it. */
const DEGRADED: AgentPresetsResponse = {
  presets: [
    {
      id: "__builtin_agent__",
      name: "Agent",
      icon: "bot",
      source: "builtin",
      agent: "default",
      bindsDefaultAgent: true,
      agentPluginId: "strict-agent",
      resolvedAgentName: "Strict Agent",
      params: {},
    },
    {
      id: "__builtin_agent_plan__",
      name: "Agent (Plan)",
      icon: "bot",
      source: "builtin",
      agent: "default",
      bindsDefaultAgent: true,
      agentPluginId: "strict-agent",
      resolvedAgentName: "Strict Agent",
      params: {},
      degraded: {
        droppedParams: ["mode"],
        message:
          'Agent tool "Agent (Plan)" drops mode, which Strict Agent does not accept, so it launches as a plain agent.',
      },
    },
  ],
};

/**
 * The same list against an agent whose schema accepts `mode`: no drop, and
 * `Agent (Plan)` keeps the param it was named for. Spelled out rather than
 * derived from `DEGRADED`, so what the second answer looks like is readable
 * without mentally applying an omit.
 */
const CLEAN: AgentPresetsResponse = {
  presets: [
    {
      id: "__builtin_agent__",
      name: "Agent",
      icon: "bot",
      source: "builtin",
      agent: "default",
      bindsDefaultAgent: true,
      agentPluginId: "permissive-agent",
      resolvedAgentName: "Permissive Agent",
      params: {},
    },
    {
      id: "__builtin_agent_plan__",
      name: "Agent (Plan)",
      icon: "bot",
      source: "builtin",
      agent: "default",
      bindsDefaultAgent: true,
      agentPluginId: "permissive-agent",
      resolvedAgentName: "Permissive Agent",
      params: { mode: "plan" },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.fetchSettings.mockResolvedValue(settings("strict-agent"));
});

describe("useAppAgentPresets", () => {
  it("fetches under an app-scoped key carrying the current default agent", async () => {
    mockedApi.fetchAppAgentPresets.mockResolvedValue(DEGRADED);

    const queryClient = makeQueryClient();
    queryClient.setQueryData(["settings"], settings("strict-agent"));
    const { result } = renderHookWithProviders(() => useAppAgentPresets(), { queryClient });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(
      queryClient.getQueryData([
        "agent-presets",
        { scope: "app", defaultAgentPluginId: "strict-agent" },
      ]),
    ).toEqual(DEGRADED);
    // Scoped, so it can never be served the project-keyed list or vice versa.
    expect(queryClient.getQueryData(["agent-presets", undefined])).toBeUndefined();
  });

  it("re-derives the degrade when the default agent moves", async () => {
    mockedApi.fetchAppAgentPresets.mockResolvedValue(DEGRADED);

    const queryClient = makeQueryClient();
    queryClient.setQueryData(["settings"], settings("strict-agent"));
    const { result } = renderHookWithProviders(() => useAppAgentPresets(), { queryClient });

    await waitFor(() =>
      expect(result.current.data?.presets[1].degraded?.droppedParams).toEqual(["mode"]),
    );

    // What `handleDefaultAgentChange` does: `useSettings` writes the new default
    // into the `settings` cache optimistically, before the PUT resolves.
    mockedApi.fetchAppAgentPresets.mockResolvedValue(CLEAN);
    act(() => {
      queryClient.setQueryData(["settings"], settings("permissive-agent"));
    });

    // The stale answer must not survive the switch: the previous default's drop
    // notice would be a false claim about the new one.
    await waitFor(() => expect(result.current.data?.presets[1].degraded).toBeUndefined());
    expect(mockedApi.fetchAppAgentPresets).toHaveBeenCalledTimes(2);
  });

  it("keys a not-yet-chosen default distinctly from a chosen one", async () => {
    mockedApi.fetchAppAgentPresets.mockResolvedValue(CLEAN);

    const queryClient = makeQueryClient();
    queryClient.setQueryData(["settings"], settings());
    const { result } = renderHookWithProviders(() => useAppAgentPresets(), { queryClient });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(
      queryClient.getQueryData([
        "agent-presets",
        { scope: "app", defaultAgentPluginId: undefined },
      ]),
    ).toEqual(CLEAN);
  });
});
