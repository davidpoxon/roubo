import { useState, useMemo } from "react";
import { Button, Checkbox, TextField, Input } from "react-aria-components";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import Select from "../Select";
import type { RuleType, PermissionRule } from "./permissionTypes";
import { ruleKey } from "./permissionsDiff";
import { ALL_RULE_TYPES, ruleTypeItemsFor, type SelectionState } from "./permissionsTable";

function RuleTypeBadge({ type }: { type: RuleType }) {
  const styles: Record<RuleType, string> = {
    allow: "bg-success-surface text-success-text border border-success-border",
    deny: "bg-danger-surface text-danger-text border border-danger-border",
    ask: "bg-bg-hover text-text-secondary border border-border-strong",
  };
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-11 ${styles[type]}`}>{type}</span>
  );
}

interface PermissionsRulesTableProps {
  rules: PermissionRule[];
  editable?: boolean;
  emptyMessage?: string;
  onRemove?: (index: number) => void;
  onEdit?: (index: number, next: PermissionRule) => void;
  paginate?: boolean;
  pageSize?: number;
  showTypeFilter?: boolean;
  selection?: SelectionState;
  highlightKeys?: Set<string>;
  /**
   * The rule tiers the project's agent carries (#862). A rule whose tier is not
   * on this list is still listed, so the user can see and remove it, but it is
   * marked as not applied and no picker offers that tier to a new rule. Defaults
   * to every tier, which is what an agent that declares nothing reports.
   */
  tiers?: RuleType[];
}

export function PermissionsRulesTable({
  rules,
  editable = false,
  emptyMessage = "No permissions saved.",
  onRemove,
  onEdit,
  paginate = true,
  pageSize = 10,
  showTypeFilter = true,
  selection,
  highlightKeys,
  tiers = ALL_RULE_TYPES,
}: PermissionsRulesTableProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editType, setEditType] = useState<RuleType>("allow");
  const [editPattern, setEditPattern] = useState("");
  const [editIsDuplicate, setEditIsDuplicate] = useState(false);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState<RuleType | "all">("all");

  const counts = useMemo(
    () => ({
      all: rules.length,
      allow: rules.filter((r) => r.type === "allow").length,
      deny: rules.filter((r) => r.type === "deny").length,
      ask: rules.filter((r) => r.type === "ask").length,
    }),
    [rules],
  );

  const filtered = useMemo(
    () =>
      rules
        .map((rule, originalIndex) => ({ rule, originalIndex }))
        .filter(({ rule }) => typeFilter === "all" || rule.type === typeFilter),
    [rules, typeFilter],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = paginate ? filtered.slice(start, start + pageSize) : filtered;

  const showFooter =
    rules.length > 0 && (showTypeFilter || (paginate && filtered.length > pageSize));

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditType(rules[index].type);
    setEditPattern(rules[index].pattern);
    setEditIsDuplicate(false);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditIsDuplicate(false);
  };

  const saveEdit = (index: number) => {
    const trimmed = editPattern.trim();
    if (!trimmed) return;
    const isDuplicate = rules.some(
      (r, i) => i !== index && r.type === editType && r.pattern === trimmed,
    );
    if (isDuplicate) {
      setEditIsDuplicate(true);
      return;
    }
    onEdit?.(index, { type: editType, pattern: trimmed });
    setEditingIndex(null);
    setEditIsDuplicate(false);
  };

  // A chip for a tier the agent does not carry is pointless unless a rule of
  // that tier is actually stored, in which case the user needs it to find the
  // rows the notice above the table is telling them about.
  const filterLabels: Array<{
    value: RuleType | "all";
    label: string;
    count: number;
  }> = [
    { value: "all", label: "All", count: counts.all },
    ...(["allow", "deny", "ask"] as RuleType[])
      .filter((tier) => tiers.includes(tier) || counts[tier] > 0)
      .map((tier) => ({ value: tier, label: tier, count: counts[tier] })),
  ];

  const gridTemplate = (() => {
    if (selection) return "36px 2fr 10fr";
    return editable ? "2fr 8fr 2fr" : "2fr 10fr";
  })();

  return (
    <div className="rounded-xl border border-border bg-bg-surface overflow-hidden">
      <div
        className="grid text-11 uppercase tracking-label text-text-secondary px-5 py-2.5 border-b border-border bg-bg-base"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {selection && <div />}
        <div>Rule</div>
        <div>Pattern</div>
        {editable && <div className="text-right">Actions</div>}
      </div>

      <div className="divide-y divide-border font-mono text-12">
        {rules.length === 0 ? (
          <div className="px-5 py-4 text-text-secondary text-12">{emptyMessage}</div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-4 text-text-secondary text-12">No rules match this filter.</div>
        ) : (
          pageItems.map(({ rule, originalIndex }) => {
            const selKey = ruleKey(rule);
            const isSelected = selection?.selectedKeys.has(selKey) ?? false;
            const isHighlighted = highlightKeys?.has(selKey) ?? false;

            if (editable && editingIndex === originalIndex) {
              return (
                <div key={`${rule.type}:${rule.pattern}:${originalIndex}`}>
                  <div
                    className="grid px-5 py-2 items-center bg-accent-muted border-l-[2px] border-l-accent"
                    style={{ gridTemplateColumns: "2fr 8fr 2fr" }}
                  >
                    <div>
                      <Select
                        ariaLabel="Rule type"
                        items={ruleTypeItemsFor(tiers, rule.type)}
                        value={editType}
                        onChange={(v) => {
                          setEditType(v as RuleType);
                          setEditIsDuplicate(false);
                        }}
                        className="w-full"
                      />
                    </div>
                    <div className="px-2">
                      <TextField
                        aria-label="Rule pattern"
                        value={editPattern}
                        onChange={(v) => {
                          setEditPattern(v);
                          setEditIsDuplicate(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(originalIndex);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        autoFocus
                      >
                        <Input className="w-full rounded-control bg-bg-field border border-border-control px-2 py-1 text-12 text-text-primary font-mono outline-none focus:border-focus-ring focus:ring-2 focus:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger" />
                      </TextField>
                    </div>
                    <div className="flex justify-end gap-1.5">
                      <Button
                        onPress={() => saveEdit(originalIndex)}
                        isDisabled={!editPattern.trim()}
                        className="text-11 px-2 py-1 rounded-control bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 text-on-accent font-medium outline-none not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        Save
                      </Button>
                      <Button
                        onPress={cancelEdit}
                        className="text-11 px-2 py-1 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                  {editIsDuplicate && (
                    <p className="px-5 pb-1.5 text-11 text-danger-text">Rule already exists</p>
                  )}
                </div>
              );
            }

            if (selection) {
              return (
                <Checkbox
                  key={`${rule.type}:${rule.pattern}:${originalIndex}`}
                  aria-label={`Select rule ${rule.pattern}`}
                  isSelected={isSelected}
                  onChange={() => selection.onToggleKey(selKey)}
                  className={`w-full grid px-5 py-2.5 items-center cursor-pointer outline-none transition-colors data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-focus-ring ${
                    isSelected ? "bg-accent-muted" : "hover:bg-bg-hover"
                  }`}
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  {({ isSelected: checked }) => (
                    <>
                      <div className="flex items-center">
                        <div
                          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                            checked
                              ? "bg-accent border-accent"
                              : "bg-bg-field border-border-control"
                          }`}
                        >
                          {checked && <Check size={12} className="text-on-accent" />}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <RuleTypeBadge type={rule.type} />
                      </div>
                      <div className="text-text-body truncate">{rule.pattern}</div>
                    </>
                  )}
                </Checkbox>
              );
            }

            return (
              <div
                key={`${rule.type}:${rule.pattern}:${originalIndex}`}
                className={`grid px-5 py-2.5 items-center transition-colors ${
                  isHighlighted ? "bg-accent-muted" : editable ? "hover:bg-bg-hover" : ""
                }`}
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div className="flex items-center gap-1">
                  {isHighlighted && (
                    <span className="text-accent-text font-mono text-11 leading-none select-none">
                      +
                    </span>
                  )}
                  <RuleTypeBadge type={rule.type} />
                  {!tiers.includes(rule.type) && (
                    <span className="text-11 text-text-secondary font-sans whitespace-nowrap">
                      not applied
                    </span>
                  )}
                </div>
                <div className="text-text-body truncate">{rule.pattern}</div>
                {editable && (
                  <div className="flex justify-end gap-2">
                    <Button
                      onPress={() => startEdit(originalIndex)}
                      isDisabled={editingIndex !== null}
                      className="text-11 text-text-secondary hover:text-text-primary outline-none disabled:opacity-40 transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      Edit
                    </Button>
                    <Button
                      onPress={() => onRemove?.(originalIndex)}
                      isDisabled={editingIndex !== null}
                      className="text-11 text-text-secondary hover:text-danger-text outline-none disabled:opacity-40 transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {showFooter && (
        <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-t border-border bg-bg-base">
          {/* Type filter pills */}
          <div className="flex items-center gap-1">
            {filterLabels.map(({ value, label, count }) => (
              <Button
                key={value}
                onPress={() => {
                  setTypeFilter(value);
                  setPage(1);
                }}
                className={`focus-visible:ring-2 focus-visible:ring-focus-ring px-2 py-0.5 text-11 rounded-control transition-colors outline-none ${
                  typeFilter === value
                    ? "bg-bg-pressed text-text-primary"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {label} ({count})
              </Button>
            ))}
          </div>

          {/* Pagination */}
          {paginate && totalPages > 1 && (
            <div className="flex items-center gap-1.5">
              <Button
                aria-label="Previous page"
                isDisabled={safePage <= 1}
                onPress={() => setPage((p) => Math.max(1, p - 1))}
                className="p-1 rounded-control text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-11 text-text-secondary tabular-nums min-w-[4rem] text-center">
                <span className="font-mono text-text-secondary">{safePage}</span>
                <span className="mx-1">/</span>
                <span className="font-mono">{totalPages}</span>
              </span>
              <Button
                aria-label="Next page"
                isDisabled={safePage >= totalPages}
                onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="p-1 rounded-control text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
