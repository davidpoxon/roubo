import { useId, useState } from "react";
import type { DeliveryCrossCheckResponse } from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectHealth, type DeliveryHealthView } from "@roubo/shared/delivery-selectors";
import { useNow } from "../../hooks/useNow";
import { focusRing } from "../ui/focus-ring";
import DeliveryCrossCheck from "./DeliveryCrossCheck";
import { STATUS_DOT_CLASSES } from "../ui/styles";
import {
  DELIVERY_HEALTH_TICK_MS,
  HEALTH_TONES,
  formatAge,
  healthLabel,
} from "./delivery-health-model";

// The delivery's health on the Delivery tab (SB-FR-019, SB-NFR-006, SB-US-007):
// the health group in the tab's header row holds the Health chip and, while the
// delivery is stale, the age of the record. The chip reads the shared health selector
// against the view's own clock, so the delivery turns stale 2 minutes after its
// last event even when no new snapshot arrives, and the next event clears it.
// Given the bench's last cross-check, the group also lists its disagreements and
// names a source it could not read (SB-FR-030); the Delivery tab passes none,
// and shows the cross-check as a panel on its summary rail instead.

// DESIGN.md Health chip: one word, a dot that names the state, and a press that
// opens the reason.
export function DeliveryHealthChip({ health }: { health: DeliveryHealthView }) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const tone = HEALTH_TONES[health.word];
  const label = healthLabel(health);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid="delivery-health-chip"
        data-health={health.word}
        data-tone={tone}
        aria-label={`Show health detail: ${label}`}
        aria-expanded={open}
        aria-controls={reasonId}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center gap-1.5 rounded-chip border border-border-strong bg-bg-surface px-1.5 py-0.5 text-text-secondary transition-colors hover:border-border-control active:bg-bg-hover ${focusRing}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASSES[tone]} ${
            health.word === "stale" ? "animate-status-pulse" : ""
          }`}
        />
        <span className="font-mono text-11 font-medium text-text-secondary">{label}</span>
      </button>
      <span
        id={reasonId}
        data-testid="delivery-health-reason"
        hidden={!open}
        className="text-12 text-text-body"
      >
        {health.reason}
      </span>
    </span>
  );
}

export interface DeliveryRailProps {
  snapshot: DeliverySnapshot;
  // True while the view knows the event stream to be down.
  disconnected?: boolean;
  // True for an attached bench that holds no session (SB-FR-003): the chip
  // reads attached until the first event arrives.
  attached?: boolean;
  // The bench's last cross-check (SB-FR-030), when the view has read it.
  crossCheck?: DeliveryCrossCheckResponse | undefined;
  // Asks the map to focus the unit or gate of a cross-check entry (SB-FR-029),
  // with the map keys to try in order.
  onFocusMapTarget?: ((keys: string[]) => void) | undefined;
}

export default function DeliveryRail({
  snapshot,
  disconnected,
  attached,
  crossCheck,
  onFocusMapTarget,
}: DeliveryRailProps) {
  const now = useNow(DELIVERY_HEALTH_TICK_MS);
  const health = selectHealth(snapshot, now, { disconnected, attached });
  const { stale, ageMs } = health.staleness;
  return (
    <div
      data-testid="delivery-rail"
      role="group"
      aria-label="Delivery health"
      className="flex flex-wrap items-start gap-3"
    >
      <DeliveryHealthChip health={health} />
      {stale && ageMs !== null && (
        <span
          data-testid="delivery-record-age"
          className="py-0.5 font-mono text-11 text-text-secondary"
        >
          record {formatAge(ageMs)} old
        </span>
      )}
      {crossCheck !== undefined && (
        <DeliveryCrossCheck
          crossCheck={crossCheck}
          snapshot={snapshot}
          onFocusMapTarget={onFocusMapTarget}
        />
      )}
    </div>
  );
}
