import { useMemo, useState } from "react";
import {
  Button,
  Input,
  ListBox,
  ListBoxItem,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  type Selection,
} from "react-aria-components";
import { Check, Filter, Folder, Grid3x3, Layout, Search, Crown, X } from "lucide-react";
import type {
  SourceCandidateCategory,
  SourceCandidateIcon,
  SourceCandidateItem,
  SourceCandidatesResponse,
  SourceSelection,
} from "@roubo/shared";

interface SourcePickerProps {
  response: SourceCandidatesResponse;
  value: SourceSelection;
  onChange: (next: SourceSelection) => void;
}

const MULTI_LIST_KEY = "items";

function iconFor(icon: SourceCandidateIcon | undefined) {
  switch (icon) {
    case "repo":
      return <Folder size={13} className="shrink-0 text-stone-400 dark:text-stone-500" />;
    case "project":
      return <Layout size={13} className="shrink-0 text-stone-400 dark:text-stone-500" />;
    case "board":
      return <Grid3x3 size={13} className="shrink-0 text-stone-400 dark:text-stone-500" />;
    case "epic":
      return <Crown size={13} className="shrink-0 text-stone-400 dark:text-stone-500" />;
    case "filter":
      return <Filter size={13} className="shrink-0 text-stone-400 dark:text-stone-500" />;
    default:
      return null;
  }
}

function filterItems(items: SourceCandidateItem[], query: string): SourceCandidateItem[] {
  if (!query.trim()) return items;
  const q = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      (item.sublabel && item.sublabel.toLowerCase().includes(q)),
  );
}

function setSelectionForKey(
  value: SourceSelection,
  key: string,
  next: Set<string>,
): SourceSelection {
  if (next.size === 0) {
    const { [key]: _removed, ...rest } = value;
    void _removed;
    return rest;
  }
  return { ...value, [key]: [...next] };
}

function selectionFromValue(value: SourceSelection, key: string): Set<string> {
  const arr = value[key];
  return arr ? new Set(arr) : new Set();
}

function selectionToKeys(selection: Selection, items: SourceCandidateItem[]): Set<string> {
  if (selection === "all") {
    return new Set(items.map((i) => i.externalId));
  }
  return new Set([...selection].map(String));
}

interface CandidateListProps {
  items: SourceCandidateItem[];
  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  ariaLabel: string;
}

function CandidateList({ items, selected, onSelectionChange, ariaLabel }: CandidateListProps) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => filterItems(items, search), [items, search]);

  return (
    <div className="flex flex-col gap-2">
      <TextField
        aria-label={`Search ${ariaLabel}`}
        value={search}
        onChange={setSearch}
        className="w-full"
      >
        <div className="relative flex items-center">
          <Search
            size={12}
            className="absolute left-2.5 text-stone-400 dark:text-stone-600 pointer-events-none shrink-0"
          />
          <Input
            type="search"
            placeholder="Search…"
            className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md bg-stone-100 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700/50 text-stone-700 dark:text-stone-300 placeholder:text-stone-400 dark:placeholder:text-stone-600 outline-none focus:border-amber-500 dark:focus:border-amber-500 focus:bg-white dark:focus:bg-stone-800 transition-colors"
          />
          {search && (
            <Button
              onPress={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-1.5 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors outline-none"
            >
              <X size={11} />
            </Button>
          )}
        </div>
      </TextField>

      <ListBox
        aria-label={ariaLabel}
        selectionMode="multiple"
        selectionBehavior="toggle"
        selectedKeys={selected}
        onSelectionChange={(s) => onSelectionChange(selectionToKeys(s, items))}
        className="outline-none max-h-64 overflow-y-auto rounded-md border border-stone-200 dark:border-stone-700/50 bg-white dark:bg-stone-900/40"
        renderEmptyState={() => (
          <p className="text-xs text-stone-400 dark:text-stone-600 px-3 py-4 text-center">
            {items.length === 0 ? "No candidates returned." : "No matches for that search."}
          </p>
        )}
      >
        {filtered.map((item) => (
          <ListBoxItem
            key={item.externalId}
            id={item.externalId}
            textValue={item.label}
            className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50 data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-amber-500 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100"
          >
            {({ isSelected }) => (
              <>
                <span className="flex items-center gap-2 min-w-0">
                  {iconFor(item.icon)}
                  <span className="flex flex-col min-w-0">
                    <span className="truncate">{item.label}</span>
                    {item.sublabel && (
                      <span className="truncate text-[11px] text-stone-400 dark:text-stone-600">
                        {item.sublabel}
                      </span>
                    )}
                  </span>
                </span>
                {isSelected && (
                  <Check
                    size={14}
                    className="text-amber-500 dark:text-amber-400 shrink-0"
                    aria-hidden
                  />
                )}
              </>
            )}
          </ListBoxItem>
        ))}
      </ListBox>
    </div>
  );
}

interface ChipProps {
  label: string;
  onRemove: () => void;
}

function Chip({ label, onRemove }: ChipProps) {
  return (
    <span className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md text-[11px] font-mono text-stone-700 dark:text-stone-300 bg-stone-100 dark:bg-stone-800/70 border border-stone-200/70 dark:border-stone-700/50">
      <span className="truncate max-w-[200px]">{label}</span>
      <Button
        onPress={onRemove}
        aria-label={`Remove ${label}`}
        className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500 rounded"
      >
        <X size={11} />
      </Button>
    </span>
  );
}

function MultiListVariant({
  response,
  value,
  onChange,
}: SourcePickerProps & { response: SourceCandidatesResponse & { items: SourceCandidateItem[] } }) {
  const items = useMemo(() => response.items ?? [], [response.items]);
  const selected = selectionFromValue(value, MULTI_LIST_KEY);
  const byId = useMemo(() => {
    const map = new Map<string, SourceCandidateItem>();
    for (const it of items) map.set(it.externalId, it);
    return map;
  }, [items]);

  const selectedList = [...selected]
    .map((id) => byId.get(id))
    .filter((it): it is SourceCandidateItem => !!it);

  const handleChange = (next: Set<string>) => {
    onChange(setSelectionForKey(value, MULTI_LIST_KEY, next));
  };

  return (
    <div className="flex flex-col gap-4">
      <CandidateList
        items={items}
        selected={selected}
        onSelectionChange={handleChange}
        ariaLabel="Source candidates"
      />
      <ChipStrip
        title={`Selected (${selectedList.length})`}
        chips={selectedList.map((it) => ({
          id: it.externalId,
          label: it.label,
          onRemove: () => {
            const next = new Set(selected);
            next.delete(it.externalId);
            handleChange(next);
          },
        }))}
      />
    </div>
  );
}

function CategorizedVariant({
  response,
  value,
  onChange,
}: SourcePickerProps & {
  response: SourceCandidatesResponse & { categories: SourceCandidateCategory[] };
}) {
  const categories = useMemo(() => response.categories ?? [], [response.categories]);
  const [activeId, setActiveId] = useState<string>(() => categories[0]?.id ?? "");

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const cat of categories) {
      out[cat.id] = value[cat.id]?.length ?? 0;
    }
    return out;
  }, [categories, value]);

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        selectedKey={activeId}
        onSelectionChange={(k) => setActiveId(String(k))}
        className="flex flex-col gap-3"
      >
        <TabList
          aria-label="Source categories"
          className="flex items-center gap-1 border-b border-stone-200 dark:border-stone-800"
        >
          {categories.map((cat) => (
            <Tab
              key={cat.id}
              id={cat.id}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-500 dark:text-stone-400 outline-none cursor-pointer border-b-2 border-transparent transition-colors data-[hovered]:text-stone-800 dark:data-[hovered]:text-stone-200 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100 data-[selected]:border-amber-500 data-[focus-visible]:ring-2 data-[focus-visible]:ring-amber-500/40 rounded-sm"
            >
              <span>{cat.label}</span>
              {counts[cat.id] > 0 && (
                <span
                  aria-label={`${counts[cat.id]} selected`}
                  className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                >
                  {counts[cat.id]}
                </span>
              )}
            </Tab>
          ))}
        </TabList>
        {categories.map((cat) => (
          <TabPanel key={cat.id} id={cat.id} className="outline-none">
            <CandidateList
              items={cat.items}
              selected={selectionFromValue(value, cat.id)}
              onSelectionChange={(next) => onChange(setSelectionForKey(value, cat.id, next))}
              ariaLabel={`${cat.label} candidates`}
            />
          </TabPanel>
        ))}
      </Tabs>

      <GroupedChipStrip categories={categories} value={value} onChange={onChange} />
    </div>
  );
}

interface ChipStripProps {
  title: string;
  chips: Array<{ id: string; label: string; onRemove: () => void }>;
}

function ChipStrip({ title, chips }: ChipStripProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
        {title}
      </span>
      {chips.length === 0 ? (
        <p className="text-xs text-stone-400 dark:text-stone-600">Nothing selected yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Chip key={chip.id} label={chip.label} onRemove={chip.onRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupedChipStrip({
  categories,
  value,
  onChange,
}: {
  categories: SourceCandidateCategory[];
  value: SourceSelection;
  onChange: (next: SourceSelection) => void;
}) {
  const groups = categories
    .map((cat) => {
      const byId = new Map(cat.items.map((it) => [it.externalId, it]));
      const selected = value[cat.id] ?? [];
      const chips = selected
        .map((id) => byId.get(id))
        .filter((it): it is SourceCandidateItem => !!it);
      return { cat, chips };
    })
    .filter((g) => g.chips.length > 0);

  if (groups.length === 0) {
    return <ChipStrip title="Selected (0)" chips={[]} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
        Selected
      </span>
      {groups.map(({ cat, chips }) => (
        <div key={cat.id} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400">
            {cat.label}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((it) => (
              <Chip
                key={it.externalId}
                label={it.label}
                onRemove={() => {
                  const current = new Set(value[cat.id] ?? []);
                  current.delete(it.externalId);
                  onChange(setSelectionForKey(value, cat.id, current));
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SourcePicker({ response, value, onChange }: SourcePickerProps) {
  if (response.shape === "multi-list") {
    const items = response.items ?? [];
    return <MultiListVariant response={{ ...response, items }} value={value} onChange={onChange} />;
  }
  const categories = response.categories ?? [];
  return (
    <CategorizedVariant response={{ ...response, categories }} value={value} onChange={onChange} />
  );
}
