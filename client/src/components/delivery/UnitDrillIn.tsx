import { memo, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import {
  classifyUnitStatus,
  ownValue,
  type DeliverySnapshot,
} from "@roubo/shared/delivery-reducer";
import { selectGatesAfterUnit } from "@roubo/shared/delivery-selectors";
import { useDeliveryFeed } from "../../hooks/useDeliveryFeed";
import { useDeliveryUnitDiff, useDeliveryUnitTranscript } from "../../hooks/useDelivery";
import Terminal from "../Terminal";
import { focusRing } from "../ui/focus-ring";
import {
  buildTimeline,
  clockTime,
  eventDetail,
  eventText,
  seamLabel,
  transcriptText,
  unitEvents,
  type TimelineItem,
  type TimelineSeamItem,
} from "./delivery-timeline-model";

// A unit's drill-in (SB-FR-013, SB-US-004): the structured event timeline
// first, the delivery session's terminal beside it, and the Diff and Verify
// panels beneath. The timeline holds the unit's events from GET
// /delivery/events?unit=<id> (the most recent 1,000, SB-NFR-003) with each
// generation seam of the unit marked on it. A done unit's terminal replays its
// recorded transcript read-only; any other unit's terminal is the live
// delivery session. Every panel is a named region the keyboard reaches, F6
// leaves the terminal for the next panel (Shift+F6 for the one before), and a
// unit with no events shows an empty state naming the unit in each panel.

export const LEAVE_TERMINAL_KEY = "F6";

export interface UnitDrillInProps {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  unitId: string;
  // The bench's delivery session terminal, when it recorded one.
  deliverySessionId?: string;
}

const PANEL = `min-w-0 space-y-2 rounded-control border border-border bg-bg-surface p-3 ${focusRing}`;
const EMPTY = "text-13 text-text-secondary";

function PanelHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-13 font-medium text-text-primary">{children}</h4>;
}

export default function UnitDrillIn({
  projectId,
  benchId,
  snapshot,
  unitId,
  deliverySessionId,
}: UnitDrillInProps) {
  const feed = useDeliveryFeed(projectId, benchId, { unit: unitId });
  const events = useMemo(() => feed.events.data?.events ?? [], [feed.events.data]);
  const unit = ownValue(snapshot.unitsById, unitId);
  const timelineRef = useRef<HTMLElement>(null);
  const diffRef = useRef<HTMLElement>(null);

  if (unit === undefined) return null;

  return (
    <div data-testid="unit-drill-in" className="space-y-3">
      <div data-drill-in-row="top" className="grid gap-3 lg:grid-cols-2">
        <UnitTimeline
          panelRef={timelineRef}
          unitId={unitId}
          events={events}
          folded={feed.events.data?.folded ?? 0}
          snapshot={snapshot}
          isPending={feed.events.isPending}
          error={feed.events.isError ? feed.events.error.message : undefined}
        />
        <UnitTerminalPanel
          projectId={projectId}
          benchId={benchId}
          unitId={unitId}
          done={classifyUnitStatus(unit.status) === "done"}
          active={classifyUnitStatus(unit.status) === "running"}
          events={events}
          deliverySessionId={deliverySessionId}
          onLeave={(backwards) => (backwards ? timelineRef : diffRef).current?.focus()}
        />
      </div>
      <div data-drill-in-row="bottom" className="grid gap-3 lg:grid-cols-2">
        <UnitDiffPanel
          panelRef={diffRef}
          projectId={projectId}
          benchId={benchId}
          unitId={unitId}
          head={unit.head}
        />
        <UnitVerifyPanel snapshot={snapshot} unitId={unitId} />
      </div>
    </div>
  );
}

// ── Timeline ──

function UnitTimeline({
  panelRef,
  unitId,
  events,
  folded,
  snapshot,
  isPending,
  error,
}: {
  panelRef: RefObject<HTMLElement | null>;
  unitId: string;
  events: readonly DeliveryEvent[];
  // The count of the unit's events that the record already carries, and so
  // that `events` leaves out.
  folded: number;
  snapshot: DeliverySnapshot;
  isPending: boolean;
  error: string | undefined;
}) {
  const items = useMemo(
    () => buildTimeline(unitId, events, snapshot.seams),
    [unitId, events, snapshot.seams],
  );
  return (
    <section
      ref={panelRef}
      aria-label={`Timeline of unit ${unitId}`}
      tabIndex={0}
      data-testid="unit-timeline"
      className={PANEL}
    >
      <PanelHeading>Timeline</PanelHeading>
      {error !== undefined ? (
        <p role="alert" className="text-13 text-danger-text">
          The events of unit {unitId} could not be read: {error}
        </p>
      ) : isPending ? (
        <p role="status" className={EMPTY}>
          Reading the events of unit {unitId}...
        </p>
      ) : items.length === 0 ? (
        <p
          data-testid="unit-timeline-empty"
          data-folded={folded > 0 ? "true" : undefined}
          className={EMPTY}
        >
          {folded > 0
            ? `No newer events for unit ${unitId}: the delivery record holds its ${folded} ${folded === 1 ? "event" : "events"}.`
            : `No events for unit ${unitId} yet.`}
        </p>
      ) : (
        <TimelineList unitId={unitId} items={items} />
      )}
    </section>
  );
}

// Memoised, so a re-render of the drill-in that brings no new event leaves a
// full timeline of 1,000 rows alone.
const TimelineList = memo(function TimelineList({
  unitId,
  items,
}: {
  unitId: string;
  items: TimelineItem[];
}) {
  const newest = items.find((item) => item.kind === "event");
  return (
    <ol
      aria-label={`Events of unit ${unitId}, newest first`}
      tabIndex={0}
      data-testid="unit-timeline-list"
      className={`max-h-96 overflow-y-auto ${focusRing}`}
    >
      {items.map((item) =>
        item.kind === "seam" ? (
          <GenerationSeam key={item.key} seam={item} />
        ) : (
          <TimelineEvent key={item.key} event={item.event} newest={item === newest} />
        ),
      )}
    </ol>
  );
});

// DESIGN.md Timeline event: mono time, a kind badge, the text and a mono detail
// line; the newest event carries the 2px accent rule.
function TimelineEvent({ event, newest }: { event: DeliveryEvent; newest: boolean }) {
  const detail = eventDetail(event);
  return (
    <li
      data-testid={`timeline-event-${event.seq}`}
      data-seq={event.seq}
      className={`flex items-start gap-3 border-b border-border bg-bg-surface p-2 ${
        newest ? "border-l-2 border-l-accent" : ""
      }`}
    >
      <time dateTime={event.ts} className="font-mono text-11 text-text-secondary">
        {clockTime(event.ts)}
      </time>
      <span className="rounded-sm bg-bg-hover px-1 font-mono text-11 text-text-secondary">
        {event.type}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-13 text-text-body">{eventText(event)}</span>
        {detail !== null && <span className="font-mono text-11 text-text-secondary">{detail}</span>}
      </span>
    </li>
  );
}

// DESIGN.md Generation seam: a hairline rule with a mono label across the
// timeline. Not focusable: it describes the timeline.
function GenerationSeam({ seam }: { seam: TimelineSeamItem }) {
  return (
    <li data-testid="timeline-seam" className="flex items-center gap-2 p-1">
      <span aria-hidden="true" className="h-px flex-1 bg-border-strong" />
      <span className="font-mono text-11 font-medium text-text-secondary">
        <span className="sr-only">Generation seam: </span>
        {seamLabel(seam)}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border-strong" />
    </li>
  );
}

// ── Terminal ──

function UnitTerminalPanel({
  projectId,
  benchId,
  unitId,
  done,
  active,
  events,
  deliverySessionId,
  onLeave,
}: {
  projectId: string;
  benchId: number;
  unitId: string;
  done: boolean;
  // The unit is running now, so the delivery session is working on it.
  active: boolean;
  events: readonly DeliveryEvent[];
  deliverySessionId: string | undefined;
  onLeave: (backwards: boolean) => void;
}) {
  // Caught before the terminal sees it, so the shortcut works from inside the
  // live terminal, which keeps every other key, Tab included.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== LEAVE_TERMINAL_KEY) return;
    event.preventDefault();
    event.stopPropagation();
    onLeave(event.shiftKey);
  };
  return (
    <section
      aria-label={`Terminal of unit ${unitId}`}
      aria-describedby={`unit-terminal-hint-${unitId}`}
      tabIndex={0}
      data-testid="unit-terminal"
      onKeyDownCapture={onKeyDownCapture}
      className={PANEL}
    >
      <PanelHeading>Terminal</PanelHeading>
      <p id={`unit-terminal-hint-${unitId}`} className="text-11 text-text-secondary">
        Press F6 to leave the terminal, Shift+F6 to go back to the timeline.
      </p>
      {done ? (
        <RecordedTranscript
          projectId={projectId}
          benchId={benchId}
          unitId={unitId}
          events={events}
        />
      ) : deliverySessionId !== undefined && (active || events.length > 0) ? (
        <div data-testid="unit-terminal-live" className="h-80">
          <Terminal sessionId={deliverySessionId} active />
        </div>
      ) : (
        <p data-testid="unit-terminal-empty" className={EMPTY}>
          {deliverySessionId === undefined
            ? `No terminal for unit ${unitId}: the bench has no delivery session.`
            : `No terminal output for unit ${unitId} yet.`}
        </p>
      )}
    </section>
  );
}

function RecordedTranscript({
  projectId,
  benchId,
  unitId,
  events,
}: {
  projectId: string;
  benchId: number;
  unitId: string;
  events: readonly DeliveryEvent[];
}) {
  const own = unitEvents(unitId, events);
  const lastSeq = own.at(-1)?.seq ?? null;
  const transcript = useDeliveryUnitTranscript(projectId, benchId, unitId, lastSeq, true);
  const text = useMemo(() => transcriptText(transcript.data?.lines ?? []), [transcript.data]);
  if (transcript.isPending) {
    return (
      <p role="status" className={EMPTY}>
        Reading the transcript of unit {unitId}...
      </p>
    );
  }
  if (transcript.isError) {
    return (
      <p role="alert" className="text-13 text-danger-text">
        The transcript of unit {unitId} could not be read: {transcript.error.message}
      </p>
    );
  }
  if (text.length === 0) {
    return (
      <p data-testid="unit-terminal-empty" className={EMPTY}>
        No transcript recorded for unit {unitId}.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p
        data-testid="unit-transcript-label"
        className="inline-block rounded-sm bg-bg-hover px-1 font-mono text-11 text-text-secondary"
      >
        Read-only: recorded transcript
      </p>
      <pre
        data-testid="unit-transcript"
        role="region"
        aria-label={`Recorded transcript of unit ${unitId}, read-only`}
        tabIndex={0}
        className={`max-h-80 overflow-auto whitespace-pre-wrap rounded-sm bg-terminal-ground p-2 font-mono text-12 text-terminal-text ${focusRing}`}
      >
        {text}
      </pre>
    </div>
  );
}

// ── Diff ──

function UnitDiffPanel({
  panelRef,
  projectId,
  benchId,
  unitId,
  head,
}: {
  panelRef: RefObject<HTMLElement | null>;
  projectId: string;
  benchId: number;
  unitId: string;
  head: string | undefined;
}) {
  const diff = useDeliveryUnitDiff(projectId, benchId, unitId, head);
  return (
    <section
      ref={panelRef}
      aria-label={`Diff of unit ${unitId}`}
      tabIndex={0}
      data-testid="unit-diff"
      className={PANEL}
    >
      <PanelHeading>Diff</PanelHeading>
      {diff.isPending ? (
        <p role="status" className={EMPTY}>
          Reading the diff of unit {unitId}...
        </p>
      ) : diff.isError ? (
        <p role="alert" className="text-13 text-danger-text">
          The diff of unit {unitId} could not be read: {diff.error.message}
        </p>
      ) : diff.data.head === null ? (
        <p data-testid="unit-diff-empty" className={EMPTY}>
          No diff for unit {unitId} yet: it has no commit.
        </p>
      ) : diff.data.diff.length === 0 ? (
        <p data-testid="unit-diff-empty" className={EMPTY}>
          Unit {unitId} changes no file.
        </p>
      ) : (
        <div className="space-y-1">
          <p className="font-mono text-11 text-text-secondary">
            {diff.data.base?.slice(0, 8)}..{diff.data.head.slice(0, 8)}
            {diff.data.truncated && " · cut at 1 MB"}
          </p>
          <pre
            data-testid="unit-diff-text"
            role="region"
            aria-label={`Diff text of unit ${unitId}`}
            tabIndex={0}
            className={`max-h-96 overflow-auto rounded-sm bg-bg-base p-2 font-mono text-12 text-text-body ${focusRing}`}
          >
            {diff.data.diff}
          </pre>
        </div>
      )}
    </section>
  );
}

// ── Verify ──

function resultStatus(snapshot: DeliverySnapshot, caseId: string): string {
  const entry = snapshot.progress.caseList.find((item) => item.id === caseId);
  const result = entry?.result ?? null;
  if (result === null) return "no result recorded";
  return result.statusOverride?.status ?? result.derivedStatus;
}

// The verify results of the cases the unit implements: the cases of the gates
// that run after it, each with its result from the spec's test-results.json as
// the server's fold reads it.
function UnitVerifyPanel({ snapshot, unitId }: { snapshot: DeliverySnapshot; unitId: string }) {
  const gates = selectGatesAfterUnit(snapshot, unitId);
  const rows = gates.flatMap((view) =>
    view.gate.cases.map((caseId) => ({ gateId: view.gate.id, caseId })),
  );
  return (
    <section
      aria-label={`Verify results of unit ${unitId}`}
      tabIndex={0}
      data-testid="unit-verify"
      className={PANEL}
    >
      <PanelHeading>Verify</PanelHeading>
      {rows.length === 0 ? (
        <p data-testid="unit-verify-empty" className={EMPTY}>
          No verify results for unit {unitId}: no gate after it names a case.
        </p>
      ) : (
        <table className="w-full text-left text-13">
          <thead>
            <tr className="text-text-secondary">
              <th scope="col" className="font-medium">
                Case
              </th>
              <th scope="col" className="font-medium">
                Gate
              </th>
              <th scope="col" className="font-medium">
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.gateId}:${row.caseId}`} data-testid={`unit-verify-${row.caseId}`}>
                <td className="font-mono text-text-body">{row.caseId}</td>
                <td className="font-mono text-text-secondary">{row.gateId}</td>
                <td className="text-text-body">{resultStatus(snapshot, row.caseId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
