import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bench, SpecBenchDecisionMode, TerminalSession } from "@roubo/shared";
import * as api from "../lib/api";
import { deliveryCrossCheckQueryKey } from "./useDeliveryCrossCheck";
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

// How often the time split is read again while no event lands, so the open
// part grows as the burn strip's elapsed time does. An ended delivery's split
// no longer grows, so it is not read again on a timer.
export const DELIVERY_TIME_REFETCH_MS = 60_000;

/**
 * Where the delivery's elapsed time went (#1671), for the delivery and each
 * started unit. The read is keyed by the snapshot's seq, so an accepted event
 * reads it again; the delivery view and a unit's drill-in share the one read.
 */
export function useDeliveryTime(projectId: string, benchId: number, seq: number) {
  return useQuery({
    queryKey: ["delivery-time", projectId, benchId, seq] as const,
    queryFn: () => api.fetchDeliveryTime(projectId, benchId),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.open === false ? false : DELIVERY_TIME_REFETCH_MS,
    placeholderData: (previous) => previous,
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

export type DecisionControlKind = "answer" | "overturn";

export interface DecisionControlRequest {
  kind: DecisionControlKind;
  decisionId: string;
  option: string;
}

/**
 * Answers an open decision, or overturns a defaulted one, with an option
 * (SB-FR-014, SB-FR-015). The control lands in the bench's outbox, so the
 * snapshot, which lists the outbox, is read again once the request settles.
 */
export function useDecisionControl(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, decisionId, option }: DecisionControlRequest) =>
      kind === "answer"
        ? api.answerDeliveryDecision(projectId, benchId, decisionId, option)
        : api.overturnDeliveryDecision(projectId, benchId, decisionId, option),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
  });
}

export type ReviewActionRequest =
  { kind: "accept"; decisionId: string } | { kind: "overturn"; decisionId: string; option: string };

/**
 * Accepts an agent decision, or overturns it with another option, from its
 * review card (SB-FR-035). The control lands in the bench's outbox, so the
 * snapshot is read again once the request settles.
 */
export function useReviewAction(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: ReviewActionRequest) =>
      action.kind === "accept"
        ? api.acceptDeliveryDecision(projectId, benchId, action.decisionId)
        : api.overturnDeliveryDecision(projectId, benchId, action.decisionId, action.option),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
  });
}

export interface ThreadMessageRequest {
  decisionId: string;
  text: string;
}

/**
 * Sends a message on an agent decision's thread (SB-FR-036). The control is
 * held for the session's next read, so the snapshot is read again once the
 * request settles; so are the bench's terminal sessions, since a refusal for
 * no live session means the card's view of the session is out of date.
 */
export function useThreadMessage(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ decisionId, text }: ThreadMessageRequest) =>
      api.sendDeliveryThreadMessage(projectId, benchId, decisionId, text),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
        queryClient.invalidateQueries({ queryKey: ["terminals", projectId, benchId] }),
      ]),
  });
}

export interface SteeringNoteRequest {
  text: string;
  // The unit boundary the note lands at.
  appliesAt: string;
}

/**
 * Sends a steering note for the next unit boundary (SB-FR-016). The control
 * lands in the bench's outbox, so the snapshot is read again once the request
 * settles, and the note shows queued.
 */
export function useSteeringNote(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ text, appliesAt }: SteeringNoteRequest) =>
      api.sendDeliverySteeringNote(projectId, benchId, text, appliesAt),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
  });
}

/**
 * Approves the delivery (SB-FR-022, SB-FR-029, SB-FR-034). The server refuses
 * it with a 409 once the delivery is complete, while the last cross-check holds
 * a blocking class, while a review is open, or while a gating case is unmet.
 */
export function useApproveDelivery(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.approveDelivery(projectId, benchId),
    onSettled: (_data, error) => {
      void queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) });
      // A refusal for a blocking class the view had not read yet: read the
      // cross-check again, so the rail lists it.
      if (api.crossCheckBlockedClassesOf(error) !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: deliveryCrossCheckQueryKey(projectId, benchId),
        });
      }
    },
  });
}

/**
 * Pauses the delivery or winds it down (SB-FR-022). The control lands in the
 * bench's outbox, so the snapshot is read again once the request settles; the
 * health chip follows the session's `lifecycle.changed`.
 */
export function useLifecycleControl(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: "pause" | "wind-down") =>
      action === "pause"
        ? api.pauseDelivery(projectId, benchId)
        : api.windDownDelivery(projectId, benchId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
  });
}

export interface RoleChangeRequest {
  role: string;
  tier: string;
  effort?: string;
}

/**
 * Changes a role's model tier and, when given, its effort (SB-FR-021). The
 * role-change control lands in the bench's outbox, so the snapshot, which
 * lists the outbox, is read again once the request settles, and the row shows
 * pending until the read-back.
 */
export function useRoleChange(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ role, tier, effort }: RoleChangeRequest) =>
      api.changeDeliveryRole(projectId, benchId, role, tier, effort),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
  });
}

/**
 * Switches the delivery's decision mode (SB-FR-032). The mode_switch control
 * lands in the bench's outbox, so the snapshot, which lists the outbox, is read
 * again once the request settles, and the switch shows pending until the
 * session's `mode.changed` reads the control back.
 */
export function useModeSwitch(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: SpecBenchDecisionMode) => api.switchDeliveryMode(projectId, benchId, mode),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
  });
}

/**
 * The main delivery session that the bench launched, from the bench's terminal
 * sessions. `session` is undefined while the bench has recorded none or the
 * list does not name it. `listed` is true once a list fetched after the hook
 * first saw the recorded id was read, so a recorded session that list does not
 * name is gone (closed from the Terminal). The list is shared with the Terminal
 * tab, so a cached list from before the launch recorded the id does not count:
 * it would read a session that has just started as gone. The list is read only
 * when the bench has recorded a session.
 */
export function useDeliverySession(bench: Bench): {
  session: TerminalSession | undefined;
  listed: boolean;
} {
  const sessionId = bench.deliverySessionId;
  const sessions = useTerminalSessions(bench.projectId, bench.id, {
    enabled: sessionId !== undefined,
  });
  // When the hook first saw the recorded id, as the list's update time then:
  // only a list read after it counts.
  const [seen, setSeen] = useState(() => ({
    id: sessionId,
    baseline: sessions.dataUpdatedAt,
  }));
  if (seen.id !== sessionId) setSeen({ id: sessionId, baseline: sessions.dataUpdatedAt });
  if (sessionId === undefined) return { session: undefined, listed: false };
  return {
    session: (sessions.data ?? []).find((s) => s.id === sessionId),
    listed: sessions.isSuccess && seen.id === sessionId && sessions.dataUpdatedAt > seen.baseline,
  };
}

/** Whether the main delivery session that the bench launched still runs. */
export function useDeliverySessionLive(bench: Bench): boolean {
  return useDeliverySession(bench).session?.status === "live";
}

/**
 * Whether the server would refuse a new delivery session now (409): while the
 * bench's session runs, or while the bench is being cleared or is in error. A
 * button that starts one says the same before it is pressed.
 */
export function useDeliverySessionStartBlocked(bench: Bench): boolean {
  const sessionLive = useDeliverySessionLive(bench);
  return bench.status === "clearing" || bench.status === "error" || sessionLive;
}

/**
 * The units and gates of the spec the bench delivers, read from the bench
 * workspace. The Delivery tab reads it while the session starts, before the
 * delivery record exists. A read error is shown as no figures, not retried.
 */
export function useDeliverySpecSummary(projectId: string, benchId: number) {
  return useQuery({
    queryKey: ["deliverySpecSummary", projectId, benchId],
    queryFn: () => api.fetchDeliverySpecSummary(projectId, benchId),
    retry: false,
  });
}

/**
 * The stage control of a gate sitting (SB-FR-023): opens the sitting of a
 * gate, or closes the bench's sitting in any state. The snapshot is read
 * again once the request settles, so the sitting's phase follows.
 */
export function useSittingStage(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stage: { action: "open"; gateId: string } | { action: "close" }) =>
      stage.action === "open"
        ? api.openDeliverySitting(projectId, benchId, stage.gateId).then(() => undefined)
        : api.closeDeliverySitting(projectId, benchId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
  });
}
