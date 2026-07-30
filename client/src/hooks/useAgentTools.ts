import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { AgentToolPreset } from "@roubo/shared";
import { useSettings } from "./useSettings";

/**
 * The app-level agent tool presets (AP-FR-008, issue #516).
 *
 * They live inside the settings blob rather than behind their own endpoint, so
 * this is a thin projection over `useSettings` plus three list operations
 * written back through the same optimistic settings mutation. That is what
 * keeps a preset edit and a default-agent change from racing each other into
 * two different views of `settings.json`.
 */
export function useAgentTools() {
  const { settings, updateSettings } = useSettings();
  // Memoised so the empty-list fallback is one stable array rather than a new
  // one per render, which would re-create every callback below on every render.
  const agentTools = useMemo(() => settings?.agentTools ?? [], [settings?.agentTools]);

  const write = useCallback(
    (next: AgentToolPreset[]) => {
      if (!settings) return;
      updateSettings({ ...settings, agentTools: next });
    },
    [settings, updateSettings],
  );

  const saveAgentTool = useCallback(
    (preset: AgentToolPreset) => {
      const index = agentTools.findIndex((p) => p.id === preset.id);
      write(
        index === -1
          ? [...agentTools, preset]
          : agentTools.map((p) => (p.id === preset.id ? preset : p)),
      );
    },
    [agentTools, write],
  );

  const deleteAgentTool = useCallback(
    (id: string) => write(agentTools.filter((p) => p.id !== id)),
    [agentTools, write],
  );

  return { agentTools, saveAgentTool, deleteAgentTool, isLoading: !settings };
}

/**
 * Every preset a project's launch surfaces offer, resolved server-side:
 * built-ins, app-level presets, and the project's own `roubo.yaml` entries
 * (AP-TC-026). Not cached long: a preset's resolved agent tracks the default
 * agent, so a stale answer here would show the wrong agent (AP-TC-039).
 */
export function useAgentPresets(projectId: string | undefined) {
  return useQuery({
    queryKey: ["agent-presets", projectId],
    queryFn: () => api.fetchAgentPresets(projectId as string),
    enabled: !!projectId,
    staleTime: 5_000,
  });
}

/**
 * The app-scoped half of the same list, resolved server-side: built-ins plus
 * app-level presets, with no project layer (issue #672). A separate hook rather
 * than a `projectId`-less mode of `useAgentPresets`, so app settings can read
 * the server's resolution without changing what a project surface fetches.
 *
 * Same short `staleTime` and for the same reason: a preset's resolved agent
 * tracks the default agent, so a stale answer would describe the wrong one.
 */
export function useAppAgentPresets() {
  return useQuery({
    // Object-shaped scope rather than the bare string "app", which a real
    // projectId could collide with, while keeping the shared key prefix.
    queryKey: ["agent-presets", { scope: "app" }],
    queryFn: () => api.fetchAppAgentPresets(),
    staleTime: 5_000,
  });
}

/** A stable id for a newly created app-level preset. */
export function newAgentToolId(): string {
  return `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
