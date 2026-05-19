import { useQuery, useMutation } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useTools(projectId: string, benchId: number) {
  return useQuery({
    queryKey: ["tools", projectId, benchId],
    queryFn: () => api.fetchTools(projectId, benchId),
    refetchInterval: 5000,
  });
}

export function useExecuteTool() {
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      index,
      userName,
    }: {
      projectId: string;
      benchId: number;
      index: number;
      userName?: string;
    }) => api.executeTool(projectId, benchId, index, userName),
  });
}
