import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

/**
 * Query a bench's recorded privileged broker calls (#671), optionally filtered to a
 * single plugin. Returns AuditEntry[] in chronological order. The query key includes
 * pluginId so a per-plugin view caches separately from the unfiltered bench view.
 */
export function useAuditLog(projectId: string, benchId: number, pluginId?: string) {
  return useQuery({
    queryKey: ["audit-log", projectId, benchId, pluginId],
    queryFn: () => api.fetchAuditLog(projectId, benchId, pluginId),
  });
}
