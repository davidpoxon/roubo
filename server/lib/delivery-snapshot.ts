// The server's entry to the shared delivery reducer (SB-FR-008, SB-FR-010).
//
// Nothing here stores a snapshot. Each call folds the record and the events it
// is given through the shared memoised reducer, which remembers only the fold
// state per delivery and refolds from the record whenever the stream it is given
// does not extend the one it folded (see `createDeliveryReducer`). A route that
// serves a snapshot reads the record and the events, calls `foldDeliverySnapshot`
// (already-validated inputs) or `foldDeliveryJson` (raw JSON), and sends the
// result, as GET /delivery in routes/delivery.ts does.

import {
  validateDeliveryEvent,
  validateDeliveryRecord,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import {
  createDeliveryReducer,
  ownValue,
  setOwnValue,
  type DeliveryFoldInputs,
  type DeliveryGap,
  type DeliveryProgress,
  type DeliverySnapshot,
} from "@roubo/shared/delivery-reducer";
import { selectNextBoundary, selectOpenDecisions } from "@roubo/shared/delivery-selectors";

const reducer = createDeliveryReducer();

export function foldDeliverySnapshot(inputs: DeliveryFoldInputs): DeliverySnapshot {
  return reducer.fold(inputs);
}

// Drop the remembered fold state of one delivery (or of all), for a caller that
// knows the stream was rewritten.
export function forgetDelivery(deliveryId?: string): void {
  reducer.forget(deliveryId);
}

export type FoldDeliveryJsonResult =
  { ok: true; snapshot: DeliverySnapshot } | { ok: false; errors: string[] };

// Validate a raw record and raw events against the observation contract, then
// fold. Errors name their field; an event error is prefixed with its index in
// the list. `rest` carries the optional fold inputs (plan, results, lifecycle,
// now).
export function foldDeliveryJson(
  rawRecord: unknown,
  rawEvents: readonly unknown[],
  rest: Omit<DeliveryFoldInputs, "record" | "events"> = {},
): FoldDeliveryJsonResult {
  const record = validateDeliveryRecord(rawRecord);
  if (!record.ok) {
    return { ok: false, errors: record.errors.map((error) => `record: ${error}`) };
  }
  const events: DeliveryEvent[] = [];
  const errors: string[] = [];
  rawEvents.forEach((raw, index) => {
    const event = validateDeliveryEvent(raw);
    if (event.ok) {
      events.push(event.data);
    } else {
      errors.push(...event.errors.map((error) => `events.${index}: ${error}`));
    }
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, snapshot: reducer.fold({ ...rest, record: record.data, events }) };
}

// A compact reading of a snapshot for a log line or a list row. `byStatus` and
// `gates` are keyed by open strings (a status word, a gate id), so they are
// read and written as own keys only: a unit whose status is `toString` counts
// as one unit with that status, not as a string appended to a function.
export interface DeliverySummary {
  deliveryId: string;
  seq: number;
  gap: DeliveryGap | null;
  lifecycle: string;
  health: string;
  units: { total: number; byStatus: Record<string, number> };
  jams: string[];
  gates: Record<string, { status: string; evaluated: string }>;
  openDecisions: number;
  nextBoundary: { unitId: string; kind: "finish" | "start" } | null;
  progress: DeliveryProgress;
  ageMs: number | null;
}

export function summarizeDelivery(snapshot: DeliverySnapshot): DeliverySummary {
  const byStatus: Record<string, number> = {};
  const units = Object.values(snapshot.unitsById);
  for (const unit of units) {
    setOwnValue(byStatus, unit.status, (ownValue(byStatus, unit.status) ?? 0) + 1);
  }
  const gates: DeliverySummary["gates"] = {};
  for (const [id, view] of Object.entries(snapshot.gatesById)) {
    setOwnValue(gates, id, { status: view.gate.status, evaluated: view.state.status });
  }
  const boundary = selectNextBoundary(snapshot);
  return {
    deliveryId: snapshot.deliveryId,
    seq: snapshot.seq,
    gap: snapshot.gap ?? null,
    lifecycle: snapshot.lifecycle.state,
    health: snapshot.health.status,
    units: { total: units.length, byStatus },
    jams: snapshot.jams,
    gates,
    openDecisions: selectOpenDecisions(snapshot).length,
    nextBoundary: boundary === null ? null : { unitId: boundary.unitId, kind: boundary.kind },
    progress: snapshot.progress,
    ageMs: snapshot.staleness.ageMs,
  };
}
