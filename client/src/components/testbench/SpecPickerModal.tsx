import { useId, useState } from "react";
import {
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Label,
  Input,
} from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";
import {
  FlaskConical,
  FileText,
  AlertTriangle,
  Check,
  Loader2,
  ChevronRight,
  Archive,
  ArchiveRestore,
  EllipsisVertical,
  Replace,
} from "lucide-react";
import {
  useTestbenchSpecs,
  useManualPathValidation,
  partitionSpecs,
  deriveSpecSummary,
  deriveArchivedLabel,
} from "../../hooks/useTestbenchSpecs";
import type { SpecPassSummary } from "../../hooks/useTestbenchSpecs";
import { useSpecLifecycleMutation } from "../../hooks/useSpecLifecycleMutation";
import type { DiscoveredSpec, SpecLifecycleRecordInput } from "../../lib/api";
import Select from "../Select";
import Spinner from "../Spinner";

// The leading marker for a pass-state summary line (#483, TSPF-FR-006). Each
// marker maps to a specific dot or icon; the summary text always accompanies it,
// so state is never conveyed by colour alone (a dot/icon plus words in every
// case). Decorative only (aria-hidden), the adjacent text carries the meaning.
function SummaryMarker({ marker }: { marker: SpecPassSummary["marker"] }) {
  switch (marker) {
    case "none":
      return (
        <span
          aria-hidden
          className="w-2 h-2 rounded-full border-[1.5px] border-stone-400 dark:border-stone-500 shrink-0"
        />
      );
    case "stale":
      return <AlertTriangle size={12} aria-hidden className="text-amber-500 shrink-0" />;
    case "passed":
      return <span aria-hidden className="w-2 h-2 rounded-full bg-green-500 shrink-0" />;
    case "failed":
      return <span aria-hidden className="w-2 h-2 rounded-full bg-red-500 shrink-0" />;
    case "progress":
    default:
      return <span aria-hidden className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />;
  }
}

// A selection is either a discovered spec row or the validated manual path. Both
// resolve to a focusedSpecPath (the absolute path to the spec's test-cases.json)
// that the create call binds the TestBench to.
type Selection =
  | { kind: "discovered"; slug: string; path: string }
  | { kind: "manual"; slug: string; path: string }
  | null;

// Copy that differs between the two flows the picker drives. `create` (#418) binds
// a brand-new bench to a focused spec; `repoint` (#423, FR-024) re-points an active
// TestBench to a different focused spec. The selection UI and explicit-confirm
// contract are identical; only the title, helper text, and button labels change.
const MODE_COPY = {
  create: {
    title: "Create a TestBench",
    description:
      "Choose a discovered spec or point at a test-cases.json by hand. The TestBench binds to the focused spec.",
    confirmLabel: "Create TestBench",
    busyLabel: "Creating...",
  },
  repoint: {
    title: "Change focused spec",
    description:
      "Re-point this TestBench to a different focused spec. The current spec's results are preserved and reload intact if you switch back.",
    confirmLabel: "Re-point TestBench",
    busyLabel: "Re-pointing...",
  },
} as const;

export type SpecPickerMode = keyof typeof MODE_COPY;

// The two lifecycle actions that need input before they can be applied (#773,
// SATCA-FR-020). Restore takes none, so it is applied straight from the menu.
type PendingLifecycleAction = { kind: "archive" | "supersede"; spec: DiscoveredSpec };

// Copy for the confirm step, lifted from the approved prototype
// (.specifications/spec-and-test-case-archival/prototype/index.html). The hint
// names the file that changes and says the change is left uncommitted, because
// Roubo is writing into a repository the reviewer owns and will have to review
// the diff themselves.
const LIFECYCLE_COPY = {
  archive: {
    title: "Archive this specification",
    description:
      "It leaves the picker's default list. You can reveal it again with Show archived, and restore it from there.",
    confirmLabel: "Archive",
    busyLabel: "Archiving...",
  },
  supersede: {
    title: "Supersede this specification",
    description: "Choose the spec that replaced it. The picker will name that spec on this row.",
    confirmLabel: "Supersede",
    busyLabel: "Superseding...",
  },
} as const;

// One row-actions menu item. Matches the ToolButtons menu styling so the two
// kebab menus in the app read the same.
const LIFECYCLE_MENU_ITEM_CLASS =
  "flex items-start gap-2.5 px-3 py-2 rounded-lg text-xs cursor-default outline-none transition-colors text-stone-600 dark:text-stone-400 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-800 data-[focused]:text-stone-900 dark:data-[focused]:text-stone-100";

// Spec picker shared by the create flow (#418, FR-001/FR-002/FR-003) and the
// re-point flow (#423, FR-024). Lists the discovered specs and offers a manual-path
// escape hatch with live validation. Confirm stays disabled until a valid selection
// exists; on confirm it calls onCreate with the chosen focusedSpecPath and the host
// owns the create / re-point flow. Dismissal (Cancel / overlay / Escape) never calls
// onCreate, so the focused spec is only ever changed explicitly.
export default function SpecPickerModal({
  isOpen,
  onClose,
  projectId,
  onCreate,
  isCreating = false,
  mode = "create",
  activePath,
}: {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreate: (focusedSpecPath: string) => void;
  isCreating?: boolean;
  mode?: SpecPickerMode;
  // Re-point only (#423/#444, TC-007 step 2): the currently focused spec's
  // path, so the matching discovered row is flagged as the active spec. Unset
  // in create mode (no bench is bound yet).
  activePath?: string;
}) {
  const copy = MODE_COPY[mode];
  const { data, isLoading, isError, error } = useTestbenchSpecs(projectId, isOpen);
  const specs = data?.specs;
  const invalid = data?.invalid;
  const [manualPath, setManualPath] = useState("");
  const [selectedDiscoveredPath, setSelectedDiscoveredPath] = useState<string | null>(null);
  // The all-passed disclosure is collapsed by default and reset to collapsed on
  // every close (see reset()), so it is always collapsed on reopen (#483,
  // TSPF-FR-005). Selection lives in selectedDiscoveredPath, shared across both
  // groups, so collapsing the tail never drops a selection made inside it.
  const [allPassedExpanded, setAllPassedExpanded] = useState(false);
  // Archived specs are hidden from the default list and revealed only by the
  // "Show archived" control, which starts off and is reset on every close (see
  // reset()), so the picker always reopens showing the live specs alone (#770,
  // SATCA-FR-015/FR-016). Revealed rows join the same controlled selection group,
  // so an archived spec stays loadable.
  const [showArchived, setShowArchived] = useState(false);
  // Ties the reveal control to the group it discloses (aria-controls) so the
  // relationship is machine-readable rather than only visual (#775, AC2).
  const archivedGroupId = useId();
  // The lifecycle confirm step (#773). While set, the picker body is replaced by
  // the confirm form for that one spec, rather than opening a second modal on
  // top of this one: nesting dialogs would aria-hide the picker while it still
  // holds focusable rows.
  const [pendingAction, setPendingAction] = useState<PendingLifecycleAction | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [supersedeTarget, setSupersedeTarget] = useState("");
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const manualState = useManualPathValidation(projectId, manualPath, isOpen);
  const lifecycleMutation = useSpecLifecycleMutation();

  // The active selection: a manual path takes precedence once it validates, so a
  // user who starts typing in the escape hatch overrides any earlier row click.
  let selection: Selection = null;
  if (manualPath.trim().length > 0) {
    selection =
      manualState.status === "valid"
        ? { kind: "manual", slug: manualState.slug, path: manualState.path }
        : null;
  } else if (selectedDiscoveredPath) {
    const row = specs?.find((s) => s.path === selectedDiscoveredPath);
    selection = row ? { kind: "discovered", slug: row.slug, path: row.path } : null;
  }

  const canCreate = selection !== null && !isCreating;

  const dismissPending = () => {
    setPendingAction(null);
    setArchiveReason("");
    setSupersedeTarget("");
    setLifecycleError(null);
  };

  const reset = () => {
    setManualPath("");
    setSelectedDiscoveredPath(null);
    setAllPassedExpanded(false);
    setShowArchived(false);
    dismissPending();
  };

  // Apply a lifecycle record to one spec, or clear it with `null` (the reversal
  // every action shares, SATCA-FR-021). The list re-reads itself on settle, so
  // the row moves between the live groups and the archived group on the server's
  // say-so rather than optimistically.
  const applyLifecycle = (slug: string, lifecycle: SpecLifecycleRecordInput | null) => {
    setLifecycleError(null);
    lifecycleMutation.mutate(
      { projectId, slug, lifecycle },
      {
        onSuccess: () => dismissPending(),
        onError: (err) =>
          setLifecycleError(err instanceof Error ? err.message : "The change could not be saved"),
      },
    );
  };

  const openPending = (kind: PendingLifecycleAction["kind"], spec: DiscoveredSpec) => {
    setArchiveReason("");
    setSupersedeTarget("");
    setLifecycleError(null);
    setPendingAction({ kind, spec });
  };

  const confirmPending = () => {
    if (!pendingAction) return;
    if (pendingAction.kind === "archive") {
      const reason = archiveReason.trim();
      applyLifecycle(pendingAction.spec.slug, {
        archived: true,
        ...(reason.length > 0 ? { reason } : {}),
      });
      return;
    }
    if (supersedeTarget.length === 0) return;
    applyLifecycle(pendingAction.spec.slug, { archived: true, supersededBy: supersedeTarget });
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleCreate = () => {
    if (!selection) return;
    onCreate(selection.path);
  };

  const invalidSpecs = invalid ?? [];
  const hasInvalid = invalidSpecs.length > 0;
  // Genuinely empty only when there are neither usable nor invalid spec files.
  // When invalid files exist they are surfaced distinctly (see the invalid panel)
  // instead of the misleading "No specs found".
  const showEmptyDiscovery = !isLoading && !isError && (specs?.length ?? 0) === 0 && !hasInvalid;
  const showInvalidSpecs = !isLoading && !isError && hasInvalid;

  // Partition the discovered specs (#483, TSPF-FR-003; #770, SATCA-FR-015):
  // archived specs are split off first and hidden until "Show archived" is
  // pressed, then the live ones divide into needs-attention (the prominent main
  // space) and all-passed (the collapsed tail disclosure). Purely presentational,
  // keyed on the server's lifecycle and classification.
  const { needsAttention, allPassed, archived } = partitionSpecs(specs ?? []);

  // Every LIVE discovered spec is all-passed (#484, TSPF-FR-007): the main space
  // would otherwise be blank, so we show an explicit empty state pointing at the
  // completed group below and the manual-path field. Keyed on the all-passed
  // group rather than the raw spec count so a project whose only remaining specs
  // are archived does not claim they all passed (#770), and not on hasInvalid:
  // the invalid panel keeps its own separate messaging.
  const showAllPassedEmptyState =
    !isLoading && !isError && allPassed.length > 0 && needsAttention.length === 0;

  // Render one selectable spec row. Shared by both groups so selection stays a
  // single controlled ToggleButtonGroup; `muted` de-emphasizes the all-passed
  // rows via colour hierarchy (slug and icon drop to muted stone). Every text
  // class holds the per-theme AA floor (text-stone-500 on white, dark:text-stone-400
  // on the stone-900 modal, both >= 4.5:1); the path sits at that floor in both
  // groups, so muting collapses there and the hierarchy reads via the slug (#493).
  const renderRow = (spec: DiscoveredSpec, muted: boolean) => {
    const isSelected = manualPath.trim().length === 0 && selectedDiscoveredPath === spec.path;
    const isActive = mode === "repoint" && spec.path === activePath;
    const summary = deriveSpecSummary(spec);
    // Archived rows (only ever rendered inside the revealed archived group) carry
    // a text label distinguishing a superseded spec from a merely archived one,
    // plus the superseding slug and any recorded reason (#770, SATCA-FR-016).
    const archivedLabel = spec.lifecycle.archived ? deriveArchivedLabel(spec) : null;
    // The lifecycle actions menu is a SIBLING of the toggle, never a child of
    // it: a row is a single ToggleButton, and nesting a menu trigger inside one
    // would nest interactive elements. Both sit in a flex row so they still read
    // as one line (#773, SATCA-FR-020/FR-021).
    const toggle = (
      <ToggleButton
        id={spec.path}
        className={`flex-1 min-w-0 flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
          isSelected
            ? "border-amber-500 bg-amber-50 dark:bg-amber-950/20"
            : "border-stone-200 dark:border-stone-800/60 hover:border-stone-300 dark:hover:border-stone-700/60 hover:bg-stone-50 dark:hover:bg-stone-800/40"
        }`}
      >
        <FileText
          size={15}
          className={`shrink-0 mt-0.5 ${
            muted ? "text-stone-300 dark:text-stone-600" : "text-stone-400 dark:text-stone-500"
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <span
              className={`truncate ${
                muted ? "text-stone-500 dark:text-stone-400" : "text-stone-800 dark:text-stone-200"
              }`}
            >
              {spec.slug}
            </span>
            {isActive && (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 rounded-full px-1.5 py-0.5">
                Active
              </span>
            )}
            {archivedLabel && (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-stone-600 dark:text-stone-300 bg-stone-200 dark:bg-stone-800 rounded-full px-1.5 py-0.5">
                {archivedLabel.label}
              </span>
            )}
          </p>
          <p className="text-[11px] font-mono truncate text-stone-500 dark:text-stone-400">
            {spec.path}
          </p>
          <p
            className={`mt-0.5 flex items-center gap-1.5 text-[11px] ${
              muted ? "text-stone-500 dark:text-stone-400" : "text-stone-600 dark:text-stone-400"
            }`}
          >
            <SummaryMarker marker={summary.marker} />
            <span
              className={
                summary.marker === "stale"
                  ? "font-medium text-amber-800 dark:text-amber-400"
                  : undefined
              }
            >
              {summary.text}
            </span>
            {summary.failed > 0 && (
              <span className="font-medium text-red-600 dark:text-red-400">
                · {summary.failed} failed
              </span>
            )}
          </p>
          {archivedLabel?.supersededBy && (
            <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
              Superseded by <span className="font-mono">{archivedLabel.supersededBy}</span>
            </p>
          )}
          {archivedLabel?.reason && (
            <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
              {archivedLabel.reason}
            </p>
          )}
        </div>
        <span className="shrink-0 text-[11px] font-medium text-stone-600 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 rounded-full px-2 py-0.5">
          {spec.caseCount} {spec.caseCount === 1 ? "case" : "cases"}
        </span>
        {isSelected && <Check size={14} className="text-amber-500 shrink-0 mt-0.5" />}
      </ToggleButton>
    );

    return (
      <div key={spec.path} className="flex items-start gap-1">
        {toggle}
        <MenuTrigger>
          <Button
            aria-label={`Actions for ${spec.slug}`}
            className={({ isHovered, isPressed, isFocusVisible }) =>
              `shrink-0 mt-1 p-1.5 rounded-lg text-stone-500 dark:text-stone-400 outline-none transition-colors ${
                isPressed
                  ? "bg-stone-200 dark:bg-stone-700/60"
                  : isHovered
                    ? "bg-stone-100 dark:bg-stone-800/60"
                    : ""
              } ${isFocusVisible ? "ring-2 ring-amber-500" : ""}`
            }
          >
            <EllipsisVertical size={15} aria-hidden />
          </Button>
          <Popover
            placement="bottom end"
            offset={4}
            className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl p-1 min-w-[11rem]"
          >
            <Menu
              className="outline-none"
              onAction={(key) => {
                if (key === "restore") {
                  // Reversal takes no input, so it applies straight from the
                  // menu: the record is deleted and the spec returns to the
                  // default list (SATCA-FR-021, SATCA-TC-050 S003/S004).
                  applyLifecycle(spec.slug, null);
                  return;
                }
                openPending(key === "supersede" ? "supersede" : "archive", spec);
              }}
            >
              {spec.lifecycle.archived ? (
                <MenuItem id="restore" className={LIFECYCLE_MENU_ITEM_CLASS}>
                  <ArchiveRestore size={14} className="shrink-0" aria-hidden />
                  <span>
                    Restore
                    <span className="block text-[11px] text-stone-500 dark:text-stone-400">
                      Return to the live list
                    </span>
                  </span>
                </MenuItem>
              ) : (
                <>
                  <MenuItem id="archive" className={LIFECYCLE_MENU_ITEM_CLASS}>
                    <Archive size={14} className="shrink-0" aria-hidden />
                    <span>Archive</span>
                  </MenuItem>
                  <MenuItem id="supersede" className={LIFECYCLE_MENU_ITEM_CLASS}>
                    <Replace size={14} className="shrink-0" aria-hidden />
                    <span>Supersede</span>
                  </MenuItem>
                </>
              )}
            </Menu>
          </Popover>
        </MenuTrigger>
      </div>
    );
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  {pendingAction ? (
                    pendingAction.kind === "archive" ? (
                      <Archive size={15} className="text-amber-500" />
                    ) : (
                      <Replace size={15} className="text-amber-500" />
                    )
                  ) : (
                    <FlaskConical size={15} className="text-amber-500" />
                  )}
                  {pendingAction ? LIFECYCLE_COPY[pendingAction.kind].title : copy.title}
                </Heading>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  {pendingAction
                    ? LIFECYCLE_COPY[pendingAction.kind].description
                    : copy.description}
                </p>
              </div>

              {/* The confirm step replaces the picker body rather than stacking a
                  second dialog on top of it (#773). One dialog stays open
                  throughout, so the rows behind are unmounted rather than left
                  focusable inside an aria-hidden subtree. */}
              {pendingAction !== null && (
                <>
                  <div className="px-5 py-4 space-y-4">
                    <p className="text-sm text-stone-700 dark:text-stone-300">
                      <span className="font-mono">{pendingAction.spec.slug}</span>
                    </p>

                    {pendingAction.kind === "archive" && (
                      <TextField value={archiveReason} onChange={setArchiveReason}>
                        <Label className="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1.5">
                          Reason (optional)
                        </Label>
                        <Input
                          placeholder="Shipped in #212, all issues closed"
                          className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
                        />
                      </TextField>
                    )}

                    {pendingAction.kind === "supersede" && (
                      <div>
                        <p
                          id="supersede-target-label"
                          className="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1.5"
                        >
                          Superseded by (required)
                        </p>
                        {/* Chosen from the project's OTHER specs, never typed
                            free-form, so the pointer cannot dangle
                            (SATCA-FR-028). The server re-checks it. */}
                        <Select
                          ariaLabel="Superseded by"
                          placeholder="Choose a specification"
                          items={(specs ?? [])
                            .filter((s) => s.slug !== pendingAction.spec.slug)
                            .map((s) => s.slug)}
                          value={supersedeTarget}
                          onChange={setSupersedeTarget}
                        />
                        {(specs ?? []).filter((s) => s.slug !== pendingAction.spec.slug).length ===
                          0 && (
                          <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
                            This project has no other specification to point at.
                          </p>
                        )}
                      </div>
                    )}

                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      Written to{" "}
                      <code className="font-mono">
                        .specifications/{pendingAction.spec.slug}/manifest.json
                      </code>
                      . Left uncommitted for you to review.
                    </p>

                    <div aria-live="polite">
                      {lifecycleError && (
                        <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                          <AlertTriangle size={12} className="shrink-0 mt-0.5" aria-hidden />
                          <span>{lifecycleError}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                    <Button
                      onPress={dismissPending}
                      className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-900"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={confirmPending}
                      isDisabled={
                        lifecycleMutation.isPending ||
                        (pendingAction.kind === "supersede" && supersedeTarget.length === 0)
                      }
                      className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-900"
                    >
                      {lifecycleMutation.isPending
                        ? LIFECYCLE_COPY[pendingAction.kind].busyLabel
                        : LIFECYCLE_COPY[pendingAction.kind].confirmLabel}
                    </Button>
                  </div>
                </>
              )}

              {pendingAction === null && (
                <>
                  <div className="px-5 py-4 space-y-5 max-h-[60vh] overflow-y-auto">
                    {/* Discovered specs */}
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
                        Discovered specs
                      </p>

                      {isLoading && (
                        <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400 py-3">
                          <Spinner />
                          Discovering specs...
                        </div>
                      )}

                      {isError && (
                        <div className="flex items-start gap-2 rounded-lg border border-red-300/60 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-3 py-2">
                          <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />
                          <p className="text-sm text-red-600 dark:text-red-400">
                            {error instanceof Error ? error.message : "Failed to discover specs"}
                          </p>
                        </div>
                      )}

                      {showEmptyDiscovery && (
                        <div className="rounded-lg border border-dashed border-stone-200 dark:border-stone-800/60 px-4 py-5 text-center">
                          <p className="text-sm text-stone-500 dark:text-stone-400">
                            No specs found in this project.
                          </p>
                          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                            Add a{" "}
                            <code className="font-mono">
                              .specifications/&lt;slug&gt;/test-cases.json
                            </code>{" "}
                            or enter a path below.
                          </p>
                        </div>
                      )}

                      {showInvalidSpecs && (
                        <div className="rounded-lg border border-amber-300/60 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5 space-y-2">
                          <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                            <span>
                              {invalidSpecs.length === 1
                                ? "1 spec file does not match the schema and was skipped:"
                                : `${invalidSpecs.length} spec files do not match the schema and were skipped:`}
                            </span>
                          </p>
                          <ul className="space-y-1.5">
                            {invalidSpecs.map((spec) => (
                              <li key={spec.path} className="text-xs">
                                <p className="font-medium text-stone-700 dark:text-stone-300">
                                  {spec.slug}
                                </p>
                                <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400 truncate">
                                  {spec.path}
                                </p>
                                <ul className="mt-0.5 list-disc pl-4 text-[11px] text-amber-700/90 dark:text-amber-400/90">
                                  {spec.errors.slice(0, 3).map((err, i) => (
                                    <li key={i}>{err}</li>
                                  ))}
                                  {spec.errors.length > 3 && (
                                    <li className="list-none text-stone-500 dark:text-stone-400">
                                      +{spec.errors.length - 3} more
                                    </li>
                                  )}
                                </ul>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Every discovered spec is all-passed (#484, TSPF-FR-007):
                      an explicit message fills the main space instead of a blank
                      list, pointing at the completed group below and the
                      manual-path field. Rendered above the group so the collapsed
                      all-passed disclosure sits beneath it. */}
                      {showAllPassedEmptyState && (
                        <div className="flex flex-col items-center text-center px-5 py-6">
                          <div className="w-10 h-10 flex items-center justify-center rounded-full bg-stone-100 dark:bg-stone-800 text-green-500 mb-3">
                            <Check size={20} strokeWidth={2.5} aria-hidden />
                          </div>
                          <p className="text-[15px] font-semibold text-stone-800 dark:text-stone-200">
                            Every discovered spec has all test cases passed
                          </p>
                          <p className="mt-1 max-w-[380px] text-[13px] text-stone-600 dark:text-stone-400">
                            Browse the completed specs below, or point a TestBench at a
                            test-cases.json by hand.
                          </p>
                        </div>
                      )}

                      {!isLoading && !isError && (specs?.length ?? 0) > 0 && (
                        <ToggleButtonGroup
                          aria-label="Discovered specs"
                          selectionMode="single"
                          selectedKeys={
                            manualPath.trim().length === 0 && selectedDiscoveredPath
                              ? [selectedDiscoveredPath]
                              : []
                          }
                          onSelectionChange={(keys) => {
                            const next = [...keys][0];
                            setManualPath("");
                            setSelectedDiscoveredPath(typeof next === "string" ? next : null);
                          }}
                          className="flex flex-col gap-1.5"
                        >
                          {/* Needs-attention specs fill the main space at full strength. */}
                          {needsAttention.map((spec) => renderRow(spec, false))}

                          {/* All-passed specs are relegated to a single quiet tail
                          disclosure, collapsed by default. The disclosure is a
                          plain Button interspersed in the group (never a
                          ToggleButton), so it is not part of the single
                          selection; the all-passed rows it reveals share the same
                          controlled group, so exactly one row is ever selected
                          across both. */}
                          {allPassed.length > 0 && (
                            <>
                              <Button
                                aria-expanded={allPassedExpanded}
                                onPress={() => setAllPassedExpanded((open) => !open)}
                                className={({ isHovered, isPressed, isFocusVisible }) =>
                                  `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-stone-500 dark:text-stone-400 outline-none transition-colors ${
                                    isPressed
                                      ? "bg-stone-200 dark:bg-stone-700/60"
                                      : isHovered
                                        ? "bg-stone-100 dark:bg-stone-800/60"
                                        : ""
                                  } ${
                                    isFocusVisible
                                      ? "ring-2 ring-amber-500 ring-offset-2 dark:ring-offset-stone-900"
                                      : ""
                                  }`
                                }
                              >
                                <ChevronRight
                                  size={14}
                                  aria-hidden
                                  className={`shrink-0 text-stone-500 dark:text-stone-400 transition-transform duration-200 ${
                                    allPassedExpanded ? "rotate-90" : ""
                                  }`}
                                />
                                <span>
                                  All passed{" "}
                                  <span className="font-normal text-stone-500 dark:text-stone-400">
                                    · {allPassed.length} spec{allPassed.length === 1 ? "" : "s"}
                                  </span>
                                </span>
                              </Button>
                              {allPassedExpanded && (
                                // role=group: aria-label is ARIA-prohibited on a
                                // role-less div (issue roubo-development#600).
                                <div
                                  role="group"
                                  aria-label="All passed specs"
                                  className="flex flex-col gap-1.5"
                                >
                                  {allPassed.map((spec) => renderRow(spec, true))}
                                </div>
                              )}
                            </>
                          )}

                          {/* Archived specs (#770, SATCA-FR-015/FR-016) sit behind
                          their own reveal control at the very tail, off by
                          default and reset off on close. Like the all-passed
                          disclosure the control is a plain Button interspersed in
                          the group (never a ToggleButton), so it takes no part in
                          the single selection, while the rows it reveals share
                          the same controlled group and stay selectable: an
                          archived spec can still be loaded into a bench. */}
                          {archived.length > 0 && (
                            <>
                              <Button
                                aria-pressed={showArchived}
                                aria-expanded={showArchived}
                                aria-controls={archivedGroupId}
                                onPress={() => setShowArchived((open) => !open)}
                                className={({ isHovered, isPressed, isFocusVisible }) =>
                                  `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-stone-500 dark:text-stone-400 outline-none transition-colors ${
                                    isPressed
                                      ? "bg-stone-200 dark:bg-stone-700/60"
                                      : isHovered
                                        ? "bg-stone-100 dark:bg-stone-800/60"
                                        : ""
                                  } ${
                                    isFocusVisible
                                      ? "ring-2 ring-amber-500 ring-offset-2 dark:ring-offset-stone-900"
                                      : ""
                                  }`
                                }
                              >
                                <Archive
                                  size={14}
                                  aria-hidden
                                  className="shrink-0 text-stone-500 dark:text-stone-400"
                                />
                                <span>
                                  Show archived{" "}
                                  <span className="font-normal text-stone-500 dark:text-stone-400">
                                    · {archived.length} spec{archived.length === 1 ? "" : "s"}
                                  </span>
                                </span>
                              </Button>
                              {/* What the reveal did to the list, in words
                                  (#775, AC2). aria-pressed alone tells a screen
                                  reader the control's own state; this says what
                                  changed below it, which is the thing the
                                  reviewer cannot see happen. Always mounted so
                                  the region exists before its text changes. */}
                              <div
                                aria-live="polite"
                                data-testid="archived-reveal-status"
                                className="sr-only"
                              >
                                {showArchived
                                  ? `${archived.length} archived spec${
                                      archived.length === 1 ? "" : "s"
                                    } shown`
                                  : "Archived specs hidden"}
                              </div>
                              {showArchived && (
                                // role=group: aria-label is ARIA-prohibited on a
                                // role-less div (issue roubo-development#600).
                                <div
                                  id={archivedGroupId}
                                  role="group"
                                  aria-label="Archived specs"
                                  className="flex flex-col gap-1.5"
                                >
                                  {archived.map((spec) => renderRow(spec, true))}
                                </div>
                              )}
                            </>
                          )}
                        </ToggleButtonGroup>
                      )}
                    </div>

                    {/* Manual path escape hatch */}
                    <TextField
                      value={manualPath}
                      onChange={setManualPath}
                      aria-describedby="manual-path-status"
                    >
                      <Label className="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1.5">
                        Or enter a path
                      </Label>
                      <Input
                        placeholder=".specifications/<slug>/test-cases.json"
                        className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm font-mono text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                      <div
                        id="manual-path-status"
                        className="mt-1.5 min-h-[1.25rem] text-xs"
                        aria-live="polite"
                      >
                        {manualState.status === "validating" && (
                          <span className="flex items-center gap-1.5 text-stone-500 dark:text-stone-400">
                            <Loader2 size={12} className="animate-spin" />
                            Validating...
                          </span>
                        )}
                        {manualState.status === "valid" && (
                          <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                            <Check size={12} />
                            Valid: {manualState.slug} ({manualState.caseCount}{" "}
                            {manualState.caseCount === 1 ? "case" : "cases"})
                          </span>
                        )}
                        {manualState.status === "invalid" && (
                          <span className="flex items-start gap-1.5 text-red-600 dark:text-red-400">
                            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                            <span>{manualState.errors.join("; ")}</span>
                          </span>
                        )}
                      </div>
                    </TextField>
                  </div>

                  {/* Restore is applied straight from the menu and never opens a
                      confirm step, so a refused reversal has no confirm-step
                      error region to land in. This one sits in the list view,
                      outside the scrolling body so it cannot be scrolled out of
                      sight, and is what makes a failed Restore visible at all. */}
                  <div aria-live="polite">
                    {lifecycleError && (
                      <p className="flex items-start gap-1.5 px-5 pb-3 text-xs text-red-600 dark:text-red-400">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" aria-hidden />
                        <span>{lifecycleError}</span>
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                    <Button
                      onPress={() => {
                        reset();
                        close();
                      }}
                      className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={handleCreate}
                      isDisabled={!canCreate}
                      className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors outline-none"
                    >
                      {isCreating ? copy.busyLabel : copy.confirmLabel}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
