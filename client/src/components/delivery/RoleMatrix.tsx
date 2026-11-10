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
// row (#1623): the mono role name, its model tier and its effort as two menus
// on the field ground (#1615), its spend so far and its share of the spend, and
// an accent badge while a change waits for the session. Changing the tier, the
// effort or both and saving writes one role-change control (PUT
// .../delivery/roles); the row shows pending from the outbox the snapshot
// carries, until the session's `roles.applied` reads the control back and
// makes the tier and effort the role's current ones.

// The tier aliases the model menu always offers. The contract gives a tier no
// vocabulary, so every tier the delivery already names is offered too.
const ROLE_TIER_OPTIONS: readonly string[] = ["fast", "balanced", "large"];

// The efforts the effort menu always offers. The contract gives an effort no
// vocabulary either, so every effort the delivery already names is offered too.
const ROLE_EFFORT_OPTIONS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

function optionsOf(base: readonly string[], named: readonly (string | null)[]): string[] {
  const options = [...base];
  for (const value of named) {
    if (value !== null && !options.includes(value)) options.push(value);
  }
  return options;
}

function tierOptions(rows: readonly RoleMatrixRow[]): string[] {
  return optionsOf(
    ROLE_TIER_OPTIONS,
    rows.flatMap((row) => [row.tier, row.pendingTier]),
  );
}

function effortOptions(rows: readonly RoleMatrixRow[]): string[] {
  return optionsOf(
    ROLE_EFFORT_OPTIONS,
    rows.flatMap((row) => [row.effort, row.pendingEffort]),
  );
}

// The value of the effort menu while the role has no effort: the record of a
// delivery tooling that names none. It is never sent.
const NO_EFFORT = "";

interface RoleChange {
  tier: string;
  effort?: string;
}

const SELECT_CLASS = `rounded-control border border-border-control bg-bg-field px-3 py-1.5 text-13 text-text-body transition-colors hover:bg-bg-hover active:bg-bg-pressed disabled:cursor-default disabled:opacity-40 ${focusRing}`;

function RoleRow({
  row,
  options,
  efforts,
  spentUsd,
  disabled,
  saving,
  onSave,
}: {
  row: RoleMatrixRow;
  options: readonly string[];
  efforts: readonly string[];
  // The spend of the whole delivery, which the row's share is of.
  spentUsd: number;
  disabled: boolean;
  saving: boolean;
  onSave: (change: RoleChange) => void;
}) {
  // The drafts start at the tier and effort in effect; the row is keyed by
  // both and by the pending pair, so a read-back starts them again from the
  // new values.
  const [draft, setDraft] = useState(row.tier);
  const [effortDraft, setEffortDraft] = useState(row.effort ?? NO_EFFORT);
  const pending = row.pendingTier !== null;
  const unchanged = draft === row.tier && effortDraft === (row.effort ?? NO_EFFORT);
  const asPending =
    pending && draft === row.pendingTier && effortDraft === (row.pendingEffort ?? NO_EFFORT);
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
      <select
        data-testid={`role-effort-${row.role}`}
        aria-label={`Effort of ${row.role}`}
        value={effortDraft}
        disabled={disabled}
        onChange={(event) => setEffortDraft(event.target.value)}
        className={SELECT_CLASS}
      >
        {effortDraft === NO_EFFORT && (
          <option value={NO_EFFORT} disabled>
            no effort
          </option>
        )}
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
      <Button
        onPress={() =>
          onSave({ tier: draft, ...(effortDraft !== NO_EFFORT && { effort: effortDraft }) })
        }
        isDisabled={disabled || saving || unchanged || asPending}
        aria-label={`Save the model and effort of ${row.role}`}
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
          pending · {row.pendingTier}
          {row.pendingEffort !== null && ` · ${row.pendingEffort}`} · next boundary
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
  const efforts = effortOptions(rows);
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
              key={`${row.role}:${row.tier}:${row.effort ?? ""}:${row.pendingTier ?? ""}:${
                row.pendingEffort ?? ""
              }`}
              row={row}
              options={options}
              efforts={efforts}
              spentUsd={snapshot.budget.spent_usd}
              disabled={disabled}
              saving={change.isPending}
              onSave={(roleChange) => change.mutate({ role: row.role, ...roleChange })}
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
