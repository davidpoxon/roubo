import type { DeliveryUnit } from "@roubo/shared/delivery-observation-contract";
import type { DeliveryGateView } from "@roubo/shared/delivery-reducer";
import StatusIndicator from "../ui/StatusIndicator";
import { focusRing } from "../ui/focus-ring";
import {
  GATE_MARKERS,
  classifyGateMarker,
  isLiveUnit,
  rowAccessibleName,
  unitKey,
  unitStatusTone,
  type MapTarget,
} from "./delivery-map-model";

// The delivery map's list view (DESIGN.md Unit row): one dense hairline row per
// unit in dependency order, with its stack, layer, id, title, status, gate and
// cost. Enter on a row opens the unit drill-in.

export interface DeliveryListRow {
  unit: DeliveryUnit;
  gates: DeliveryGateView[];
}

export interface DeliveryListProps {
  rows: DeliveryListRow[];
  selectedKey: string | null;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
}

export default function DeliveryList({ rows, selectedKey, onSelect, onOpen }: DeliveryListProps) {
  return (
    <ol
      data-testid="delivery-list"
      aria-label="Units in dependency order"
      className="border-t border-border"
    >
      {rows.map((row) => (
        <UnitRow
          key={row.unit.id}
          row={row}
          selected={selectedKey === unitKey(row.unit.id)}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ))}
    </ol>
  );
}

function UnitRow({
  row,
  selected,
  onSelect,
  onOpen,
}: {
  row: DeliveryListRow;
  selected: boolean;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
}) {
  const { unit, gates } = row;
  const target: MapTarget = { kind: "unit", id: unit.id };
  return (
    <li>
      <button
        type="button"
        data-testid={`unit-row-${unit.id}`}
        data-status={unit.status}
        aria-label={rowAccessibleName(unit, gates)}
        aria-current={selected ? "true" : undefined}
        onClick={() => {
          onSelect(target);
          onOpen(target);
        }}
        onFocus={() => onSelect(target)}
        className={`flex w-full items-center gap-3 border-b border-border px-3 py-1.5 text-left text-12 text-text-body transition-colors hover:bg-bg-hover active:bg-bg-pressed ${focusRing} ${
          selected ? "bg-bg-hover" : "bg-bg-surface"
        } ${isLiveUnit(unit) ? "border-l-2 border-l-accent" : ""}`}
      >
        <span
          data-col="stack"
          className="w-16 shrink-0 truncate font-mono text-12 text-text-secondary"
        >
          {unit.stack}
        </span>
        <span
          data-col="layer"
          className="w-6 shrink-0 font-mono text-12 text-text-secondary tabular-nums"
        >
          {unit.layer}
        </span>
        <span
          data-col="id"
          className="w-24 shrink-0 truncate font-mono text-12 font-medium text-text-body"
        >
          {unit.id}
        </span>
        <span data-col="title" className="min-w-0 flex-1 truncate font-medium text-text-primary">
          {unit.title}
        </span>
        <span data-col="status" className="w-24 shrink-0">
          <StatusIndicator tone={unitStatusTone(unit)} label={unit.status} />
        </span>
        <span data-col="gate" className="w-40 shrink-0 truncate">
          {gates.length === 0 ? (
            <span className="text-11 text-text-secondary">no gate</span>
          ) : (
            gates.map((view) => (
              <span
                key={view.gate.id}
                className="mr-1 inline-flex rounded-chip bg-bg-hover px-1.5 py-0.5 text-11 text-text-secondary"
              >
                {view.gate.id} · {GATE_MARKERS[classifyGateMarker(view.gate)].label}
              </span>
            ))
          )}
        </span>
        <span data-col="cost" className="w-12 shrink-0 text-right font-mono text-12 tabular-nums">
          {unit.cost_usd !== undefined ? unit.cost_usd.toFixed(2) : ""}
        </span>
      </button>
    </li>
  );
}
