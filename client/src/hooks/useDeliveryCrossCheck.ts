import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

// The bench's last delivery cross-check (SB-FR-030). The server refreshes it on
// its own triggers, so the view reads it on the snapshot's 5-second interval.
// The first read after a server start waits for the load refresh.
export const DELIVERY_CROSS_CHECK_REFETCH_MS = 5_000;

export function deliveryCrossCheckQueryKey(projectId: string, benchId: number) {
  return ["delivery-crosscheck", projectId, benchId] as const;
}

export function useDeliveryCrossCheck(projectId: string, benchId: number) {
  return useQuery({
    queryKey: deliveryCrossCheckQueryKey(projectId, benchId),
    queryFn: () => api.fetchDeliveryCrossCheck(projectId, benchId),
    retry: false,
    refetchInterval: DELIVERY_CROSS_CHECK_REFETCH_MS,
  });
}
