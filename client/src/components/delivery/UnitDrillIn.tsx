import { memo, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { TabPanel as AriaTabPanel, type Key } from "react-aria-components";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import type { CaseResult } from "@roubo/shared/testbench-contracts";
import { ownValue, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectGatesAfterUnit } from "@roubo/shared/delivery-selectors";
import { useDeliveryFeed } from "../../hooks/useDeliveryFeed";
import { useDeliveryUnitDiff } from "../../hooks/useDelivery";
import { STATUS_DOT, STATUS_LABEL } from "../testbench/statusLabels";
import { focusRing } from "../ui/focus-ring";
import { Tab, TabList, TAB_PANEL_CLASS, Tabs } from "../ui/Tabs";
import { DeliveryPanel } from "./DeliveryPanel";
import DeliveryTimeSplit from "./DeliveryTimeSplit";
import {
  buildTimeline,
  eventDetail,
  eventText,
  seamLabel,
  timelineTime,
  type TimelineItem,
  type TimelineSeamItem,
} from "./delivery-timeline-model";

// A unit's drill-in (SB-FR-013, SB-US-004): the structured event timeline on
// the left, and on the right a panel with a Diff tab and a Verify tab (#1621).
// Below both, the unit's time split (#1671).
// The timeline holds the unit's events from GET /delivery/events?unit=<id>
// (the most recent 1,000, SB-NFR-003), the events the delivery record already
// carries included (#1659), with each generation seam of the unit marked on
// it. The drill-in shows no terminal: the delivery's agents run in the bench's
// Terminal tab (#1659). Every panel is a named region the keyboard reaches,
// and a unit with no events shows an empty state naming the unit in each
// panel. The Verify tab lists the cases of the gates after the unit as rows
// under their gate, each opening its evidence. Both tab panels stay mounted,
// the unselected one hidden, so the diff is read as the drill-in opens,
// whichever tab shows.

export interface UnitDrillInProps {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  unitId: string;
}

const EMPTY = "text-13 text-text-secondary";
// The body of a tab panel, named for the screen reader by its region.
const TAB_BODY = `min-w-0 space-y-2 p-3 ${focusRing} focus-visible:ring-inset`;

export default function UnitDrillIn({ projectId, benchId, snapshot, unitId }: UnitDrillInProps) {
  const feed = useDeliveryFeed(projectId, benchId, { unit: unitId });
  const events = useMemo(() => feed.events.data?.events ?? [], [feed.events.data]);
  const unit = ownValue(snapshot.unitsById, unitId);
  const diffRef = useRef<HTMLElement>(null);
  const verifyRef = useRef<HTMLElement>(null);
  const [sideTab, setSideTab] = useState<Key>("diff");

  if (unit === undefined) return null;

  return (
    <div data-testid="unit-drill-in" className="@container">
      <div className="grid items-start gap-3.5 @4xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <UnitTimeline
          unitId={unitId}
          events={events}
          folded={feed.events.data?.folded ?? 0}
          snapshot={snapshot}
          isPending={feed.events.isPending}
          error={feed.events.isError ? feed.events.error.message : undefined}
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
      <DeliveryTimeSplit
        projectId={projectId}
        benchId={benchId}
        seq={snapshot.seq}
        unitId={unitId}
        className="mt-3.5"
      />
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
  unitId,
  events,
  folded,
  snapshot,
  isPending,
  error,
}: {
  unitId: string;
  events: readonly DeliveryEvent[];
  // The count of the unit's events that the record already carries. `events`
  // holds the ones the delivery outbox still has (#1659), so the timeline is
  // empty with a count only when the outbox no longer holds them.
  folded: number;
  snapshot: DeliverySnapshot;
  isPending: boolean;
  error: string | undefined;
}) {
  const items = useMemo(
    () => buildTimeline(unitId, events, snapshot.seams),
    [unitId, events, snapshot.seams],
  );
  const count = items.filter((item) => item.kind === "event").length;
  return (
    <DeliveryPanel
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
        <TimelineList unitId={unitId} items={items} />
      )}
    </DeliveryPanel>
  );
}

// Memoised, so a re-render of the drill-in that brings no new event leaves a
// full timeline of 1,000 rows alone. The list scrolls, so it is one Tab stop
// the keyboard scrolls. Every row reads its day against one `now`, taken when
// the list renders: a list left open over midnight relabels its days at the
// next event.
const TimelineList = memo(function TimelineList({
  unitId,
  items,
}: {
  unitId: string;
  items: TimelineItem[];
}) {
  const newest = items.find((item) => item.kind === "event");
  const now = new Date();
  return (
    <ol
      aria-label={`Events of unit ${unitId}, newest first`}
      tabIndex={0}
      data-testid="unit-timeline-list"
      className={`max-h-[40rem] overflow-y-auto ${focusRing} focus-visible:ring-inset`}
    >
      {items.map((item) =>
        item.kind === "seam" ? (
          <GenerationSeam key={item.key} seam={item} now={now} />
        ) : (
          <TimelineEvent key={item.key} event={item.event} newest={item === newest} now={now} />
        ),
      )}
    </ol>
  );
});

// DESIGN.md Timeline event: mono time, a kind badge, the text and a mono detail
// line; the newest event carries the 2px accent rule. The time is local, with
// the day in front of it when it is not today; the exact instant is its title.
function TimelineEvent({
  event,
  newest,
  now,
}: {
  event: DeliveryEvent;
  newest: boolean;
  now: Date;
}) {
  const detail = eventDetail(event);
  return (
    <li
      data-testid={`timeline-event-${event.seq}`}
      data-seq={event.seq}
      className={`grid grid-cols-[6.5rem_7rem_minmax(0,1fr)] items-start gap-3 border-b border-border bg-bg-surface px-3 py-2 last:border-b-0 ${
        newest ? "border-l-2 border-l-accent" : ""
      }`}
    >
      <time dateTime={event.ts} title={event.ts} className="font-mono text-11 text-text-secondary">
        {timelineTime(event.ts, now)}
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
    </li>
  );
}

// DESIGN.md Generation seam: a hairline rule with a mono label across the
// timeline. Not focusable: it describes the timeline.
function GenerationSeam({ seam, now }: { seam: TimelineSeamItem; now: Date }) {
  return (
    <li
      data-testid="timeline-seam"
      className="flex items-center gap-3 border-b border-border px-3 py-1.5"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border-strong" />
      <span className="font-mono text-11 font-medium text-text-secondary">
        <span className="sr-only">Generation seam: </span>
        {seamLabel(seam, now)}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border-strong" />
    </li>
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

function resultStatus(result: CaseResult | null) {
  if (result === null) return null;
  return result.statusOverride?.status ?? result.derivedStatus;
}

// The verifier's method tier and confidence, as the row shows them.
function resultTier(result: CaseResult | null): string | null {
  const verification = result?.verification;
  return verification === undefined
    ? null
    : `tier ${verification.tier} · ${verification.confidence}`;
}

// The evidence a result rests on: the verifier's evidence pointers, then the
// notes written on the case.
function resultEvidence(result: CaseResult | null): string[] {
  if (result === null) return [];
  return [...(result.verification?.evidence ?? []), ...result.notes.map((note) => note.text)];
}

function CaseEvidence({ caseId, result }: { caseId: string; result: CaseResult | null }) {
  const lines = resultEvidence(result);
  if (lines.length === 0) {
    return (
      <p data-testid={`unit-verify-evidence-${caseId}`} className={EMPTY}>
        No evidence recorded for {caseId}.
      </p>
    );
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

// One case of a gate: its status dot, its mono id, its title from the plan and
// its verification tier, on one row that opens the evidence beneath it. The
// ids never wrap; only the title and the evidence do.
function VerifyCaseRow({
  gateId,
  caseId,
  snapshot,
}: {
  gateId: string;
  caseId: string;
  snapshot: DeliverySnapshot;
}) {
  const [open, setOpen] = useState(false);
  const entry = snapshot.progress.caseList.find((item) => item.id === caseId);
  const result = entry?.result ?? null;
  const status = resultStatus(result);
  const tier = resultTier(result);
  const evidenceId = `unit-verify-evidence-${gateId}-${caseId}`;
  return (
    <li data-testid={`unit-verify-${caseId}`} className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? evidenceId : undefined}
        onClick={() => setOpen((was) => !was)}
        className={`grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left text-13 transition-colors hover:bg-bg-hover active:bg-bg-pressed ${focusRing} focus-visible:ring-inset`}
      >
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${status === null ? "bg-border-strong" : STATUS_DOT[status]}`}
        />
        <span className="whitespace-nowrap font-mono text-12 text-text-body">{caseId}</span>
        {/* A space, so the row's name reads "TC-1 Title", not "TC-1Title". */}{" "}
        <span className="min-w-0 break-words text-text-body">
          {entry?.title ?? <span className="text-text-secondary">not in the plan</span>}
          <span className="sr-only">
            , {status === null ? "no result recorded" : STATUS_LABEL[status]}
          </span>
        </span>
        <span className="whitespace-nowrap font-mono text-11 text-text-secondary">
          {tier ?? (status === null ? "no result" : "")}
        </span>
      </button>
      {open && (
        <div id={evidenceId} className="px-3 pb-2 pl-8">
          <CaseEvidence caseId={caseId} result={result} />
        </div>
      )}
    </li>
  );
}

// The verify results of the cases the unit implements: the cases of the gates
// that run after it, grouped under each gate, each with its result from the
// spec's test-results.json as the server's fold reads it.
function UnitVerifyPanel({
  panelRef,
  snapshot,
  unitId,
}: {
  panelRef: RefObject<HTMLElement | null>;
  snapshot: DeliverySnapshot;
  unitId: string;
}) {
  const gates = selectGatesAfterUnit(snapshot, unitId).filter((view) => view.gate.cases.length > 0);
  return (
    <section
      ref={panelRef}
      aria-label={`Verify results of unit ${unitId}`}
      tabIndex={0}
      data-testid="unit-verify"
      className={TAB_BODY}
    >
      {gates.length === 0 ? (
        <p data-testid="unit-verify-empty" className={EMPTY}>
          No verify results for unit {unitId}: no gate after it names a case.
        </p>
      ) : (
        gates.map((view) => (
          <section
            key={view.gate.id}
            aria-labelledby={`unit-verify-gate-${unitId}-${view.gate.id}`}
            data-testid={`unit-verify-${view.gate.id}`}
            className="overflow-hidden rounded-control border border-border"
          >
            <h3
              id={`unit-verify-gate-${unitId}-${view.gate.id}`}
              className="border-b border-border bg-bg-base px-3 py-1.5 font-mono text-11 font-medium text-text-secondary"
            >
              <span className="whitespace-nowrap">{view.gate.id}</span> · {view.gate.status}
            </h3>
            <ul>
              {view.gate.cases.map((caseId) => (
                <VerifyCaseRow
                  key={caseId}
                  gateId={view.gate.id}
                  caseId={caseId}
                  snapshot={snapshot}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
