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
    }: {
      projectId: string;
      benchId: number;
      command?: string;
      jigId?: string;
    }) => api.createTerminal(projectId, benchId, command, jigId),
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
