import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectBurn, type BurnRoleCost } from "@roubo/shared/delivery-selectors";
import { useNow } from "../../hooks/useNow";
import { DeliveryPanel, DeliveryStatStrip } from "./DeliveryPanel";
import { DeliveryStat } from "./DeliveryProgress";
import { formatElapsed } from "./delivery-health-model";
import { utcMinute } from "./delivery-timeline-model";

// The burn meter (SB-FR-018, SB-US-007): a "Burn" panel whose stat strip holds
// four Delivery stats (#1623): spend against the soft budget, the role that
// spent the most, spend against the estimate, and the time since the delivery
// started. The cost per unit (each unit's `cost_usd`) and per role (the
// budget's `by_role`) follow below the strip. It reads the snapshot, so a
// `unit.changed` or a `budget.changed` moves it with the next delivery frame.
// The record has one estimate for the whole delivery and none per unit, so the
// strip compares the spend with that estimate rather than an accuracy per unit.

// How often the elapsed time reads the clock again.
const ELAPSED_TICK_MS = 60_000;

function usd(value: number): string {
  return value.toFixed(2);
}

function percent(part: number, whole: number): string {
  return `${String(whole > 0 ? Math.round((part / whole) * 100) : 0)} percent`;
}

// The role that spent the most, with its share of the spend, and the others.
function RoleStat({ byRole, spentUsd }: { byRole: BurnRoleCost[]; spentUsd: number }) {
  const [top, ...rest] = [...byRole].sort((a, b) => b.costUsd - a.costUsd);
  if (top === undefined) {
    return (
      <DeliveryStat
        testId="delivery-stat-by-role"
        eyebrow="By role"
        value="none"
        note="no role has a cost yet"
      />
    );
  }
  return (
    <DeliveryStat
      testId="delivery-stat-by-role"
      eyebrow="By role"
      value={usd(top.costUsd)}
      note={`${top.role} · ${percent(top.costUsd, spentUsd)}`}
      {...(rest.length > 0 && {
        detail: rest.map((entry) => `${entry.role} ${usd(entry.costUsd)}`).join(" · "),
      })}
    />
  );
}

function ElapsedStat({ startedAt, endedAt }: { startedAt: string; endedAt: string | null }) {
  const now = useNow(ELAPSED_TICK_MS);
  const start = Date.parse(startedAt);
  const end = endedAt === null ? now : Date.parse(endedAt);
  const known = !Number.isNaN(start) && !Number.isNaN(end);
  return (
    <DeliveryStat
      testId="delivery-stat-elapsed"
      eyebrow="Elapsed"
      value={known ? formatElapsed(end - start) : "unknown"}
      note={endedAt === null ? `since ${utcMinute(startedAt)}` : `ended ${utcMinute(endedAt)}`}
    />
  );
}

function Breakdown({
  testId,
  label,
  empty,
  rows,
}: {
  testId: string;
  label: string;
  empty: string;
  rows: { key: string; testId: string; name: string; costUsd: number }[];
}) {
  return (
    <section data-testid={testId} aria-label={label} className="space-y-1">
      <h4 className="font-mono text-11 font-medium text-text-secondary">{label}</h4>
      {rows.length === 0 ? (
        <p className="text-12 text-text-secondary">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <li
              key={row.key}
              data-testid={row.testId}
              className="flex items-center justify-between gap-3 border-b border-border py-0.5 text-12"
            >
              <span className="truncate font-mono text-text-body">{row.name}</span>
              <span className="font-mono tabular-nums text-text-body">{usd(row.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function DeliveryBurn({ snapshot }: { snapshot: DeliverySnapshot }) {
  const burn = selectBurn(snapshot);
  return (
    <DeliveryPanel
      testId="delivery-burn"
      title="Burn"
      meta={`estimate ${usd(burn.estimateUsd)} · soft budget ${usd(burn.softBudgetUsd)}`}
    >
      <DeliveryStatStrip testId="delivery-burn-stats">
        <DeliveryStat
          testId="delivery-stat-spent"
          eyebrow="Spent"
          value={usd(burn.spentUsd)}
          note={`of ${usd(burn.softBudgetUsd)} soft budget${burn.overBudget ? ", over budget" : ""}`}
          fill={burn.fill}
        />
        <RoleStat byRole={burn.byRole} spentUsd={burn.spentUsd} />
        <DeliveryStat
          testId="delivery-stat-estimate"
          eyebrow="Estimate"
          value={usd(burn.estimateUsd)}
          note={
            burn.estimateUsd > 0
              ? `spent is ${percent(burn.spentUsd, burn.estimateUsd)} of it`
              : "no estimate"
          }
        />
        <ElapsedStat
          startedAt={snapshot.lifecycle.started_at}
          endedAt={snapshot.lifecycle.ended_at ?? null}
        />
      </DeliveryStatStrip>
      <div className="grid gap-4 border-t border-border p-3 sm:grid-cols-2">
        <Breakdown
          testId="delivery-burn-units"
          label="Cost per unit"
          empty="No unit has a cost yet"
          rows={burn.byUnit.map((entry) => ({
            key: entry.unitId,
            testId: `delivery-burn-unit-${entry.unitId}`,
            name: entry.unitId,
            costUsd: entry.costUsd,
          }))}
        />
        <Breakdown
          testId="delivery-burn-roles"
          label="Cost per role"
          empty="No role has a cost yet"
          rows={burn.byRole.map((entry) => ({
            key: entry.role,
            testId: `delivery-burn-role-${entry.role}`,
            name: entry.role,
            costUsd: entry.costUsd,
          }))}
        />
      </div>
    </DeliveryPanel>
  );
}
