import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Bench, BenchNotification, BenchStatus } from "@roubo/shared";
import { formatNotification } from "../lib/notifications";

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

type SseEvent = NotificationsEvent | BenchStatusEvent;

export function useNotificationStream(): void {
  const queryClient = useQueryClient();
  // Tracks notification IDs for which a native OS notification has already been shown.
  // Per-hook-instance so tests stay isolated and the set resets on component remount.
  const firedIds = useRef(new Set<string>());

  useEffect(() => {
    const source = new EventSource("/api/notifications/stream");

    source.onmessage = (event: MessageEvent<string>) => {
      let data: SseEvent;
      try {
        data = JSON.parse(event.data) as SseEvent;
      } catch {
        return;
      }

      if (data.type === "bench-status") {
        // Patch caches in place so the bench card transitions in a single render
        // frame, with no refetch round-trip and no flicker.
        queryClient.setQueryData<Bench>(["bench", data.projectId, data.benchId], (prev) =>
          prev ? { ...prev, status: data.status } : prev,
        );
        queryClient.setQueriesData<Bench[]>({ queryKey: ["benches"] }, (prev) =>
          Array.isArray(prev)
            ? prev.map((b) =>
                b.projectId === data.projectId && b.id === data.benchId
                  ? { ...b, status: data.status }
                  : b,
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

    source.onerror = (e) => {
      console.error("[useNotificationStream] SSE error:", e);
    };

    return () => {
      source.close();
    };
  }, [queryClient]);
}
