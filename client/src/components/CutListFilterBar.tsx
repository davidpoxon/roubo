import { useMemo } from "react";
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
import type { FilterFacet, FilterFacetOption } from "@roubo/shared";
import type { FilterState } from "../lib/cut-list-filters";
import {
  activeFilterCount,
  createEmptyFilters,
  getFacetSelection,
  isFiltersEmpty,
  setFacetSelection,
} from "../lib/cut-list-filters";
import { useFacetOptions } from "../hooks/useCutListFacets";
import Spinner from "./Spinner";

export type { FilterState };

// CLI-FR-014 / FR-015 (#900): facets whose closed/archived values are
// dropped at the source (milestones and epics) carry a footer note in the
// filter popover explaining why those values never appear as options. The text
// is fixed per facet id and identical across plugins (github-com/ghe emit the
// "milestone" facet, jira-self-hosted the "epic" facet), so the note lives here
// as a client-side id-keyed map rather than a field on FilterFacet.
const SOURCE_EXCLUSION_NOTES: Record<string, string> = {
  milestone: "Closed / archived milestones are excluded at the source.",
  epic: "Closed / resolved epics are excluded at the source.",
};

interface CutListFilterBarProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  facets: FilterFacet[];
  projectId: string;
  pluginId: string | null;
  /**
   * Fallback option values keyed by facet id, derived from the currently
   * loaded cut list. Used to populate `enum` facets that ship no inline
   * options (typical for the COMMON_FACET_FALLBACK set returned to plugins
   * built against host-API 1.0.0).
   */
  derivedOptions: Record<string, string[]>;
}

export default function CutListFilterBar({
  filters,
  onFiltersChange,
  facets,
  projectId,
  pluginId,
  derivedOptions,
}: CutListFilterBarProps) {
  const count = activeFilterCount(filters);
  const hasFilters = !isFiltersEmpty(filters);
  const hasOptions = facets.length > 0;

  return (
    <div className="flex items-center gap-1.5 pl-3 pr-1 py-2">
      <TextField
        aria-label="Search cuts by title or number"
        value={filters.search}
        onChange={(value) => onFiltersChange({ ...filters, search: value })}
        className="flex-1 min-w-0"
      >
        <div className="relative flex items-center">
          <Search
            size={12}
            className="absolute left-2 text-text-secondary pointer-events-none shrink-0"
          />
          <Input
            placeholder="Search by title or #number…"
            className="w-full pl-6 pr-6 py-1 text-12 rounded-control bg-bg-field border border-border-control text-text-primary placeholder:text-text-secondary outline-none focus:border-focus-ring transition-colors focus:ring-2 focus:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
          />
          {filters.search && (
            <Button
              onPress={() => onFiltersChange({ ...filters, search: "" })}
              aria-label="Clear search"
              className="absolute right-1.5 text-text-secondary hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <X size={12} />
            </Button>
          )}
        </div>
      </TextField>

      {hasOptions && (
        <DialogTrigger>
          <Button
            aria-label={count > 0 ? `Filter cut list, ${count} active` : "Filter cut list"}
            className={[
              "focus-visible:ring-2 focus-visible:ring-focus-ring relative p-1.5 rounded-control transition-colors outline-none shrink-0",
              count > 0
                ? "bg-bg-pressed text-text-primary"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover",
            ].join(" ")}
          >
            <ListFilter size={14} />
            {count > 0 && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-accent text-11 leading-none font-bold text-on-accent flex items-center justify-center px-0.5"
              >
                {count}
              </span>
            )}
          </Button>
          <Popover placement="bottom end" offset={6} className="animate-rise-in">
            <Dialog className="outline-none">
              <div className="w-72 rounded-control bg-bg-surface border border-border shadow-elevation-0 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <span className="text-12 font-semibold text-text-primary">Filters</span>
                  {hasFilters && (
                    <Button
                      onPress={() => onFiltersChange(createEmptyFilters())}
                      className="text-11 text-text-secondary hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      Clear all
                    </Button>
                  )}
                </div>

                <div className="max-h-[320px] overflow-y-auto">
                  {facets.map((facet, idx) => (
                    <FacetSection
                      key={facet.id}
                      facet={facet}
                      filters={filters}
                      onFiltersChange={onFiltersChange}
                      projectId={projectId}
                      pluginId={pluginId}
                      derivedOptions={derivedOptions[facet.id] ?? []}
                      isLast={idx === facets.length - 1}
                    />
                  ))}
                </div>
              </div>
            </Dialog>
          </Popover>
        </DialogTrigger>
      )}
    </div>
  );
}

interface FacetSectionProps {
  facet: FilterFacet;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  projectId: string;
  pluginId: string | null;
  derivedOptions: string[];
  isLast: boolean;
}

function FacetSection({
  facet,
  filters,
  onFiltersChange,
  projectId,
  pluginId,
  derivedOptions,
  isLast,
}: FacetSectionProps) {
  // `enum-async` facets fetch their options via `getFacetOptions` as soon as
  // the popover renders this section. The panel also prefetches these on load
  // (see usePrefetchFacetOptions), so the query usually resolves instantly from
  // cache. Eager facets (`enum`/`multi-enum`) render their inline or derived
  // options immediately and never call `getFacetOptions`.
  const isAsync = facet.type === "enum-async";

  const asyncQuery = useFacetOptions(projectId, pluginId, facet.id, { enabled: isAsync });

  const selection = getFacetSelection(filters, facet.id);
  const multi = facet.type !== "enum";

  // Resolve the option universe for this facet. Precedence: inline options
  // from the plugin, then a lazy-fetched list, then options derived from
  // currently-loaded issues.
  const options = useMemo<FilterFacetOption[]>(() => {
    const fromInline = facet.options;
    const fromAsync = asyncQuery.data;
    const fromDerived = derivedOptions.map((v) => ({ value: v, label: v }));
    return fromInline ?? fromAsync ?? fromDerived;
  }, [facet.options, asyncQuery.data, derivedOptions]);

  const clearSelection = () => onFiltersChange(setFacetSelection(filters, facet.id, new Set()));

  const handleSelectionChange = (keys: Iterable<string | number>) => {
    const arr = [...keys].map(String);
    const next = multi ? new Set(arr) : new Set(arr.slice(-1));
    onFiltersChange(setFacetSelection(filters, facet.id, next));
  };

  const showEmpty = options.length === 0 && !asyncQuery.isLoading;

  // CLI-FR-014 / FR-015 (#900): show the source-exclusion note for facets
  // whose closed/archived values are dropped at the source, once the section has
  // settled (not while loading or after a load error).
  const sourceExclusionNote = SOURCE_EXCLUSION_NOTES[facet.id];
  const showSourceExclusionNote =
    sourceExclusionNote !== undefined && !asyncQuery.isLoading && !asyncQuery.isError;

  return (
    <div className={isLast ? "" : "border-b border-border"}>
      <div className="px-3 pt-2.5 pb-1 flex items-center justify-between">
        <span className="text-11 font-medium uppercase tracking-label text-text-secondary">
          {facet.label}
        </span>
        {selection.size > 0 && (
          <Button
            onPress={clearSelection}
            aria-label={`Clear ${facet.label} filter`}
            className="text-text-secondary hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <X size={12} />
          </Button>
        )}
      </div>

      {asyncQuery.isLoading && (
        <div className="px-3 py-3 flex items-center gap-2 text-11 text-text-secondary">
          <Spinner />
          <span>Loading…</span>
        </div>
      )}

      {asyncQuery.isError && (
        <div className="px-3 py-2 text-11 text-danger-text">
          Couldn’t load options. Try reopening the filter.
        </div>
      )}

      {options.length > 0 && (
        <ListBox
          aria-label={`Filter by ${facet.label}`}
          selectionMode={multi ? "multiple" : "single"}
          selectionBehavior="toggle"
          selectedKeys={selection}
          onSelectionChange={(keys) => handleSelectionChange(keys as Iterable<string | number>)}
          className="outline-none pb-1"
        >
          {options.map((opt) => (
            <ListBoxItem
              key={opt.value}
              id={opt.value}
              textValue={opt.label}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-13 text-text-body outline-none cursor-default transition-colors data-[hovered]:bg-bg-hover data-[focused]:bg-bg-hover data-[selected]:text-text-primary"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate">{opt.label}</span>
              </span>
              {selection.has(opt.value) && <Check size={14} className="text-accent shrink-0" />}
            </ListBoxItem>
          ))}
        </ListBox>
      )}

      {showEmpty && (
        <div className="px-3 py-2 text-11 text-text-secondary">No options available</div>
      )}

      {showSourceExclusionNote && (
        <div data-testid="source-exclusion-note" className="px-3 py-2 text-11 text-text-secondary">
          {sourceExclusionNote}
        </div>
      )}
    </div>
  );
}
