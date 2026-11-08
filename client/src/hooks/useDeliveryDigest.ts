import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

// The since-you-left digest of a Spec Bench's delivery (SB-FR-012, SB-US-012):
// what changed above the seq the operator last viewed, as the server derives it
// from the reducer over the events above that seq (GET <base>/digest).
//
// The digest is read once each time the Delivery tab opens: its key is not
// under the snapshot's, so a delivery frame that reads the snapshot again does
// not read it, and a change the operator watches arrive does not join a digest
// already on screen.
//
// The last view is the seq the operator has seen, which moves on while the tab
// shows no digest: when the digest it opens with lists nothing (before the
// first view too), the view marks the delivery seen at once, and as the tab
// closes, or the page is hidden, it marks it seen at the snapshot's current
// seq, so the events the operator watched arrive live do not come back in the
// next digest. A digest that lists changes stays until it is dismissed: until
// then nothing is marked. Dismissing marks the delivery seen at the later of
// the digest's seq and the snapshot's (POST <base>/digest/seen) and reads it
// again, which then lists nothing: it comes back only once new events arrive.

export function deliveryDigestQueryKey(projectId: string, benchId: number) {
  return ["delivery-digest", projectId, benchId] as const;
}

export function useDeliveryDigest(projectId: string, benchId: number, currentSeq: number) {
  const queryClient = useQueryClient();
  const digest = useQuery({
    queryKey: deliveryDigestQueryKey(projectId, benchId),
    queryFn: () => api.fetchDeliveryDigest(projectId, benchId),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });

  // The highest seq this view has marked seen, or the server holds.
  const markedSeq = useRef<number | null>(null);
  // Whether the digest on screen lists changes, which hold the last view back.
  const showing = useRef(true);
  const latestSeq = useRef(currentSeq);
  useEffect(() => {
    latestSeq.current = currentSeq;
  }, [currentSeq]);

  const markSeen = useCallback(
    (seq: number) => {
      if (markedSeq.current !== null && seq <= markedSeq.current) return;
      markedSeq.current = seq;
      api.markDeliveryDigestSeen(projectId, benchId, seq).catch(() => {
        // The next open marks it again.
      });
    },
    [projectId, benchId],
  );

  const dismiss = useMutation({
    mutationFn: (seq: number) => api.markDeliveryDigestSeen(projectId, benchId, seq),
    onSuccess: (_result, seq) => {
      showing.current = false;
      markedSeq.current = Math.max(markedSeq.current ?? seq, seq);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryDigestQueryKey(projectId, benchId) }),
  });
  const data = digest.data;
  const { mutate } = dismiss;
  const dismissDigest = useCallback(() => {
    if (data === undefined) return;
    mutate(Math.max(data.seq, latestSeq.current));
  }, [data, mutate]);

  // An empty digest moves the last view up to this one.
  useEffect(() => {
    if (data === undefined) return;
    if (data.lastViewedSeq !== null) {
      markedSeq.current = Math.max(markedSeq.current ?? data.lastViewedSeq, data.lastViewedSeq);
    }
    showing.current = data.entries.length > 0;
    if (!showing.current) markSeen(Math.max(data.seq, latestSeq.current));
  }, [data, markSeen]);

  // As the tab closes, or the page is hidden, the events that arrived while
  // no digest was on screen were seen.
  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded) return undefined;
    const leave = () => {
      if (!showing.current) markSeen(latestSeq.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      leave();
    };
  }, [loaded, markSeen]);

  return { digest, dismiss, dismissDigest };
}
