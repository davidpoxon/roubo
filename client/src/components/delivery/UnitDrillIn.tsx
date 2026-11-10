import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { TabPanel as AriaTabPanel, type Key } from "react-aria-components";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import type { CaseResult } from "@roubo/shared/testbench-contracts";
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
import { Tab, TabList, TAB_PANEL_CLASS, Tabs } from "../ui/Tabs";
import { DeliveryPanel } from "./DeliveryPanel";
import {
  buildTimeline,
  clockTime,
  eventDetail,
  eventText,
  matchEventOutput,
  seamLabel,
  transcriptText,
  unitEvents,
  type TimelineItem,
  type TimelineSeamItem,
} from "./delivery-timeline-model";

// A unit's drill-in (SB-FR-013, SB-US-004): the structured event timeline
// first, on the left, and on the right the delivery session's terminal above
// a panel with a Diff tab and a Verify tab (#1621). The timeline holds the unit's events from GET
// /delivery/events?unit=<id> (the most recent 1,000, SB-NFR-003) with each
// generation seam of the unit marked on it. A done or jammed (failed, blocked)
// unit's terminal replays its recorded transcript read-only, and choosing an
// event on the timeline scrolls that transcript to the output the event
// matches; an active unit's terminal is the live
// delivery session, embedded here beside the timeline. It holds a socket of its
// own to the session, next to the one the bench's Terminal tab holds: the
// server takes several viewers per session and sends each the replay and the
// live output. Every panel is a named region the keyboard reaches, F6
// leaves the terminal for the selected one of Diff and Verify (Shift+F6 for
// the timeline), and a unit with no events shows an empty state naming the
// unit in each panel. Both tab panels stay mounted, the unselected one hidden,
// so the diff is read as the drill-in opens, whichever tab shows.

export const LEAVE_TERMINAL_KEY = "F6";

export interface UnitDrillInProps {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  unitId: string;
  // The bench's delivery session terminal, when it recorded one.
  deliverySessionId?: string;
}

const EMPTY = "text-13 text-text-secondary";
// The body of a tab panel, named for the screen reader by its region.
const TAB_BODY = `min-w-0 space-y-2 p-3 ${focusRing} focus-visible:ring-inset`;

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
  const verifyRef = useRef<HTMLElement>(null);
  const [sideTab, setSideTab] = useState<Key>("diff");
  const [chosenSeq, setChosenSeq] = useState<number | null>(null);
  const chosen = useMemo(
    () => (chosenSeq === null ? null : (events.find((item) => item.seq === chosenSeq) ?? null)),
    [events, chosenSeq],
  );

  if (unit === undefined) return null;
  const kind = classifyUnitStatus(unit.status);

  return (
    <div data-testid="unit-drill-in" className="@container">
      <div className="grid items-start gap-3.5 @4xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <UnitTimeline
          panelRef={timelineRef}
          unitId={unitId}
          events={events}
          folded={feed.events.data?.folded ?? 0}
          snapshot={snapshot}
          isPending={feed.events.isPending}
          error={feed.events.isError ? feed.events.error.message : undefined}
          chosenSeq={chosen?.seq ?? null}
          onChoose={setChosenSeq}
        />
        <div data-drill-in-column="side" className="grid min-w-0 gap-3.5">
          <UnitTerminalPanel
            projectId={projectId}
            benchId={benchId}
            unitId={unitId}
            recorded={kind === "done" || kind === "jammed"}
            active={kind === "running"}
            events={events}
            chosen={chosen}
            deliverySessionId={deliverySessionId}
            onLeave={(backwards) => {
              const next = backwards ? timelineRef : sideTab === "verify" ? verifyRef : diffRef;
              next.current?.focus();
            }}
          />
          <div
            data-testid="unit-diff-verify"
            className="animate-rise-in min-w-0 overflow-hidden rounded-control border border-border bg-bg-surface"
          >
            <Tabs selectedKey={sideTab} onSelectionChange={setSideTab}>
              <TabList aria-label={`Diff and verify results of unit ${unitId}`} className="px-3">
                <Tab id="diff" className="focus-visible:ring-inset">
                  Diff
                </Tab>
                <Tab id="verify" className="focus-visible:ring-inset">
                  Verify
                </Tab>
              </TabList>
              <SideTabPanel id="diff">
                <UnitDiffPanel
                  panelRef={diffRef}
                  projectId={projectId}
                  benchId={benchId}
                  unitId={unitId}
                  head={unit.head}
                />
              </SideTabPanel>
              <SideTabPanel id="verify">
                <UnitVerifyPanel panelRef={verifyRef} snapshot={snapshot} unitId={unitId} />
              </SideTabPanel>
            </Tabs>
          </div>
        </div>
      </div>
    </div>
  );
}

// A tab panel of the Diff and Verify pair. It stays mounted while the other
// tab shows, inert and out of the layout, as the Terminal tab of the bench
// does. The display is set inline, so it holds wherever the page's styles do
// not reach.
function SideTabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <AriaTabPanel
      id={id}
      shouldForceMount
      className={TAB_PANEL_CLASS}
      style={({ isInert }) => (isInert ? { display: "none" } : undefined)}
    >
      {children}
    </AriaTabPanel>
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
  chosenSeq,
  onChoose,
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
  // The event whose output the terminal shows, chosen on the timeline.
  chosenSeq: number | null;
  onChoose: (seq: number) => void;
}) {
  const items = useMemo(
    () => buildTimeline(unitId, events, snapshot.seams),
    [unitId, events, snapshot.seams],
  );
  const count = items.filter((item) => item.kind === "event").length;
  return (
    <DeliveryPanel
      ref={panelRef}
      title="Timeline"
      label={`Timeline of unit ${unitId}`}
      tabStop
      testId="unit-timeline"
      meta={count > 0 && `${count} ${count === 1 ? "event" : "events"} · newest first`}
    >
      {error !== undefined ? (
        <p role="alert" className="p-3 text-13 text-danger-text">
          The events of unit {unitId} could not be read: {error}
        </p>
      ) : isPending ? (
        <p role="status" className={`p-3 ${EMPTY}`}>
          Reading the events of unit {unitId}...
        </p>
      ) : items.length === 0 ? (
        <p
          data-testid="unit-timeline-empty"
          data-folded={folded > 0 ? "true" : undefined}
          className={`p-3 ${EMPTY}`}
        >
          {folded > 0
            ? `No newer events for unit ${unitId}: the delivery record holds its ${folded} ${folded === 1 ? "event" : "events"}.`
            : `No events for unit ${unitId} yet.`}
        </p>
      ) : (
        <TimelineList unitId={unitId} items={items} chosenSeq={chosenSeq} onChoose={onChoose} />
      )}
    </DeliveryPanel>
  );
}

// The arrow keys that move between the events of the timeline.
const EVENT_STEP_KEYS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };

// Memoised, so a re-render of the drill-in that brings no new event leaves a
// full timeline of 1,000 rows alone. The list is one Tab stop: the arrow keys
// move between its events, and Enter or a click on one chooses it, so the
// terminal shows that event's output.
const TimelineList = memo(function TimelineList({
  unitId,
  items,
  chosenSeq,
  onChoose,
}: {
  unitId: string;
  items: TimelineItem[];
  chosenSeq: number | null;
  onChoose: (seq: number) => void;
}) {
  const newest = items.find((item) => item.kind === "event");
  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const step = ownValue(EVENT_STEP_KEYS, event.key);
    if (step === undefined) return;
    event.preventDefault();
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-event-seq]"),
    ];
    const at = buttons.findIndex((button) => button === document.activeElement);
    const next = at < 0 ? (step > 0 ? 0 : buttons.length - 1) : at + step;
    buttons[Math.min(Math.max(next, 0), buttons.length - 1)]?.focus();
  };
  return (
    <>
      <p id={`unit-timeline-hint-${unitId}`} className="sr-only">
        Use the arrow keys to move between events, and Enter to show an event&apos;s output in the
        terminal.
      </p>
      <ol
        aria-label={`Events of unit ${unitId}, newest first`}
        aria-describedby={`unit-timeline-hint-${unitId}`}
        tabIndex={0}
        data-testid="unit-timeline-list"
        onKeyDown={onKeyDown}
        className={`max-h-[40rem] overflow-y-auto ${focusRing} focus-visible:ring-inset`}
      >
        {items.map((item) =>
          item.kind === "seam" ? (
            <GenerationSeam key={item.key} seam={item} />
          ) : (
            <TimelineEvent
              key={item.key}
              event={item.event}
              newest={item === newest}
              chosen={item.event.seq === chosenSeq}
              onChoose={onChoose}
            />
          ),
        )}
      </ol>
    </>
  );
});

// DESIGN.md Timeline event: mono time, a kind badge, the text and a mono detail
// line; the newest event carries the 2px accent rule. The row is a button that
// chooses the event, so the terminal scrolls to its output.
function TimelineEvent({
  event,
  newest,
  chosen,
  onChoose,
}: {
  event: DeliveryEvent;
  newest: boolean;
  chosen: boolean;
  onChoose: (seq: number) => void;
}) {
  const detail = eventDetail(event);
  return (
    <li
      data-testid={`timeline-event-${event.seq}`}
      data-seq={event.seq}
      data-chosen={chosen ? "true" : undefined}
      className={`border-b border-border last:border-b-0 ${chosen ? "bg-bg-hover" : "bg-bg-surface"} ${
        newest ? "border-l-2 border-l-accent" : ""
      }`}
    >
      <button
        type="button"
        tabIndex={-1}
        data-event-seq={event.seq}
        aria-pressed={chosen}
        onClick={() => onChoose(event.seq)}
        className={`grid w-full grid-cols-[4rem_7rem_minmax(0,1fr)] items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-bg-hover active:bg-bg-pressed ${focusRing} focus-visible:ring-inset`}
      >
        <time dateTime={event.ts} className="font-mono text-11 text-text-secondary">
          {clockTime(event.ts)}
        </time>
        <span className="justify-self-start rounded-chip bg-bg-hover px-1 font-mono text-11 text-text-secondary [overflow-wrap:anywhere]">
          {event.type}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words text-13 text-text-body">{eventText(event)}</span>
          {detail !== null && (
            <span className="break-words font-mono text-11 text-text-secondary">{detail}</span>
          )}
        </span>
      </button>
    </li>
  );
}

// DESIGN.md Generation seam: a hairline rule with a mono label across the
// timeline. Not focusable: it describes the timeline.
function GenerationSeam({ seam }: { seam: TimelineSeamItem }) {
  return (
    <li
      data-testid="timeline-seam"
      className="flex items-center gap-3 border-b border-border px-3 py-1.5"
    >
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
  recorded,
  active,
  events,
  chosen,
  deliverySessionId,
  onLeave,
}: {
  projectId: string;
  benchId: number;
  unitId: string;
  // The unit is done or jammed, so its terminal replays its recorded span.
  recorded: boolean;
  // The unit is running now, so the delivery session is working on it.
  active: boolean;
  events: readonly DeliveryEvent[];
  // The event chosen on the timeline, whose output the transcript scrolls to.
  chosen: DeliveryEvent | null;
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
  const live = !recorded && deliverySessionId !== undefined && (active || events.length > 0);
  return (
    <DeliveryPanel
      title="Terminal"
      label={`Terminal of unit ${unitId}`}
      describedBy={`unit-terminal-hint-${unitId}`}
      tabStop
      testId="unit-terminal"
      onKeyDownCapture={onKeyDownCapture}
      meta={recorded ? "read-only transcript" : live && active ? `${unitId} · live` : null}
    >
      <div className="space-y-2 p-3">
        <p id={`unit-terminal-hint-${unitId}`} className="text-11 text-text-secondary">
          Press F6 to leave the terminal, Shift+F6 to go back to the timeline.
        </p>
        {recorded ? (
          <RecordedTranscript
            projectId={projectId}
            benchId={benchId}
            unitId={unitId}
            events={events}
            chosen={chosen}
          />
        ) : live ? (
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
      </div>
    </DeliveryPanel>
  );
}

function RecordedTranscript({
  projectId,
  benchId,
  unitId,
  events,
  chosen,
}: {
  projectId: string;
  benchId: number;
  unitId: string;
  events: readonly DeliveryEvent[];
  chosen: DeliveryEvent | null;
}) {
  const own = unitEvents(unitId, events);
  const lastSeq = own.at(-1)?.seq ?? null;
  const transcript = useDeliveryUnitTranscript(projectId, benchId, unitId, lastSeq, true);
  const text = useMemo(() => transcriptText(transcript.data?.lines ?? []), [transcript.data]);
  const match = useMemo(
    () => (chosen === null ? null : matchEventOutput(text, chosen)),
    [text, chosen],
  );
  const matchRef = useRef<HTMLElement>(null);
  // Scroll the transcript to the chosen event's output. jsdom has no layout,
  // and so ships no scrollIntoView.
  useEffect(() => {
    const mark = matchRef.current;
    if (match !== null && mark !== null && typeof mark.scrollIntoView === "function") {
      mark.scrollIntoView({ block: "nearest" });
    }
  }, [match]);
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
        {match === null ? (
          text
        ) : (
          <>
            {text.slice(0, match.start)}
            <mark
              ref={matchRef}
              data-testid="unit-transcript-match"
              data-seq={chosen?.seq}
              className="rounded-sm bg-accent-muted text-accent-text"
            >
              {text.slice(match.start, match.end)}
            </mark>
            {text.slice(match.end)}
          </>
        )}
      </pre>
      {chosen !== null && (
        <p role="status" data-testid="unit-transcript-chosen" className={EMPTY}>
          {match === null
            ? `No output in the transcript of unit ${unitId} matches event ${chosen.seq}.`
            : `Showing the output of event ${chosen.seq}.`}
        </p>
      )}
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
      className={TAB_BODY}
    >
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

function caseResult(snapshot: DeliverySnapshot, caseId: string): CaseResult | null {
  return snapshot.progress.caseList.find((item) => item.id === caseId)?.result ?? null;
}

function resultStatus(result: CaseResult | null): string {
  if (result === null) return "no result recorded";
  return result.statusOverride?.status ?? result.derivedStatus;
}

// The evidence a result rests on: the verifier's method tier and confidence
// with its evidence pointers, then the notes written on the case.
function resultEvidence(result: CaseResult | null): string[] {
  if (result === null) return [];
  const lines: string[] = [];
  const { verification } = result;
  if (verification !== undefined) {
    lines.push(`tier ${verification.tier} · ${verification.confidence} confidence`);
    lines.push(...verification.evidence);
  }
  lines.push(...result.notes.map((note) => note.text));
  return lines;
}

function CaseEvidence({ caseId, result }: { caseId: string; result: CaseResult | null }) {
  const lines = resultEvidence(result);
  if (lines.length === 0) {
    return <span className="text-text-secondary">no evidence recorded</span>;
  }
  return (
    <ul
      aria-label={`Evidence of ${caseId}`}
      data-testid={`unit-verify-evidence-${caseId}`}
      className="space-y-0.5 font-mono text-11 text-text-secondary"
    >
      {lines.map((line, index) => (
        <li key={index} className="break-words">
          {line}
        </li>
      ))}
    </ul>
  );
}

// The verify results of the cases the unit implements: the cases of the gates
// that run after it, each with its result from the spec's test-results.json as
// the server's fold reads it, and the evidence that result rests on.
function UnitVerifyPanel({
  panelRef,
  snapshot,
  unitId,
}: {
  panelRef: RefObject<HTMLElement | null>;
  snapshot: DeliverySnapshot;
  unitId: string;
}) {
  const gates = selectGatesAfterUnit(snapshot, unitId);
  const rows = gates.flatMap((view) =>
    view.gate.cases.map((caseId) => ({ gateId: view.gate.id, caseId })),
  );
  return (
    <section
      ref={panelRef}
      aria-label={`Verify results of unit ${unitId}`}
      tabIndex={0}
      data-testid="unit-verify"
      className={TAB_BODY}
    >
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
              <th scope="col" className="font-medium">
                Evidence
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const result = caseResult(snapshot, row.caseId);
              return (
                <tr
                  key={`${row.gateId}:${row.caseId}`}
                  data-testid={`unit-verify-${row.caseId}`}
                  className="align-top"
                >
                  <td className="font-mono text-text-body">{row.caseId}</td>
                  <td className="font-mono text-text-secondary">{row.gateId}</td>
                  <td className="text-text-body">{resultStatus(result)}</td>
                  <td>
                    <CaseEvidence caseId={row.caseId} result={result} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
