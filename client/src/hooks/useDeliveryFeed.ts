import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DeliveryEventsResponse } from "@roubo/shared/delivery-bench";
import * as api from "../lib/api";
import { deliveryQueryKey, useDelivery } from "./useDelivery";

// A Spec Bench's delivery as a view reads it (SB-FR-008, SB-FR-013, SB-US-003,
// SB-US-004): the snapshot, and the accepted events of the delivery or of one
// unit.
//
// The snapshot is the server's fold of the record and the accepted events
// through the shared reducer (GET /delivery). It is read on mount, and read
// again on each delivery frame of the notification stream that the held
// snapshot is behind (useNotificationStream invalidates the delivery queries of
// the bench). The record stays on the server, so the client folds no event
// itself: a frame moves the client to the server's next fold.
//
// A stream gap is the reducer's `gap`: the fold stopped at a seq hole. Then the
// snapshot is read again, and the event list is dropped and read again whole,
// so neither shows a stream with a hole in it.
//
// The event list lives under the snapshot's query key, so every invalidation of
// the bench's delivery (a frame, a reconnect of the stream) reads it too. Each
// read after the first asks only for the events above the accepted seq it
// holds, and appends them. The list keeps the most recent
// DELIVERY_FEED_MAX_EVENTS events only (SB-NFR-003), so a long delivery cannot
// grow the client without bound; the older ones stay on the server.

export const DELIVERY_FEED_MAX_EVENTS = 1_000;

function mostRecent(response: DeliveryEventsResponse): DeliveryEventsResponse {
  return response.events.length > DELIVERY_FEED_MAX_EVENTS
    ? { ...response, events: response.events.slice(-DELIVERY_FEED_MAX_EVENTS) }
    : response;
}

export function deliveryEventsQueryKey(projectId: string, benchId: number, unit?: string) {
  return [...deliveryQueryKey(projectId, benchId), "events", unit ?? null] as const;
}

export interface UseDeliveryFeedOptions {
  // Only the events whose envelope unit_id is this unit.
  unit?: string;
}

async function readEvents(
  queryClient: QueryClient,
  projectId: string,
  benchId: number,
  unit: string | undefined,
): Promise<DeliveryEventsResponse> {
  const key = deliveryEventsQueryKey(projectId, benchId, unit);
  const held = queryClient.getQueryData<DeliveryEventsResponse>(key);
  if (held === undefined) return mostRecent(await api.fetchDeliveryEvents(projectId, benchId, { unit }));
  const next = await api.fetchDeliveryEvents(projectId, benchId, {
    after: held.acceptedSeq,
    unit,
  });
  const heldDelivery = held.events[0]?.delivery_id;
  const nextDelivery = next.events[0]?.delivery_id;
  // A seq that went back, or events of another delivery, mean the bench's log
  // started again: what is held no longer extends, so read the list whole.
  if (
    next.acceptedSeq < held.acceptedSeq ||
    (heldDelivery !== undefined && nextDelivery !== undefined && heldDelivery !== nextDelivery)
  ) {
    return mostRecent(await api.fetchDeliveryEvents(projectId, benchId, { unit }));
  }
  const last = held.events.at(-1)?.seq ?? held.acceptedSeq;
  return mostRecent({
    events: [...held.events, ...next.events.filter((event) => event.seq > last)],
    acceptedSeq: next.acceptedSeq,
  });
}

export function useDeliveryFeed(
  projectId: string,
  benchId: number,
  options: UseDeliveryFeedOptions = {},
) {
  const { unit } = options;
  const queryClient = useQueryClient();
  const snapshot = useDelivery(projectId, benchId);
  const events = useQuery({
    queryKey: deliveryEventsQueryKey(projectId, benchId, unit),
    queryFn: () => readEvents(queryClient, projectId, benchId, unit),
    retry: false,
  });

  // React Query keeps the same object for an equal refetch, so a gap that a
  // fresh read still shows does not fire this again.
  const gap = snapshot.data?.gap;
  useEffect(() => {
    if (gap === undefined) return;
    void queryClient.resetQueries({
      queryKey: [...deliveryQueryKey(projectId, benchId), "events"],
    });
    void queryClient.invalidateQueries({
      queryKey: deliveryQueryKey(projectId, benchId),
      exact: true,
    });
  }, [gap, queryClient, projectId, benchId]);

  return { snapshot, events };
}
