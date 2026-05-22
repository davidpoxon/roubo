import {
  DialogTrigger,
  Button,
  Popover,
  Dialog,
  ListBox,
  ListBoxItem,
  TextField,
  Input,
} from "react-aria-components";
import { ListFilter, X, Check, Search } from "lucide-react";
import type { FilterState } from "../lib/cut-list-filters";
import { activeFilterCount, createEmptyFilters, isFiltersEmpty } from "../lib/cut-list-filters";

export type { FilterState };

interface CutListFilterBarProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  availableTypes: string[];
  availableLabels: string[];
}

export default function CutListFilterBar({
  filters,
  onFiltersChange,
  availableTypes,
  availableLabels,
}: CutListFilterBarProps) {
  const count = activeFilterCount(filters);
  const hasFilters = !isFiltersEmpty(filters);
  const hasOptions = availableTypes.length > 0 || availableLabels.length > 0;

  return (
    <div className="flex items-center gap-1.5 px-3 py-2">
      {/* Search input */}
      <TextField
        aria-label="Search cuts by title or number"
        value={filters.search}
        onChange={(value) => onFiltersChange({ ...filters, search: value })}
        className="flex-1 min-w-0"
      >
        <div className="relative flex items-center">
          <Search
            size={11}
            className="absolute left-2 text-stone-400 dark:text-stone-600 pointer-events-none shrink-0"
          />
          <Input
            placeholder="Search by title or #number…"
            className="w-full pl-6 pr-6 py-1 text-xs rounded-md bg-stone-100 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700/50 text-stone-700 dark:text-stone-300 placeholder:text-stone-400 dark:placeholder:text-stone-600 outline-none focus:border-amber-500 dark:focus:border-amber-500 focus:bg-white dark:focus:bg-stone-800 transition-colors"
          />
          {filters.search && (
            <Button
              onPress={() => onFiltersChange({ ...filters, search: "" })}
              aria-label="Clear search"
              className="absolute right-1.5 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none"
            >
              <X size={10} />
            </Button>
          )}
        </div>
      </TextField>

      {/* Filter popover trigger — only when structured filters exist */}
      {hasOptions && (
        <DialogTrigger>
          <Button
            aria-label={count > 0 ? `Filter cut list, ${count} active` : "Filter cut list"}
            className={[
              "relative p-1.5 rounded-md transition-colors outline-none shrink-0",
              count > 0
                ? "text-amber-500 dark:text-amber-400 hover:bg-amber-500/10"
                : "text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50",
            ].join(" ")}
          >
            <ListFilter size={13} />
            {count > 0 && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-amber-500 text-[9px] font-bold text-white flex items-center justify-center px-0.5"
              >
                {count}
              </span>
            )}
          </Button>
          <Popover placement="bottom end" offset={6}>
            <Dialog className="outline-none">
              <div className="w-72 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700/50 shadow-2xl overflow-hidden">
                {/* Popover header */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-stone-200 dark:border-stone-800/60">
                  <span className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                    Filters
                  </span>
                  {hasFilters && (
                    <Button
                      onPress={() => onFiltersChange(createEmptyFilters())}
                      className="text-[11px] text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none"
                    >
                      Clear all
                    </Button>
                  )}
                </div>

                {/* Filter sections */}
                <div className="max-h-[320px] overflow-y-auto">
                  {/* Type */}
                  {availableTypes.length > 0 && (
                    <div
                      className={
                        availableLabels.length > 0
                          ? "border-b border-stone-100 dark:border-stone-800/40"
                          : ""
                      }
                    >
                      <div className="px-3 pt-2.5 pb-1 flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                          Type
                        </span>
                        {filters.type && (
                          <Button
                            onPress={() => onFiltersChange({ ...filters, type: "" })}
                            aria-label="Clear type filter"
                            className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none"
                          >
                            <X size={10} />
                          </Button>
                        )}
                      </div>
                      <ListBox
                        aria-label="Filter by type"
                        selectionMode="single"
                        selectionBehavior="toggle"
                        selectedKeys={filters.type ? new Set([filters.type]) : new Set<string>()}
                        onSelectionChange={(keys) => {
                          const arr = [...keys];
                          onFiltersChange({
                            ...filters,
                            type: arr.length > 0 ? String(arr[arr.length - 1]) : "",
                          });
                        }}
                        className="outline-none pb-1"
                      >
                        {availableTypes.map((t) => (
                          <ListBoxItem
                            key={t}
                            id={t}
                            textValue={t}
                            className="flex items-center justify-between px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
                          >
                            {t}
                            {filters.type === t && (
                              <Check
                                size={14}
                                className="text-stone-500 dark:text-stone-400 shrink-0"
                              />
                            )}
                          </ListBoxItem>
                        ))}
                      </ListBox>
                    </div>
                  )}

                  {/* Labels */}
                  {availableLabels.length > 0 && (
                    <div>
                      <div className="px-3 pt-2.5 pb-1 flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                          Labels
                        </span>
                        {filters.labels.size > 0 && (
                          <Button
                            onPress={() => onFiltersChange({ ...filters, labels: new Set() })}
                            aria-label="Clear labels filter"
                            className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none"
                          >
                            <X size={10} />
                          </Button>
                        )}
                      </div>
                      <ListBox
                        aria-label="Filter by labels"
                        selectionMode="multiple"
                        selectionBehavior="toggle"
                        selectedKeys={filters.labels}
                        onSelectionChange={(keys) => {
                          onFiltersChange({ ...filters, labels: new Set([...keys].map(String)) });
                        }}
                        className="outline-none pb-1"
                      >
                        {availableLabels.map((l) => (
                          <ListBoxItem
                            key={l}
                            id={l}
                            textValue={l}
                            className="flex items-center justify-between px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
                          >
                            {l}
                            {filters.labels.has(l) && (
                              <Check
                                size={14}
                                className="text-stone-500 dark:text-stone-400 shrink-0"
                              />
                            )}
                          </ListBoxItem>
                        ))}
                      </ListBox>
                    </div>
                  )}
                </div>
              </div>
            </Dialog>
          </Popover>
        </DialogTrigger>
      )}
    </div>
  );
}
