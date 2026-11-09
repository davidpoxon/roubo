import type { ReactNode } from "react";
import { isDecisionOpen, ownValue, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  selectBoundaryPanel,
  selectBurn,
  selectDecisionPile,
  selectJammedUnits,
  selectProgress,
  selectReviewStack,
  type BoundaryQueueItem,
} from "@roubo/shared/delivery-selectors";
import { focusRing } from "../ui/focus-ring";
import { DeliveryPanel, DeliveryStatStrip } from "./DeliveryPanel";
import { DeliveryStat } from "./DeliveryProgress";

// The summary panels on the Delivery tab's rail (#1618): "Burn and health" (spent, jams and cases met in one stat
// strip), "Decisions" (the newest open decision first, else the newest on the
// pile, and the counts), and
// "Next boundary" (the next unit boundary and what is queued for it). Each one
// reads the snapshot and summarises a view that holds the full detail and its
// controls; the link in a panel's header brings that view into view. Nothing
// here answers, steers or changes the delivery.

function usd(value: number): string {
  return value.toFixed(2);
}

function share(met: number, total: number): number {
  return total === 0 ? 0 : met / total;
}

// A text button in a panel header that brings a view into view.
function PanelLink({
  label,
  onPress,
  children,
}: {
  label?: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className={`inline-flex min-h-6 items-center rounded-control text-11 font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline ${focusRing}`}
    >
      {children}
    </button>
  );
}

export function BurnHealthPanel({
  snapshot,
  onOpenCostHealthControls,
}: {
  snapshot: DeliverySnapshot;
  onOpenCostHealthControls: () => void;
}) {
  const burn = selectBurn(snapshot);
  const jammed = selectJammedUnits(snapshot);
  const { cases } = selectProgress(snapshot);
  return (
    <DeliveryPanel
      testId="delivery-burn-health"
      title="Burn and health"
      meta={<PanelLink onPress={onOpenCostHealthControls}>Cost, health and controls</PanelLink>}
    >
      <DeliveryStatStrip testId="delivery-burn-health-stats">
        <DeliveryStat
          testId="delivery-rail-stat-spent"
          eyebrow="Spent"
          value={usd(burn.spentUsd)}
          note={`of ${usd(burn.softBudgetUsd)} soft budget${burn.overBudget ? ", over budget" : ""}`}
          fill={burn.fill}
        />
        <DeliveryStat
          testId="delivery-rail-stat-jams"
          eyebrow="Jams"
          value={jammed.length}
          note={jammed.length === 0 ? "no unit is jammed" : jammed.join(", ")}
        />
        <DeliveryStat
          testId="delivery-rail-stat-cases"
          eyebrow="Cases"
          value={`${String(cases.met)} / ${String(cases.total)}`}
          note="cases met"
          fill={share(cases.met, cases.total)}
        />
      </DeliveryStatStrip>
    </DeliveryPanel>
  );
}

const DECISION_BADGE_CLASS =
  "rounded-chip bg-bg-hover px-1.5 py-0.5 font-mono text-11 font-medium text-text-secondary";
const OPEN_BADGE_CLASS =
  "rounded-chip bg-accent-muted px-1.5 py-0.5 font-mono text-11 font-medium text-accent-text";

export function DecisionSummaryPanel({
  snapshot,
  onOpenDecisions,
}: {
  snapshot: DeliverySnapshot;
  onOpenDecisions: () => void;
}) {
  const pile = selectDecisionPile(snapshot);
  const open = pile.filter(isDecisionOpen);
  const toReview = selectReviewStack(snapshot).length;
  const [top, ...rest] = [...open, ...pile.filter((decision) => !isDecisionOpen(decision))];
  return (
    <DeliveryPanel
      testId="delivery-decision-summary"
      title="Decisions"
      label="Decision summary"
      meta={
        <>
          <span data-testid="delivery-decision-summary-counts">
            {toReview} to review · {open.length} pending ·
          </span>
          <PanelLink label="Open the decision pile" onPress={onOpenDecisions}>
            open
          </PanelLink>
        </>
      }
    >
      {top === undefined ? (
        <p className="px-3 py-2 text-12 text-text-secondary">No decision is on the pile</p>
      ) : (
        <ul className="divide-y divide-border">
          <li data-testid={`delivery-decision-summary-${top.id}`} className="space-y-1 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={isDecisionOpen(top) ? OPEN_BADGE_CLASS : DECISION_BADGE_CLASS}>
                {top.id} · {top.status}
              </span>
              {top.unit_id !== undefined && (
                <span className="font-mono text-11 text-text-secondary">{top.unit_id}</span>
              )}
            </div>
            <p className="break-words text-13 text-text-primary">{top.question}</p>
          </li>
          {rest.slice(0, 2).map((decision) => (
            <li
              key={decision.id}
              data-testid={`delivery-decision-summary-${decision.id}`}
              className="flex flex-wrap items-center gap-2 px-3 py-2"
            >
              <span className={isDecisionOpen(decision) ? OPEN_BADGE_CLASS : DECISION_BADGE_CLASS}>
                {decision.id} · {decision.status}
              </span>
              {decision.unit_id !== undefined && (
                <span className="font-mono text-11 text-text-secondary">{decision.unit_id}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </DeliveryPanel>
  );
}

function queuedText(item: BoundaryQueueItem): string {
  return item.kind === "steering-note" ? item.note : `${item.role}: ${item.tier}`;
}

export function NextBoundaryPanel({
  snapshot,
  className,
}: {
  snapshot: DeliverySnapshot;
  className?: string;
}) {
  const { boundary, queued } = selectBoundaryPanel(snapshot);
  const unit = boundary === null ? undefined : ownValue(snapshot.unitsById, boundary.unitId);
  return (
    <DeliveryPanel
      testId="delivery-next-boundary"
      title="Next boundary"
      label="Boundary summary"
      {...(className !== undefined && { className })}
      meta={
        boundary === null ? undefined : (
          <span className="font-mono">
            {boundary.unitId}
            {unit === undefined ? "" : ` · ${unit.status}`}
          </span>
        )
      }
    >
      {boundary === null ? (
        <p className="px-3 py-2 text-12 text-text-secondary">No unit boundary is ahead</p>
      ) : queued.length === 0 ? (
        <p className="px-3 py-2 text-12 text-text-secondary">Nothing is queued for it</p>
      ) : (
        <ul className="divide-y divide-border">
          {queued.map((item) => (
            <li
              key={item.controlSeq}
              data-testid={`delivery-next-boundary-item-${String(item.controlSeq)}`}
              className="flex min-w-0 items-start gap-2 px-3 py-2"
            >
              <span className={DECISION_BADGE_CLASS}>
                {item.kind === "steering-note" ? "note queued" : "role queued"}
              </span>
              <span className="min-w-0 break-words text-12 text-text-secondary">
                {queuedText(item)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DeliveryPanel>
  );
}
