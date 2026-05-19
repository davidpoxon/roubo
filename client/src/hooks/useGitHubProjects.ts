import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useGitHubProjects(projectId: string | undefined) {
  return useQuery({
    queryKey: ["projects", projectId],
    queryFn: () => api.fetchProjectGitHubProjects(projectId as string),
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
  });
}
