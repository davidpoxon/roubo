import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bench } from "@roubo/shared";
import * as api from "../lib/api";
import { useTerminalSessions } from "./useTerminal";

// React Query hooks for a Spec Bench's delivery read (SB-FR-009). The server
// validates the record on every read, so the query refetches on an interval: a
// record fixed on disk shows up without a reload, and one that stops conforming
// takes its controls away. `retry: false` because a 409 is an answer, not a
// transient failure.

export const DELIVERY_REFETCH_MS = 5_000;

export function deliveryQueryKey(projectId: string, benchId: number) {
  return ["delivery", projectId, benchId] as const;
}

export function useDelivery(projectId: string, benchId: number) {
  return useQuery({
    queryKey: deliveryQueryKey(projectId, benchId),
    queryFn: () => api.fetchDelivery(projectId, benchId),
    retry: false,
    refetchInterval: DELIVERY_REFETCH_MS,
  });
}

export function useResumeDelivery(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.resumeDelivery(projectId, benchId),
    // A resume records a new session on the bench and starts a terminal, so the
    // bench list and the bench's terminal sessions are read again too.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
        queryClient.invalidateQueries({ queryKey: ["benches"] }),
        queryClient.invalidateQueries({ queryKey: ["terminals", projectId, benchId] }),
      ]),
  });
}

/**
 * Whether the main delivery session that the bench launched still runs. It
 * reads the bench's terminal sessions only when the bench has recorded one.
 */
export function useDeliverySessionLive(bench: Bench): boolean {
  const sessionId = bench.deliverySessionId;
  const sessions = useTerminalSessions(bench.projectId, bench.id, {
    enabled: sessionId !== undefined,
  });
  if (sessionId === undefined) return false;
  return (sessions.data ?? []).some((s) => s.id === sessionId && s.status === "live");
}
