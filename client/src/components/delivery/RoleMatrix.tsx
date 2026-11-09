import { useState } from "react";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectRoleMatrix, type RoleMatrixRow } from "@roubo/shared/delivery-selectors";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { focusRing } from "../ui/focus-ring";
import { useRoleChange } from "../../hooks/useDelivery";
import { DeliveryPanel } from "./DeliveryPanel";

// The role matrix of the Delivery tab (SB-FR-021): a "Role matrix" panel with
// one DESIGN.md Role matrix row per role of the delivery, as a dense hairline
// row (#1623): the mono role name, its model tier as a menu on the field
// ground, its spend so far and its share of the spend, and an accent badge while a
// change waits for the session. Changing the tier and saving writes a
// role-change control (PUT .../delivery/roles); the row shows pending from the
// outbox the snapshot carries, until the session's `roles.applied` reads the
// control back and makes the tier the role's current one. The record carries
// no effort per role, so the row has no effort menu (#1615).

// The tier aliases the menu always offers. The contract gives a tier no
// vocabulary, so every tier the delivery already names is offered too.
const ROLE_TIER_OPTIONS: readonly string[] = ["fast", "balanced", "large"];

function tierOptions(rows: readonly RoleMatrixRow[]): string[] {
  const options = [...ROLE_TIER_OPTIONS];
  for (const row of rows) {
    for (const tier of [row.tier, row.pendingTier]) {
      if (tier !== null && !options.includes(tier)) options.push(tier);
    }
  }
  return options;
}

const SELECT_CLASS = `rounded-control border border-border-control bg-bg-field px-3 py-1.5 text-13 text-text-body transition-colors hover:bg-bg-hover active:bg-bg-pressed disabled:cursor-default disabled:opacity-40 ${focusRing}`;

function RoleRow({
  row,
  options,
  spentUsd,
  disabled,
  saving,
  onSave,
}: {
  row: RoleMatrixRow;
  options: readonly string[];
  // The spend of the whole delivery, which the row's share is of.
  spentUsd: number;
  disabled: boolean;
  saving: boolean;
  onSave: (tier: string) => void;
}) {
  // The draft starts at the tier in effect; the row is keyed by the tier and
  // the pending tier, so a read-back starts it again from the new tier.
  const [draft, setDraft] = useState(row.tier);
  const pending = row.pendingTier !== null;
  return (
    <li
      data-testid={`role-row-${row.role}`}
      data-state={pending ? "pending" : "current"}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2 last:border-b-0 ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <span className="min-w-28 break-all font-mono text-13 font-medium text-text-primary">
        {row.role}
      </span>
      <select
        data-testid={`role-model-${row.role}`}
        aria-label={`Model of ${row.role}`}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        className={SELECT_CLASS}
      >
        {options.map((tier) => (
          <option key={tier} value={tier}>
            {tier}
          </option>
        ))}
      </select>
      <Button
        onPress={() => onSave(draft)}
        isDisabled={disabled || saving || draft === row.tier || draft === row.pendingTier}
        aria-label={`Save the model of ${row.role}`}
      >
        Save
      </Button>
      <span
        data-testid={`role-spent-${row.role}`}
        className="font-mono text-12 tabular-nums text-text-secondary"
      >
        {row.spentUsd === null
          ? "no spend yet"
          : `$${row.spentUsd.toFixed(2)} · ${String(
              spentUsd > 0 ? Math.round((row.spentUsd / spentUsd) * 100) : 0,
            )} percent`}
      </span>
      {pending && (
        <span
          data-testid={`role-pending-${row.role}`}
          className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text"
        >
          pending · {row.pendingTier} · next boundary
        </span>
      )}
    </li>
  );
}

export default function RoleMatrix({
  projectId,
  benchId,
  snapshot,
  disabled = false,
}: {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  // True while the delivery is ended: no role changes then.
  disabled?: boolean;
}) {
  const rows = selectRoleMatrix(snapshot);
  const options = tierOptions(rows);
  const change = useRoleChange(projectId, benchId);
  return (
    <DeliveryPanel
      testId="delivery-role-controls"
      title="Role matrix"
      label="Roles"
      meta="changes apply at the next unit boundary"
    >
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-12 text-text-secondary">The delivery names no role.</p>
      ) : (
        <ul aria-label="Role matrix">
          {rows.map((row) => (
            <RoleRow
              key={`${row.role}:${row.tier}:${row.pendingTier ?? ""}`}
              row={row}
              options={options}
              spentUsd={snapshot.budget.spent_usd}
              disabled={disabled}
              saving={change.isPending}
              onSave={(tier) => change.mutate({ role: row.role, tier })}
            />
          ))}
        </ul>
      )}
      {change.isError && (
        <Callout role="alert" title="The role change was not sent" className="m-3">
          {change.error.message}
        </Callout>
      )}
    </DeliveryPanel>
  );
}
