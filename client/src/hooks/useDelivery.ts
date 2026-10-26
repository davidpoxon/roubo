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

/**
 * The pull-request diff of a unit's layer (SB-FR-013). A diff between two
 * commits never changes, so the read is keyed by the unit's head and never goes
 * stale: a new head reads it again, a delivery frame does not.
 */
export function useDeliveryUnitDiff(
  projectId: string,
  benchId: number,
  unitId: string,
  head: string | undefined,
) {
  return useQuery({
    queryKey: ["delivery-unit-diff", projectId, benchId, unitId, head ?? null] as const,
    queryFn: () => api.fetchDeliveryUnitDiff(projectId, benchId, unitId),
    retry: false,
    staleTime: Infinity,
  });
}

/**
 * A done unit's recorded transcript (SB-FR-013): the delivery session
 * terminal's scrollback between the unit's first and last event. Keyed by the
 * seq of the unit's last event, so an event of the unit reads it again.
 */
export function useDeliveryUnitTranscript(
  projectId: string,
  benchId: number,
  unitId: string,
  lastSeq: number | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["delivery-unit-transcript", projectId, benchId, unitId, lastSeq] as const,
    queryFn: () => api.fetchDeliveryUnitTranscript(projectId, benchId, unitId),
    retry: false,
    staleTime: Infinity,
    enabled,
  });
}

function useDeliverySessionMutation<T>(
  projectId: string,
  benchId: number,
  start: () => Promise<T>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: start,
    // A launch or a resume records a new session on the bench and starts a
    // terminal, so the bench list and the bench's terminal sessions are read
    // again too.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
        queryClient.invalidateQueries({ queryKey: ["benches"] }),
        queryClient.invalidateQueries({ queryKey: ["terminals", projectId, benchId] }),
      ]),
  });
}

export function useResumeDelivery(projectId: string, benchId: number) {
  return useDeliverySessionMutation(projectId, benchId, () =>
    api.resumeDelivery(projectId, benchId),
  );
}

/** Launches a launch-mode bench's session again while it has no record yet. */
export function useLaunchDelivery(projectId: string, benchId: number) {
  return useDeliverySessionMutation(projectId, benchId, () =>
    api.launchDelivery(projectId, benchId),
  );
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
