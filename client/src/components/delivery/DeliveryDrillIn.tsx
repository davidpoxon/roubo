import { useEffect, useRef } from "react";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  selectGateState,
  selectGatesAfterUnit,
  selectUnitDependencies,
  selectUnitStatus,
} from "@roubo/shared/delivery-selectors";
import { ownValue } from "@roubo/shared/delivery-reducer";
import Button from "../ui/Button";
import StatusIndicator from "../ui/StatusIndicator";
import { focusRing } from "../ui/focus-ring";
import UnitDrillIn from "./UnitDrillIn";
import { sittingLabel, type DeliverySittingView } from "./gate-sitting-model";
import {
  GATE_MARKERS,
  classifyGateMarker,
  dependencyLine,
  gateMarkerLabel,
  targetKey,
  unitStatusTone,
  type MapTarget,
} from "./delivery-map-model";

// The drill-in of the unit or gate opened from the map, which the Delivery tab
// shows as a view of its own (#1620). A unit's opens on its timeline, with its
// terminal beside it and its diff and verify results beneath (UnitDrillIn),
// then names what the snapshot holds for it; a gate's names what the snapshot
// holds for the gate. Its heading takes the focus as it opens.
export default function DeliveryDrillIn({
  projectId,
  benchId,
  snapshot,
  target,
  deliverySessionId,
  sitting,
  onClose,
}: {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  target: MapTarget;
  deliverySessionId: string | undefined;
  sitting: DeliverySittingView | undefined;
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
        <GateDetail snapshot={snapshot} gateId={target.id} sitting={sitting} />
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
          : gates.map((view) => `${view.gate.id} ${gateMarkerLabel(view.gate)}`).join(", ")}
      </dd>
    </dl>
  );
}

function GateDetail({
  snapshot,
  gateId,
  sitting,
}: {
  snapshot: DeliverySnapshot;
  gateId: string;
  sitting: DeliverySittingView | undefined;
}) {
  const view = selectGateState(snapshot, gateId);
  if (view === null) {
    return <p className="text-13 text-text-secondary">The delivery no longer has this gate.</p>;
  }
  const marker = GATE_MARKERS[classifyGateMarker(view.gate)];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-13">
      <dt className="text-text-secondary">Status</dt>
      <dd>
        <StatusIndicator tone={marker.tone} label={gateMarkerLabel(view.gate)} />
      </dd>
      {sitting !== undefined && sitting.gateId === gateId && (
        <>
          <dt className="text-text-secondary">Sitting</dt>
          <dd data-testid="gate-detail-sitting" className="text-text-body">
            {sittingLabel(sitting)}
          </dd>
        </>
      )}
      <dt className="text-text-secondary">After</dt>
      <dd className="font-mono text-text-body">{view.gate.after.join(", ")}</dd>
      <dt className="text-text-secondary">Cases</dt>
      <dd className="font-mono text-text-body">
        {view.gate.cases.length === 0 ? "none" : view.gate.cases.join(", ")}
      </dd>
    </dl>
  );
}
