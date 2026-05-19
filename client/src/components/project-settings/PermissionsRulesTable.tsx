import { useState, useMemo } from "react";
import { Button, Checkbox, TextField, Input } from "react-aria-components";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import Select from "../Select";
import type { ProjectPermissions } from "@roubo/shared";
import type { RuleType, PermissionRule } from "./permissionTypes";
import { ruleKey } from "./permissionsDiff";

export type { RuleType, PermissionRule } from "./permissionTypes";

export function flattenPermissions(permissions: ProjectPermissions): PermissionRule[] {
  return [
    ...permissions.allow.map((p) => ({
      type: "allow" as RuleType,
      pattern: p,
    })),
    ...permissions.deny.map((p) => ({ type: "deny" as RuleType, pattern: p })),
    ...(permissions.ask ?? []).map((p) => ({
      type: "ask" as RuleType,
      pattern: p,
    })),
  ];
}

export const RULE_TYPE_ITEMS = [
  { value: "allow", label: "allow" },
  { value: "deny", label: "deny" },
  { value: "ask", label: "ask" },
];

function RuleTypeBadge({ type }: { type: RuleType }) {
  const styles: Record<RuleType, string> = {
    allow:
      "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800/40",
    deny: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800/40",
    ask: "bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 border border-stone-300 dark:border-stone-700",
  };
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] ${styles[type]}`}>{type}</span>
  );
}

export interface SelectionState {
  selectedKeys: Set<string>;
  onToggleKey: (key: string) => void;
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

  const filterLabels: Array<{
    value: RuleType | "all";
    label: string;
    count: number;
  }> = [
    { value: "all", label: "All", count: counts.all },
    { value: "allow", label: "allow", count: counts.allow },
    { value: "deny", label: "deny", count: counts.deny },
    { value: "ask", label: "ask", count: counts.ask },
  ];

  const gridTemplate = (() => {
    if (selection) return "36px 2fr 10fr";
    return editable ? "2fr 8fr 2fr" : "2fr 10fr";
  })();

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-800/80 bg-stone-50 dark:bg-stone-900/30 overflow-hidden">
      <div
        className="grid text-[10px] uppercase tracking-wider text-stone-500 px-5 py-2.5 border-b border-stone-200 dark:border-stone-800/60 bg-stone-100 dark:bg-stone-900/60"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {selection && <div />}
        <div>Rule</div>
        <div>Pattern</div>
        {editable && <div className="text-right">Actions</div>}
      </div>

      <div className="divide-y divide-stone-200 dark:divide-stone-800/60 font-mono text-[12px]">
        {rules.length === 0 ? (
          <div className="px-5 py-4 text-stone-500 text-[12px]">{emptyMessage}</div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-4 text-stone-500 text-[12px]">No rules match this filter.</div>
        ) : (
          pageItems.map(({ rule, originalIndex }) => {
            const selKey = ruleKey(rule);
            const isSelected = selection?.selectedKeys.has(selKey) ?? false;
            const isHighlighted = highlightKeys?.has(selKey) ?? false;

            if (editable && editingIndex === originalIndex) {
              return (
                <div key={`${rule.type}:${rule.pattern}:${originalIndex}`}>
                  <div
                    className="grid px-5 py-2 items-center bg-amber-500/5 border-l-[2px] border-l-amber-500"
                    style={{ gridTemplateColumns: "2fr 8fr 2fr" }}
                  >
                    <div>
                      <Select
                        items={RULE_TYPE_ITEMS}
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
                        <Input className="w-full rounded-md bg-white dark:bg-stone-950/80 border border-stone-300 dark:border-stone-600 px-2 py-1 text-[12px] text-stone-900 dark:text-stone-200 font-mono focus:outline-none focus:border-stone-500" />
                      </TextField>
                    </div>
                    <div className="flex justify-end gap-1.5">
                      <Button
                        onPress={() => saveEdit(originalIndex)}
                        isDisabled={!editPattern.trim()}
                        className="text-[11px] px-2 py-1 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-stone-950 font-medium outline-none"
                      >
                        Save
                      </Button>
                      <Button
                        onPress={cancelEdit}
                        className="text-[11px] px-2 py-1 rounded border border-stone-300 dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 outline-none"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                  {editIsDuplicate && (
                    <p className="px-5 pb-1.5 text-[11px] text-red-500 dark:text-red-400">
                      Rule already exists
                    </p>
                  )}
                </div>
              );
            }

            if (selection) {
              return (
                <Checkbox
                  key={`${rule.type}:${rule.pattern}:${originalIndex}`}
                  isSelected={isSelected}
                  onChange={() => selection.onToggleKey(selKey)}
                  className={`w-full grid px-5 py-2.5 items-center cursor-pointer outline-none transition-colors data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-amber-400 ${
                    isSelected
                      ? "bg-amber-500/5 dark:bg-amber-500/8"
                      : "hover:bg-stone-100 dark:hover:bg-stone-900/40"
                  }`}
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  {({ isSelected: checked }) => (
                    <>
                      <div className="flex items-center">
                        <div
                          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                            checked
                              ? "bg-amber-500 border-amber-500"
                              : "bg-stone-100 dark:bg-stone-800 border-stone-300 dark:border-stone-600"
                          }`}
                        >
                          {checked && <Check size={10} className="text-stone-950" />}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <RuleTypeBadge type={rule.type} />
                      </div>
                      <div className="text-stone-700 dark:text-stone-200 truncate">
                        {rule.pattern}
                      </div>
                    </>
                  )}
                </Checkbox>
              );
            }

            return (
              <div
                key={`${rule.type}:${rule.pattern}:${originalIndex}`}
                className={`grid px-5 py-2.5 items-center transition-colors ${
                  isHighlighted
                    ? "bg-amber-500/5 dark:bg-amber-500/[0.08]"
                    : editable
                      ? "hover:bg-stone-100 dark:hover:bg-stone-900/40"
                      : ""
                }`}
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div className="flex items-center gap-1">
                  {isHighlighted && (
                    <span className="text-amber-500 font-mono text-[10px] leading-none select-none">
                      +
                    </span>
                  )}
                  <RuleTypeBadge type={rule.type} />
                </div>
                <div className="text-stone-700 dark:text-stone-200 truncate">{rule.pattern}</div>
                {editable && (
                  <div className="flex justify-end gap-2">
                    <Button
                      onPress={() => startEdit(originalIndex)}
                      isDisabled={editingIndex !== null}
                      className="text-[11px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-200 outline-none disabled:opacity-40 transition-colors"
                    >
                      Edit
                    </Button>
                    <Button
                      onPress={() => onRemove?.(originalIndex)}
                      isDisabled={editingIndex !== null}
                      className="text-[11px] text-stone-500 hover:text-red-600 dark:hover:text-red-400 outline-none disabled:opacity-40 transition-colors"
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
        <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-t border-stone-200 dark:border-stone-800/60 bg-stone-50/60 dark:bg-stone-900/40">
          {/* Type filter pills */}
          <div className="flex items-center gap-1">
            {filterLabels.map(({ value, label, count }) => (
              <Button
                key={value}
                onPress={() => {
                  setTypeFilter(value);
                  setPage(1);
                }}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors outline-none ${
                  typeFilter === value
                    ? "bg-stone-200 dark:bg-stone-700 text-stone-800 dark:text-stone-200"
                    : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
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
                className="p-1 rounded text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 disabled:opacity-30 transition-colors outline-none"
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-[11px] text-stone-500 tabular-nums min-w-[4rem] text-center">
                <span className="font-mono text-stone-600 dark:text-stone-400">{safePage}</span>
                <span className="mx-1">/</span>
                <span className="font-mono">{totalPages}</span>
              </span>
              <Button
                aria-label="Next page"
                isDisabled={safePage >= totalPages}
                onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="p-1 rounded text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 disabled:opacity-30 transition-colors outline-none"
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
