import type { DeliveryCrossCheckResponse } from "@roubo/shared/delivery-bench";
import { ownValue, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectHealth, selectJammedUnits } from "@roubo/shared/delivery-selectors";
import { useNow } from "../../hooks/useNow";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { STATUS_DOT_CLASSES } from "../ui/styles";
import { DELIVERY_HEALTH_TICK_MS, HEALTH_TONES } from "./delivery-health-model";
import { DeliveryPanel } from "./DeliveryPanel";

// The jam list (SB-FR-019, SB-US-007): one danger Callout per jammed unit, in
// stack order, with the unit's id, its title and the status word that jams it,
// and, given `onOpenUnit`, a button that opens the unit (#1623). It reads the
// same jams as the Health chip and the map's jam mark, so a `unit.changed`
// that jams or resumes a unit moves all three with the next delivery frame.
export default function DeliveryJams({
  snapshot,
  onOpenUnit,
}: {
  snapshot: DeliverySnapshot;
  onOpenUnit?: (unitId: string) => void;
}) {
  const jammed = selectJammedUnits(snapshot);
  return (
    <section data-testid="delivery-jams" aria-label="Jams">
      {jammed.length === 0 ? (
        <p className="text-12 text-text-secondary">No unit is jammed</p>
      ) : (
        <ul className="space-y-2">
          {jammed.map((id) => {
            const unit = ownValue(snapshot.unitsById, id);
            return (
              <li key={id} data-testid={`delivery-jam-row-${id}`} data-unit={id}>
                <Callout
                  title={
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span data-col="unit" className="font-mono">
                        {id}
                      </span>
                      <span data-col="title" className="break-words">
                        {unit?.title ?? ""}
                      </span>
                    </span>
                  }
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span data-col="status" className="font-mono text-11 text-text-secondary">
                      {unit?.status ?? ""}
                    </span>
                    {onOpenUnit !== undefined && (
                      <Button onPress={() => onOpenUnit(id)}>Open {id}</Button>
                    )}
                  </div>
                </Callout>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The Health panel of the cost view (#1623): the health of the delivery as a
// dot and its reason, then the jam list. Its meta counts the jams and, once the
// view has read the bench's cross-check, the disagreements.
export function DeliveryHealthPanel({
  snapshot,
  attached,
  crossCheck,
  onOpenUnit,
}: {
  snapshot: DeliverySnapshot;
  attached?: boolean;
  crossCheck?: DeliveryCrossCheckResponse | undefined;
  onOpenUnit?: (unitId: string) => void;
}) {
  const now = useNow(DELIVERY_HEALTH_TICK_MS);
  const health = selectHealth(snapshot, now, { attached });
  const jams = selectJammedUnits(snapshot).length;
  const disagreements = crossCheck?.disagreements.length;
  const meta = [
    jams === 0 ? "no jams" : `${String(jams)} ${jams === 1 ? "jam" : "jams"}`,
    ...(disagreements === undefined
      ? []
      : [`${String(disagreements)} ${disagreements === 1 ? "disagreement" : "disagreements"}`]),
  ].join(" · ");
  return (
    <DeliveryPanel testId="delivery-health-panel" title="Health" meta={meta}>
      <div className="space-y-3 p-3">
        <p
          data-testid="delivery-health-line"
          data-health={health.word}
          className="flex items-start gap-2 text-12 text-text-secondary"
        >
          <span
            aria-hidden="true"
            className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASSES[HEALTH_TONES[health.word]]}`}
          />
          <span className="min-w-0 break-words">
            <span className="font-mono text-text-primary">{health.word}</span> · {health.reason}
          </span>
        </p>
        <DeliveryJams snapshot={snapshot} {...(onOpenUnit !== undefined && { onOpenUnit })} />
      </div>
    </DeliveryPanel>
  );
}
