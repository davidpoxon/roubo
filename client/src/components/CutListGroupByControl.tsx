import {
  DialogTrigger,
  Button,
  Popover,
  Dialog,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { Layers, Check } from "lucide-react";
import type { FilterFacet } from "@roubo/shared";
import type { GroupingState, GroupByDimension } from "../lib/cut-list-groups";
import { createEmptyGrouping, isGroupingActive } from "../lib/cut-list-groups";

export type { GroupingState };

interface CutListGroupByControlProps {
  grouping: GroupingState;
  onGroupingChange: (grouping: GroupingState) => void;
  /**
   * Facets exposed by the active plugin. Each becomes a group-by dimension
   * alongside the "None" sentinel, so grouping stays in lock-step with the
   * available filters (e.g. Milestone).
   */
  facets: FilterFacet[];
}

export default function CutListGroupByControl({
  grouping,
  onGroupingChange,
  facets,
}: CutListGroupByControlProps) {
  const dimensions: { id: GroupByDimension; label: string }[] = [
    { id: "none", label: "None" },
    ...facets.map((f) => ({ id: f.id, label: f.label })),
  ];
  const activeDimensionLabel = (groupBy: GroupByDimension): string =>
    dimensions.find((d) => d.id === groupBy)?.label ?? "";

  // Guard a persisted groupBy whose facet is no longer exposed (plugin switch):
  // treat it as inactive so we never render a dangling dimension label.
  const known = dimensions.some((d) => d.id === grouping.groupBy);
  const active = isGroupingActive(grouping) && known;
  const dimLabel = activeDimensionLabel(grouping.groupBy);

  return (
    <DialogTrigger>
      <Button
        aria-label={active ? `Group cut list by ${dimLabel}` : "Group cut list"}
        className={[
          "relative flex items-center gap-1 rounded-md transition-colors outline-none",
          active
            ? "px-1.5 py-1 text-amber-500 dark:text-amber-400 hover:bg-amber-500/10"
            : "p-1.5 text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50",
        ].join(" ")}
      >
        <Layers size={13} />
        {active && <span className="text-[11px] font-medium whitespace-nowrap">{dimLabel}</span>}
      </Button>
      <Popover placement="bottom end" offset={6}>
        <Dialog className="outline-none">
          <div className="w-52 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700/50 shadow-2xl overflow-hidden">
            {/* Popover header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-stone-200 dark:border-stone-800/60">
              <span className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                Group by
              </span>
              {active && (
                <Button
                  onPress={() => onGroupingChange(createEmptyGrouping())}
                  className="text-[11px] text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none"
                >
                  Clear
                </Button>
              )}
            </div>

            {/* Dimension list */}
            <ListBox
              aria-label="Group by dimension"
              selectionMode="single"
              selectionBehavior="toggle"
              selectedKeys={new Set([grouping.groupBy])}
              onSelectionChange={(keys) => {
                const arr = [...keys];
                const next = (
                  arr.length > 0 ? String(arr[arr.length - 1]) : "none"
                ) as GroupByDimension;
                onGroupingChange({ groupBy: next === grouping.groupBy ? "none" : next });
              }}
              className="outline-none py-1"
            >
              {dimensions.map((dim) => (
                <ListBoxItem
                  key={dim.id}
                  id={dim.id}
                  textValue={dim.label}
                  className="flex items-center justify-between px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
                >
                  {dim.label}
                  {grouping.groupBy === dim.id && (
                    <Check size={14} className="text-stone-500 dark:text-stone-400 shrink-0" />
                  )}
                </ListBoxItem>
              ))}
            </ListBox>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
