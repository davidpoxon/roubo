import { useCallback, useEffect, useRef, useState } from "react";
import type { Bench } from "@roubo/shared";
import type { DeliveryReadError } from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { classifyLifecycleState } from "@roubo/shared/delivery-selectors";
import { useDelivery, useDeliverySessionLive, useLaunchDelivery } from "../../hooks/useDelivery";
import { useDeliveryCrossCheck } from "../../hooks/useDeliveryCrossCheck";
import { deliveryReadErrorOf } from "../../lib/api";
import BoundaryPanel from "./BoundaryPanel";
import DecisionPile from "./DecisionPile";
import DeliveryBurn from "./DeliveryBurn";
import DeliveryDriftLedger from "./DeliveryDriftLedger";
import DeliveryRail from "./DeliveryHealth";
import DeliveryJams from "./DeliveryJams";
import DeliveryMap from "./DeliveryMap";
import DeliveryModeControl from "./DeliveryModeControl";
import type { MapFocusRequest } from "./delivery-map-model";
import { DeliveryMetCases, DeliveryProgressStats } from "./DeliveryProgress";
import LifecycleControls from "./LifecycleControls";
import RoleMatrix from "./RoleMatrix";

// The Spec Bench's Delivery tab (SB-FR-009). It names what the bench delivers
// and how it is bound, then reads the delivery: the folded snapshot, its
// health rail (SB-FR-019, SB-NFR-006) with the cross-check's disagreements and
// source error on it (SB-FR-030), where Enter on an entry focuses its unit or
// gate on the map (SB-FR-029), and the mode in effect named in a mono label
// beside the health chip (SB-FR-032), its progress in cases met and
// requirements covered (SB-FR-011), its map, and its view of cost, health and
// controls: the burn meter (SB-FR-018), the jam list (SB-FR-019), the drift
// ledger (SB-FR-020), the decision pile where a decision is answered or its
// default overturned in place (SB-FR-014, SB-FR-015), with the agent decisions
// to review on the same pile (SB-FR-033), the boundary panel with the steering
// composer (SB-FR-016, SB-FR-017), the role matrix (SB-FR-021) with the Mode
// switch beside it (SB-FR-032), and the lifecycle controls (SB-FR-022), among
// them Approve, which waits while a review is open (SB-FR-034), a gating case
// is unmet or the cross-check holds a blocking class (SB-FR-029), when the
// record conforms, or the named error when it does not. No
// decision, steering, role, mode or lifecycle control renders until the record
// conforms, so nothing can act on a record the bench cannot read. The one
// exception is a launch-mode bench with no record yet: it offers to launch its
// session again, since no record means no session has run the delivery yet.
//
// `decisionPileFocusKey` is set when the bench was opened from a link to its
// decision pile, such as a delivery-decision notification's (SB-FR-014), and
// the pile has not yet taken focus for that link: the pile is scrolled into view
// and focused once the snapshot shows, and `onDecisionPileFocused` reports the
// key. This panel unmounts while another tab is selected, so the caller keeps
// the reported key and stops passing it, and a return to the tab under the
// same link leaves the focus where it is.
export default function DeliveryTabPanel({
  bench,
  decisionPileFocusKey,
  onDecisionPileFocused,
}: {
  bench: Bench;
  decisionPileFocusKey?: string | undefined;
  onDecisionPileFocused?: ((key: string) => void) | undefined;
}) {
  const specFolder = bench.focusedSpecPath;
  const slug = specFolder?.split("/").filter(Boolean).pop();
  const delivery = useDelivery(bench.projectId, bench.id);
  const readError = delivery.isError ? deliveryReadErrorOf(delivery.error) : undefined;

  return (
    <div data-testid="delivery-tab-panel" className="space-y-4">
      <div className="space-y-2">
        <p className="text-13 text-text-body">
          Delivering <span className="font-mono text-text-primary">{slug ?? "no spec"}</span>
          {bench.deliveryBindMode && (
            <span className="text-text-secondary">
              {bench.deliveryBindMode === "attach"
                ? " · attached to a running delivery"
                : " · launched from this bench"}
            </span>
          )}
        </p>
        {specFolder && <p className="text-12 font-mono text-text-secondary">{specFolder}</p>}
      </div>

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
          snapshot={delivery.data}
          decisionPileFocusKey={decisionPileFocusKey}
          onDecisionPileFocused={onDecisionPileFocused}
        />
      )}
    </div>
  );
}

function readErrorTitle(error: DeliveryReadError): string {
  switch (error.code) {
    case "DELIVERY_NONCONFORMANT":
      return `The delivery record is missing its ${error.section ?? "required"} section`;
    case "DELIVERY_INVALID":
      return error.field
        ? `The delivery record has an invalid ${error.field} field`
        : "The delivery record is invalid";
    case "DELIVERY_VERSION_MISMATCH":
      return `The delivery record is at version ${error.found ?? "unknown"}, and this bench reads ${error.supported ?? "another"}`;
    case "DELIVERY_RECORD_MISSING":
      return "No delivery record yet";
  }
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

function DeliverySnapshotView({
  bench,
  snapshot,
  decisionPileFocusKey,
  onDecisionPileFocused,
}: {
  bench: Bench;
  snapshot: DeliverySnapshot;
  decisionPileFocusKey: string | undefined;
  onDecisionPileFocused: ((key: string) => void) | undefined;
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
  const costHealthControls = useRef<HTMLElement>(null);
  const decisionPile = useRef<HTMLDivElement>(null);
  const focusedPileKey = useRef<string | undefined>(undefined);
  // A link to the decision pile brings it into view and focus, once per link:
  // the ref guards this mount, and the caller, told through
  // onDecisionPileFocused, guards a later mount of the panel.
  useEffect(() => {
    if (decisionPileFocusKey === undefined || focusedPileKey.current === decisionPileFocusKey) {
      return;
    }
    const pile = decisionPile.current;
    if (pile === null) return;
    focusedPileKey.current = decisionPileFocusKey;
    pile.scrollIntoView?.({ block: "start" });
    pile.focus();
    onDecisionPileFocused?.(decisionPileFocusKey);
  }, [decisionPileFocusKey, onDecisionPileFocused]);
  // A complete delivery takes no role change and no mode switch.
  const ended = classifyLifecycleState(snapshot.lifecycle.state) === "complete";
  // The view of cost, health and controls: the burn meter, the jam list, the
  // drift ledger and the delivery's controls, which the header's button opens.
  const openCostHealthControls = () => {
    const view = costHealthControls.current;
    if (view === null) return;
    view.scrollIntoView?.({ block: "start" });
    view.focus();
  };

  return (
    <div data-testid="delivery-snapshot" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <DeliveryRail
            snapshot={snapshot}
            attached={bench.deliveryBindMode === "attach" && bench.deliverySessionId === undefined}
            crossCheck={crossCheck.data}
            onFocusMapTarget={focusMapTarget}
          />
          <span
            data-testid="delivery-mode-label"
            data-mode={snapshot.mode.value}
            className="py-0.5 font-mono text-11 font-medium text-text-secondary"
          >
            {snapshot.mode.value} mode
          </span>
        </div>
        <Button onPress={openCostHealthControls}>Cost, health and controls</Button>
      </div>
      <DeliveryProgressStats snapshot={snapshot} />
      <DeliveryMetCases snapshot={snapshot} />

      <DeliveryMap
        projectId={bench.projectId}
        benchId={bench.id}
        snapshot={snapshot}
        {...(bench.deliverySessionId !== undefined && {
          deliverySessionId: bench.deliverySessionId,
        })}
        focusRequest={mapFocus}
      />

      <section
        ref={costHealthControls}
        tabIndex={-1}
        data-testid="delivery-cost-health-controls"
        aria-label="Cost, health and controls"
        className="space-y-4 focus:outline-none"
      >
        <DeliveryBurn snapshot={snapshot} />
        <DeliveryJams snapshot={snapshot} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-13">
          <dt className="text-text-secondary">Lifecycle</dt>
          <dd className="text-text-primary" data-testid="delivery-lifecycle">
            {snapshot.lifecycle.state}
          </dd>
          <dt className="text-text-secondary">Budget</dt>
          <dd className="text-text-primary" data-testid="delivery-budget">
            ${snapshot.budget.spent_usd.toFixed(2)} of ${snapshot.budget.soft_budget_usd.toFixed(2)}
          </dd>
        </dl>

        <DeliveryDriftLedger snapshot={snapshot} />

        <div
          ref={decisionPile}
          tabIndex={-1}
          data-testid="delivery-decision-pile-target"
          className="focus:outline-none"
        >
          <DecisionPile
            projectId={bench.projectId}
            benchId={bench.id}
            snapshot={snapshot}
            sessionLive={sessionLive}
          />
        </div>

        <section data-testid="delivery-steering-controls" aria-label="Steering">
          <BoundaryPanel projectId={bench.projectId} benchId={bench.id} snapshot={snapshot} />
        </section>

        <section
          data-testid="delivery-role-controls"
          aria-label="Roles and mode"
          className="flex flex-wrap items-start gap-6"
        >
          <div className="min-w-0 flex-1">
            <RoleMatrix
              projectId={bench.projectId}
              benchId={bench.id}
              snapshot={snapshot}
              disabled={ended}
            />
          </div>
          <DeliveryModeControl
            projectId={bench.projectId}
            benchId={bench.id}
            snapshot={snapshot}
            disabled={ended}
          />
        </section>

        <LifecycleControls
          bench={bench}
          snapshot={snapshot}
          sessionStartBlocked={sessionStartBlocked}
          crossCheck={crossCheck.data}
        />
      </section>
    </div>
  );
}
