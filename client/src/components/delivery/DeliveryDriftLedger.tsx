import type { DeliveryDrift } from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectDriftLedger } from "@roubo/shared/delivery-selectors";
import { focusRing } from "../ui/focus-ring";
import { isWebUrl } from "./web-url";

// The drift ledger (SB-FR-020, SB-US-007): one row per drift entry, oldest
// first, with the spec file the edit changed, its summary, the ids it minted
// and a link to the spec-layer pull request. A `drift.detected` event adds a
// row with the next delivery frame. An entry from before the spec-edit fields
// shows its kind and detail in their place.

function DriftRow({ entry, index }: { entry: DeliveryDrift; index: number }) {
  const ids = entry.ids ?? [];
  return (
    <li
      data-testid={`delivery-drift-row-${index}`}
      className="space-y-0.5 border-b border-border py-1.5 text-12"
    >
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span data-col="file" className="font-mono text-text-primary">
          {entry.file ?? entry.kind}
        </span>
        <span data-col="summary" className="text-text-body">
          {entry.summary ?? entry.detail}
        </span>
      </p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span data-col="ids" className="flex flex-wrap gap-1">
          {ids.length === 0 ? (
            <span className="text-11 text-text-secondary">no ids minted</span>
          ) : (
            ids.map((id) => (
              <span
                key={id}
                className="rounded-chip bg-bg-hover px-1.5 py-0.5 font-mono text-11 text-text-secondary"
              >
                {id}
              </span>
            ))
          )}
        </span>
        <span data-col="pull-request">
          {entry.pr_url !== undefined && isWebUrl(entry.pr_url) ? (
            <a
              href={entry.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-11 text-accent underline ${focusRing}`}
            >
              Spec-layer pull request
            </a>
          ) : (
            <span className="text-11 text-text-secondary">no spec-layer pull request</span>
          )}
        </span>
        <span className="font-mono text-11 text-text-secondary">{entry.detected_at}</span>
      </p>
    </li>
  );
}

export default function DeliveryDriftLedger({ snapshot }: { snapshot: DeliverySnapshot }) {
  const drift = selectDriftLedger(snapshot);
  return (
    <section data-testid="delivery-drift-ledger" aria-label="Drift ledger" className="space-y-1">
      <h3 className="font-mono text-11 font-medium text-text-secondary">Drift ledger</h3>
      {drift.length === 0 ? (
        <p className="text-12 text-text-secondary">No spec edit yet</p>
      ) : (
        <ol>
          {drift.map((entry, index) => (
            <DriftRow key={index} entry={entry} index={index} />
          ))}
        </ol>
      )}
    </section>
  );
}
