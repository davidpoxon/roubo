import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import type { SourceCandidateItem, SourceCandidatesResponse, SourceSelection } from "@roubo/shared";
import MultiSelect from "./MultiSelect";

/**
 * Host-rendered declarative source picker (FR-019). The active integration
 * plugin returns a shape descriptor from `listSourceCandidates`; this component
 * renders it. `multi-list` is one flat selector (GitHub.com / GHE repos +
 * Projects); `categorized-multi-list` is a tabbed selector (Jira Boards / Epics
 * / Filters). Plugins ship no React.
 *
 * The persisted `SourceSelection` (`Record<categoryId, entry[]>`) is the value;
 * the literal key `"items"` holds the multi-list selection. Entries are written
 * in their primitive (string externalId) form here, since this generic picker
 * carries no per-source toggles.
 */
interface SourcePickerProps {
  candidates: SourceCandidatesResponse;
  value: SourceSelection;
  onChange: (next: SourceSelection) => void;
}

const MULTI_LIST_KEY = "items";

export default function SourcePicker({ candidates, value, onChange }: SourcePickerProps) {
  if (candidates.shape === "multi-list") {
    const items = candidates.items ?? [];
    return (
      <div className="flex flex-col gap-2" data-testid="source-picker">
        <SectionLabel>Sources</SectionLabel>
        <MultiSelect
          items={toOptions(items)}
          selectedKeys={selectedSet(value, MULTI_LIST_KEY)}
          onChange={(keys) => onChange(withCategory(value, MULTI_LIST_KEY, keys))}
          placeholder="Select sources"
        />
      </div>
    );
  }

  if (candidates.shape === "searchable-categorized") {
    // The async type-ahead picker that consumes this shape arrives in a
    // follow-up slice (WU-003, #352). Until then, render a neutral notice
    // rather than an empty tab strip so the configure dialog stays coherent.
    return (
      <div className="flex flex-col gap-2" data-testid="source-picker">
        <SectionLabel>Sources</SectionLabel>
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Source selection for this integration is not available in this view yet.
        </p>
      </div>
    );
  }

  const categories = candidates.categories ?? [];
  return (
    <div className="flex flex-col gap-2" data-testid="source-picker">
      <SectionLabel>Sources</SectionLabel>
      <Tabs>
        <TabList
          aria-label="Source categories"
          className="flex gap-1 border-b border-stone-200 dark:border-stone-800 mb-3"
        >
          {categories.map((category) => {
            const count = selectedSet(value, category.id).size;
            return (
              <Tab
                key={category.id}
                id={category.id}
                className="px-3 py-1.5 text-xs font-medium text-stone-500 dark:text-stone-400 cursor-default outline-none border-b-2 border-transparent -mb-px transition-colors data-[hovered]:text-stone-700 dark:data-[hovered]:text-stone-200 data-[selected]:text-stone-900 dark:data-[selected]:text-stone-100 data-[selected]:border-amber-500 data-[focus-visible]:ring-2 data-[focus-visible]:ring-amber-500 rounded-t"
              >
                {category.label}
                {count > 0 && (
                  <span className="ml-1.5 text-[10px] font-semibold text-amber-600 dark:text-amber-500">
                    {count}
                  </span>
                )}
              </Tab>
            );
          })}
        </TabList>
        {categories.map((category) => (
          <TabPanel key={category.id} id={category.id} className="outline-none">
            <MultiSelect
              items={toOptions(category.items)}
              selectedKeys={selectedSet(value, category.id)}
              onChange={(keys) => onChange(withCategory(value, category.id, keys))}
              placeholder={`Select ${category.label.toLowerCase()}`}
            />
          </TabPanel>
        ))}
      </Tabs>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
      {children}
    </span>
  );
}

function toOptions(items: SourceCandidateItem[]): { value: string; label: string }[] {
  return items.map((item) => ({
    value: item.externalId,
    label: item.sublabel ? `${item.label} · ${item.sublabel}` : item.label,
  }));
}

function selectedSet(value: SourceSelection, key: string): Set<string> {
  const entries = value[key] ?? [];
  return new Set(entries.map(entryExternalId));
}

function entryExternalId(entry: SourceSelection[string][number]): string {
  return typeof entry === "object" ? entry.externalId : String(entry);
}

function withCategory(value: SourceSelection, key: string, keys: Set<string>): SourceSelection {
  if (keys.size === 0) {
    // Drop the category entirely when nothing is selected (rebuild rather than
    // `delete` so the no-dynamic-delete lint rule stays satisfied).
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
  }
  return { ...value, [key]: Array.from(keys) };
}
