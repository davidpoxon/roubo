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
      perLaunchOverrides,
    }: {
      projectId: string;
      benchId: number;
      command?: string;
      jigId?: string;
      // The agent launch path (AP-FR-007, issue #517): naming an agent plugin,
      // and optionally the preset's parameter overrides, routes creation
      // through the agent pipeline instead of the built-in command path. It is
      // also what the launch-failure Retry action relaunches through.
      agentPluginId?: string;
      presetOverrides?: Record<string, unknown>;
      // The transient fourth layer above the preset (AP-FR-011, issue #518),
      // produced by the per-launch override dialog. It applies to this one
      // session and is never written to app or project configuration.
      perLaunchOverrides?: Record<string, unknown>;
    }) =>
      api.createTerminal(projectId, benchId, command, jigId, {
        ...(agentPluginId !== undefined && { agentPluginId }),
        ...(presetOverrides !== undefined && { presetOverrides }),
        ...(perLaunchOverrides !== undefined && { perLaunchOverrides }),
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
