import type {
  DeliveryCrossCheckDisagreement,
  DeliveryCrossCheckResponse,
  DeliveryCrossCheckValue,
} from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import type { Ref } from "react";
import { focusRing } from "../ui/focus-ring";
import { crossCheckMapKeys } from "./delivery-map-model";
import { DeliveryPanel } from "./DeliveryPanel";

// The delivery cross-check, a "Cross-check" panel (SB-FR-029, SB-FR-030,
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
//
// The Delivery tab shows the panel last on its rail of summary panels, where
// it takes the rest of the rail's height and scrolls its entries under a
// header that stays in place (#1655). DeliveryRail still hosts it when it is
// given a cross-check, which the tab no longer does.
// The header of the Delivery tab carries a chip that counts the disagreements
// (DeliveryCrossCheckChip); a press on it brings this panel into view.

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

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

// What the header chip reads: the count of disagreements, then how many block,
// or the class of a lone one that does not; a cross-check that found nothing
// but could not read a source names that instead.
function crossCheckSummary(crossCheck: DeliveryCrossCheckResponse): string | null {
  const { disagreements, sourceError } = crossCheck;
  if (disagreements.length === 0) {
    return sourceError === null ? null : "cross-check · source not read";
  }
  const blocking = disagreements.filter((disagreement) => disagreement.blocking).length;
  const count = plural(disagreements.length, "disagreement");
  if (blocking > 0) return `${count} · ${String(blocking)} blocking`;
  const [only] = disagreements;
  return disagreements.length === 1 && only !== undefined ? `${count} · ${only.class}` : count;
}

// The header chip: it shows while the cross-check has something to show, and a
// press brings the rail's Cross-check panel into view.
export function DeliveryCrossCheckChip({
  crossCheck,
  onOpen,
}: {
  crossCheck: DeliveryCrossCheckResponse;
  onOpen: () => void;
}) {
  const summary = crossCheckSummary(crossCheck);
  if (summary === null) return null;
  const blocking = crossCheck.disagreements.some((disagreement) => disagreement.blocking);
  return (
    <button
      type="button"
      data-testid="delivery-crosscheck-chip"
      data-blocking={blocking}
      aria-label={`Show the cross-check: ${summary}`}
      onClick={onOpen}
      className={`inline-flex min-h-6 items-center gap-1.5 rounded-chip border border-border-strong bg-bg-surface px-1.5 py-0.5 font-mono text-11 font-medium transition-colors hover:border-border-control active:bg-bg-hover ${focusRing} ${
        blocking ? "text-text-primary" : "text-text-secondary"
      }`}
    >
      {summary}
    </button>
  );
}

export default function DeliveryCrossCheck({
  ref,
  crossCheck,
  snapshot,
  onFocusMapTarget,
  className,
}: {
  ref?: Ref<HTMLElement>;
  className?: string | undefined;
  crossCheck: DeliveryCrossCheckResponse;
  // The folded delivery, which tells a gate from a unit; without it no entry
  // has a map target.
  snapshot?: DeliverySnapshot | undefined;
  onFocusMapTarget?: ((keys: string[]) => void) | undefined;
}) {
  const { disagreements, sourceError } = crossCheck;
  if (disagreements.length === 0 && sourceError === null) return null;
  return (
    <DeliveryPanel
      ref={ref}
      testId="delivery-crosscheck"
      title="Cross-check"
      meta={plural(disagreements.length, "disagreement")}
      focusable
      fill
      {...(className !== undefined && { className })}
    >
      <div
        data-testid="delivery-crosscheck-body"
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2"
      >
        {sourceError !== null && (
          <p
            role="status"
            data-testid="delivery-crosscheck-source-error"
            data-source={sourceError.source}
            className="break-words py-0.5 font-mono text-11 text-text-secondary"
          >
            {SOURCE_NAMES[sourceError.source] ?? sourceError.source} could not be read:{" "}
            {sourceError.message}
          </p>
        )}
        {disagreements.length > 0 && (
          <ul
            data-testid="delivery-crosscheck-list"
            aria-label="Disagreements"
            className="divide-y divide-border"
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
                    className={`flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-control py-1.5 text-left text-12 ${focusRing} ${
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
                    <span
                      data-col="claimed"
                      className="min-w-0 break-all font-mono text-11 text-text-secondary"
                    >
                      record {formatValue(disagreement.claimed)}
                    </span>
                    <span
                      data-col="observed"
                      className="min-w-0 break-all font-mono text-11 text-text-secondary"
                    >
                      {disagreement.source} {formatValue(disagreement.observed)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DeliveryPanel>
  );
}
