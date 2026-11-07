import { useEffect, useRef } from "react";
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
// When the digest it opens with lists nothing (before the first view too), the
// view marks the delivery seen at the digest's seq, so the next one starts
// from this view. Dismissing a digest marks it seen at the seq it was read at
// (POST <base>/digest/seen) and reads it again, which then lists nothing: it
// comes back only once new events arrive after that seq.

export function deliveryDigestQueryKey(projectId: string, benchId: number) {
  return ["delivery-digest", projectId, benchId] as const;
}

export function useDeliveryDigest(projectId: string, benchId: number) {
  const queryClient = useQueryClient();
  const digest = useQuery({
    queryKey: deliveryDigestQueryKey(projectId, benchId),
    queryFn: () => api.fetchDeliveryDigest(projectId, benchId),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });

  const dismiss = useMutation({
    mutationFn: (seq: number) => api.markDeliveryDigestSeen(projectId, benchId, seq),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveryDigestQueryKey(projectId, benchId) }),
  });

  // An empty digest moves the last view up to this one, once per open.
  const marked = useRef(false);
  const data = digest.data;
  useEffect(() => {
    if (marked.current || data === undefined || data.entries.length > 0) return;
    marked.current = true;
    if (data.lastViewedSeq === data.seq) return;
    api.markDeliveryDigestSeen(projectId, benchId, data.seq).catch(() => {
      // The next open marks it again.
    });
  }, [data, projectId, benchId]);

  return { digest, dismiss };
}
