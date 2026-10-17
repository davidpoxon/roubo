import { useEffect, useMemo, useRef } from "react";
import {
  createDeliveryReducer,
  type DeliveryFoldInputs,
  type DeliveryGap,
  type DeliveryReducer,
  type DeliverySnapshot,
} from "@roubo/shared/delivery-reducer";

// Fold an already-fetched delivery record and event list into a snapshot
// (SB-FR-008). The hook fetches nothing and stores no snapshot: every render
// calls the shared memoised reducer, which remembers only the fold state and
// costs one step per new event when the list extends the one it folded. The
// fetcher that feeds this hook, and the views that read the snapshot through the
// selectors, come with later units.
//
// `onGap` fires when the fold stops at a seq hole (the caller should refetch the
// record); `now` is the epoch-ms reference for the staleness age, absent means
// no age.
export interface UseDeliverySnapshotOptions {
  onGap?: (gap: DeliveryGap, snapshot: DeliverySnapshot) => void;
  now?: number;
}

export type DeliverySnapshotInputs = Omit<DeliveryFoldInputs, "now">;

export function useDeliverySnapshot(
  inputs: DeliverySnapshotInputs,
  options: UseDeliverySnapshotOptions = {},
): DeliverySnapshot {
  const { onGap, now } = options;
  // One reducer per hook instance, created on the first render only.
  const reducerRef = useRef<DeliveryReducer | null>(null);
  if (reducerRef.current === null) {
    reducerRef.current = createDeliveryReducer();
  }
  const reducer = reducerRef.current;
  const { record, events, plan, results, lifecycle } = inputs;

  const snapshot = useMemo(
    () => reducer.fold({ record, events, plan, results, lifecycle, now }),
    [reducer, record, events, plan, results, lifecycle, now],
  );

  // Keep the latest callback without re-running the effect for a new identity.
  const onGapRef = useRef(onGap);
  onGapRef.current = onGap;

  useEffect(() => {
    if (snapshot.gap !== undefined) {
      onGapRef.current?.(snapshot.gap, snapshot);
    }
  }, [snapshot]);

  return snapshot;
}
