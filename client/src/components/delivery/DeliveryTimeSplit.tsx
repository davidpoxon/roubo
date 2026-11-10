import {
  DELIVERY_TIME_STATES,
  type DeliveryTimeSpan,
  type DeliveryTimeSplit as DeliveryTimeSplitData,
  type DeliveryTimeState,
} from "@roubo/shared/delivery-time-split";
import { useDeliveryTime } from "../../hooks/useDelivery";
import { formatRunTime } from "../../lib/unexpected-exit";
import { DeliveryPanel } from "./DeliveryPanel";
import { formatElapsed } from "./delivery-health-model";
import { utcMinute } from "./delivery-timeline-model";

// Where a delivery's elapsed time went (#1671): a "Time" panel with the
// delivery's window, or one unit's, split into agent working, waiting on the
// operator, at a gate and no live session. The parts add up to the total. A
// decorative bar shows the shares; the list below carries every value in
// words, each duration also in a long form for the screen reader. The panel
// holds no control, so it adds no Tab stop. The split comes from GET
// /delivery/time, which the delivery view and a unit's drill-in share. The
// delivery's notes name what the record cannot date: a session that ends
// without a pause, always, and a truncated history or an inferred review close
// when the split says so.

const TIME_STATE_LABEL: Record<DeliveryTimeState, string> = {
  agent: "Agent working",
  operator: "Waiting on you",
  gate: "At a gate",
  no_session: "No live session",
};

// The status roles of DESIGN.md: working is active, waiting is preparing, a
// gate takes the gate's status-error, and no session takes idle as a paused
// or wound-down delivery does.
const TIME_STATE_FILL: Record<DeliveryTimeState, string> = {
  agent: "bg-status-active",
  operator: "bg-status-preparing",
  gate: "bg-status-error",
  no_session: "bg-status-idle",
};

const EMPTY = "p-3 text-13 text-text-secondary";

function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function Duration({ ms }: { ms: number }) {
  return (
    <>
      <span aria-hidden="true">{formatElapsed(ms)}</span>
      <span className="sr-only">{formatRunTime(ms)}</span>
    </>
  );
}

function TimeSplitBody({ span, testId }: { span: DeliveryTimeSpan; testId: string }) {
  return (
    <div className="space-y-3 p-3">
      <div aria-hidden="true" className="flex h-2 w-full overflow-hidden rounded-full bg-bg-hover">
        {DELIVERY_TIME_STATES.map((state) =>
          span.parts[state] > 0 ? (
            <span
              key={state}
              data-testid={`${testId}-bar-${state}`}
              className={`block h-2 ${TIME_STATE_FILL[state]}`}
              style={{ width: `${String((span.parts[state] / span.totalMs) * 100)}%` }}
            />
          ) : null,
        )}
      </div>
      <dl className="space-y-0.5 text-12">
        {DELIVERY_TIME_STATES.map((state) => (
          <div
            key={state}
            data-testid={`${testId}-${state}`}
            className="flex items-center justify-between gap-3 border-b border-border py-0.5"
          >
            <dt className="flex items-center gap-1.5 text-text-body">
              <span
                aria-hidden="true"
                className={`inline-block size-2 shrink-0 rounded-full ${TIME_STATE_FILL[state]}`}
              />
              {TIME_STATE_LABEL[state]}
            </dt>
            <dd className="font-mono tabular-nums text-text-body">
              <Duration ms={span.parts[state]} />
              {", "}
              {`${String(share(span.parts[state], span.totalMs))} percent`}
            </dd>
          </div>
        ))}
        <div
          data-testid={`${testId}-total`}
          className="flex items-center justify-between gap-3 py-0.5 font-medium"
        >
          <dt className="text-text-primary">Total</dt>
          <dd className="font-mono tabular-nums text-text-primary">
            <Duration ms={span.totalMs} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Notes({ split }: { split: DeliveryTimeSplitData }) {
  const notes: string[] = [
    "A session that ends without a pause counts as agent working until the delivery is paused, wound down or resumed: the record does not say when a session ends.",
  ];
  if (split.notes.historyTruncated) {
    notes.push(
      "The event history does not reach back to the start: before its first event, a unit or gate that later changes counts as not yet started.",
    );
  }
  if (split.notes.reviewCloseInferred) {
    notes.push(
      "The record does not say when a review closed, so a review counts until its last outcome.",
    );
  }
  return (
    <ul
      data-testid="delivery-time-notes"
      className="space-y-1 px-3 pb-3 text-12 text-text-secondary"
    >
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/**
 * The Time panel. With `unitId` it shows that unit's split, from its first
 * move out of pending until it is done and the gates after it passed; without
 * it, the delivery's.
 */
export default function DeliveryTimeSplit({
  projectId,
  benchId,
  seq,
  unitId,
  className,
}: {
  projectId: string;
  benchId: number;
  seq: number;
  unitId?: string;
  className?: string;
}) {
  const query = useDeliveryTime(projectId, benchId, seq);
  const split = query.data;
  const testId = unitId === undefined ? "delivery-time" : "unit-time";
  const span =
    split === undefined
      ? undefined
      : unitId === undefined
        ? split
        : split.units.find((entry) => entry.unitId === unitId);

  let meta: string | undefined;
  if (span !== undefined && split !== undefined) {
    meta =
      unitId === undefined
        ? split.open
          ? `since ${utcMinute(split.from)}`
          : `${utcMinute(split.from)} to ${utcMinute(split.to)}`
        : span.totalMs > 0
          ? `from ${utcMinute(span.from)}`
          : undefined;
  }

  let body;
  if (split === undefined) {
    body = query.isError ? (
      <p role="alert" className={EMPTY}>
        The time split could not be read: {query.error.message}
      </p>
    ) : (
      <p role="status" className={EMPTY}>
        Reading the time split
      </p>
    );
  } else if (span === undefined) {
    body = <p className={EMPTY}>Unit {unitId} has not started.</p>;
  } else if (span.totalMs === 0 && unitId !== undefined) {
    // A started unit with no counted time finished before a truncated history
    // begins, or started just now.
    body = (
      <p className={EMPTY}>
        {split.notes.historyTruncated
          ? `Unit ${unitId} has no time in the event history.`
          : `Unit ${unitId} has no time counted yet.`}
      </p>
    );
  } else {
    body = (
      <>
        <TimeSplitBody span={span} testId={testId} />
        {unitId === undefined && <Notes split={split} />}
      </>
    );
  }

  return (
    <DeliveryPanel
      testId={testId}
      title="Time"
      label={unitId === undefined ? "Time of the delivery" : `Time of unit ${unitId}`}
      {...(meta !== undefined && { meta })}
      {...(className !== undefined && { className })}
    >
      {body}
    </DeliveryPanel>
  );
}
