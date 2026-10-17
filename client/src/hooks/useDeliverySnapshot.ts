import { useEffect, useMemo, useRef, useState } from "react";
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
  // One reducer per hook instance: the lazy initializer runs on the first
  // render only, so the fold state survives re-renders.
  const [reducer] = useState<DeliveryReducer>(() => createDeliveryReducer());
  const { record, events, plan, results, lifecycle } = inputs;

  const snapshot = useMemo(
    () => reducer.fold({ record, events, plan, results, lifecycle, now }),
    [reducer, record, events, plan, results, lifecycle, now],
  );

  // Keep the latest callback without re-running the gap effect for a new
  // identity. The ref is written in an effect, never during render.
  const onGapRef = useRef(onGap);
  useEffect(() => {
    onGapRef.current = onGap;
  });

  useEffect(() => {
    if (snapshot.gap !== undefined) {
      onGapRef.current?.(snapshot.gap, snapshot);
    }
  }, [snapshot]);

  return snapshot;
}
