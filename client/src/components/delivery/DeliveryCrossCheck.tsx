import type {
  DeliveryCrossCheckDisagreement,
  DeliveryCrossCheckResponse,
  DeliveryCrossCheckValue,
} from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { focusRing } from "../ui/focus-ring";
import { crossCheckMapKeys } from "./delivery-map-model";

// The delivery cross-check on the Delivery tab's rail (SB-FR-029, SB-FR-030,
// SB-US-010, SB-NFR-004): one entry per disagreement of the bench's last
// cross-check, in the order the server lists them, each naming its class, what
// it is about, whether it blocks, and what the record claims beside what the
// source of truth observes (both commits of a head-commit-differs); and, when
// the last refresh could not read
// GitHub, the source error. It shows nothing while the cross-check finds
// nothing and reads every source.
//
// Each entry is a button in the Tab order whose accessible name carries its
// class and whether it blocks, so a screen reader announces both. Enter (or a
// press) asks the map to focus the unit or gate the entry is about, through
// `onFocusMapTarget` with the map keys to try in order. An entry about the
// whole delivery (plan-hash-mismatch) has no map target: it stays in the Tab
// order and is announced, and reads as unavailable to press.

const SOURCE_NAMES: Record<string, string> = { github: "GitHub" };

// What a disagreement is about: its unit, its stack, or its case.
function subjectOf(disagreement: DeliveryCrossCheckDisagreement): string {
  if (disagreement.caseId !== undefined) {
    return `${disagreement.unitId ?? ""} ${disagreement.caseId}`.trim();
  }
  return disagreement.unitId ?? disagreement.stack ?? "delivery";
}

// A full commit id reads as its first seven characters.
function shortValue(value: string): string {
  return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value;
}

function isValueList(value: DeliveryCrossCheckValue): value is readonly string[] {
  return Array.isArray(value);
}

// A claimed or observed value as the rail shows it: a word, a list in order,
// each side with its value (the local and remote heads of a branch), or
// `none`.
function formatValue(value: DeliveryCrossCheckValue): string {
  if (value === null) return "none";
  if (typeof value === "string") return shortValue(value);
  if (isValueList(value)) return value.join(" > ");
  return Object.entries(value)
    .map(([side, sideValue]) => `${side} ${sideValue === null ? "none" : shortValue(sideValue)}`)
    .join(", ");
}

function blockingWord(disagreement: DeliveryCrossCheckDisagreement): string {
  return disagreement.blocking ? "blocking" : "shown only";
}

// The entry's accessible name: its class, whether it blocks, and its subject.
function crossCheckEntryName(disagreement: DeliveryCrossCheckDisagreement): string {
  return `${disagreement.class}, ${blockingWord(disagreement)}, ${subjectOf(disagreement)}`;
}

export default function DeliveryCrossCheck({
  crossCheck,
  snapshot,
  onFocusMapTarget,
}: {
  crossCheck: DeliveryCrossCheckResponse;
  // The folded delivery, which tells a gate from a unit; without it no entry
  // has a map target.
  snapshot?: DeliverySnapshot | undefined;
  onFocusMapTarget?: ((keys: string[]) => void) | undefined;
}) {
  const { disagreements, sourceError } = crossCheck;
  if (disagreements.length === 0 && sourceError === null) return null;
  return (
    <section data-testid="delivery-crosscheck" aria-label="Cross-check" className="space-y-1">
      {sourceError !== null && (
        <p
          role="status"
          data-testid="delivery-crosscheck-source-error"
          data-source={sourceError.source}
          className="py-0.5 font-mono text-11 text-text-secondary"
        >
          {SOURCE_NAMES[sourceError.source] ?? sourceError.source} could not be read:{" "}
          {sourceError.message}
        </p>
      )}
      {disagreements.length > 0 && (
        <ul
          data-testid="delivery-crosscheck-list"
          aria-label="Disagreements"
          className="space-y-0.5"
        >
          {disagreements.map((disagreement, index) => {
            const keys = snapshot === undefined ? [] : crossCheckMapKeys(disagreement, snapshot);
            const focusable = keys.length > 0 && onFocusMapTarget !== undefined;
            return (
              <li
                key={`${disagreement.class}-${subjectOf(disagreement)}-${String(index)}`}
                data-testid="delivery-crosscheck-row"
                data-class={disagreement.class}
                data-blocking={disagreement.blocking}
              >
                <button
                  type="button"
                  data-testid="delivery-crosscheck-entry"
                  aria-label={crossCheckEntryName(disagreement)}
                  aria-disabled={focusable ? undefined : "true"}
                  onClick={() => {
                    if (focusable) onFocusMapTarget(keys);
                  }}
                  className={`flex items-baseline gap-3 rounded-control py-0.5 text-left text-12 ${focusRing} ${
                    focusable ? "hover:bg-bg-hover active:bg-bg-pressed" : "cursor-default"
                  }`}
                >
                  <span data-col="class" className="font-mono text-text-primary">
                    {disagreement.class}
                  </span>
                  <span data-col="subject" className="font-mono text-11 text-text-body">
                    {subjectOf(disagreement)}
                  </span>
                  <span data-col="blocking" className="font-mono text-11 text-text-secondary">
                    {blockingWord(disagreement)}
                  </span>
                  <span data-col="claimed" className="font-mono text-11 text-text-secondary">
                    record {formatValue(disagreement.claimed)}
                  </span>
                  <span data-col="observed" className="font-mono text-11 text-text-secondary">
                    {disagreement.source} {formatValue(disagreement.observed)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
