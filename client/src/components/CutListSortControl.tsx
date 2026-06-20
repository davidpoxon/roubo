import {
  DialogTrigger,
  Button,
  Popover,
  Dialog,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { ArrowDownUp, ArrowUp, ArrowDown, Check } from "lucide-react";
import type { SortField } from "@roubo/shared";

/** The active sort selection, or null for the plugin's natural order (CLI-FR-010). */
export interface SortSelection {
  sortBy: string;
  sortDir: "asc" | "desc";
}

interface CutListSortControlProps {
  /** Sort fields declared by the active plugin (CLI-FR-009). */
  fields: SortField[];
  /** The current selection, or null when no sort is active (natural order). */
  selection: SortSelection | null;
  onSelectionChange: (selection: SortSelection | null) => void;
}

/**
 * Host-rendered cut-list sort picker (CLI-FR-009/CLI-FR-010). Populated from the
 * active plugin's declared sort fields; selecting a field applies its
 * `defaultDir` first, and re-selecting the active field toggles the direction.
 * Returns null (renders nothing) when the plugin declares no sort fields, so no
 * picker appears (CLI-FR-011). Built on React Aria Components for full WCAG 2.1
 * AA keyboard / label / focus support (CLI-NFR-007).
 */
export default function CutListSortControl({
  fields,
  selection,
  onSelectionChange,
}: CutListSortControlProps) {
  // No declared fields => no picker (CLI-FR-011).
  if (fields.length === 0) return null;

  const active = selection !== null && fields.some((f) => f.id === selection.sortBy);
  const activeField = active ? fields.find((f) => f.id === selection?.sortBy) : undefined;
  const activeLabel = activeField?.label ?? "";
  const activeDir = selection?.sortDir ?? "asc";

  const onSelect = (fieldId: string): void => {
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;
    if (selection && selection.sortBy === fieldId) {
      // Re-selecting the active field toggles its direction.
      onSelectionChange({ sortBy: fieldId, sortDir: selection.sortDir === "asc" ? "desc" : "asc" });
      return;
    }
    onSelectionChange({ sortBy: fieldId, sortDir: field.defaultDir });
  };

  return (
    <DialogTrigger>
      <Button
        aria-label={
          active ? `Sort cut list by ${activeLabel}, ${activeDir}ending` : "Sort cut list"
        }
        className={[
          "relative flex items-center gap-1 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500",
          active
            ? "px-1.5 py-1 text-amber-500 dark:text-amber-400 hover:bg-amber-500/10"
            : "p-1.5 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50",
        ].join(" ")}
      >
        <ArrowDownUp size={13} />
        {active && (
          <span className="flex items-center gap-0.5 text-[11px] font-medium whitespace-nowrap">
            {activeLabel}
            {activeDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
          </span>
        )}
      </Button>
      <Popover placement="bottom end" offset={6}>
        <Dialog className="outline-none">
          <div className="w-52 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700/50 shadow-2xl overflow-hidden">
            {/* Popover header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-stone-200 dark:border-stone-800/60">
              <span className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                Sort by
              </span>
              {active && (
                <Button
                  onPress={() => onSelectionChange(null)}
                  className="text-[11px] text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
                >
                  Clear
                </Button>
              )}
            </div>

            {/* Sort-field list */}
            <ListBox
              aria-label="Sort field"
              selectionMode="single"
              selectionBehavior="toggle"
              selectedKeys={active && selection ? new Set([selection.sortBy]) : new Set()}
              onSelectionChange={(keys) => {
                const arr = [...keys];
                // Re-selecting the currently-active option clears the toggle
                // selection (React Aria emits an empty set). Treat that as a
                // direction toggle on the active field rather than a no-op, so
                // a second click flips asc <-> desc (CLI-FR-010).
                if (arr.length === 0) {
                  if (selection) onSelect(selection.sortBy);
                  return;
                }
                onSelect(String(arr[arr.length - 1]));
              }}
              className="outline-none py-1"
            >
              {fields.map((field) => {
                const isActive = selection?.sortBy === field.id;
                return (
                  <ListBoxItem
                    key={field.id}
                    id={field.id}
                    textValue={field.label}
                    className="flex items-center justify-between px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
                  >
                    {field.label}
                    {isActive &&
                      (selection?.sortDir === "asc" ? (
                        <ArrowUp
                          size={14}
                          className="text-stone-500 dark:text-stone-400 shrink-0"
                        />
                      ) : (
                        <ArrowDown
                          size={14}
                          className="text-stone-500 dark:text-stone-400 shrink-0"
                        />
                      ))}
                    {!isActive && (
                      <Check
                        size={14}
                        className="text-stone-500 dark:text-stone-400 shrink-0 opacity-0"
                      />
                    )}
                  </ListBoxItem>
                );
              })}
            </ListBox>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
