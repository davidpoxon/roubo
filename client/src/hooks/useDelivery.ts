import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bench, SpecBenchDecisionMode } from "@roubo/shared";
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
 * A done or jammed unit's recorded transcript (SB-FR-013): the delivery session
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
 * Approves the delivery (SB-FR-022, SB-FR-034). The server refuses it with a
 * 409 once the delivery is complete, while a review is open, or while a
 * gating case is unmet.
 */
export function useApproveDelivery(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.approveDelivery(projectId, benchId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryQueryKey(projectId, benchId) }),
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
}

/**
 * Changes a role's model tier (SB-FR-021). The role-change control lands in
 * the bench's outbox, so the snapshot, which lists the outbox, is read again
 * once the request settles, and the row shows pending until the read-back.
 */
export function useRoleChange(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ role, tier }: RoleChangeRequest) =>
      api.changeDeliveryRole(projectId, benchId, role, tier),
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
