import { useEffect, useMemo, useRef, useState } from "react";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectDependencyOrder, selectGatesAfterUnit } from "@roubo/shared/delivery-selectors";
import Callout from "../ui/Callout";
import { focusRing } from "../ui/focus-ring";
import { useBenchViewState } from "../../hooks/useBenchViewState";
import DeliveryGraph from "./DeliveryGraph";
import DeliveryList from "./DeliveryList";
import { DeliveryPanel } from "./DeliveryPanel";
import {
  DEFAULT_DELIVERY_MAP_VIEW,
  cycleMessage,
  layoutDeliveryMap,
  selectHeldUnitIds,
  targetKey,
  type DeliveryMapView,
  type MapFocusRequest,
  type MapTarget,
} from "./delivery-map-model";

// The Delivery tab's map (SB-FR-010, SB-US-003): the units, their dependency
// edges, their stack and layer, the gates and each unit's status, as a graph by
// default and as a list behind a toggle. The view is remembered per bench, and
// the selected unit survives a switch between the two. Enter or a press on a
// unit or a gate asks the tab to open its drill-in (`onOpen`), which the tab
// shows as a view of its own (#1620). A record whose
// dependencies form a cycle has no order to draw, so the map names the cycle
// instead and the rest of the tab stays as it is.

export interface DeliveryMapProps {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  // A request to focus a unit or gate, such as Enter on a cross-check entry of
  // the rail (SB-FR-029): the first key that the view in effect draws takes
  // the focus, which selects it. A request with `open`, such as a link of the
  // since-you-left digest (SB-FR-012), selects that unit or gate instead, while
  // the tab opens its drill-in.
  focusRequest?: MapFocusRequest | null;
  // Called with the unit or gate whose drill-in to open.
  onOpen?: (target: MapTarget) => void;
}

// The drawn map item of the first key, in the map's own section.
function mapItemOf(root: HTMLElement, keys: readonly string[]): HTMLElement | null {
  const items = [...root.querySelectorAll<HTMLElement>("[data-key]")];
  for (const key of keys) {
    const item = items.find((element) => element.dataset.key === key);
    if (item !== undefined) return item;
  }
  return null;
}

const VIEWS: { id: DeliveryMapView; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "list", label: "List" },
];

export default function DeliveryMap({
  projectId,
  benchId,
  snapshot,
  focusRequest,
  onOpen,
}: DeliveryMapProps) {
  const viewState = useBenchViewState(projectId, benchId);
  const view = viewState.deliveryMapView ?? DEFAULT_DELIVERY_MAP_VIEW;
  const [selected, setSelected] = useState<MapTarget | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // A request that also opens its target (a since-you-left digest link)
  // selects it once per request, so the map shows it selected on the return.
  const [openedFor, setOpenedFor] = useState<MapFocusRequest | null>(null);
  if (focusRequest?.open !== undefined && focusRequest !== openedFor) {
    setOpenedFor(focusRequest);
    setSelected(focusRequest.open);
  }
  const open = (target: MapTarget) => {
    onOpen?.(target);
  };

  // Each new request moves the focus once; a later snapshot does not.
  useEffect(() => {
    if (focusRequest === undefined || focusRequest === null) return;
    if (focusRequest.open !== undefined) return;
    const root = sectionRef.current;
    if (root === null) return;
    const item = mapItemOf(root, focusRequest.keys);
    if (item === null) return;
    item.scrollIntoView?.({ block: "nearest" });
    item.focus();
  }, [focusRequest]);

  const order = useMemo(() => selectDependencyOrder(snapshot), [snapshot]);
  const layout = useMemo(
    () => (order.kind === "ordered" ? layoutDeliveryMap(snapshot, order.units) : null),
    [snapshot, order],
  );
  const held = useMemo(() => selectHeldUnitIds(snapshot), [snapshot]);
  const rows = useMemo(
    () =>
      order.kind === "ordered"
        ? order.units.map((unit) => ({
            unit,
            gates: selectGatesAfterUnit(snapshot, unit.id),
            held: held.has(unit.id),
          }))
        : [],
    [snapshot, order, held],
  );

  if (order.kind === "cycle") {
    return (
      <DeliveryPanel title="Delivery map" testId="delivery-map">
        <div className="p-3">
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
        </div>
      </DeliveryPanel>
    );
  }

  const selectedKey = selected === null ? null : targetKey(selected);

  return (
    <DeliveryPanel
      ref={sectionRef}
      title="Delivery map"
      testId="delivery-map"
      meta={
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
                className={`min-h-6 px-2.5 py-0.5 text-12 font-medium transition-colors ${focusRing} ${
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
      }
    >
      <div className="space-y-3 p-3">
        {view === "graph" && layout !== null ? (
          <DeliveryGraph
            layout={layout}
            selectedKey={selectedKey}
            onSelect={setSelected}
            onOpen={open}
          />
        ) : (
          <div data-testid="delivery-list-scroll" className="overflow-x-auto">
            <DeliveryList
              rows={rows}
              selectedKey={selectedKey}
              onSelect={setSelected}
              onOpen={open}
            />
          </div>
        )}
      </div>
    </DeliveryPanel>
  );
}
