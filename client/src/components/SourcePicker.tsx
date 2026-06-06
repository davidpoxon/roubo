import { Radio, RadioGroup, Switch, Tab, TabList, TabPanel, Tabs } from "react-aria-components";
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
 * rendered by `MineSourceControl` (no `getSourceOptions` backing; #396).
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

  // Clean-break detection (WU-006, #355): a persisted source set whose keys are
  // all legacy old-shape categories (e.g. `boards`/`epics`/`filters` from the
  // retired flat-tab picker) no longer translates host-side, so it would silently
  // yield an empty cut list. When the config has source keys but none survive the
  // plugin's currently-declared categories, prompt the user to re-pick rather than
  // honoring the stale shape. No migration is attempted.
  const validCategoryIds = new Set<string>(categories.map((category) => category.id));
  const persistedKeys = Object.keys(value);
  const isStaleConfig =
    persistedKeys.length > 0 && persistedKeys.every((key) => !validCategoryIds.has(key));

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
      let kept = entries.filter(
        (e) => !(typeof e === "object" && e.project !== undefined && removed.includes(e.project)),
      );
      // An in-project mine source has no scope left once the last project
      // leaves, so drop it (an anywhere mine carries no project dependency and
      // survives). Boards / filters / epics are already pruned above by their
      // stamped project (TC-039).
      if (cat === "mine" && projects.length === 0) {
        kept = kept.filter((e) => !(typeof e === "object" && e.mineScope === "in-project"));
      }
      if (kept.length > 0) next[cat] = kept;
    }
    if (projects.length > 0) next.project = projects;
    onChange(next);
  }

  // The synthetic `mine` source is a single collective entry: toggling the
  // control on writes `{ externalId: "mine", mineScope }` (no project key — its
  // in-project scope is derived from the project sources at resolution time),
  // and toggling it off drops the category.
  function changeMine(entry: SourceSelectionEntry | null) {
    onChange(setCategoryEntries(value, "mine", entry ? [entry] : []));
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

  const mineCategory = categories.find((category) => category.id === "mine");

  return (
    <div className="flex flex-col gap-4">
      {isStaleConfig && (
        <p
          className="text-xs text-amber-600 dark:text-amber-500"
          role="status"
          data-testid="stale-sources-notice"
        >
          Your saved sources use the old format and can no longer be used. Re-pick your sources
          below.
        </p>
      )}
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
      {mineCategory && (
        <MineSourceControl
          category={mineCategory}
          value={value.mine ?? []}
          hasProjects={projectKeys.length > 0}
          onChange={changeMine}
        />
      )}
    </div>
  );
}

// The async type-ahead loop renders only the live-search categories. The
// synthetic `mine` category (declared with `options`, no `getSourceOptions`
// backing) is rendered separately by `MineSourceControl`.
function isScopedSearchCategory(category: SearchableSourceCategory): boolean {
  return (
    category.id === "project" ||
    category.id === "board" ||
    category.id === "filter" ||
    category.id === "epic"
  );
}

type MineScope = "in-project" | "anywhere";

/**
 * The synthetic "Assigned to me" (`mine`) control. Unlike the other categories
 * it has no `getSourceOptions` backing: it persists a single sentinel entry
 * `{ externalId: "mine", mineScope }`. A Switch toggles inclusion; a segmented
 * RadioGroup picks the mode. The `in-project` mode needs a project in scope, so
 * it is gated (disabled with a hint) until one exists; enabling the source with
 * no project in scope defaults to `anywhere`. Built on React Aria primitives for
 * keyboard navigation, visible focus, and screen-reader labels (WCAG 2.1 AA).
 */
function MineSourceControl({
  category,
  value,
  hasProjects,
  onChange,
}: {
  category: SearchableSourceCategory;
  value: SourceSelectionEntry[];
  hasProjects: boolean;
  onChange: (entry: SourceSelectionEntry | null) => void;
}) {
  const entry = value[0];
  const enabled = typeof entry === "object";
  const mineScope: MineScope =
    (typeof entry === "object" ? entry.mineScope : undefined) ?? "anywhere";
  const label = category.label;
  const options = category.options ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-stone-600 dark:text-stone-400">{label}</span>
        <Switch
          isSelected={enabled}
          onChange={(on) =>
            onChange(
              on
                ? { externalId: "mine", mineScope: hasProjects ? "in-project" : "anywhere" }
                : null,
            )
          }
          aria-label={`Include ${label.toLowerCase()}`}
          className="group outline-none"
        >
          {({ isSelected, isFocusVisible }) => (
            <div
              className={[
                "relative shrink-0 w-9 h-5 rounded-full border transition-all duration-150",
                isSelected
                  ? "bg-stone-700 dark:bg-stone-300 border-stone-700 dark:border-stone-300"
                  : "bg-transparent border-stone-300 dark:border-stone-600",
                isFocusVisible
                  ? "ring-2 ring-amber-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
                  : "",
              ].join(" ")}
            >
              <div
                className={[
                  "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all duration-150",
                  isSelected
                    ? "left-[18px] bg-white dark:bg-stone-900"
                    : "left-0.5 bg-stone-300 dark:bg-stone-600",
                ].join(" ")}
              />
            </div>
          )}
        </Switch>
      </div>

      {enabled && options.length > 0 && (
        <RadioGroup
          value={mineScope}
          onChange={(next) => onChange({ externalId: "mine", mineScope: next as MineScope })}
          aria-label={`${label} scope`}
          className="flex gap-2"
        >
          {options.map((opt) => {
            const optionDisabled = opt.id === "in-project" && !hasProjects;
            return (
              <Radio
                key={opt.id}
                value={opt.id}
                aria-label={opt.label}
                isDisabled={optionDisabled}
                className="outline-none data-[disabled]:opacity-40"
              >
                {({ isSelected, isFocusVisible, isDisabled }) => (
                  <div
                    className={[
                      "px-3 py-1.5 rounded-lg border text-xs select-none transition-all duration-150",
                      isDisabled ? "cursor-not-allowed" : "cursor-pointer",
                      isSelected
                        ? "border-stone-400 dark:border-stone-500 bg-stone-100 dark:bg-stone-800/80 text-stone-900 dark:text-stone-100"
                        : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 text-stone-600 dark:text-stone-400 hover:border-stone-300 dark:hover:border-stone-700",
                      isFocusVisible
                        ? "ring-2 ring-amber-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
                        : "",
                    ].join(" ")}
                  >
                    {opt.label}
                  </div>
                )}
              </Radio>
            );
          })}
        </RadioGroup>
      )}

      {enabled && !hasProjects && (
        <p className="text-[11px] text-stone-400 dark:text-stone-600">Pick a project first.</p>
      )}
    </div>
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
