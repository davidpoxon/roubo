import { useCallback, useEffect, useRef, useState } from "react";
import type { Bench } from "@roubo/shared";
import type { DeliveryReadError, DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { focusRing } from "../ui/focus-ring";
import {
  classifyLifecycleState,
  selectDecisionPile,
  selectProgress,
} from "@roubo/shared/delivery-selectors";
import { isUnreviewedAgentDecision, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { useDelivery, useDeliverySessionLive, useLaunchDelivery } from "../../hooks/useDelivery";
import { useDeliveryCrossCheck } from "../../hooks/useDeliveryCrossCheck";
import { deliveryReadErrorOf } from "../../lib/api";
import BoundaryPanel from "./BoundaryPanel";
import DecisionPile from "./DecisionPile";
import DeliveryCostView from "./DeliveryCostView";
import { readErrorTitle } from "./delivery-read-error";
import DeliveryCrossCheck, { DeliveryCrossCheckChip } from "./DeliveryCrossCheck";
import DeliveryRail from "./DeliveryHealth";
import DeliveryMap from "./DeliveryMap";
import DeliveryBreadcrumb from "./DeliveryBreadcrumb";
import DeliveryDrillIn from "./DeliveryDrillIn";
import GateSitting from "./GateSitting";
import { gateKey, unitKey, type MapFocusRequest, type MapTarget } from "./delivery-map-model";
import DeliveryDigest from "./DeliveryDigest";
import { useDeliveryDigest } from "../../hooks/useDeliveryDigest";
import type { DeliveryDigestEntry } from "@roubo/shared/delivery-digest";
import DeliveryCasesView from "./DeliveryCasesView";
import { BurnHealthPanel, DecisionSummaryPanel, NextBoundaryPanel } from "./DeliverySummaryRail";

// The Spec Bench's Delivery tab (SB-FR-009). It shows one view at a time
// (#1620), with no route of its own: the map, which opens first, or one of
// four views that each carry a breadcrumb back to it, a unit's or a gate's
// drill-in, decisions and steering, cost, health and controls, and the cases
// (#1655). A unit
// node or row, a gate marker on the map and a digest link to a unit or a gate
// open a drill-in. The
// rail's Decisions panel, a digest link to a decision and a link to the
// decision pile open the decisions view. The rail's Cost, health and controls
// link and a digest link to the drift ledger open the cost view. The header's
// cases met and the rail's Cases figure open the cases view. A return to
// the map puts the focus back on what opened the view, or on the map when the
// view was not opened from it. The map, decisions and cost views stay mounted
// while hidden, so each keeps its scroll, its selection and any text typed in
// it; a drill-in and the cases view mount while they show.
//
// It names what the bench delivers and how it is bound, then reads the
// delivery: the folded snapshot. The map view takes the height of the tab
// (#1655), down to a floor under which the tab scrolls, and holds:
// - a header row with the spec slug, the cases met with a meter, the health
//   chip (SB-FR-019, SB-NFR-006), the mode in effect in a mono label
//   (SB-FR-032) and a chip that counts the cross-check's disagreements, with
//   how the bench is bound and the spec folder on a line under it;
// - the gate sitting the bench prepares or has open, which reads waiting for
//   build until the pinned build passed its smoke check and ready to sit after
//   (SB-FR-023);
// - the since-you-left digest of what changed since the operator's last view
//   (SB-FR-012), until the operator dismisses it;
// - the map and a rail of summary panels (burn and health, decisions, the
//   next boundary, and the cross-check with its disagreements and source
//   error, SB-FR-030), side by side once the tab is wide enough for both, else
//   the rail under the map (#1618). Side by side, both take the rest of the
//   tab's height, and the cross-check takes the rest of the rail's and scrolls
//   its entries. Enter on a cross-check entry focuses its unit or gate on the
//   map (SB-FR-029).
// The cases view holds the progress in cases met and requirements covered
// (SB-FR-011), the gating cases, and the detail of the selected case with its
// verify record (DeliveryCasesView).
// The decisions view holds the decision pile, where a decision is answered or
// its default overturned in place (SB-FR-014, SB-FR-015), with the agent
// decisions to review on the same pile (SB-FR-033), and the boundary panel
// with the steering composer (SB-FR-016, SB-FR-017). The cost view
// (DeliveryCostView, #1623) holds a title row with the lifecycle badge and the
// lifecycle controls (SB-FR-022), among them Approve, which waits while a
// review is open (SB-FR-034), a gating case is unmet or the cross-check holds a
// blocking class (SB-FR-029); then the burn meter (SB-FR-018), the health line
// and the jams (SB-FR-019), the role matrix (SB-FR-021), the Mode switch
// (SB-FR-032) and the drift ledger (SB-FR-020), each in its own panel. A jam's
// Open button opens its unit's drill-in.
//
// The tab shows the snapshot when the record conforms, or the named error
// when it does not. No decision, steering, role, mode or lifecycle control
// renders until the record conforms, so nothing can act on a record the bench
// cannot read. The one exception is a launch-mode bench with no record yet: it
// offers to launch its session again, since no record means no session has
// run the delivery yet.
//
// `decisionPileFocusKey` is set when the bench was opened from a link to its
// decision pile, such as a delivery-decision notification's (SB-FR-014), and
// the pile has not yet taken focus for that link: the decisions view opens and
// the pile is scrolled into view and focused once the snapshot shows, and
// `onDecisionPileFocused` reports the key. This panel unmounts while another tab is selected, so the caller keeps
// the reported key and stops passing it, and a return to the tab under the
// same link leaves the focus where it is.
//
// `onSittingOpened` is called once a provisional gate's review card opened the
// gate's sitting (SB-FR-038), so the bench can show the sitting's cases.
export default function DeliveryTabPanel({
  bench,
  decisionPileFocusKey,
  onDecisionPileFocused,
  onSittingOpened,
}: {
  bench: Bench;
  decisionPileFocusKey?: string | undefined;
  onDecisionPileFocused?: ((key: string) => void) | undefined;
  onSittingOpened?: ((gateId: string) => void) | undefined;
}) {
  const specFolder = bench.focusedSpecPath;
  const slug = specFolder?.split("/").filter(Boolean).pop();
  const bindText =
    bench.deliveryBindMode === "attach"
      ? "attached to a running delivery"
      : bench.deliveryBindMode === "launch"
        ? "launched from this bench"
        : undefined;
  const delivery = useDelivery(bench.projectId, bench.id);
  const readError = delivery.isError ? deliveryReadErrorOf(delivery.error) : undefined;

  return (
    <div data-testid="delivery-tab-panel" className="flex h-full flex-col gap-4">
      {!delivery.isSuccess && (
        <div className="space-y-2">
          <p className="text-13 text-text-body">
            Delivering{" "}
            <span className="font-mono text-16 font-medium text-text-primary">
              {slug ?? "no spec"}
            </span>
            {bindText !== undefined && <span className="text-text-secondary"> · {bindText}</span>}
          </p>
          {specFolder && (
            <p className="break-all font-mono text-12 text-text-secondary">{specFolder}</p>
          )}
        </div>
      )}

      {delivery.isPending && (
        <p role="status" className="text-13 text-text-secondary">
          Reading the delivery record...
        </p>
      )}
      {delivery.isError && readError && (
        <DeliveryReadErrorCallout bench={bench} error={readError} />
      )}
      {delivery.isError && !readError && (
        <Callout role="alert" title="The delivery could not be read" data-testid="delivery-error">
          {delivery.error.message}
        </Callout>
      )}
      {delivery.isSuccess && (
        <DeliverySnapshotView
          bench={bench}
          slug={slug}
          source={[bindText, specFolder].filter(
            (part): part is string => part !== undefined && part !== "",
          )}
          snapshot={delivery.data}
          decisionPileFocusKey={decisionPileFocusKey}
          onDecisionPileFocused={onDecisionPileFocused}
          onSittingOpened={onSittingOpened}
        />
      )}
    </div>
  );
}

// The server refuses a new session while the bench's session runs or the bench
// is going (409), so a button that starts one says the same before it is pressed.
function useSessionStartBlocked(bench: Bench): boolean {
  const sessionLive = useDeliverySessionLive(bench);
  return bench.status === "clearing" || bench.status === "error" || sessionLive;
}

function DeliveryReadErrorCallout({ bench, error }: { bench: Bench; error: DeliveryReadError }) {
  const waiting = error.code === "DELIVERY_RECORD_MISSING";
  return (
    <Callout
      role={waiting ? "status" : "alert"}
      title={readErrorTitle(error)}
      data-testid="delivery-read-error"
    >
      <p>{error.error}</p>
      {waiting ? (
        <p>The delivery session writes it when it starts.</p>
      ) : (
        <p>
          Fix the record in the spec folder of the bench workspace. The tab reads it again on its
          own.
        </p>
      )}
      {waiting && bench.deliveryBindMode === "launch" && <LaunchDeliveryControl bench={bench} />}
    </Callout>
  );
}

// A launch-mode bench whose record is missing: the create-time launch may have
// failed, or the session ended before it wrote the record, so the operator can
// launch it again.
function LaunchDeliveryControl({ bench }: { bench: Bench }) {
  const launch = useLaunchDelivery(bench.projectId, bench.id);
  const blocked = useSessionStartBlocked(bench);
  return (
    <div data-testid="delivery-launch-control" className="space-y-2">
      <Button onPress={() => launch.mutate()} isDisabled={launch.isPending || blocked}>
        Launch the delivery session
      </Button>
      {launch.isError && <p role="alert">{launch.error.message}</p>}
    </div>
  );
}

// Where a digest link shows a decision, from the decision as it is now: its
// card on the decision pile while it is open, defaulted or overturned, its
// review card while it is an unreviewed agent decision, else (it was answered
// or reviewed since) the drill-in of the unit it is about, and with no such
// unit the decision pile's place, raising no card.
type DecisionLinkTarget = { kind: "card" } | { kind: "unit"; unitId: string } | { kind: "pile" };

function decisionLinkTarget(snapshot: DeliverySnapshot, decisionId: string): DecisionLinkTarget {
  if (selectDecisionPile(snapshot).some((decision) => decision.id === decisionId)) {
    return { kind: "card" };
  }
  const decision = Object.hasOwn(snapshot.decisionsById, decisionId)
    ? snapshot.decisionsById[decisionId]
    : undefined;
  if (decision === undefined) return { kind: "pile" };
  if (isUnreviewedAgentDecision(decision)) return { kind: "card" };
  const unitId = decision.unit_id;
  if (unitId !== undefined && Object.hasOwn(snapshot.unitsById, unitId)) {
    return { kind: "unit", unitId };
  }
  return { kind: "pile" };
}

// The view of the Delivery tab that shows (#1620).
type DeliveryView =
  | { kind: "map" }
  | { kind: "drill-in"; target: MapTarget }
  | { kind: "decisions" }
  | { kind: "cost" }
  | { kind: "cases" };

const VIEW_TITLE = "text-16 font-semibold text-text-primary";

function bringIntoView(view: HTMLElement | null): void {
  if (view === null) return;
  view.scrollIntoView?.({ block: "start" });
  view.focus();
}

// The header's progress: the cases met of all the cases, with a meter, and
// the requirements covered. A press opens the cases view.
function DeliveryHeaderProgress({
  snapshot,
  onOpen,
}: {
  snapshot: DeliverySnapshot;
  onOpen: () => void;
}) {
  const { cases, requirements } = selectProgress(snapshot);
  const fill = cases.total === 0 ? 0 : cases.met / cases.total;
  return (
    <button
      type="button"
      data-testid="delivery-header-progress"
      aria-label={`Show the cases: ${String(cases.met)} of ${String(cases.total)} cases met, ${String(requirements.met)} of ${String(requirements.total)} requirements covered`}
      onClick={onOpen}
      className={`flex min-h-6 min-w-0 flex-wrap items-center gap-2 rounded-control text-12 text-text-secondary hover:text-text-primary ${focusRing}`}
    >
      <span data-testid="delivery-header-cases">
        {cases.met} of {cases.total} cases met
      </span>
      <span aria-hidden="true" className="block h-1 w-40 max-w-full rounded-full bg-bg-hover">
        <span
          className="block h-1 rounded-full bg-accent"
          style={{ width: `${Math.round(fill * 100)}%` }}
        />
      </span>
      <span data-testid="delivery-header-requirements">
        {requirements.met} of {requirements.total} requirements covered
      </span>
    </button>
  );
}

function DeliverySnapshotView({
  bench,
  snapshot,
  decisionPileFocusKey,
  onDecisionPileFocused,
  onSittingOpened,
  slug,
  source,
}: {
  bench: Bench;
  // The spec the bench delivers, which leads the header row, and the line
  // under the row: how the bench is bound and the spec folder.
  slug: string | undefined;
  source: string[];
  snapshot: DeliverySnapshotResponse;
  decisionPileFocusKey: string | undefined;
  onDecisionPileFocused: ((key: string) => void) | undefined;
  onSittingOpened: ((gateId: string) => void) | undefined;
}) {
  const sessionStartBlocked = useSessionStartBlocked(bench);
  const sessionLive = useDeliverySessionLive(bench);
  // The cross-check is a read of its own: a failed read leaves the rail as it
  // is, and the snapshot shows whatever it does.
  const crossCheck = useDeliveryCrossCheck(bench.projectId, bench.id);
  // Enter on a cross-check entry of the rail focuses its unit or gate on the
  // map (SB-FR-029).
  const [mapFocus, setMapFocus] = useState<MapFocusRequest | null>(null);
  const focusMapTarget = useCallback((keys: string[]) => {
    setMapFocus((last) => ({ keys, nonce: (last?.nonce ?? 0) + 1 }));
  }, []);
  // The since-you-left digest (SB-FR-012), read once as the tab opens. Its
  // links open a unit's or a gate's drill-in, show a decision where it is now
  // (see decisionLinkTarget), or bring the drift ledger into view.
  const { digest, dismiss, dismissDigest } = useDeliveryDigest(
    bench.projectId,
    bench.id,
    snapshot.seq,
  );
  const [raiseDecision, setRaiseDecision] = useState<{
    decisionId: string;
    nonce: number;
  } | null>(null);
  const driftLedger = useRef<HTMLDivElement>(null);
  const costHealthControls = useRef<HTMLElement>(null);
  const decisionPile = useRef<HTMLDivElement>(null);
  const crossCheckPanel = useRef<HTMLElement>(null);
  const casesView = useRef<HTMLElement>(null);
  // Which view of the tab shows, and, while another view shows, the element
  // of the map that opened it, which takes the focus back on the return.
  const [view, setView] = useState<DeliveryView>({ kind: "map" });
  const mapView = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // What takes the focus once the view just opened shows: hidden elements take
  // no focus, so this waits for the render that shows them. A drill-in focuses
  // its own heading.
  const [pendingFocus, setPendingFocus] = useState<{
    target: () => HTMLElement | null;
    block: ScrollLogicalPosition;
  } | null>(null);
  useEffect(() => {
    if (pendingFocus === null) return;
    const element = pendingFocus.target();
    if (element === null) return;
    element.scrollIntoView?.({ block: pendingFocus.block });
    // A card the view raised on its way in, such as a review card a digest
    // link raised, has taken the focus already inside the target: keep it.
    const active = document.activeElement;
    if (active !== element && active !== null && element.contains(active)) return;
    element.focus();
  }, [pendingFocus]);
  // The opener is the map control that has the focus. A view that a link from
  // outside the tab opens (fromMap false) has no opener, so the return focuses
  // the map, whatever had the focus when the link arrived.
  const openView = useCallback(
    (next: DeliveryView, focus?: () => HTMLElement | null, fromMap = true) => {
      const active = document.activeElement;
      opener.current =
        fromMap && active instanceof HTMLElement && mapView.current?.contains(active) === true
          ? active
          : null;
      setView(next);
      setPendingFocus(focus === undefined ? null : { target: focus, block: "start" });
    },
    [],
  );
  const returnToMap = () => {
    setView({ kind: "map" });
    setPendingFocus({
      target: () => (opener.current?.isConnected === true ? opener.current : mapView.current),
      block: "nearest",
    });
  };
  const openDrillIn = (target: MapTarget) => {
    openView({ kind: "drill-in", target });
  };
  const openMapTarget = (kind: "unit" | "gate", id: string) => {
    setMapFocus((last) => ({
      keys: [kind === "unit" ? unitKey(id) : gateKey(id)],
      nonce: (last?.nonce ?? 0) + 1,
      open: { kind, id },
    }));
    openDrillIn({ kind, id });
  };
  const openDigestEntry = (entry: DeliveryDigestEntry) => {
    if (entry.kind === "unit" || entry.kind === "gate") {
      openMapTarget(entry.kind, entry.id);
      return;
    }
    if (entry.kind === "decision") {
      const target = decisionLinkTarget(snapshot, entry.id);
      if (target.kind === "unit") {
        openMapTarget("unit", target.unitId);
        return;
      }
      if (target.kind === "card") {
        setRaiseDecision((last) => ({ decisionId: entry.id, nonce: (last?.nonce ?? 0) + 1 }));
      }
    }
    if (entry.kind === "decision") {
      openView({ kind: "decisions" }, () => decisionPile.current);
    } else {
      openView({ kind: "cost" }, () => driftLedger.current);
    }
  };
  const focusedPileKey = useRef<string | undefined>(undefined);
  // A link to the decision pile opens the decisions view and focuses the pile,
  // once per link: the ref guards this mount, and the caller, told through
  // onDecisionPileFocused, guards a later mount of the panel.
  useEffect(() => {
    if (decisionPileFocusKey === undefined || focusedPileKey.current === decisionPileFocusKey) {
      return;
    }
    focusedPileKey.current = decisionPileFocusKey;
    openView({ kind: "decisions" }, () => decisionPile.current, false);
    onDecisionPileFocused?.(decisionPileFocusKey);
  }, [decisionPileFocusKey, onDecisionPileFocused, openView]);
  // A complete delivery takes no role change and no mode switch.
  const ended = classifyLifecycleState(snapshot.lifecycle.state) === "complete";
  // The view of cost, health and controls: the burn meter, the health and the
  // jams, the drift ledger and the delivery's controls, which the rail's Burn
  // and health panel opens.
  const openCostHealthControls = () => {
    openView({ kind: "cost" }, () => costHealthControls.current);
  };
  // The rail's Decisions panel opens the decisions view on the pile, and the
  // header's cross-check chip brings the rail's Cross-check panel into view.
  const openDecisionPile = () => {
    openView({ kind: "decisions" }, () => decisionPile.current);
  };
  const openCrossCheck = () => {
    bringIntoView(crossCheckPanel.current);
  };
  const openCases = () => {
    openView({ kind: "cases" }, () => casesView.current);
  };

  return (
    <div
      data-testid="delivery-snapshot"
      // The map view fills the tab, so the tab does not scroll while the
      // window is at least 560px high; below that it keeps a 560px floor and
      // the tab scrolls. Just above 560px the map row gets what the header,
      // banner and digest leave, which can be little.
      className={
        view.kind === "map"
          ? "flex min-h-[560px] flex-1 flex-col [@media(min-height:560px)]:min-h-0"
          : "shrink-0 space-y-4"
      }
    >
      <div
        ref={mapView}
        tabIndex={-1}
        hidden={view.kind !== "map"}
        data-testid="delivery-view-map"
        className="flex min-h-0 flex-1 flex-col gap-4 focus:outline-none"
      >
        <div className="shrink-0 space-y-1 border-b border-border pb-3">
          <div
            data-testid="delivery-header"
            className="flex flex-wrap items-center gap-x-4 gap-y-2"
          >
            <span
              data-testid="delivery-slug"
              className="font-mono text-16 font-medium text-text-primary"
            >
              {slug ?? "no spec"}
            </span>
            <DeliveryHeaderProgress snapshot={snapshot} onOpen={openCases} />
            <DeliveryRail
              snapshot={snapshot}
              attached={
                bench.deliveryBindMode === "attach" && bench.deliverySessionId === undefined
              }
            />
            <span
              data-testid="delivery-mode-label"
              data-mode={snapshot.mode.value}
              className="py-0.5 font-mono text-11 font-medium text-text-secondary"
            >
              {snapshot.mode.value} mode
            </span>
            {crossCheck.data !== undefined && (
              <DeliveryCrossCheckChip crossCheck={crossCheck.data} onOpen={openCrossCheck} />
            )}
          </div>
          {source.length > 0 && (
            <p
              data-testid="delivery-source"
              className="break-all font-mono text-11 text-text-secondary"
            >
              {source.join(" · ")}
            </p>
          )}
        </div>
        {snapshot.sitting !== undefined && (
          <div className="shrink-0">
            <GateSitting sitting={snapshot.sitting} />
          </div>
        )}
        {digest.isSuccess && digest.data.entries.length > 0 && (
          <div data-testid="delivery-digest-frame" className="max-h-48 shrink-0 overflow-y-auto">
            <DeliveryDigest
              digest={digest.data}
              isDismissing={dismiss.isPending}
              onDismiss={dismissDigest}
              onOpen={openDigestEntry}
            />
          </div>
        )}

        {/* Side by side, the map and the rail take the rest of the height;
            stacked, each takes a height of its own and the tab scrolls. */}
        <div data-testid="delivery-workspace" className="@container/workspace min-h-0 flex-1">
          <div className="grid gap-4 @4xl:h-full @4xl:grid-cols-[minmax(0,1fr)_320px] @4xl:grid-rows-[minmax(0,1fr)]">
            <div className="flex h-[70dvh] min-h-0 min-w-0 flex-col @4xl:h-full">
              <DeliveryMap
                projectId={bench.projectId}
                benchId={bench.id}
                snapshot={snapshot}
                focusRequest={mapFocus}
                onOpen={openDrillIn}
              />
            </div>
            <aside
              data-testid="delivery-summary-rail"
              aria-label="Delivery summary"
              className="@container/rail flex min-h-0 min-w-0 flex-col gap-4 @4xl:overflow-y-auto"
            >
              <div className="grid shrink-0 gap-4 @md/rail:grid-cols-2 @3xl/rail:grid-cols-3">
                <BurnHealthPanel
                  snapshot={snapshot}
                  onOpenCostHealthControls={openCostHealthControls}
                  onOpenCases={openCases}
                />
                <DecisionSummaryPanel snapshot={snapshot} onOpenDecisions={openDecisionPile} />
                <NextBoundaryPanel snapshot={snapshot} className="col-span-full" />
              </div>
              {crossCheck.data !== undefined && (
                <DeliveryCrossCheck
                  ref={crossCheckPanel}
                  crossCheck={crossCheck.data}
                  snapshot={snapshot}
                  onFocusMapTarget={focusMapTarget}
                  className="flex-1 @md/rail:max-h-[60dvh] @4xl/workspace:min-h-40"
                />
              )}
            </aside>
          </div>
        </div>
      </div>

      {view.kind === "drill-in" && (
        <div data-testid="delivery-view-drill-in" className="space-y-3">
          <DeliveryBreadcrumb
            benchId={bench.id}
            current={view.target.id}
            mono
            onReturn={returnToMap}
          />
          <DeliveryDrillIn
            projectId={bench.projectId}
            benchId={bench.id}
            snapshot={snapshot}
            target={view.target}
            sitting={snapshot.sitting}
            onClose={returnToMap}
          />
        </div>
      )}

      <section
        hidden={view.kind !== "decisions"}
        data-testid="delivery-decisions-steering"
        aria-label="Decisions and steering"
        className="space-y-4"
      >
        <DeliveryBreadcrumb
          benchId={bench.id}
          current="Decisions and steering"
          onReturn={returnToMap}
        />
        <h2 className={VIEW_TITLE}>Decisions and steering</h2>
        {/* The Decisions panel and the Steering panel sit side by side on a
            wide view and stack on a narrow one (#1622). */}
        <div className="@container">
          <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
            <div
              ref={decisionPile}
              tabIndex={-1}
              data-testid="delivery-decision-pile-target"
              className="min-w-0 focus:outline-none"
            >
              <DecisionPile
                projectId={bench.projectId}
                benchId={bench.id}
                snapshot={snapshot}
                sessionLive={sessionLive}
                onSittingOpened={onSittingOpened}
                raiseRequest={raiseDecision}
              />
            </div>

            <BoundaryPanel projectId={bench.projectId} benchId={bench.id} snapshot={snapshot} />
          </div>
        </div>
      </section>

      <section
        ref={costHealthControls}
        tabIndex={-1}
        hidden={view.kind !== "cost"}
        data-testid="delivery-cost-health-controls"
        aria-label="Cost, health and controls"
        className="space-y-4 focus:outline-none"
      >
        <DeliveryBreadcrumb
          benchId={bench.id}
          current="Cost, health and controls"
          onReturn={returnToMap}
        />
        <DeliveryCostView
          bench={bench}
          snapshot={snapshot}
          title="Cost, health and controls"
          ended={ended}
          attached={bench.deliveryBindMode === "attach" && bench.deliverySessionId === undefined}
          sessionStartBlocked={sessionStartBlocked}
          crossCheck={crossCheck.data}
          driftLedgerRef={driftLedger}
          onOpenUnit={(id) => openMapTarget("unit", id)}
        />
      </section>

      {view.kind === "cases" && (
        <section
          ref={casesView}
          tabIndex={-1}
          data-testid="delivery-view-cases"
          aria-label="Cases"
          className="space-y-4 focus:outline-none"
        >
          <DeliveryBreadcrumb benchId={bench.id} current="Cases" onReturn={returnToMap} />
          <h2 className={VIEW_TITLE}>Cases</h2>
          <DeliveryCasesView projectId={bench.projectId} benchId={bench.id} snapshot={snapshot} />
        </section>
      )}
    </div>
  );
}
