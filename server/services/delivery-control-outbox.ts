// The control outbox of a Spec Bench (SB-FR-014, SB-FR-021, SB-FR-022).
//
// Every operator control goes through `issueDeliveryControl`: the service gives
// it the next `control_seq` of the bench, stamps it with the operator who issued
// it, validates it against the delivery control contract and only then keeps
// it. Nothing here reads or writes a file in the spec folder, in the bench
// workspace or in the project checkout: a control lands in the outbox only.
//
// Where a control is kept follows its durability:
//   durable   status `pending`, appended to the bench's `deliveryControlQueue`
//             and written to state.json before the call returns, so the outbox
//             survives a server restart and `control_seq` goes on from its last
//             value. The queue goes with the bench.
//   volatile  status `queued`, held in memory for the next read only, and
//             dropped once a read has served it.
//
// The delivery tooling reads the outbox with `readDeliveryControls` (GET
// /api/hooks/delivery-controls), and the bench reads a control back from the
// events the tooling posts (`applyDeliveryControlReadBacks`): an event whose
// payload names the control's `control_seq`, or a `decision.answered` for the
// decision an answer control targets, marks the control `applied`. A control
// stays `pending` until then.
//
// The read takes the seq to read after only. The service keeps the read open to
// a later long poll (a `wait` and one waiting read per bench), which would wait
// here for the next issued control.
import type { Bench, DeliveryOutboxControl } from "@roubo/shared";
import {
  DELIVERY_CONTROL_DURABILITY,
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
  validateDeliveryControl,
  type DeliveryControlKind,
  type DeliveryControlReadReply,
  type DeliveryControlStatus,
} from "@roubo/shared/delivery-control-contract";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import type { Author } from "@roubo/shared/testbench-contracts";
import * as stateService from "./state.js";

// The volatile controls held for the next read, per bench.
const volatileControls = new Map<string, DeliveryOutboxControl[]>();
// The last control_seq issued per bench, volatile controls included. Seeded
// from the persisted queue after a restart.
const latestSeqs = new Map<string, number>();

function benchKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

// The statuses of a control the tooling has not acted on yet.
const OUTSTANDING: ReadonlySet<DeliveryControlStatus> = new Set(["pending", "queued", "delivered"]);

export function isControlOutstanding(control: DeliveryOutboxControl): boolean {
  return OUTSTANDING.has(control.status);
}

function persist(bench: Bench): void {
  stateService.updateBench(stateService.toPersistedBench(bench));
}

/** The highest control_seq the bench has issued, 0 before any. */
export function deliveryControlLatestSeq(bench: Bench): number {
  const key = benchKey(bench.projectId, bench.id);
  const queued = (bench.deliveryControlQueue ?? []).reduce(
    (max, control) => Math.max(max, control.control_seq),
    0,
  );
  const latest = Math.max(latestSeqs.get(key) ?? 0, queued);
  latestSeqs.set(key, latest);
  return latest;
}

/** Every control of the bench's outbox, durable and volatile, in control_seq order. */
export function deliveryControlsOf(bench: Bench): DeliveryOutboxControl[] {
  const volatile = volatileControls.get(benchKey(bench.projectId, bench.id)) ?? [];
  return [...(bench.deliveryControlQueue ?? []), ...volatile].sort(
    (a, b) => a.control_seq - b.control_seq,
  );
}

export interface DeliveryControlRequest {
  deliveryId: string;
  kind: DeliveryControlKind;
  targetId?: string;
  body: unknown;
  author: Author;
  // The issue time; the clock by default.
  issuedAt?: string;
}

export type IssueDeliveryControlResult =
  { ok: true; control: DeliveryOutboxControl } | { ok: false; errors: string[] };

/**
 * Validates a control against the control contract and appends it to the
 * bench's outbox with the next control_seq. A control that fails the contract
 * takes no seq and is kept nowhere.
 */
export function issueDeliveryControl(
  bench: Bench,
  request: DeliveryControlRequest,
): IssueDeliveryControlResult {
  const durability = DELIVERY_CONTROL_DURABILITY[request.kind];
  const controlSeq = deliveryControlLatestSeq(bench) + 1;
  const raw = {
    $schema: DELIVERY_CONTROL_SCHEMA_ID,
    schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
    delivery_id: request.deliveryId,
    control_seq: controlSeq,
    kind: request.kind,
    ...(request.targetId !== undefined && { target_id: request.targetId }),
    body: request.body,
    durability,
    issued_at: request.issuedAt ?? new Date().toISOString(),
    status: durability === "durable" ? "pending" : "queued",
  };
  const validated = validateDeliveryControl(raw);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const control: DeliveryOutboxControl = { ...validated.data, author: { ...request.author } };

  const key = benchKey(bench.projectId, bench.id);
  latestSeqs.set(key, controlSeq);
  if (durability === "durable") {
    bench.deliveryControlQueue = [...(bench.deliveryControlQueue ?? []), control];
    persist(bench);
  } else {
    volatileControls.set(key, [...(volatileControls.get(key) ?? []), control]);
  }
  return { ok: true, control };
}

/**
 * The read reply of the outbox: the controls above `after` in control_seq
 * order, and the latest control_seq. A volatile control is served once: the
 * read that returns it drops it from memory.
 */
export function readDeliveryControls(bench: Bench, after: number): DeliveryControlReadReply {
  const key = benchKey(bench.projectId, bench.id);
  const controls = deliveryControlsOf(bench).filter((control) => control.control_seq > after);
  const served = new Set(
    controls.filter((c) => c.durability === "volatile").map((c) => c.control_seq),
  );
  if (served.size > 0) {
    const left = (volatileControls.get(key) ?? []).filter((c) => !served.has(c.control_seq));
    if (left.length > 0) volatileControls.set(key, left);
    else volatileControls.delete(key);
  }
  return { controls, latestSeq: deliveryControlLatestSeq(bench) };
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Whether an accepted event reads the control back.
function readsBack(event: DeliveryEvent, control: DeliveryOutboxControl): boolean {
  if (event.delivery_id !== control.delivery_id) return false;
  const payload = event.payload as Record<string, unknown>;
  if (payload.control_seq === control.control_seq) return true;
  if (event.type === "decision.answered" && control.kind === "decision-answer") {
    const decisionId = payloadString(payload, "decision_id") ?? payloadString(payload, "id");
    return decisionId !== undefined && decisionId === control.target_id;
  }
  return false;
}

/**
 * Marks `applied` each outstanding durable control that one of the accepted
 * events reads back, and persists the queue when one changed. Returns the
 * control_seqs it marked.
 */
export function applyDeliveryControlReadBacks(
  bench: Bench,
  events: readonly DeliveryEvent[],
): number[] {
  const queue = bench.deliveryControlQueue;
  if (queue === undefined || queue.length === 0 || events.length === 0) return [];
  const applied: number[] = [];
  const next = queue.map((control) => {
    if (!isControlOutstanding(control)) return control;
    if (!events.some((event) => readsBack(event, control))) return control;
    applied.push(control.control_seq);
    return { ...control, status: "applied" as const };
  });
  if (applied.length > 0) {
    bench.deliveryControlQueue = next;
    persist(bench);
  }
  return applied;
}

/**
 * Drops the bench's outbox. The caller persists the bench: Clear bench writes
 * the record itself once the variant's teardown is done.
 */
export function forgetDeliveryControls(bench: Bench): void {
  const key = benchKey(bench.projectId, bench.id);
  volatileControls.delete(key);
  latestSeqs.delete(key);
  bench.deliveryControlQueue = undefined;
}

/** Drops the in-memory part of every outbox, as a server restart does. */
export function forgetDeliveryControlMemory(): void {
  volatileControls.clear();
  latestSeqs.clear();
}
