import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectBurn } from "@roubo/shared/delivery-selectors";
import { DeliveryStat } from "./DeliveryProgress";

// The burn meter (SB-FR-018, SB-US-007): spend against the soft budget as a
// Delivery stat, then the cost per unit (each unit's `cost_usd`) and per role
// (the budget's `by_role`). It reads the snapshot, so a `unit.changed` or a
// `budget.changed` moves it with the next delivery frame.

function usd(value: number): string {
  return value.toFixed(2);
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
      <h3 className="font-mono text-11 font-medium text-text-secondary">{label}</h3>
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
    <section data-testid="delivery-burn" aria-label="Burn" className="space-y-3">
      <DeliveryStat
        testId="delivery-stat-spent"
        eyebrow="Spent"
        value={usd(burn.spentUsd)}
        note={`of ${usd(burn.softBudgetUsd)} soft budget${burn.overBudget ? ", over budget" : ""}`}
        fill={burn.fill}
      />
      <div className="grid grid-cols-2 gap-4">
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
    </section>
  );
}
