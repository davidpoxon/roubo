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
//             dropped from the outbox once a read has served it. A served
//             thread message stays in memory as `delivered` for the review
//             card only (`deliveryCardControlsOf`), so the card keeps the
//             question while the session answers; no read serves it again,
//             nothing writes it to a file, and a `review.outcome` for its
//             decision drops it (SB-FR-036).
// Either way the issue writes the bench's `deliveryControlSeq`, the last
// control_seq issued, to state.json, so a restart after a volatile control
// never issues its seq again.
//
// The delivery tooling reads the outbox with `readDeliveryControls` (GET
// /api/hooks/delivery-controls), and the bench reads a control back from the
// events the tooling posts (`applyDeliveryControlReadBacks`): an event whose
// payload names the control's `control_seq`, a `decision.answered` for the
// decision an answer control targets, or a `decision.overturned` for the
// decision an overturn control targets, or a `review.outcome` for the decision
// a review control targets (`accepted` for a `review_accept`, `overturned` for
// an `overturn`), marks the control `applied`. A `review.outcome` with the
// other outcome settles the review all the same: it marks an outstanding review
// action on that decision `superseded`, so no later read serves it. The read
// that serves a pending durable control marks it `delivered`, so the bench knows
// the tooling has it; it stays `delivered` until the read-back or the record
// shows its effect.
//
// A control issued with `supersedes` marks each pending control it names
// `superseded` in the same write (an operator's second review action on a card
// before the tooling read the first). A read never serves a superseded control.
//
// The record loader prunes the queue against the record on every load
// (`pruneDeliveryControlQueue`, SB-FR-037): a queued control leaves the queue
// only when the record shows its effect, never on delivery alone. A review
// action leaves it once the record shows its decision reviewed with the outcome
// it asked for (`accepted` for a `review_accept`, `overturned` for an
// `overturn`), and a `mode_switch` once the record states its mode with no
// other switch on its way (see `pruneDeliveryControls` for a switch that a later
// one overtook). A review action whose decision the record shows
// reviewed with the other outcome is marked `superseded` instead, as the event
// read-back marks it, so no read serves it again. So a `delivered` control
// that the record does not show applied stays queued, and a read with
// `after=0` after a restart serves it again; the tooling applies an accept or
// an overturn for the same decision and option once only.
//
// A read with a `wait` and nothing to serve (`hasServableDeliveryControl`: a
// superseded control above its cursor counts as nothing) waits here for the
// next issued control (SB-FR-041): `waitForDeliveryControl` keeps one waiter per bench in
// memory, and `issueDeliveryControl` wakes it. A second waiter for the same
// bench ends the first as superseded. A token revoke or a new token ends it as
// revoked (see delivery-token-registry.ts), and a server shutdown ends every
// waiter.
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
import type {
  DeliveryEvent,
  DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import type { Author } from "@roubo/shared/testbench-contracts";
import * as stateService from "./state.js";

// The volatile controls held for the next read, per bench.
const volatileControls = new Map<string, DeliveryOutboxControl[]>();
// The thread messages a read has served, per bench, kept for the review card
// until their decision's review outcome. Memory only: a restart drops them.
const servedThreadMessages = new Map<string, DeliveryOutboxControl[]>();
// The last control_seq issued per bench, volatile controls included. Seeded
// after a restart from the persisted `deliveryControlSeq` and the queue.
const latestSeqs = new Map<string, number>();

interface ControlWaiter {
  end(reason: DeliveryControlWaitEnd): void;
}

// The one held control read per bench.
const waiters = new Map<string, ControlWaiter>();

function benchKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

// The statuses of a control the tooling has not acted on yet.
const OUTSTANDING: ReadonlySet<DeliveryControlStatus> = new Set(["pending", "queued", "delivered"]);

// An operator's review action on an agent decision's card. Once a read has
// served one, nothing replaces it (409 REVIEW_ACTION_DELIVERED).
export function isReviewControl(control: DeliveryOutboxControl): boolean {
  return control.reviewAction === true;
}

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
  const latest = Math.max(latestSeqs.get(key) ?? 0, bench.deliveryControlSeq ?? 0, queued);
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

/**
 * The controls a view of the bench shows: every control of the outbox, and the
 * thread messages a read has served, as `delivered`, in control_seq order. No
 * read of the tooling serves the served thread messages again.
 */
export function deliveryCardControlsOf(bench: Bench): DeliveryOutboxControl[] {
  const served = servedThreadMessages.get(benchKey(bench.projectId, bench.id)) ?? [];
  return [...deliveryControlsOf(bench), ...served].sort((a, b) => a.control_seq - b.control_seq);
}

export interface DeliveryControlRequest {
  deliveryId: string;
  kind: DeliveryControlKind;
  targetId?: string;
  body: unknown;
  author: Author;
  // The issue time; the clock by default.
  issuedAt?: string;
  // The control_seqs of the pending durable controls this one replaces: each
  // reads `superseded` once this control is kept.
  supersedes?: readonly number[];
  // A review action on an agent decision's card (see DeliveryOutboxControl).
  reviewAction?: boolean;
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
  const control: DeliveryOutboxControl = {
    ...validated.data,
    author: { ...request.author },
    ...(request.reviewAction === true && { reviewAction: true as const }),
  };

  const key = benchKey(bench.projectId, bench.id);
  latestSeqs.set(key, controlSeq);
  bench.deliveryControlSeq = controlSeq;
  const supersedes = new Set(request.supersedes ?? []);
  const queue = (bench.deliveryControlQueue ?? []).map((kept) =>
    supersedes.has(kept.control_seq) && kept.status === "pending"
      ? { ...kept, status: "superseded" as const }
      : kept,
  );
  if (durability === "durable") {
    bench.deliveryControlQueue = [...queue, control];
  } else {
    if (supersedes.size > 0) bench.deliveryControlQueue = queue;
    volatileControls.set(key, [...(volatileControls.get(key) ?? []), control]);
  }
  persist(bench);
  waiters.get(key)?.end("control");
  return { ok: true, control };
}

/**
 * Why a held control read ended:
 *   control     a control was issued for the bench
 *   timeout     the wait ran out
 *   superseded  a second held read for the same bench took its place
 *   revoked     the bench's token was revoked or replaced
 *   shutdown    the server is shutting down
 *   closed      the reader went away, so nothing answers it
 */
export type DeliveryControlWaitEnd =
  "control" | "timeout" | "superseded" | "revoked" | "shutdown" | "closed";

export interface DeliveryControlWait {
  /** Settles once, with the first reason the wait ended for. */
  done: Promise<DeliveryControlWaitEnd>;
  /** Ends the wait as `closed`: the reader went away. */
  cancel(): void;
}

/**
 * Holds a control read of the bench for up to `waitMs`. A held read of the
 * same bench ends at once as `superseded`. The caller reads the outbox first:
 * this waits for the next issued control only.
 */
export function waitForDeliveryControl(bench: Bench, waitMs: number): DeliveryControlWait {
  const key = benchKey(bench.projectId, bench.id);
  waiters.get(key)?.end("superseded");
  let settle: (reason: DeliveryControlWaitEnd) => void = () => undefined;
  const done = new Promise<DeliveryControlWaitEnd>((resolve) => {
    settle = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiter: ControlWaiter = {
    end(reason) {
      if (waiters.get(key) === waiter) waiters.delete(key);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      settle(reason);
    },
  };
  waiters.set(key, waiter);
  timer = setTimeout(() => waiter.end("timeout"), waitMs);
  return { done, cancel: () => waiter.end("closed") };
}

/** Whether a control read of the bench is held. */
export function hasDeliveryControlWaiter(bench: Bench): boolean {
  return waiters.has(benchKey(bench.projectId, bench.id));
}

/** Ends the bench's held control read, if any, for the reason given. */
export function releaseDeliveryControlWaiter(
  bench: Pick<Bench, "projectId" | "id">,
  reason: DeliveryControlWaitEnd,
): void {
  waiters.get(benchKey(bench.projectId, bench.id))?.end(reason);
}

/** Ends every held control read as `shutdown`. */
export function releaseDeliveryControlWaiters(): void {
  for (const waiter of [...waiters.values()]) waiter.end("shutdown");
}

/**
 * Whether a read with the cursor `after` serves the control: it lies above
 * `after` and is not `superseded`. The read and its hold gate share this test,
 * so a read is held whenever it would serve nothing.
 */
export function isServableDeliveryControl(control: DeliveryOutboxControl, after: number): boolean {
  return control.control_seq > after && control.status !== "superseded";
}

/** Whether a read of the bench with the cursor `after` serves any control. */
export function hasServableDeliveryControl(bench: Bench, after: number): boolean {
  return deliveryControlsOf(bench).some((control) => isServableDeliveryControl(control, after));
}

/**
 * The read reply of the outbox: the controls above `after` in control_seq
 * order, and the latest control_seq. A superseded control is never served. A
 * volatile control is served once: the read that returns it drops it from
 * memory. Each pending durable control the read serves is marked `delivered`
 * and persisted, and the reply carries it so.
 */
export function readDeliveryControls(bench: Bench, after: number): DeliveryControlReadReply {
  const key = benchKey(bench.projectId, bench.id);
  const delivered = new Set(
    deliveryControlsOf(bench)
      .filter((c) => c.control_seq > after && c.durability === "durable" && c.status === "pending")
      .map((c) => c.control_seq),
  );
  if (delivered.size > 0) {
    bench.deliveryControlQueue = (bench.deliveryControlQueue ?? []).map((c) =>
      delivered.has(c.control_seq) ? { ...c, status: "delivered" as const } : c,
    );
    persist(bench);
  }
  const controls = deliveryControlsOf(bench).filter((control) =>
    isServableDeliveryControl(control, after),
  );
  const served = new Set(
    controls.filter((c) => c.durability === "volatile").map((c) => c.control_seq),
  );
  if (served.size > 0) {
    const held = volatileControls.get(key) ?? [];
    const left = held.filter((c) => !served.has(c.control_seq));
    if (left.length > 0) volatileControls.set(key, left);
    else volatileControls.delete(key);
    const threadMessages = held
      .filter((c) => served.has(c.control_seq) && c.kind === "thread_message")
      .map((c) => ({ ...c, status: "delivered" as const }));
    if (threadMessages.length > 0) {
      servedThreadMessages.set(key, [...(servedThreadMessages.get(key) ?? []), ...threadMessages]);
    }
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
  const decisionRead =
    (event.type === "decision.answered" && control.kind === "decision-answer") ||
    (event.type === "decision.overturned" && control.kind === "overturn");
  const reviewRead =
    event.type === "review.outcome" &&
    ((payload.status === "accepted" && control.kind === "review_accept") ||
      (payload.status === "overturned" && control.kind === "overturn"));
  if (decisionRead || reviewRead) {
    const decisionId = payloadString(payload, "decision_id") ?? payloadString(payload, "id");
    return decisionId !== undefined && decisionId === control.target_id;
  }
  return false;
}

// Whether an accepted event settles the review of the decision a review
// action targets, whatever outcome it states.
function settlesReview(event: DeliveryEvent, control: DeliveryOutboxControl): boolean {
  if (event.type !== "review.outcome" || !isReviewControl(control)) return false;
  if (event.delivery_id !== control.delivery_id) return false;
  const payload = event.payload as Record<string, unknown>;
  const decisionId = payloadString(payload, "decision_id") ?? payloadString(payload, "id");
  return decisionId !== undefined && decisionId === control.target_id;
}

/**
 * Marks `applied` each outstanding durable control that one of the accepted
 * events reads back, and persists the queue when one changed. A review action
 * whose decision a `review.outcome` settles with the other outcome (an accept
 * the session overturned, or an overturn it accepted) is marked `superseded`
 * instead, so no read serves it again. A `review.outcome` also drops every
 * thread message on its decision, served or not: after the outcome only the
 * summary stays. Returns the control_seqs it marked `applied`.
 */
export function applyDeliveryControlReadBacks(
  bench: Bench,
  events: readonly DeliveryEvent[],
): number[] {
  dropReviewedThreadMessages(bench, events);
  const queue = bench.deliveryControlQueue;
  if (queue === undefined || queue.length === 0 || events.length === 0) return [];
  const applied: number[] = [];
  let changed = false;
  const next = queue.map((control) => {
    if (!isControlOutstanding(control)) return control;
    if (events.some((event) => readsBack(event, control))) {
      applied.push(control.control_seq);
      changed = true;
      return { ...control, status: "applied" as const };
    }
    if (events.some((event) => settlesReview(event, control))) {
      changed = true;
      return { ...control, status: "superseded" as const };
    }
    return control;
  });
  if (changed) {
    bench.deliveryControlQueue = next;
    persist(bench);
  }
  return applied;
}

/** What the record states that a prune of the queue reads. */
export type DeliveryControlPruneRecord = Pick<DeliveryRecord, "delivery_id" | "decisions" | "mode">;

// The review outcome a review action asks for.
function reviewOutcomeOf(control: DeliveryOutboxControl): "accepted" | "overturned" | undefined {
  if (!isReviewControl(control)) return undefined;
  if (control.kind === "review_accept") return "accepted";
  if (control.kind === "overturn") return "overturned";
  return undefined;
}

function switchedMode(control: DeliveryOutboxControl): unknown {
  return (control.body as { mode?: unknown } | undefined)?.mode;
}

/**
 * The queue as the record leaves it: each control whose effect the record
 * shows is gone, and each review action whose decision the record shows
 * reviewed with the other outcome reads `superseded`. A control of another
 * delivery is left as it is. Returns the queue itself when nothing changes.
 *
 * A `mode_switch` is judged against the last one in the queue: when the record
 * states that one's mode and no switch is pending, a switch to that mode goes,
 * and so does an earlier switch to another mode that no read has served (or
 * that the tooling has applied): the last one overtook it. An earlier switch to
 * another mode that a read served (`delivered`) stays, because the record does
 * not show its effect and the tooling may still apply it; the last switch then
 * stays too, so a replay ends at the operator's last mode.
 */
export function pruneDeliveryControls(
  queue: readonly DeliveryOutboxControl[],
  record: DeliveryControlPruneRecord,
): readonly DeliveryOutboxControl[] {
  const reviews = new Map<string, string>();
  for (const decision of record.decisions) {
    const status = decision.review?.status;
    if (status === "accepted" || status === "overturned") reviews.set(decision.id, status);
  }
  const ownSwitches = queue.filter(
    (control) => control.kind === "mode_switch" && control.delivery_id === record.delivery_id,
  );
  const lastSwitch = ownSwitches.reduce<DeliveryOutboxControl | undefined>(
    (last, control) => (last === undefined || control.control_seq > last.control_seq ? control : last),
    undefined,
  );
  const pending = record.mode.pending ?? null;
  const modeShown =
    lastSwitch !== undefined &&
    switchedMode(lastSwitch) === record.mode.value &&
    (pending === null || pending === record.mode.value);
  // An earlier switch to another mode that the tooling has read but the record
  // does not show applied.
  const servedOther = (control: DeliveryOutboxControl): boolean =>
    control !== lastSwitch &&
    control.status === "delivered" &&
    switchedMode(control) !== record.mode.value;
  const keepLast = ownSwitches.some(servedOther);

  let changed = false;
  const next: DeliveryOutboxControl[] = [];
  for (const control of queue) {
    if (control.delivery_id !== record.delivery_id) {
      next.push(control);
      continue;
    }
    if (control.kind === "mode_switch" && modeShown) {
      const stays = control === lastSwitch ? keepLast : servedOther(control);
      if (!stays) {
        changed = true;
        continue;
      }
    }
    const asked = reviewOutcomeOf(control);
    const shown = control.target_id === undefined ? undefined : reviews.get(control.target_id);
    if (asked !== undefined && shown !== undefined) {
      if (shown === asked) {
        changed = true;
        continue;
      }
      if (isControlOutstanding(control)) {
        changed = true;
        next.push({ ...control, status: "superseded" });
        continue;
      }
    }
    next.push(control);
  }
  return changed ? next : queue;
}

/**
 * Prunes the bench's queue against the record it loaded (SB-FR-037), and
 * persists the bench when the queue changed. The record loader calls it on
 * every load of a bench's record. Returns the control_seqs it cleared.
 */
export function pruneDeliveryControlQueue(
  bench: Bench,
  record: DeliveryControlPruneRecord,
): number[] {
  const queue = bench.deliveryControlQueue;
  if (queue === undefined || queue.length === 0) return [];
  const next = pruneDeliveryControls(queue, record);
  if (next === queue) return [];
  const kept = new Set(next.map((control) => control.control_seq));
  bench.deliveryControlQueue = [...next];
  persist(bench);
  return queue.filter((control) => !kept.has(control.control_seq)).map((c) => c.control_seq);
}

// Drops the thread messages, held or served, of each decision that a
// `review.outcome` among the events settles.
function dropReviewedThreadMessages(bench: Bench, events: readonly DeliveryEvent[]): void {
  const reviewed = new Set<string>();
  for (const event of events) {
    if (event.type !== "review.outcome") continue;
    const payload = event.payload as Record<string, unknown>;
    const decisionId = payloadString(payload, "decision_id") ?? payloadString(payload, "id");
    if (decisionId !== undefined) reviewed.add(`${event.delivery_id}\u0000${decisionId}`);
  }
  if (reviewed.size === 0) return;
  const key = benchKey(bench.projectId, bench.id);
  const keeps = (control: DeliveryOutboxControl) =>
    control.kind !== "thread_message" ||
    control.target_id === undefined ||
    !reviewed.has(`${control.delivery_id}\u0000${control.target_id}`);
  for (const store of [volatileControls, servedThreadMessages]) {
    const held = store.get(key);
    if (held === undefined) continue;
    const left = held.filter(keeps);
    if (left.length > 0) store.set(key, left);
    else store.delete(key);
  }
}

/**
 * Drops the bench's outbox. The caller persists the bench: Clear bench writes
 * the record itself once the variant's teardown is done.
 */
export function forgetDeliveryControls(bench: Bench): void {
  const key = benchKey(bench.projectId, bench.id);
  volatileControls.delete(key);
  servedThreadMessages.delete(key);
  latestSeqs.delete(key);
  bench.deliveryControlQueue = undefined;
  bench.deliveryControlSeq = undefined;
}

/**
 * Drops the in-memory part of every outbox, as a server restart does, and ends
 * every held read as a shutdown does.
 */
export function forgetDeliveryControlMemory(): void {
  releaseDeliveryControlWaiters();
  volatileControls.clear();
  servedThreadMessages.clear();
  latestSeqs.clear();
}
