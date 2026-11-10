import type { DeliveryDrift } from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectDriftLedger } from "@roubo/shared/delivery-selectors";
import { focusRing } from "../ui/focus-ring";
import { utcMinute } from "./delivery-timeline-model";
import { DeliveryPanel } from "./DeliveryPanel";
import { isWebUrl } from "./web-url";

// The drift ledger (SB-FR-020, SB-US-007): a "Drift ledger" panel with one
// dense hairline row per drift entry, oldest first (#1623). A row holds the
// time it was detected, the spec file the edit changed as a badge, its summary
// over a mono line of the ids it minted and the unit it came from, and a link
// to the spec-layer pull request. A `drift.detected` event adds a row with the
// next delivery frame. An entry from before the spec-edit fields shows its
// kind and detail in their place.

const BADGE_CLASS =
  "inline-block max-w-full break-all rounded-chip bg-bg-hover px-1.5 py-0.5 font-mono text-11 font-medium text-text-secondary";

function DriftRow({ entry, index }: { entry: DeliveryDrift; index: number }) {
  const ids = entry.ids ?? [];
  const [date, minute] = utcMinute(entry.detected_at).split(" ");
  return (
    <li
      data-testid={`delivery-drift-row-${index}`}
      className="grid grid-cols-[5.5rem_8rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-12 last:border-b-0 @2xl:grid-cols-[5.5rem_8rem_minmax(0,1fr)_auto]"
    >
      <span data-col="time" className="font-mono text-11 text-text-secondary">
        {minute === undefined ? (
          entry.detected_at
        ) : (
          <>
            <span className="block">{date}</span> <span className="block">{minute} UTC</span>
          </>
        )}
      </span>
      <span>
        <span data-col="file" className={BADGE_CLASS}>
          {entry.file ?? entry.kind}
        </span>
      </span>
      <span className="min-w-0 space-y-0.5">
        <span data-col="summary" className="block break-words text-text-body">
          {entry.summary ?? entry.detail}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-11 text-text-secondary">
          <span data-col="ids" className="flex flex-wrap gap-x-2">
            {ids.length === 0 ? (
              <span className="font-sans">no ids minted</span>
            ) : (
              ids.map((id) => <span key={id}>{id}</span>)
            )}
          </span>
          {entry.unit_id !== undefined && <span data-col="unit">· {entry.unit_id}</span>}
        </span>
      </span>
      <span data-col="pull-request" className="col-start-3 @2xl:col-start-auto">
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
    </li>
  );
}

export default function DeliveryDriftLedger({
  snapshot,
  className,
}: {
  snapshot: DeliverySnapshot;
  className?: string;
}) {
  const drift = selectDriftLedger(snapshot);
  return (
    <DeliveryPanel
      testId="delivery-drift-ledger"
      title="Drift ledger"
      meta={`${String(drift.length)} ${drift.length === 1 ? "entry" : "entries"}`}
      {...(className !== undefined && { className })}
    >
      {drift.length === 0 ? (
        <p className="px-3 py-2 text-12 text-text-secondary">No spec edit yet</p>
      ) : (
        <ol className="@container">
          {drift.map((entry, index) => (
            <DriftRow key={index} entry={entry} index={index} />
          ))}
        </ol>
      )}
    </DeliveryPanel>
  );
}
