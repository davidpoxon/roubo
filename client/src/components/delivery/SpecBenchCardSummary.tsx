import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  isDecisionOpen,
  selectBurn,
  selectDecisionPile,
  selectHealth,
  selectProgress,
  selectUnitsInStackOrder,
} from "@roubo/shared/delivery-selectors";
import { useBenchViewState } from "../../hooks/useBenchViewState";
import { useDelivery } from "../../hooks/useDelivery";
import { DECISION_PILE_HASH } from "../../hooks/useDeepLink";
import { useNow } from "../../hooks/useNow";
import { deliveryReadErrorOf } from "../../lib/api";
import Button from "../ui/Button";
import { DELIVERY_HEALTH_TICK_MS, healthLabel } from "./delivery-health-model";
import { isLiveUnit, unitCostLabel } from "./delivery-map-model";
import { readErrorTitle } from "./delivery-read-error";

// What a Spec Bench's card shows in place of the component list (#1624), read
// from the bench's delivery snapshot: the spec slug, the cases met, the spend
// and a meter of the cases, then the decisions waiting, the live unit and the
// delivery's health. The card offers "Open delivery", and "Answer" while a
// decision waits. A record the bench cannot read shows why, and offers
// "Open bench" only.

// The card's height is fixed, so the actions keep their place at the foot of
// the summary and the lines above them scroll only if they cannot fit.
const ROOT_CLASS = "flex h-full min-h-0 flex-col gap-2 pb-1.5";
const INFO_CLASS = "min-h-0 flex-1 space-y-1.5 overflow-y-auto";
const LINE_CLASS = "flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-12 text-text-secondary";
const KEY_CLASS = "min-w-0 break-all text-text-body";

export default function SpecBenchCardSummary({ bench }: { bench: Bench }) {
  const navigate = useNavigate();
  const { setActiveTab } = useBenchViewState(bench.projectId, bench.id);
  const delivery = useDelivery(bench.projectId, bench.id);
  const benchPath = `/projects/${bench.projectId}/benches/${bench.id}`;
  const slug = bench.focusedSpecPath?.split("/").filter(Boolean).pop() ?? "no spec";

  if (delivery.isSuccess) {
    return (
      <SnapshotSummary
        bench={bench}
        slug={slug}
        snapshot={delivery.data}
        onOpenDelivery={() => {
          setActiveTab("delivery");
          void navigate(benchPath);
        }}
        onAnswer={() => void navigate(`${benchPath}${DECISION_PILE_HASH}`)}
      />
    );
  }

  const readError = delivery.isError ? deliveryReadErrorOf(delivery.error) : undefined;
  const waiting = readError?.code === "DELIVERY_RECORD_MISSING";
  return (
    <div data-testid="specbench-card-summary" className={ROOT_CLASS}>
      <div className={INFO_CLASS}>
        <p className={LINE_CLASS}>
          <span className={KEY_CLASS}>{slug}</span>
          {delivery.isPending && <span>Reading the delivery record...</span>}
          {delivery.isError && (
            <span
              data-testid="specbench-card-error"
              className={waiting ? undefined : "text-danger-text"}
            >
              {readError ? readErrorTitle(readError) : "The delivery could not be read"}
            </span>
          )}
        </p>
        {delivery.isError && !waiting && (
          <p className={LINE_CLASS}>No controls until the record conforms</p>
        )}
      </div>
      {delivery.isError && (
        <CardActions>
          <Button onPress={() => void navigate(benchPath)}>Open bench</Button>
        </CardActions>
      )}
    </div>
  );
}

function SnapshotSummary({
  bench,
  slug,
  snapshot,
  onOpenDelivery,
  onAnswer,
}: {
  bench: Bench;
  slug: string;
  snapshot: DeliverySnapshot;
  onOpenDelivery: () => void;
  onAnswer: () => void;
}) {
  const now = useNow(DELIVERY_HEALTH_TICK_MS);
  const { cases } = selectProgress(snapshot);
  const { spentUsd } = selectBurn(snapshot);
  const fill = cases.total === 0 ? 0 : cases.met / cases.total;
  // The pile is newest first, so the oldest open decision is its last.
  const open = selectDecisionPile(snapshot).filter(isDecisionOpen);
  const oldest = open.at(-1);
  const live = selectUnitsInStackOrder(snapshot).find(isLiveUnit);
  const attached = bench.deliveryBindMode === "attach" && bench.deliverySessionId === undefined;
  const health = selectHealth(snapshot, now, { attached });

  return (
    <div data-testid="specbench-card-summary" className={ROOT_CLASS}>
      <div className={INFO_CLASS}>
        <p className={LINE_CLASS}>
          <span className={KEY_CLASS}>{slug}</span>
          <span>
            {cases.met} of {cases.total} cases met
          </span>
          <span>{unitCostLabel(spentUsd)}</span>
        </p>
        <span aria-hidden="true" className="block h-1 w-full rounded-full bg-bg-hover">
          <span
            data-testid="specbench-card-meter"
            className="block h-1 rounded-full bg-accent"
            style={{ width: `${Math.round(fill * 100)}%` }}
          />
        </span>
        <p className={LINE_CLASS}>
          <span className="text-text-body">
            {open.length === 0
              ? "no decision waiting"
              : `${open.length} ${open.length === 1 ? "decision" : "decisions"} waiting`}
          </span>
          {live !== undefined && (
            <span data-testid="specbench-card-live">
              {live.id} {live.status}
            </span>
          )}
          <span data-testid="specbench-card-health" data-health={health.word}>
            {healthLabel(health)}
          </span>
        </p>
      </div>
      <CardActions>
        <Button variant="primary" onPress={onOpenDelivery}>
          Open delivery
        </Button>
        {oldest !== undefined && <Button onPress={onAnswer}>Answer {oldest.id}</Button>}
      </CardActions>
    </div>
  );
}

// The card is a link to the bench, so a press on one of its buttons stops
// there rather than also opening the bench.
function CardActions({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex shrink-0 flex-wrap gap-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
