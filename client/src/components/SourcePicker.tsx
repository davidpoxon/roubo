import { useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Disclosure,
  DisclosurePanel,
  Heading,
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
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  Filter,
  Folder,
  Grid3x3,
  Layout,
  RefreshCw,
  Search,
  Crown,
  X,
} from "lucide-react";
import type {
  ListIssuesWarning,
  SourceCandidateCategory,
  SourceCandidateIcon,
  SourceCandidateItem,
  SourceCandidatesResponse,
  SourceSelection,
  SourceSelectionEntry,
} from "@roubo/shared";
import IssueChip from "./IssueChip";
import OAuthReconsentDialog from "./OAuthReconsentDialog";
import {
  applyIdSelection,
  entriesFor,
  entryFlag,
  entryId,
  idsFor,
  setFlagForEntry,
  type AlertFlagKey,
} from "../lib/source-selection-helpers";

/**
 * Optional plugin-specific context the warning-chip variants need.
 *
 * - `pluginId` picks the remediation flow for a `missing-scope` warning:
 *   `"ghe"` renders a link chip to the GHE instance's PAT settings page,
 *   `"github-com"` renders a "Reconnect GitHub" chip that runs the OAuth
 *   re-consent flow.
 * - `gheInstanceUrl` is required to build the GHE token settings URL.
 * - `onReconnectOAuth` lets a parent supply its own re-consent handler for
 *   the github.com chip. When omitted, the SourcePicker falls back to its
 *   internal WU-031 OAuth re-consent dialog.
 *
 * Absent or partial values fall back to the generic "Unavailable" chip so
 * non-GitHub plugins (Jira etc.) and old call sites still render.
 */
export interface SourcePickerChipContext {
  pluginId?: string;
  gheInstanceUrl?: string;
  onReconnectOAuth?: () => void;
}

interface SourcePickerProps {
  response: SourceCandidatesResponse;
  value: SourceSelection;
  onChange: (next: SourceSelection) => void;
  /**
   * Per-source per-category warnings from the latest listIssues page-1 pull.
   * Drives the inline warning chips shown next to each alert-category
   * checkbox. Absent or empty means "no warnings."
   */
  warnings?: ListIssuesWarning[];
  /**
   * Plugin-specific data the chip variant switch needs (PAT settings URL).
   * Optional; see `SourcePickerChipContext`.
   */
  chipContext?: SourcePickerChipContext;
  /**
   * Project-wide count of benches whose persisted `assignedIssue.issueType`
   * matches a given security category, keyed by the category's frozen-snapshot
   * issueType (e.g. `"security-dependabot"`). Drives the muted help text
   * "<K> existing benches still show alerts from this category." rendered in
   * the per-source security disclosure. WU-035 / TC-097.
   */
  alertBenchCounts?: Partial<Record<string, number>>;
}

const MULTI_LIST_KEY = "items";

const STRINGS = {
  searchPrefix: "Search ",
  searchPlaceholder: "Search…",
  clearSearch: "Clear search",
  noCandidates: "No candidates returned.",
  noMatches: "No matches for that search.",
  removePrefix: "Remove ",
  alertSuffix: " alerts",
  securityAlertsHeading: "Security & quality alerts",
  securityAlertsAriaPrefix: "Security & quality alerts for ",
  enabledCountSuffix: " enabled",
  selectedCountSuffix: " selected",
  benchSingular: "1 existing bench still shows alerts from this category.",
  benchPlural: (k: number) => `${k} existing benches still show alerts from this category.`,
  verifyPatPrefix: "Verify your PAT has ",
  verifyPatSuffix: " scope",
  verifyPatAriaPrefix: "Verify your PAT has the security_events scope. Opens token settings on ",
  verifyPatAriaSuffix:
    " so you can regenerate the token with that scope and paste it back into the Personal access token field.",
  verifyPatTitlePrefix: "Verify your PAT has the security_events scope. Opens token settings on ",
  verifyPatTitleSuffix: ".",
  reconnectGitHub: "Reconnect GitHub",
  reconnectAriaDescription:
    "Reconnect GitHub. The OAuth token is missing the security_events scope; re-authenticate to grant it.",
  retry: "Retry",
  verifyToken: "Verify token",
  unavailable: "Unavailable",
  sourceCandidatesAriaLabel: "Source candidates",
  sourceCategoriesAriaLabel: "Source categories",
  categoryCandidatesSuffix: " candidates",
  selectedHeading: (n: number) => `Selected (${n})`,
  selectedLabel: "Selected",
  nothingSelected: "Nothing selected yet.",
  securityEventsScope: "security_events",
};

interface AlertCategoryDef {
  flag: AlertFlagKey;
  label: string;
  /** Warning category id emitted by the github-com plugin. */
  warningCategory: ListIssuesWarning["category"];
  /**
   * Frozen-snapshot issueType the github-family plugins stamp on alerts of
   * this category. Used by the Configure dialog to count alert-backed
   * benches via `assignedIssue.issueType` (see WU-035 / TC-097).
   */
  issueType: string;
}

const ALERT_CATEGORIES: AlertCategoryDef[] = [
  {
    flag: "includeCodeQLAlerts",
    label: "Code Scanning alerts",
    warningCategory: "code-scanning",
    issueType: "security-code-scanning",
  },
  {
    flag: "includeSecretScanningAlerts",
    label: "Secret Scanning alerts",
    warningCategory: "secret-scanning",
    issueType: "security-secret-scanning",
  },
  {
    flag: "includeDependabotAlerts",
    label: "Dependabot alerts",
    warningCategory: "dependabot",
    issueType: "security-dependabot",
  },
];

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
        aria-label={`${STRINGS.searchPrefix}${ariaLabel}`}
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
            placeholder={STRINGS.searchPlaceholder}
            className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md bg-stone-100 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700/50 text-stone-700 dark:text-stone-300 placeholder:text-stone-400 dark:placeholder:text-stone-600 outline-none focus:border-amber-500 dark:focus:border-amber-500 focus:bg-white dark:focus:bg-stone-800 transition-colors"
          />
          {search && (
            <Button
              onPress={() => setSearch("")}
              aria-label={STRINGS.clearSearch}
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
            {items.length === 0 ? STRINGS.noCandidates : STRINGS.noMatches}
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
        aria-label={`${STRINGS.removePrefix}${label}`}
        className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500 rounded"
      >
        <X size={11} />
      </Button>
    </span>
  );
}

function findWarning(
  warnings: ListIssuesWarning[] | undefined,
  sourceExternalId: string,
  category: ListIssuesWarning["category"],
): ListIssuesWarning | undefined {
  if (!warnings) return undefined;
  return warnings.find((w) => w.sourceExternalId === sourceExternalId && w.category === category);
}

// WU-031: a warning is "OAuth re-consent recoverable" when GitHub responded
// 401 to one of the three security-alert categories. The cause string itself
// is human-readable copy that may evolve; we match on structured fields so the
// trigger stays stable across copy edits in plugins/_shared-github/src/alerts.
const OAUTH_RECONSENT_CATEGORIES = new Set<ListIssuesWarning["category"]>([
  "code-scanning",
  "secret-scanning",
  "dependabot",
]);

function isOAuthReconsentWarning(warning: ListIssuesWarning): boolean {
  return warning.detail?.status === 401 && OAUTH_RECONSENT_CATEGORIES.has(warning.category);
}

function buildGheTokenSettingsUrl(instance: string): string {
  return `${instance.replace(/\/$/, "")}/settings/tokens`;
}

interface WarningChipProps {
  warning: ListIssuesWarning;
  chipContext?: SourcePickerChipContext;
  // WU-031: triggers the shared OAuth re-consent dialog when the user clicks
  // the warning chip. Only invoked for OAuth-recoverable warnings.
  onReconsent?: () => void;
  // Render the small "Retry" affordance inside the chip after a previous
  // attempt was cancelled or failed.
  showRetry?: boolean;
}

/**
 * Picks a chip variant based on `warning.code` and the surrounding context:
 *
 *  - `missing-scope` + GHE: link chip reading "Verify your PAT has
 *    `security_events` scope" that opens `<instance>/settings/tokens` in a new
 *    tab. User regenerates the PAT with `security_events` and pastes it back
 *    into the Configure dialog's existing PAT field. No OAuth flow is run
 *    (WU-032 AC #5, WU-040 / TC-137 GHE PAT branch).
 *  - `missing-scope` + github.com: "Reconnect GitHub" chip that runs the
 *    OAuth re-consent flow (WU-031). The chip's onPress drives the shared
 *    dialog state owned by SourcePicker.
 *  - `scope-unverifiable` (either plugin): non-link "Verify token" chip
 *    rendering NFR-015's graceful copy as the tooltip (WU-032 AC #6).
 *  - 401 on an alert category (no `code`): WU-031 OAuth-recoverable warning;
 *    same OAuth re-consent flow as missing-scope github-com.
 *  - any other warning: the generic "Unavailable" chip, surfacing
 *    `warning.cause` verbatim.
 */
export function WarningChip({ warning, chipContext, onReconsent, showRetry }: WarningChipProps) {
  const pluginId = chipContext?.pluginId;

  if (warning.code === "missing-scope" && pluginId === "ghe" && chipContext?.gheInstanceUrl) {
    const url = buildGheTokenSettingsUrl(chipContext.gheInstanceUrl);
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${STRINGS.verifyPatAriaPrefix}${chipContext.gheInstanceUrl}${STRINGS.verifyPatAriaSuffix}`}
        title={`${STRINGS.verifyPatTitlePrefix}${chipContext.gheInstanceUrl}${STRINGS.verifyPatTitleSuffix}`}
        className="inline-flex outline-none rounded focus-visible:ring-2 focus-visible:ring-amber-500/40"
        data-testid="alert-chip-missing-scope-ghe"
      >
        <IssueChip variant="status" tone="warning" icon={ExternalLink}>
          {STRINGS.verifyPatPrefix}
          <code className="font-mono">{STRINGS.securityEventsScope}</code>
          {STRINGS.verifyPatSuffix}
        </IssueChip>
      </a>
    );
  }

  if (warning.code === "missing-scope" && pluginId === "github-com") {
    // Prefer a parent-supplied OAuth handler; otherwise fall back to the
    // SourcePicker-owned re-consent dialog. Either way, the github.com chip
    // becomes a "Reconnect GitHub" button.
    const handler = chipContext?.onReconnectOAuth ?? onReconsent;
    if (handler) {
      const actionSuffix = showRetry ? (
        <span className="ml-1 underline" data-testid="oauth-reconsent-retry-hint">
          {STRINGS.retry}
        </span>
      ) : undefined;
      return (
        <IssueChip
          variant="status"
          tone="warning"
          icon={RefreshCw}
          ariaDescription={STRINGS.reconnectAriaDescription}
          onPress={handler}
          actionSuffix={actionSuffix}
          data-testid="alert-chip-missing-scope-github-com"
        >
          {STRINGS.reconnectGitHub}
        </IssueChip>
      );
    }
  }

  if (warning.code === "scope-unverifiable") {
    return (
      <IssueChip
        variant="status"
        tone="warning"
        icon={AlertTriangle}
        ariaDescription={warning.cause}
        data-testid="alert-chip-scope-unverifiable"
      >
        {STRINGS.verifyToken}
      </IssueChip>
    );
  }

  // WU-031 OAuth-recoverable 401 with no specific `code`: same behaviour as
  // missing-scope github-com — chip becomes a button that triggers the OAuth
  // re-consent dialog.
  if (isOAuthReconsentWarning(warning) && onReconsent) {
    const actionSuffix = showRetry ? (
      <span className="ml-1 underline" data-testid="oauth-reconsent-retry-hint">
        {STRINGS.retry}
      </span>
    ) : undefined;
    return (
      <IssueChip
        variant="status"
        tone="warning"
        icon={AlertTriangle}
        ariaDescription={warning.cause}
        onPress={onReconsent}
        actionSuffix={actionSuffix}
        data-testid="alert-chip-oauth-recoverable"
      >
        {STRINGS.unavailable}
      </IssueChip>
    );
  }

  return (
    <IssueChip variant="status" tone="warning" icon={AlertTriangle} ariaDescription={warning.cause}>
      {STRINGS.unavailable}
    </IssueChip>
  );
}

interface AlertCheckboxRowProps {
  category: AlertCategoryDef;
  selected: boolean;
  onChange: (next: boolean) => void;
  warning?: ListIssuesWarning;
  chipContext?: SourcePickerChipContext;
  onReconsent?: () => void;
  showRetry?: boolean;
  /**
   * Count of alert-backed benches for this category across the project. When
   * > 0, the row renders a muted line explaining that toggling the category
   * does not affect existing benches.
   */
  benchCount?: number;
}

function AlertCheckboxRow({
  category,
  selected,
  onChange,
  warning,
  chipContext,
  onReconsent,
  showRetry,
  benchCount,
}: AlertCheckboxRowProps) {
  const k = benchCount ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Checkbox
          isSelected={selected}
          onChange={onChange}
          aria-label={category.label}
          data-testid={`alert-checkbox-${category.flag}`}
          className="flex items-center gap-2 cursor-pointer group flex-1"
        >
          {({ isSelected }) => (
            <>
              <div
                className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  isSelected
                    ? "bg-stone-600 border-stone-500"
                    : "bg-stone-200 dark:bg-stone-800 border-stone-400 dark:border-stone-600"
                }`}
              >
                {isSelected && <Check size={10} className="text-stone-100" />}
              </div>
              <span className="text-sm text-stone-700 dark:text-stone-300">{category.label}</span>
            </>
          )}
        </Checkbox>
        {warning && (
          <WarningChip
            warning={warning}
            chipContext={chipContext}
            onReconsent={onReconsent}
            showRetry={showRetry}
          />
        )}
      </div>
      {k > 0 && (
        <p
          className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed pl-6"
          data-testid={`alert-existing-benches-${category.flag}`}
        >
          {k === 1 ? STRINGS.benchSingular : STRINGS.benchPlural(k)}
        </p>
      )}
    </div>
  );
}

interface SecurityAlertsDisclosureProps {
  sourceExternalId: string;
  sourceLabel: string;
  entry: SourceSelectionEntry;
  warnings: ListIssuesWarning[] | undefined;
  onFlagChange: (flag: AlertFlagKey, value: boolean) => void;
  chipContext?: SourcePickerChipContext;
  onReconsent?: (sourceExternalId: string, category: ListIssuesWarning["category"]) => void;
  retryHints?: ReadonlySet<string>;
  alertBenchCounts?: Partial<Record<string, number>>;
}

function SecurityAlertsDisclosure({
  sourceExternalId,
  sourceLabel,
  entry,
  warnings,
  onFlagChange,
  chipContext,
  onReconsent,
  retryHints,
  alertBenchCounts,
}: SecurityAlertsDisclosureProps) {
  const enabled = ALERT_CATEGORIES.filter((c) => entryFlag(entry, c.flag));
  const enabledCount = enabled.length;
  const summary =
    enabledCount > 0
      ? `(${enabled.map((c) => c.label.replace(new RegExp(`${STRINGS.alertSuffix}$`), "")).join(", ")})`
      : null;

  return (
    <Disclosure
      className="border-t border-stone-100 dark:border-stone-800 pt-2"
      data-testid={`security-alerts-disclosure-${sourceExternalId}`}
    >
      {({ isExpanded }) => (
        <>
          <Heading level={4} className="m-0">
            <Button
              slot="trigger"
              className="w-full flex items-center gap-2 px-1 py-1 text-left text-[12px] text-stone-600 dark:text-stone-400 outline-none rounded transition-colors hover:text-stone-800 dark:hover:text-stone-200 focus-visible:ring-2 focus-visible:ring-amber-500/40"
              aria-label={`${STRINGS.securityAlertsAriaPrefix}${sourceLabel}`}
            >
              <ChevronRight
                size={12}
                className={`shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                aria-hidden
              />
              <span className="font-medium">{STRINGS.securityAlertsHeading}</span>
              {summary && (
                <span className="text-stone-500 dark:text-stone-500 truncate">{summary}</span>
              )}
              {enabledCount > 0 && (
                <span
                  aria-label={`${enabledCount}${STRINGS.enabledCountSuffix}`}
                  className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                >
                  {enabledCount}
                </span>
              )}
            </Button>
          </Heading>
          <DisclosurePanel className="flex flex-col gap-2 pt-2 pl-5">
            {ALERT_CATEGORIES.map((category) => {
              const warning = findWarning(warnings, sourceExternalId, category.warningCategory);
              const retryKey = retryHintKey(sourceExternalId, category.warningCategory);
              return (
                <AlertCheckboxRow
                  key={category.flag}
                  category={category}
                  selected={entryFlag(entry, category.flag)}
                  onChange={(next) => onFlagChange(category.flag, next)}
                  warning={warning}
                  chipContext={chipContext}
                  onReconsent={
                    onReconsent
                      ? () => onReconsent(sourceExternalId, category.warningCategory)
                      : undefined
                  }
                  showRetry={retryHints?.has(retryKey) ?? false}
                  benchCount={alertBenchCounts?.[category.issueType]}
                />
              );
            })}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}

interface PerSourceConfigListProps {
  category: string;
  items: SourceCandidateItem[];
  entries: SourceSelectionEntry[];
  warnings: ListIssuesWarning[] | undefined;
  /** Set true to show the security disclosure (github-com/GHE). Other plugins hide it. */
  showSecurityAlerts: boolean;
  onFlagChange: (externalId: string, flag: AlertFlagKey, value: boolean) => void;
  chipContext?: SourcePickerChipContext;
  onReconsent?: (sourceExternalId: string, category: ListIssuesWarning["category"]) => void;
  retryHints?: ReadonlySet<string>;
  alertBenchCounts?: Partial<Record<string, number>>;
}

function PerSourceConfigList({
  category,
  items,
  entries,
  warnings,
  showSecurityAlerts,
  onFlagChange,
  chipContext,
  onReconsent,
  retryHints,
  alertBenchCounts,
}: PerSourceConfigListProps) {
  if (!showSecurityAlerts || entries.length === 0) return null;
  const byId = new Map(items.map((i) => [i.externalId, i]));
  return (
    <div
      className="flex flex-col gap-3"
      data-testid={`per-source-config-${category}`}
      data-category={category}
    >
      {entries.map((entry) => {
        const id = entryId(entry);
        const item = byId.get(id);
        const sourceLabel = item?.label ?? id;
        return (
          <div
            key={id}
            className="flex flex-col gap-1 rounded-md border border-stone-200 dark:border-stone-700/50 px-3 py-2 bg-white/40 dark:bg-stone-900/40"
          >
            <div className="flex items-center gap-2 text-xs text-stone-700 dark:text-stone-300 font-mono">
              <span className="truncate">{sourceLabel}</span>
            </div>
            <SecurityAlertsDisclosure
              sourceExternalId={id}
              sourceLabel={sourceLabel}
              entry={entry}
              warnings={warnings}
              onFlagChange={(flag, value) => onFlagChange(id, flag, value)}
              chipContext={chipContext}
              onReconsent={onReconsent}
              retryHints={retryHints}
              alertBenchCounts={alertBenchCounts}
            />
          </div>
        );
      })}
    </div>
  );
}

function MultiListVariant({
  response,
  value,
  onChange,
  warnings,
  chipContext,
  showSecurityAlerts,
  onReconsent,
  retryHints,
  alertBenchCounts,
}: SourcePickerProps & {
  response: SourceCandidatesResponse & { items: SourceCandidateItem[] };
  showSecurityAlerts: boolean;
  onReconsent?: (sourceExternalId: string, category: ListIssuesWarning["category"]) => void;
  retryHints?: ReadonlySet<string>;
}) {
  const items = useMemo(() => response.items ?? [], [response.items]);
  const selectedIds = useMemo(() => new Set(idsFor(value, MULTI_LIST_KEY)), [value]);
  const entries = entriesFor(value, MULTI_LIST_KEY);
  const byId = useMemo(() => {
    const map = new Map<string, SourceCandidateItem>();
    for (const it of items) map.set(it.externalId, it);
    return map;
  }, [items]);

  const selectedList = [...selectedIds]
    .map((id) => byId.get(id))
    .filter((it): it is SourceCandidateItem => !!it);

  const handleChange = (next: Set<string>) => {
    onChange(applyIdSelection(value, MULTI_LIST_KEY, next));
  };

  const handleFlagChange = (externalId: string, flag: AlertFlagKey, val: boolean) => {
    onChange(setFlagForEntry(value, MULTI_LIST_KEY, externalId, flag, val));
  };

  return (
    <div className="flex flex-col gap-4">
      <CandidateList
        items={items}
        selected={selectedIds}
        onSelectionChange={handleChange}
        ariaLabel={STRINGS.sourceCandidatesAriaLabel}
      />
      <ChipStrip
        title={STRINGS.selectedHeading(selectedList.length)}
        chips={selectedList.map((it) => ({
          id: it.externalId,
          label: it.label,
          onRemove: () => {
            const next = new Set(selectedIds);
            next.delete(it.externalId);
            handleChange(next);
          },
        }))}
      />
      <PerSourceConfigList
        category={MULTI_LIST_KEY}
        items={items}
        entries={entries}
        warnings={warnings}
        showSecurityAlerts={showSecurityAlerts}
        onFlagChange={handleFlagChange}
        chipContext={chipContext}
        onReconsent={onReconsent}
        retryHints={retryHints}
        alertBenchCounts={alertBenchCounts}
      />
    </div>
  );
}

function CategorizedVariant({
  response,
  value,
  onChange,
  warnings,
  chipContext,
  showSecurityAlerts,
  onReconsent,
  retryHints,
  alertBenchCounts,
}: SourcePickerProps & {
  response: SourceCandidatesResponse & { categories: SourceCandidateCategory[] };
  showSecurityAlerts: boolean;
  onReconsent?: (sourceExternalId: string, category: ListIssuesWarning["category"]) => void;
  retryHints?: ReadonlySet<string>;
}) {
  const categories = useMemo(() => response.categories ?? [], [response.categories]);
  const [activeId, setActiveId] = useState<string>(() => categories[0]?.id ?? "");

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const cat of categories) {
      out[cat.id] = entriesFor(value, cat.id).length;
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
          aria-label={STRINGS.sourceCategoriesAriaLabel}
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
                  aria-label={`${counts[cat.id]}${STRINGS.selectedCountSuffix}`}
                  className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                >
                  {counts[cat.id]}
                </span>
              )}
            </Tab>
          ))}
        </TabList>
        {categories.map((cat) => {
          const catIds = new Set(idsFor(value, cat.id));
          return (
            <TabPanel key={cat.id} id={cat.id} className="outline-none flex flex-col gap-3">
              <CandidateList
                items={cat.items}
                selected={catIds}
                onSelectionChange={(next) => onChange(applyIdSelection(value, cat.id, next))}
                ariaLabel={`${cat.label}${STRINGS.categoryCandidatesSuffix}`}
              />
              <PerSourceConfigList
                category={cat.id}
                items={cat.items}
                entries={entriesFor(value, cat.id)}
                warnings={warnings}
                showSecurityAlerts={showSecurityAlerts}
                onFlagChange={(externalId, flag, val) =>
                  onChange(setFlagForEntry(value, cat.id, externalId, flag, val))
                }
                chipContext={chipContext}
                onReconsent={onReconsent}
                retryHints={retryHints}
                alertBenchCounts={alertBenchCounts}
              />
            </TabPanel>
          );
        })}
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
    <div className="flex flex-col gap-1.5" aria-live="polite" aria-atomic="true">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
        {title}
      </span>
      {chips.length === 0 ? (
        <p className="text-xs text-stone-400 dark:text-stone-600">{STRINGS.nothingSelected}</p>
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
      const selected = idsFor(value, cat.id);
      const chips = selected
        .map((id) => byId.get(id))
        .filter((it): it is SourceCandidateItem => !!it);
      return { cat, chips };
    })
    .filter((g) => g.chips.length > 0);

  if (groups.length === 0) {
    return <ChipStrip title={STRINGS.selectedHeading(0)} chips={[]} />;
  }

  return (
    <div className="flex flex-col gap-3" aria-live="polite" aria-atomic="true">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
        {STRINGS.selectedLabel}
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
                  const current = new Set(idsFor(value, cat.id));
                  current.delete(it.externalId);
                  onChange(applyIdSelection(value, cat.id, current));
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SourcePicker({
  response,
  value,
  onChange,
  warnings,
  chipContext,
  alertBenchCounts,
}: SourcePickerProps) {
  // Only the bundled GitHub-family source kinds use the security alert toggles.
  // Detect via the icon hint declared on the candidate items; other plugins
  // (e.g. Jira) declare their own icons, so the disclosure stays hidden there.
  const showSecurityAlerts = useMemo(() => {
    const items =
      response.shape === "multi-list"
        ? (response.items ?? [])
        : (response.categories ?? []).flatMap((c) => c.items);
    return items.some((it) => it.icon === "repo" || it.icon === "project");
  }, [response]);

  // WU-031: single OAuth re-consent dialog instance shared across every
  // chip-as-button in this picker. One GitHub OAuth grant clears 401s for all
  // sources at once, so one dialog is enough; we just remember which row
  // surfaced the click so post-cancel we can mark only that row with Retry.
  const [reconsentOpen, setReconsentOpen] = useState(false);
  const [retryHints, setRetryHints] = useState<ReadonlySet<string>>(() => new Set<string>());
  const lastTriggerRef = useRef<string | null>(null);

  const handleReconsent = (sourceExternalId: string, category: ListIssuesWarning["category"]) => {
    lastTriggerRef.current = retryHintKey(sourceExternalId, category);
    // Clear any prior "Retry" hint for this row when the user opens the
    // dialog again, so the chip resets to its baseline label.
    if (retryHints.has(lastTriggerRef.current)) {
      const next = new Set(retryHints);
      next.delete(lastTriggerRef.current);
      setRetryHints(next);
    }
    setReconsentOpen(true);
  };

  const handleSuccess = () => {
    // A fresh token clears every per-row hint; the warnings themselves will
    // disappear on the next listIssues pull (already invalidated by the dialog).
    setRetryHints(new Set());
  };

  const handleCancelled = () => {
    if (!lastTriggerRef.current) return;
    const next = new Set(retryHints);
    next.add(lastTriggerRef.current);
    setRetryHints(next);
  };

  const variantPropsExtras = {
    onReconsent: handleReconsent,
    retryHints,
  } as const;

  const body =
    response.shape === "multi-list" ? (
      <MultiListVariant
        response={{ ...response, items: response.items ?? [] }}
        value={value}
        onChange={onChange}
        warnings={warnings}
        chipContext={chipContext}
        showSecurityAlerts={showSecurityAlerts}
        alertBenchCounts={alertBenchCounts}
        {...variantPropsExtras}
      />
    ) : (
      <CategorizedVariant
        response={{ ...response, categories: response.categories ?? [] }}
        value={value}
        onChange={onChange}
        warnings={warnings}
        chipContext={chipContext}
        showSecurityAlerts={showSecurityAlerts}
        alertBenchCounts={alertBenchCounts}
        {...variantPropsExtras}
      />
    );

  return (
    <>
      {body}
      <OAuthReconsentDialog
        isOpen={reconsentOpen}
        onOpenChange={setReconsentOpen}
        onSuccess={handleSuccess}
        onCancelled={handleCancelled}
      />
    </>
  );
}

function retryHintKey(sourceExternalId: string, category: ListIssuesWarning["category"]): string {
  return `${sourceExternalId}:${category}`;
}
