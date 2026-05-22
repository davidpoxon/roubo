import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useBenchIssue(projectId: string, externalId: string | undefined) {
  return useQuery({
    queryKey: ["bench-issue", projectId, externalId],
    queryFn: () => api.fetchIssue(projectId, externalId as string),
    enabled: Boolean(externalId),
  });
}
