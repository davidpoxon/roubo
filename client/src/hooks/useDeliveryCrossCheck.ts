import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

// The bench's last delivery cross-check (SB-FR-030). The server refreshes it on
// its own triggers, so the view reads it on the snapshot's 5-second interval.
// The first read after a server start waits for the load refresh, at most
// 4 seconds, and the next read comes 5 seconds later.
export const DELIVERY_CROSS_CHECK_REFETCH_MS = 5_000;

// A read that the server could not answer (it is restarting: the request
// failed, or answered 5xx) is retried after 1 second, up to 4 times, so a tab
// open across a restart shows the rail soon after the server is back instead
// of a full interval later (SB-NFR-005). A read error the server answered,
// such as a 409 for a missing record, is not retried.
export const DELIVERY_CROSS_CHECK_RETRY_MS = 1_000;
export const DELIVERY_CROSS_CHECK_RETRIES = 4;

export function shouldRetryDeliveryCrossCheck(failureCount: number, error: unknown): boolean {
  if (failureCount >= DELIVERY_CROSS_CHECK_RETRIES) return false;
  return !(error instanceof api.ApiError) || error.status >= 500;
}

export function deliveryCrossCheckQueryKey(projectId: string, benchId: number) {
  return ["delivery-crosscheck", projectId, benchId] as const;
}

export function useDeliveryCrossCheck(projectId: string, benchId: number) {
  return useQuery({
    queryKey: deliveryCrossCheckQueryKey(projectId, benchId),
    queryFn: () => api.fetchDeliveryCrossCheck(projectId, benchId),
    retry: shouldRetryDeliveryCrossCheck,
    retryDelay: DELIVERY_CROSS_CHECK_RETRY_MS,
    refetchInterval: DELIVERY_CROSS_CHECK_REFETCH_MS,
  });
}
