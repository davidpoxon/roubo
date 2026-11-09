import type { Ref } from "react";
import type { Bench } from "@roubo/shared";
import type { DeliveryCrossCheckResponse } from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import DeliveryBurn from "./DeliveryBurn";
import DeliveryDriftLedger from "./DeliveryDriftLedger";
import { DeliveryHealthPanel } from "./DeliveryJams";
import DeliveryModeControl from "./DeliveryModeControl";
import { DeliveryPanel } from "./DeliveryPanel";
import LifecycleControls from "./LifecycleControls";
import RoleMatrix from "./RoleMatrix";

// The body of the Delivery tab's cost view (#1623), below its breadcrumb: a
// title row with the lifecycle badge and the lifecycle buttons, then the Burn
// panel, the Health and Role matrix panels side by side on a wide view, the
// Decision mode panel and the Drift ledger panel. The view only composes
// them; each panel reads the snapshot and writes its own controls.

const BADGE_CLASS =
  "rounded-chip bg-bg-hover px-1.5 py-0.5 font-mono text-11 font-medium text-text-secondary";

export default function DeliveryCostView({
  bench,
  snapshot,
  title,
  ended,
  attached,
  sessionStartBlocked,
  crossCheck,
  driftLedgerRef,
  onOpenUnit,
}: {
  bench: Bench;
  snapshot: DeliverySnapshot;
  title: string;
  // True while the delivery is ended: no role change or mode switch then.
  ended: boolean;
  attached: boolean;
  sessionStartBlocked: boolean;
  crossCheck: DeliveryCrossCheckResponse | undefined;
  // The drift ledger, which a digest link brings into view.
  driftLedgerRef: Ref<HTMLDivElement>;
  onOpenUnit: (unitId: string) => void;
}) {
  return (
    <>
      <LifecycleControls
        bench={bench}
        snapshot={snapshot}
        sessionStartBlocked={sessionStartBlocked}
        crossCheck={crossCheck}
        heading={
          <>
            <h2 className="text-16 font-semibold text-text-primary">{title}</h2>
            <span data-testid="delivery-lifecycle" className={`${BADGE_CLASS} sm:ml-auto`}>
              {snapshot.lifecycle.state}
            </span>
          </>
        }
      />
      <div className="@container">
        <div className="grid items-start gap-4 @4xl:grid-cols-2">
          <div className="col-span-full min-w-0">
            <DeliveryBurn snapshot={snapshot} />
          </div>
          <DeliveryHealthPanel
            snapshot={snapshot}
            attached={attached}
            crossCheck={crossCheck}
            onOpenUnit={onOpenUnit}
          />
          <RoleMatrix
            projectId={bench.projectId}
            benchId={bench.id}
            snapshot={snapshot}
            disabled={ended}
          />
          <DeliveryPanel
            testId="delivery-mode-panel"
            title="Decision mode"
            meta="a switch applies at the next unit boundary"
            className="col-span-full"
          >
            <div className="p-3">
              <DeliveryModeControl
                projectId={bench.projectId}
                benchId={bench.id}
                snapshot={snapshot}
                disabled={ended}
              />
            </div>
          </DeliveryPanel>
          <div
            ref={driftLedgerRef}
            tabIndex={-1}
            data-testid="delivery-drift-ledger-target"
            className="col-span-full min-w-0 focus:outline-none"
          >
            <DeliveryDriftLedger snapshot={snapshot} />
          </div>
        </div>
      </div>
    </>
  );
}
