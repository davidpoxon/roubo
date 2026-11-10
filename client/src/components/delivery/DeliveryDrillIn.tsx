import { useEffect, useMemo, useRef } from "react";
import type { DeliveryUnit } from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  selectGateState,
  selectGatesAfterUnit,
  selectUnitDependencies,
  selectUnitStack,
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
  HELD_DRAFT_LABEL,
  classifyGateMarker,
  dependencyLine,
  gateMarkerLabel,
  pullRequestNumber,
  selectHeldUnitIds,
  targetKey,
  unitCostLabel,
  unitStatusTone,
  type MapTarget,
} from "./delivery-map-model";

// The drill-in of the unit or gate opened from the map, which the Delivery tab
// shows as a view of its own (#1620). A unit's drill-in (#1621) is headed by
// its mono id, its title and chips for its status, its stack, layer and base,
// its dependencies when they are not only the base, its pull request, the
// gates after it and its cost; UnitDrillIn lays out its timeline, terminal and
// Diff and Verify tabs beneath. A gate's names what the snapshot holds for the
// gate. Its heading takes the focus as it opens.
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

  if (target.kind === "gate") {
    const heading = `Gate ${target.id}`;
    return (
      <section
        aria-label={heading}
        data-testid="delivery-drill-in"
        className="space-y-2 rounded-control border border-border bg-bg-surface p-3"
      >
        <div className="flex items-center justify-between gap-3">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className={`text-14 font-medium text-text-primary ${focusRing}`}
          >
            {heading}
          </h2>
          <Button onPress={onClose}>Close</Button>
        </div>
        <GateDetail snapshot={snapshot} gateId={target.id} sitting={sitting} />
      </section>
    );
  }

  const unit = ownValue(snapshot.unitsById, target.id);
  return (
    <section aria-label={`Unit ${target.id}`} data-testid="delivery-drill-in" className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className={`flex min-w-0 flex-wrap items-baseline gap-x-3 rounded-control ${focusRing}`}
        >
          <span className="font-mono text-13 font-medium text-text-body">{target.id}</span>
          {/* A space, so the heading's name reads "B Second", not "BSecond". */}{" "}
          {unit !== undefined && (
            <span className="min-w-0 break-words text-16 font-semibold text-text-primary">
              {unit.title}
            </span>
          )}
        </h2>
        {unit !== undefined && <UnitChips snapshot={snapshot} unit={unit} />}
        <div className="ml-auto">
          <Button onPress={onClose}>Close</Button>
        </div>
      </div>
      {unit === undefined ? (
        <p className="text-13 text-text-secondary">The delivery no longer has this unit.</p>
      ) : (
        <UnitDrillIn
          projectId={projectId}
          benchId={benchId}
          snapshot={snapshot}
          unitId={target.id}
          {...(deliverySessionId !== undefined && { deliverySessionId })}
        />
      )}
    </section>
  );
}

const CHIP =
  "inline-flex min-w-0 items-center gap-1 rounded-chip border border-border-strong bg-bg-surface px-1.5 py-0.5 text-11 text-text-secondary";

// The unit below this one on its stack, whose branch this unit's pull request
// is based on; none for the first unit of a stack.
function stackBase(snapshot: DeliverySnapshot, unitId: string): string | undefined {
  const view = selectUnitStack(snapshot, unitId);
  return view !== null && view.index > 0 ? view.members[view.index - 1] : undefined;
}

// The facts the drill-in names about a unit, as chips beside its title.
function UnitChips({ snapshot, unit }: { snapshot: DeliverySnapshot; unit: DeliveryUnit }) {
  const status = selectUnitStatus(snapshot, unit.id);
  const base = stackBase(snapshot, unit.id);
  const dependencies = selectUnitDependencies(snapshot, unit.id);
  const onlyBase =
    base === undefined
      ? dependencies.length === 0
      : dependencies.length === 1 && dependencies[0] === base;
  const heldIds = useMemo(() => selectHeldUnitIds(snapshot), [snapshot]);
  const held = heldIds.has(unit.id);
  const pr = held ? HELD_DRAFT_LABEL : pullRequestNumber(unit);
  const gates = selectGatesAfterUnit(snapshot, unit.id);
  return (
    <ul aria-label={`About unit ${unit.id}`} className="flex flex-wrap items-center gap-2">
      <li data-testid="unit-chip-status" className={CHIP}>
        <StatusIndicator tone={unitStatusTone(unit)} label={status.status ?? unit.status} />
      </li>
      <li data-testid="unit-chip-stack" className={CHIP}>
        stack {unit.stack} · layer {unit.layer}
        {base !== undefined && ` · base ${base}`}
      </li>
      {!onlyBase && (
        <li data-testid="unit-chip-dependencies" className={`${CHIP} font-mono`}>
          {dependencyLine(dependencies)}
        </li>
      )}
      {pr !== null && (
        <li data-testid="unit-chip-pr" className={`${CHIP} font-mono`}>
          {pr}
        </li>
      )}
      {gates.map((view) => (
        <li key={view.gate.id} data-testid={`unit-chip-gate-${view.gate.id}`} className={CHIP}>
          gate {view.gate.id} · {gateMarkerLabel(view.gate)}
        </li>
      ))}
      {unit.cost_usd !== undefined && (
        <li data-testid="unit-chip-cost" className={`${CHIP} tabular-nums`}>
          {unitCostLabel(unit.cost_usd)}
        </li>
      )}
    </ul>
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
