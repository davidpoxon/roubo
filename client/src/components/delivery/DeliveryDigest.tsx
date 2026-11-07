import {
  DELIVERY_DIGEST_KINDS,
  type DeliveryDigest as DeliveryDigestBody,
  type DeliveryDigestEntry,
  type DeliveryDigestKind,
} from "@roubo/shared/delivery-digest";
import Button from "../ui/Button";
import { focusRing } from "../ui/focus-ring";

// The since-you-left digest (SB-FR-012, SB-US-012): on opening the Delivery
// tab, what changed in the delivery since the operator last viewed it, grouped
// by unit, decision, gate and drift. Each entry links to its target: a unit or
// a gate opens its drill-in on the map, a decision raises its card on the
// decision pile or the review pile while it is on one, else opens the drill-in
// of the unit it is about, and a drift entry brings the drift ledger into view.
// Dismiss marks the delivery seen, and the digest stays away until new events
// arrive.

const GROUP_LABELS: Record<DeliveryDigestKind, string> = {
  unit: "Units",
  decision: "Decisions",
  gate: "Gates",
  drift: "Drift",
};

const LINK_LABELS: Record<DeliveryDigestKind, string> = {
  unit: "Open unit",
  decision: "Show decision",
  gate: "Open gate",
  drift: "Show drift entry",
};

// What changed, in a few words: the status move, or the status of a new entry.
function changeText(entry: DeliveryDigestEntry): string {
  if (entry.kind === "drift") return `new ${entry.status} drift`;
  if (entry.previousStatus === null) return entry.status;
  if (entry.previousStatus === entry.status) return `still ${entry.status}`;
  return `${entry.previousStatus} to ${entry.status}`;
}

export interface DeliveryDigestProps {
  digest: DeliveryDigestBody;
  isDismissing: boolean;
  onDismiss: () => void;
  onOpen: (entry: DeliveryDigestEntry) => void;
}

export default function DeliveryDigest({
  digest,
  isDismissing,
  onDismiss,
  onOpen,
}: DeliveryDigestProps) {
  const groups = DELIVERY_DIGEST_KINDS.map((kind) => ({
    kind,
    entries: digest.entries.filter((entry) => entry.kind === kind),
  })).filter((group) => group.entries.length > 0);

  return (
    <section
      data-testid="delivery-digest"
      data-source={digest.source}
      aria-label="Since you left"
      className="space-y-3 rounded-control border border-border bg-bg-surface p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-14 font-medium text-text-primary">Since you left</h3>
        <Button onPress={onDismiss} isDisabled={isDismissing}>
          Dismiss
        </Button>
      </div>
      {digest.source === "record" && (
        <p data-testid="delivery-digest-from-record" className="text-12 text-text-secondary">
          Some events since your last view are no longer in the event log, so this reads the
          delivery record for them.
        </p>
      )}
      {groups.map((group) => (
        <div key={group.kind} data-testid={`delivery-digest-${group.kind}`} className="space-y-1">
          <h4 className="font-mono text-11 font-medium text-text-secondary">
            {GROUP_LABELS[group.kind]}
          </h4>
          <ul className="space-y-1">
            {group.entries.map((entry) => (
              <li
                key={`${entry.kind}-${entry.id}`}
                className="flex flex-wrap items-baseline gap-x-3 text-13"
              >
                <button
                  type="button"
                  data-testid={`delivery-digest-link-${entry.kind}-${entry.id}`}
                  aria-label={`${LINK_LABELS[entry.kind]} ${entry.kind === "drift" ? entry.label : entry.id}`}
                  onClick={() => onOpen(entry)}
                  className={`font-mono text-12 text-accent underline ${focusRing}`}
                >
                  {entry.kind === "drift" ? entry.status : entry.id}
                </button>
                <span className="text-text-body">{entry.label}</span>
                <span className="font-mono text-11 text-text-secondary">{changeText(entry)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
