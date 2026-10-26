import type { Bench } from "@roubo/shared";
import type { DeliveryReadError } from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectOpenDecisions, selectUnitsInStackOrder } from "@roubo/shared/delivery-selectors";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import {
  useDelivery,
  useDeliverySessionLive,
  useLaunchDelivery,
  useResumeDelivery,
} from "../../hooks/useDelivery";
import { deliveryReadErrorOf } from "../../lib/api";
import DeliveryMap from "./DeliveryMap";

// The Spec Bench's Delivery tab (SB-FR-009). It names what the bench delivers
// and how it is bound, then reads the delivery: the folded snapshot and its
// controls when the record conforms, or the named error when it does not. No
// decision, steering, role or lifecycle control renders until the record
// conforms, so nothing can act on a record the bench cannot read. The one
// exception is a launch-mode bench with no record yet: it offers to launch its
// session again, since no record means no session has run the delivery yet.
export default function DeliveryTabPanel({ bench }: { bench: Bench }) {
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
      {delivery.isSuccess && <DeliverySnapshotView bench={bench} snapshot={delivery.data} />}
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

function DeliverySnapshotView({ bench, snapshot }: { bench: Bench; snapshot: DeliverySnapshot }) {
  const units = selectUnitsInStackOrder(snapshot);
  const decisions = selectOpenDecisions(snapshot);
  const roles = Object.entries(snapshot.roles);
  const resume = useResumeDelivery(bench.projectId, bench.id);
  const resumeBlocked = useSessionStartBlocked(bench);

  return (
    <div data-testid="delivery-snapshot" className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-13">
        <dt className="text-text-secondary">Lifecycle</dt>
        <dd className="text-text-primary" data-testid="delivery-lifecycle">
          {snapshot.lifecycle.state}
        </dd>
        <dt className="text-text-secondary">Units</dt>
        <dd className="text-text-primary">{units.length}</dd>
        <dt className="text-text-secondary">Budget</dt>
        <dd className="text-text-primary" data-testid="delivery-budget">
          ${snapshot.budget.spent_usd.toFixed(2)} of ${snapshot.budget.soft_budget_usd.toFixed(2)}
        </dd>
      </dl>

      <DeliveryMap projectId={bench.projectId} benchId={bench.id} snapshot={snapshot} />

      <p className="text-12 text-text-secondary">
        Sending answers, steering notes and tier changes is not available on this bench yet.
      </p>

      <section
        data-testid="delivery-decision-controls"
        aria-label="Decisions"
        className="space-y-2"
      >
        {decisions.length === 0 && <p className="text-13 text-text-secondary">No open decisions</p>}
        {decisions.map((decision) => (
          <div key={decision.id} className="space-y-1">
            <p className="text-13 text-text-body">{decision.question}</p>
            <div className="flex flex-wrap gap-2">
              {decision.options.map((option) => (
                <Button key={option} isDisabled>
                  {option}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section data-testid="delivery-steering-controls" aria-label="Steering">
        <Button isDisabled>Add steering note</Button>
      </section>

      <section
        data-testid="delivery-role-controls"
        aria-label="Roles"
        className="flex flex-wrap gap-2"
      >
        {roles.map(([role, value]) => (
          <Button key={role} isDisabled>
            {role}: {value.tier}
          </Button>
        ))}
      </section>

      <section
        data-testid="delivery-lifecycle-controls"
        aria-label="Lifecycle"
        className="flex flex-wrap gap-2"
      >
        <Button onPress={() => resume.mutate()} isDisabled={resume.isPending || resumeBlocked}>
          Resume
        </Button>
        <Button isDisabled>Pause</Button>
        <Button isDisabled>Wind down</Button>
      </section>
      {resume.isError && (
        <Callout role="alert" title="The delivery session did not start">
          {resume.error.message}
        </Callout>
      )}
    </div>
  );
}
