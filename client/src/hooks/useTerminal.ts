import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useTerminalSessions(projectId: string, benchId: number) {
  return useQuery({
    queryKey: ["terminals", projectId, benchId],
    queryFn: () => api.fetchTerminals(projectId, benchId),
    refetchInterval: 5000,
  });
}

export function useCreateTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      command,
      jigId,
      agentPluginId,
      presetOverrides,
    }: {
      projectId: string;
      benchId: number;
      command?: string;
      jigId?: string;
      // The agent launch path (AP-FR-007, issue #517): naming an agent plugin,
      // and optionally the preset's parameter overrides, routes creation
      // through the agent pipeline instead of the built-in command path.
      agentPluginId?: string;
      presetOverrides?: Record<string, unknown>;
    }) =>
      api.createTerminal(projectId, benchId, command, jigId, {
        ...(agentPluginId !== undefined && { agentPluginId }),
        ...(presetOverrides !== undefined && { presetOverrides }),
      }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["terminals", vars.projectId, vars.benchId] });
    },
  });
}

export function useDestroyTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      sessionId,
    }: {
      projectId: string;
      benchId: number;
      sessionId: string;
    }) => api.destroyTerminal(projectId, benchId, sessionId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["terminals", vars.projectId, vars.benchId] });
    },
  });
}
