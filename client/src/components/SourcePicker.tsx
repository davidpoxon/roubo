import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import type {
  SearchableSourceCategory,
  SourceCandidateItem,
  SourceCandidatesResponse,
  SourceSelection,
  SourceSelectionEntry,
} from "@roubo/shared";
import MultiSelect from "./MultiSelect";
import AsyncSourceSearch from "./AsyncSourceSearch";
import type { SourceOptionCategory } from "../hooks/useSourceOptions";
import { entryExternalId } from "../lib/source-selection";

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
  // Required by the `searchable-categorized` shape, which fetches options
  // through the project-scoped `getSourceOptions` route.
  projectId?: string;
}

const MULTI_LIST_KEY = "items";

export default function SourcePicker({
  candidates,
  value,
  onChange,
  projectId,
}: SourcePickerProps) {
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
    return (
      <div className="flex flex-col gap-3" data-testid="source-picker">
        <SectionLabel>Sources</SectionLabel>
        <SearchableSourcePicker
          categories={candidates.searchableCategories ?? []}
          value={value}
          onChange={onChange}
          projectId={projectId}
        />
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

/**
 * The `searchable-categorized` arm (WU-003, #352): a project-first cascade. The
 * project type-ahead is always enabled; the board / filter / epic controls are
 * gated until at least one project is in scope. Removing a project prunes the
 * board / filter / epic sources scoped to it. The synthetic `mine` category is
 * not yet rendered (its JQL resolution lands in WU-004, #353).
 */
function SearchableSourcePicker({
  categories,
  value,
  onChange,
  projectId,
}: {
  categories: SearchableSourceCategory[];
  value: SourceSelection;
  onChange: (next: SourceSelection) => void;
  projectId?: string;
}) {
  if (!projectId) {
    return (
      <p className="text-xs text-amber-600 dark:text-amber-500">
        Connect the integration to configure sources.
      </p>
    );
  }

  const projectKeys = (value.project ?? []).map(entryExternalId);
  const scope = { project: projectKeys };

  // Apply a batch of additions / removals for the project scope in one update.
  // Removing a project also prunes every board / filter / epic source scoped to
  // it (FR-001 / TC-039), rebuilding the record without empty categories.
  function changeProjects(added: SourceCandidateItem[], removed: string[]) {
    let projects = (value.project ?? []).filter((e) => !removed.includes(entryExternalId(e)));
    for (const item of added) {
      if (!projects.some((e) => entryExternalId(e) === item.externalId)) {
        // Project entries carry just the key; the cascade derives scope from them.
        projects = [...projects, item.externalId];
      }
    }
    const next: SourceSelection = {};
    for (const [cat, entries] of Object.entries(value)) {
      if (cat === "project") continue;
      const kept = entries.filter(
        (e) => !(typeof e === "object" && e.project !== undefined && removed.includes(e.project)),
      );
      if (kept.length > 0) next[cat] = kept;
    }
    if (projects.length > 0) next.project = projects;
    onChange(next);
  }

  // Apply a batch for a scoped category (board / filter / epic) in one update,
  // stamping each newly-added entry with the project it was found under so it
  // can be pruned when that project leaves scope.
  function changeScoped(category: string, added: SourceCandidateItem[], removed: string[]) {
    let entries = (value[category] ?? []).filter((e) => !removed.includes(entryExternalId(e)));
    for (const item of added) {
      if (entries.some((e) => entryExternalId(e) === item.externalId)) continue;
      const project = attributeProject(item, projectKeys);
      entries = [
        ...entries,
        project ? { externalId: item.externalId, project } : { externalId: item.externalId },
      ];
    }
    onChange(setCategoryEntries(value, category, entries));
  }

  return (
    <div className="flex flex-col gap-4">
      {categories
        .filter((category) => isScopedSearchCategory(category))
        .map((category) => {
          const isProject = category.id === "project";
          const enabled = isProject || projectKeys.length > 0;
          return (
            <AsyncSourceSearch
              key={category.id}
              projectId={projectId}
              category={category.id as SourceOptionCategory}
              label={category.label}
              scope={isProject ? undefined : scope}
              enabled={enabled}
              disabledHint={enabled ? undefined : "Pick a project first."}
              value={value[category.id] ?? []}
              onChange={(added, removed) =>
                isProject
                  ? changeProjects(added, removed)
                  : changeScoped(category.id, added, removed)
              }
            />
          );
        })}
    </div>
  );
}

// The searchable picker renders only the live-search categories. The synthetic
// `mine` category (declared with `options`, no `getSourceOptions` backing) is
// deferred to WU-004 (#353).
function isScopedSearchCategory(category: SearchableSourceCategory): boolean {
  return (
    category.id === "project" ||
    category.id === "board" ||
    category.id === "filter" ||
    category.id === "epic"
  );
}

/**
 * Attribute a picked board / filter / epic to one of the scoped projects so it
 * can be pruned when that project leaves scope. With a single project in scope
 * the answer is unambiguous; with several, prefer a project key the item itself
 * references (epic key prefix, board sublabel). When nothing matches (filters
 * carry no project key) leave it unset rather than guessing, so the source is
 * never pruned by a project it has nothing to do with.
 */
function attributeProject(item: SourceCandidateItem, projectKeys: string[]): string | undefined {
  if (projectKeys.length === 0) return undefined;
  if (projectKeys.length === 1) return projectKeys[0];
  const haystack = `${item.externalId} ${item.sublabel ?? ""}`.toUpperCase();
  return projectKeys.find((key) =>
    new RegExp(`\\b${escapeRegExp(key.toUpperCase())}\\b`).test(haystack),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setCategoryEntries(
  value: SourceSelection,
  key: string,
  entries: SourceSelectionEntry[],
): SourceSelection {
  if (entries.length === 0) {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
  }
  return { ...value, [key]: entries };
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

function withCategory(value: SourceSelection, key: string, keys: Set<string>): SourceSelection {
  if (keys.size === 0) {
    // Drop the category entirely when nothing is selected (rebuild rather than
    // `delete` so the no-dynamic-delete lint rule stays satisfied).
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
  }
  return { ...value, [key]: Array.from(keys) };
}
