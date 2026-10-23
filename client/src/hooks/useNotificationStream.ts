import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Bench, BenchNotification, BenchStatus } from "@roubo/shared";
import type { DeliveryStreamFrame } from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { formatNotification } from "../lib/notifications";
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

type SseEvent = NotificationsEvent | BenchStatusEvent | DeliveryStreamFrame;

// How long the hook waits before it opens the stream again when the browser
// gave the connection up (readyState CLOSED). A connection that only dropped is
// reopened by the EventSource itself, after the retry delay the server sends.
export const SSE_RECONNECT_MS = 2_000;

// A delivery frame (SB-FR-008) says the bench accepted events up to `seq`. The
// frame carries no event, so the client reads the snapshot again unless the one
// it holds is already at that seq. A frame that jumps past the held seq (a
// sequence gap: frames were missed, or the batch held several events) gets the
// same refetch, and the server's snapshot folds every accepted event, so none is
// missing from the timeline.
function applyDeliveryFrame(queryClient: QueryClient, frame: DeliveryStreamFrame): void {
  const key = deliveryQueryKey(frame.projectId, frame.benchId);
  const held = queryClient.getQueryData<DeliverySnapshot>(key);
  if (held !== undefined && typeof held.seq === "number" && frame.seq <= held.seq) return;
  void queryClient.invalidateQueries({ queryKey: key });
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

      if (data.type === "bench-status") {
        const { status } = data;
        // Patch caches in place so the bench card transitions in a single render
        // frame, with no refetch round-trip and no flicker.
        queryClient.setQueryData<Bench>(["bench", data.projectId, data.benchId], (prev) =>
          prev ? { ...prev, status } : prev,
        );
        queryClient.setQueriesData<Bench[]>({ queryKey: ["benches"] }, (prev) =>
          Array.isArray(prev)
            ? prev.map((b) =>
                b.projectId === data.projectId && b.id === data.benchId ? { ...b, status } : b,
              )
            : prev,
        );
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({
        queryKey: ["bench", data.projectId, data.benchId],
      });

      if (window.roubo?.showNotification) {
        const routeTo = `roubo://project/${data.projectId}/bench/${String(data.benchId)}`;
        for (const n of data.notifications) {
          if (n.priority === "action-needed" && !firedIds.current.has(n.id)) {
            firedIds.current.add(n.id);
            const { title, body } = formatNotification(n);
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
