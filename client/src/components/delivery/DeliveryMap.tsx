import { useEffect, useMemo, useRef, useState } from "react";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  selectDependencyOrder,
  selectGateState,
  selectGatesAfterUnit,
  selectUnitDependencies,
  selectUnitStatus,
} from "@roubo/shared/delivery-selectors";
import { ownValue } from "@roubo/shared/delivery-reducer";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import StatusIndicator from "../ui/StatusIndicator";
import { focusRing } from "../ui/focus-ring";
import { useBenchViewState } from "../../hooks/useBenchViewState";
import DeliveryGraph from "./DeliveryGraph";
import DeliveryList from "./DeliveryList";
import UnitDrillIn from "./UnitDrillIn";
import {
  DEFAULT_DELIVERY_MAP_VIEW,
  GATE_MARKERS,
  classifyGateMarker,
  cycleMessage,
  dependencyLine,
  layoutDeliveryMap,
  targetKey,
  unitStatusTone,
  type DeliveryMapView,
  type MapTarget,
} from "./delivery-map-model";

// The Delivery tab's map (SB-FR-010, SB-US-003): the units, their dependency
// edges, their stack and layer, the gates and each unit's status, as a graph by
// default and as a list behind a toggle. The view is remembered per bench, and
// the selected unit survives a switch between the two. A record whose
// dependencies form a cycle has no order to draw, so the map names the cycle
// instead and the rest of the tab stays as it is.

export interface DeliveryMapProps {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  // The bench's delivery session terminal, which a unit's drill-in shows live.
  deliverySessionId?: string;
}

const VIEWS: { id: DeliveryMapView; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "list", label: "List" },
];

export default function DeliveryMap({
  projectId,
  benchId,
  snapshot,
  deliverySessionId,
}: DeliveryMapProps) {
  const viewState = useBenchViewState(projectId, benchId);
  const view = viewState.deliveryMapView ?? DEFAULT_DELIVERY_MAP_VIEW;
  const [selected, setSelected] = useState<MapTarget | null>(null);
  const [opened, setOpened] = useState<MapTarget | null>(null);

  const order = useMemo(() => selectDependencyOrder(snapshot), [snapshot]);
  const layout = useMemo(
    () => (order.kind === "ordered" ? layoutDeliveryMap(snapshot, order.units) : null),
    [snapshot, order],
  );
  const rows = useMemo(
    () =>
      order.kind === "ordered"
        ? order.units.map((unit) => ({ unit, gates: selectGatesAfterUnit(snapshot, unit.id) }))
        : [],
    [snapshot, order],
  );

  if (order.kind === "cycle") {
    return (
      <section aria-label="Delivery map" data-testid="delivery-map">
        <Callout
          role="alert"
          title="The delivery map cannot be drawn: the units depend on each other in a cycle"
          data-testid="delivery-map-cycle"
        >
          <p>{cycleMessage(order.cycle)}</p>
          <p>
            Fix the units' depends_on in the delivery record. The map reads it again on its own.
          </p>
        </Callout>
      </section>
    );
  }

  const selectedKey = selected === null ? null : targetKey(selected);

  return (
    <section aria-label="Delivery map" data-testid="delivery-map" className="space-y-3">
      <div
        role="group"
        aria-label="Map view"
        className="inline-flex rounded-control border border-border-strong"
      >
        {VIEWS.map((option) => {
          const pressed = view === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => viewState.setDeliveryMapView(option.id)}
              className={`px-3 py-1.5 text-12 font-medium transition-colors ${focusRing} ${
                pressed
                  ? "bg-accent-muted text-accent-text"
                  : "text-text-body hover:bg-bg-hover active:bg-bg-pressed"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {view === "graph" && layout !== null ? (
        <DeliveryGraph
          layout={layout}
          selectedKey={selectedKey}
          onSelect={setSelected}
          onOpen={setOpened}
        />
      ) : (
        <DeliveryList
          rows={rows}
          selectedKey={selectedKey}
          onSelect={setSelected}
          onOpen={setOpened}
        />
      )}

      {opened !== null && (
        <DrillIn
          projectId={projectId}
          benchId={benchId}
          snapshot={snapshot}
          target={opened}
          deliverySessionId={deliverySessionId}
          onClose={() => setOpened(null)}
        />
      )}
    </section>
  );
}

// The drill-in of the unit or gate last opened from the map. A unit's opens on
// its timeline, with its terminal beside it and its diff and verify results
// beneath (UnitDrillIn), then names what the snapshot holds for it; a gate's
// names what the snapshot holds for the gate.
function DrillIn({
  projectId,
  benchId,
  snapshot,
  target,
  deliverySessionId,
  onClose,
}: {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  target: MapTarget;
  deliverySessionId: string | undefined;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const key = targetKey(target);
  useEffect(() => {
    headingRef.current?.focus();
  }, [key]);

  const heading = target.kind === "unit" ? `Unit ${target.id}` : `Gate ${target.id}`;
  return (
    <section
      aria-label={heading}
      data-testid="delivery-drill-in"
      className="space-y-2 rounded-control border border-border bg-bg-surface p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className={`text-14 font-medium text-text-primary ${focusRing}`}
        >
          {heading}
        </h3>
        <Button onPress={onClose}>Close</Button>
      </div>
      {target.kind === "unit" ? (
        <>
          <UnitDrillIn
            projectId={projectId}
            benchId={benchId}
            snapshot={snapshot}
            unitId={target.id}
            {...(deliverySessionId !== undefined && { deliverySessionId })}
          />
          <UnitDetail snapshot={snapshot} unitId={target.id} />
        </>
      ) : (
        <GateDetail snapshot={snapshot} gateId={target.id} />
      )}
    </section>
  );
}

function UnitDetail({ snapshot, unitId }: { snapshot: DeliverySnapshot; unitId: string }) {
  const unit = ownValue(snapshot.unitsById, unitId);
  if (unit === undefined) {
    return <p className="text-13 text-text-secondary">The delivery no longer has this unit.</p>;
  }
  const status = selectUnitStatus(snapshot, unitId);
  const gates = selectGatesAfterUnit(snapshot, unitId);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-13">
      <dt className="text-text-secondary">Title</dt>
      <dd className="text-text-primary">{unit.title}</dd>
      <dt className="text-text-secondary">Status</dt>
      <dd>
        <StatusIndicator tone={unitStatusTone(unit)} label={status.status ?? unit.status} />
      </dd>
      <dt className="text-text-secondary">Stack</dt>
      <dd className="font-mono text-text-body">
        {unit.stack}, layer {unit.layer}
      </dd>
      <dt className="text-text-secondary">Dependencies</dt>
      <dd className="font-mono text-text-body">
        {dependencyLine(selectUnitDependencies(snapshot, unitId))}
      </dd>
      <dt className="text-text-secondary">Gates</dt>
      <dd className="font-mono text-text-body">
        {gates.length === 0
          ? "none"
          : gates
              .map((view) => `${view.gate.id} ${GATE_MARKERS[classifyGateMarker(view.gate)].label}`)
              .join(", ")}
      </dd>
    </dl>
  );
}

function GateDetail({ snapshot, gateId }: { snapshot: DeliverySnapshot; gateId: string }) {
  const view = selectGateState(snapshot, gateId);
  if (view === null) {
    return <p className="text-13 text-text-secondary">The delivery no longer has this gate.</p>;
  }
  const marker = GATE_MARKERS[classifyGateMarker(view.gate)];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-13">
      <dt className="text-text-secondary">Status</dt>
      <dd>
        <StatusIndicator tone={marker.tone} label={marker.label} />
      </dd>
      <dt className="text-text-secondary">After</dt>
      <dd className="font-mono text-text-body">{view.gate.after.join(", ")}</dd>
      <dt className="text-text-secondary">Cases</dt>
      <dd className="font-mono text-text-body">
        {view.gate.cases.length === 0 ? "none" : view.gate.cases.join(", ")}
      </dd>
    </dl>
  );
}
