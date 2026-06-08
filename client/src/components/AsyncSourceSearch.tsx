import { useMemo, useRef, useState } from "react";
import { Button, Input, ListBox, ListBoxItem, Popover, SearchField } from "react-aria-components";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { Selection } from "react-aria-components";
import type { SourceCandidateItem, SourceSelectionEntry } from "@roubo/shared";
import { useSourceOptions, type SourceOptionCategory } from "../hooks/useSourceOptions";
import { entryExternalId } from "../lib/source-selection";

interface AsyncSourceSearchProps {
  projectId: string;
  category: SourceOptionCategory;
  // Visible category label, e.g. "Boards".
  label: string;
  // Parent (project) scope for board / filter / epic searches. Ignored by the
  // project category.
  scope?: { project?: string[] };
  // Project-first gate: when false the control is disabled and shows the hint.
  enabled?: boolean;
  disabledHint?: string;
  // Current persisted entries for this category.
  value: SourceSelectionEntry[];
  // Parent owns the mutation policy (project stamping, pruning), so the control
  // hands back a batch of picked items / removed ids to apply in one update
  // rather than a finished entry. Batching keeps a multi-item change (e.g. a
  // keyboard select-all) from clobbering itself through stale closures.
  onChange: (added: SourceCandidateItem[], removed: string[]) => void;
}

/**
 * Reconstruct a display item from a persisted entry, using the label/sublabel
 * captured at pick time when the object form carries them, so a reopened dialog
 * renders the source's name rather than its raw id without re-fetching.
 */
function entryToItem(entry: SourceSelectionEntry, id: string): SourceCandidateItem {
  if (typeof entry === "object" && typeof entry.label === "string" && entry.label.length > 0) {
    return { externalId: id, label: entry.label, sublabel: entry.sublabel };
  }
  return { externalId: id, label: id };
}

/**
 * Debounced async type-ahead for a single source category (WU-003, #352). The
 * results render inside a React Aria `Popover`, which portals to the document
 * body and so is never clipped by the configure modal (FR-013). Selecting a
 * result toggles its membership; results show the full untruncated name plus a
 * monospace `KEY · #id` secondary line (FR-011). Built on React Aria primitives
 * for keyboard navigation, visible focus, and screen-reader labels (NFR-002).
 */
export default function AsyncSourceSearch({
  projectId,
  category,
  label,
  scope,
  enabled = true,
  disabledHint,
  value,
  onChange,
}: AsyncSourceSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Clear the search term whenever the popover closes so a reopen starts clean.
  function setOpen(open: boolean) {
    setIsOpen(open);
    if (!open) setSearch("");
  }

  const { items, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error, durationMs } =
    useSourceOptions({ projectId, category, scope, search, enabled: enabled && isOpen });

  // Remember the items the user picks this session so the chips keep their full
  // labels after the result list changes or the popover closes (the search hook
  // stops returning results when closed). Updated only from the selection event.
  const [picked, setPicked] = useState<Map<string, SourceCandidateItem>>(new Map());

  const itemsById = useMemo(() => new Map(items.map((item) => [item.externalId, item])), [items]);
  const selectedIds = useMemo(() => new Set(value.map(entryExternalId)), [value]);

  function handleSelectionChange(selection: Selection) {
    // Select-all is purely additive over the loaded page; any other change is
    // the new selection set. Removals are scoped to the current page (off-page
    // entries are removed via their chip), so select-all never strands them.
    const nextIds =
      selection === "all"
        ? new Set([...selectedIds, ...items.map((i) => i.externalId)])
        : new Set(selection as Set<string>);
    const added = items.filter((i) => nextIds.has(i.externalId) && !selectedIds.has(i.externalId));
    const removed = items
      .filter((i) => !nextIds.has(i.externalId) && selectedIds.has(i.externalId))
      .map((i) => i.externalId);
    if (added.length === 0 && removed.length === 0) return;
    if (added.length > 0) {
      setPicked((prev) => {
        const next = new Map(prev);
        for (const item of added) next.set(item.externalId, item);
        return next;
      });
    }
    onChange(added, removed);
  }

  // Prefer the item picked this session, then a freshly loaded result, then the
  // label/sublabel persisted on the entry itself (so a reopened dialog shows the
  // name without a fetch), and only fall back to the bare id when none exist.
  const selectedItems = value.map((entry) => {
    const id = entryExternalId(entry);
    return picked.get(id) ?? itemsById.get(id) ?? entryToItem(entry, id);
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-stone-600 dark:text-stone-400">{label}</span>
        <Button
          ref={triggerRef}
          isDisabled={!enabled}
          onPress={() => setOpen(!isOpen)}
          aria-label={`Add ${label.toLowerCase()}`}
          aria-expanded={isOpen}
          className="flex items-center gap-1.5 rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-2.5 py-1.5 text-xs text-stone-700 dark:text-stone-300 transition-colors hover:border-stone-400 dark:hover:border-stone-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
        >
          <Search size={13} className="shrink-0 text-stone-400 dark:text-stone-600" />
          Search
          <ChevronDown size={13} className="shrink-0 text-stone-400 dark:text-stone-600" />
        </Button>
      </div>

      {!enabled && disabledHint && (
        <p className="text-[11px] text-stone-400 dark:text-stone-600">{disabledHint}</p>
      )}

      {enabled && selectedItems.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={`Selected ${label.toLowerCase()}`}>
          {selectedItems.map((item) => (
            <li
              key={item.externalId}
              className="flex items-center justify-between gap-2 rounded-lg bg-stone-100 dark:bg-stone-800/60 px-2.5 py-1.5"
            >
              <span className="min-w-0 flex flex-col">
                <span className="text-xs text-stone-800 dark:text-stone-200 break-words">
                  {item.label}
                </span>
                {item.sublabel && (
                  <span className="text-[10px] font-mono text-stone-400 dark:text-stone-600 break-words">
                    {item.sublabel}
                  </span>
                )}
              </span>
              <Button
                aria-label={`Remove ${item.label}`}
                onPress={() => onChange([], [item.externalId])}
                className="shrink-0 p-0.5 rounded text-stone-400 dark:text-stone-600 transition-colors hover:text-stone-600 dark:hover:text-stone-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <X size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Popover
        triggerRef={triggerRef}
        isOpen={isOpen}
        onOpenChange={setOpen}
        placement="bottom start"
        className="w-[var(--trigger-width)] min-w-72 rounded-lg bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 shadow-xl p-2 z-50 transition-opacity duration-150 data-[entering]:opacity-0"
      >
        <SearchField
          value={search}
          onChange={setSearch}
          autoFocus
          aria-label={`Search ${label.toLowerCase()}`}
          className="flex flex-col gap-1 mb-2"
        >
          <Input
            placeholder={`Search ${label.toLowerCase()}…`}
            className="w-full rounded-lg bg-stone-100 dark:bg-stone-900/60 border border-stone-300 dark:border-stone-700/50 px-3 py-1.5 text-sm text-stone-900 dark:text-stone-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          />
        </SearchField>

        <div className="max-h-60 overflow-auto">
          {error && (
            <p className="px-3 py-2 text-xs text-amber-600 dark:text-amber-500">
              Could not load results. Try again.
            </p>
          )}
          {!error && isLoading && (
            <p className="px-3 py-2 text-xs text-stone-400 dark:text-stone-600">Searching…</p>
          )}
          {!error && !isLoading && items.length === 0 && (
            <p className="px-3 py-2 text-xs text-stone-400 dark:text-stone-600">No matches.</p>
          )}
          {/* Always-present live region so the readout's first appearance and
              every later update announce reliably (NFR-002); empty until a page
              loads, with no padding so it adds no gap above the empty/loading
              messages. */}
          {!error && (
            <div
              role="status"
              aria-live="polite"
              className={
                items.length > 0
                  ? "flex items-baseline gap-1 px-3 pb-1 text-[11px] text-stone-400 dark:text-stone-600"
                  : "sr-only"
              }
            >
              {items.length > 0 && (
                <>
                  <span data-testid="source-search-result-count">
                    {items.length}
                    {hasNextPage ? "+" : ""} results
                  </span>
                  {durationMs != null && (
                    <span data-testid="source-search-latency">· {durationMs}ms</span>
                  )}
                </>
              )}
            </div>
          )}
          {!error && items.length > 0 && (
            <ListBox
              selectionMode="multiple"
              selectionBehavior="toggle"
              selectedKeys={selectedIds}
              onSelectionChange={handleSelectionChange}
              aria-label={`${label} results`}
              className="outline-none flex flex-col gap-0.5"
            >
              {items.map((item) => (
                <ListBoxItem
                  key={item.externalId}
                  id={item.externalId}
                  textValue={item.sublabel ? `${item.label}, ${item.sublabel}` : item.label}
                  className="flex items-start justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[focus-visible]:ring-2 data-[focus-visible]:ring-amber-500 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
                >
                  {({ isSelected }) => (
                    <>
                      <span className="min-w-0 flex flex-col">
                        <span className="break-words">{item.label}</span>
                        {item.sublabel && (
                          <span className="text-[10px] font-mono text-stone-400 dark:text-stone-600 break-words">
                            {item.sublabel}
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <Check
                          size={14}
                          className="mt-0.5 shrink-0 text-stone-500 dark:text-stone-400"
                        />
                      )}
                    </>
                  )}
                </ListBoxItem>
              ))}
            </ListBox>
          )}
          {!error && hasNextPage && (
            <Button
              onPress={() => fetchNextPage()}
              isDisabled={isFetchingNextPage}
              className="mt-1 w-full rounded-md px-3 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-500 outline-none transition-colors hover:bg-stone-100 dark:hover:bg-stone-700/50 focus-visible:ring-2 focus-visible:ring-amber-500 data-[disabled]:opacity-50"
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </Popover>
    </div>
  );
}
