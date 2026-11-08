import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Bench, BenchNotification, BenchStatus, SpecBenchDecisionMode } from "@roubo/shared";
import type { DeliveryStreamFrame } from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { formatNotification, notificationRouteTo } from "../lib/notifications";
import { deliveryQueryKey } from "./useDelivery";

interface NotificationsEvent {
  type: "notifications";
  projectId: string;
  benchId: number;
  notifications: BenchNotification[];
}

interface BenchStatusEvent {
  type: "bench-status";
  projectId: string;
  benchId: number;
  status: BenchStatus;
}

// A Spec Bench's decision mode in effect changed (SB-FR-032).
interface BenchDecisionModeEvent {
  type: "bench-decision-mode";
  projectId: string;
  benchId: number;
  decisionMode: SpecBenchDecisionMode;
}

type SseEvent =
  NotificationsEvent | BenchStatusEvent | BenchDecisionModeEvent | DeliveryStreamFrame;

// How long the hook waits before it opens the stream again when the browser
// gave the connection up (readyState CLOSED). A connection that only dropped is
// reopened by the EventSource itself, after the retry delay the server sends.
export const SSE_RECONNECT_MS = 2_000;

// A delivery frame (SB-FR-008) says the bench accepted events up to `seq`. The
// frame carries no event, so the client reads the snapshot again unless the one
// it holds is already at that seq. A frame that jumps past the held seq (a
// sequence gap: frames were missed, or the batch held several events) gets the
// same refetch, and the server's snapshot folds every accepted event, so none is
// missing from the timeline. The invalidation matches the key as a prefix, so
// the bench's event lists (useDeliveryFeed) are read again with it. A
// `controls` frame says the control outbox changed with no new event (a
// decision answer, SB-FR-014): its seq is one the client may already hold, so
// it is never skipped.
function applyDeliveryFrame(queryClient: QueryClient, frame: DeliveryStreamFrame): void {
  const key = deliveryQueryKey(frame.projectId, frame.benchId);
  const held = queryClient.getQueryData<DeliverySnapshot>(key);
  if (
    frame.change !== "controls" &&
    held !== undefined &&
    typeof held.seq === "number" &&
    frame.seq <= held.seq
  ) {
    return;
  }
  void queryClient.invalidateQueries({ queryKey: key });
}

// Patches one bench in the bench caches in place, with no refetch.
function patchBench(
  queryClient: QueryClient,
  projectId: string,
  benchId: number,
  patch: Partial<Bench>,
): void {
  queryClient.setQueryData<Bench>(["bench", projectId, benchId], (prev) =>
    prev ? { ...prev, ...patch } : prev,
  );
  queryClient.setQueriesData<Bench[]>({ queryKey: ["benches"] }, (prev) =>
    Array.isArray(prev)
      ? prev.map((b) => (b.projectId === projectId && b.id === benchId ? { ...b, ...patch } : b))
      : prev,
  );
}

export function useNotificationStream(): void {
  const queryClient = useQueryClient();
  // Tracks notification IDs for which a native OS notification has already been shown.
  // Per-hook-instance so tests stay isolated and the set resets on component remount.
  const firedIds = useRef(new Set<string>());

  useEffect(() => {
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // Set once the connection errors; the next open is a reconnect.
    let interrupted = false;

    const onMessage = (event: MessageEvent<string>) => {
      let data: SseEvent;
      try {
        data = JSON.parse(event.data) as SseEvent;
      } catch {
        return;
      }

      if (data.type === "delivery") {
        applyDeliveryFrame(queryClient, data);
        return;
      }

      if (data.type === "bench-decision-mode") {
        // The session applied another mode: the bench card's variant badge
        // names it at once, as a status change patches the card.
        patchBench(queryClient, data.projectId, data.benchId, {
          deliveryDecisionMode: data.decisionMode,
        });
        return;
      }

      if (data.type === "bench-status") {
        // Patch caches in place so the bench card transitions in a single render
        // frame, with no refetch round-trip and no flicker.
        patchBench(queryClient, data.projectId, data.benchId, { status: data.status });
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({
        queryKey: ["bench", data.projectId, data.benchId],
      });

      if (window.roubo?.showNotification) {
        for (const n of data.notifications) {
          if (n.priority === "action-needed" && !firedIds.current.has(n.id)) {
            firedIds.current.add(n.id);
            const { title, body } = formatNotification(n);
            const routeTo = notificationRouteTo(data.projectId, data.benchId, n);
            window.roubo.showNotification({ title, body, routeTo });
          }
        }
      }
    };

    const connect = () => {
      const next = new EventSource("/api/notifications/stream");
      source = next;
      next.onmessage = onMessage;
      next.onopen = () => {
        if (!interrupted) return;
        interrupted = false;
        // Every delivery frame sent while the stream was down is lost, so each
        // delivery snapshot is read again (SB-TC-054).
        void queryClient.invalidateQueries({ queryKey: ["delivery"] });
      };
      next.onerror = (e) => {
        console.error("[useNotificationStream] SSE error:", e);
        interrupted = true;
        // CLOSED means the browser will not try again on its own.
        if (next.readyState === 2 && !disposed && reconnectTimer === undefined) {
          next.close();
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (!disposed) connect();
          }, SSE_RECONNECT_MS);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [queryClient]);
}
