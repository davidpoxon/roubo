import { useId, useRef, useState } from "react";
import {
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  Button,
  Menu,
  MenuItem,
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
          className="w-2 h-2 rounded-full border-[1.5px] border-status-idle shrink-0"
        />
      );
    case "stale":
      return <AlertTriangle size={12} aria-hidden className="text-accent-text shrink-0" />;
    case "passed":
      return <span aria-hidden className="w-2 h-2 rounded-full bg-status-active shrink-0" />;
    case "failed":
      return <span aria-hidden className="w-2 h-2 rounded-full bg-status-error shrink-0" />;
    case "progress":
    default:
      return <span aria-hidden className="w-2 h-2 rounded-full bg-status-preparing shrink-0" />;
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
  "flex items-start gap-2.5 px-3 py-2 rounded-chip text-12 cursor-default outline-none transition-colors text-text-secondary data-[focused]:bg-bg-hover data-[focused]:text-text-primary";

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
  // The one row-actions menu, shared by every row (#773). Each row renders only a
  // native trigger button; the spec whose menu is open and the button it anchors
  // to live here. A react-aria MenuTrigger + Button per row made the triggers
  // about 40% of the cost of opening the picker on a 25-spec payload
  // (TSPF-NFR-002), for a menu that is closed on every row but one.
  //
  // The open menu is held as the row's PATH, and the spec is looked up in the live
  // list on every render, the way a per-row menu read its own row: a refetch that
  // changes the spec's lifecycle changes the items offered, and one that drops the
  // row closes the menu rather than leaving it anchored to an unmounted button.
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null);
  // Which item takes focus on open: the last one when ArrowUp opened the menu,
  // the first otherwise (the menu-button pattern a MenuTrigger implements).
  const [menuFocus, setMenuFocus] = useState<"first" | "last">("first");
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const menuSpec =
    openMenuPath === null ? null : (specs?.find((s) => s.path === openMenuPath) ?? null);
  const closeRowMenu = () => setOpenMenuPath(null);

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
    closeRowMenu();
    menuTriggerRef.current = null;
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
  // rows via colour hierarchy (the slug drops to text-secondary). Every text
  // class holds the AA floor (text-secondary clears 4.5:1 on the modal's
  // bg-surface in both themes); the path sits at that floor in both
  // groups, so muting collapses there and the hierarchy reads via the slug (#493).
  const openRowMenu = (
    trigger: HTMLButtonElement,
    spec: DiscoveredSpec,
    focus: "first" | "last" = "first",
  ) => {
    menuTriggerRef.current = trigger;
    setMenuFocus(focus);
    setOpenMenuPath(spec.path);
  };

  const renderRow = (spec: DiscoveredSpec, muted: boolean) => {
    const isSelected = manualPath.trim().length === 0 && selectedDiscoveredPath === spec.path;
    const isActive = mode === "repoint" && spec.path === activePath;
    const summary = deriveSpecSummary(spec);
    // Archived rows (only ever rendered inside the revealed archived group) carry
    // a text label distinguishing a superseded spec from a merely archived one,
    // plus the superseding slug and any recorded reason (#770, SATCA-FR-016).
    const archivedLabel = spec.lifecycle.archived ? deriveArchivedLabel(spec) : null;
    // The lifecycle actions trigger is a SIBLING of the toggle, never a child of
    // it: a row is a single ToggleButton, and nesting a menu trigger inside one
    // would nest interactive elements. Both sit in a flex row so they still read
    // as one line (#773, SATCA-FR-020/FR-021). The menu itself is rendered once,
    // below, and anchors to whichever trigger opened it.
    const toggle = (
      <ToggleButton
        id={spec.path}
        className={`flex-1 min-w-0 flex items-start gap-3 px-3 py-2.5 rounded-control border text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
          isSelected
            ? "border-accent-border bg-accent-muted"
            : "border-border hover:border-border-strong hover:bg-bg-hover"
        }`}
      >
        <FileText size={14} className="shrink-0 mt-0.5 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-13 font-medium">
            <span className={`truncate ${muted ? "text-text-secondary" : "text-text-primary"}`}>
              {spec.slug}
            </span>
            {isActive && (
              <span className="shrink-0 text-11 font-semibold uppercase tracking-label text-accent-text bg-accent-muted rounded-full px-1.5 py-0.5">
                Active
              </span>
            )}
            {archivedLabel && (
              <span className="shrink-0 text-11 font-semibold uppercase tracking-label text-text-body bg-bg-pressed rounded-full px-1.5 py-0.5">
                {archivedLabel.label}
              </span>
            )}
          </p>
          <p className="text-11 font-mono truncate text-text-secondary">{spec.path}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-11 text-text-secondary">
            <SummaryMarker marker={summary.marker} />
            <span
              className={summary.marker === "stale" ? "font-medium text-accent-text" : undefined}
            >
              {summary.text}
            </span>
            {summary.failed > 0 && (
              <span className="font-medium text-danger-text">· {summary.failed} failed</span>
            )}
          </p>
          {archivedLabel?.supersededBy && (
            <p className="mt-0.5 text-11 text-text-secondary">
              Superseded by <span className="font-mono">{archivedLabel.supersededBy}</span>
            </p>
          )}
          {archivedLabel?.reason && (
            <p className="mt-0.5 text-11 text-text-secondary">{archivedLabel.reason}</p>
          )}
        </div>
        <span className="shrink-0 text-11 font-medium text-text-secondary bg-bg-hover rounded-full px-2 py-0.5">
          {spec.caseCount} {spec.caseCount === 1 ? "case" : "cases"}
        </span>
        {isSelected && <Check size={14} className="text-accent shrink-0 mt-0.5" />}
      </ToggleButton>
    );

    return (
      <div key={spec.path} className="flex items-start gap-1">
        {toggle}
        <button
          type="button"
          aria-label={`Actions for ${spec.slug}`}
          aria-haspopup="menu"
          aria-expanded={menuSpec?.path === spec.path}
          aria-controls={menuSpec?.path === spec.path ? menuId : undefined}
          onClick={(event) => openRowMenu(event.currentTarget, spec)}
          onKeyDown={(event) => {
            // Match the menu-button pattern: the arrow keys open the menu too,
            // ArrowDown onto its first item and ArrowUp onto its last.
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              openRowMenu(event.currentTarget, spec, event.key === "ArrowUp" ? "last" : "first");
            }
          }}
          className="shrink-0 mt-1 p-1.5 rounded-control outline-none transition-colors text-text-secondary hover:bg-bg-hover active:bg-bg-pressed active:text-text-body focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <EllipsisVertical size={14} aria-hidden />
        </button>
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-lg mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-border">
                <Heading
                  slot="title"
                  className="flex items-center gap-2 text-16 font-semibold text-text-primary"
                >
                  {pendingAction ? (
                    pendingAction.kind === "archive" ? (
                      <Archive size={16} className="text-accent-text" />
                    ) : (
                      <Replace size={16} className="text-accent-text" />
                    )
                  ) : (
                    <FlaskConical size={16} className="text-accent-text" />
                  )}
                  {pendingAction ? LIFECYCLE_COPY[pendingAction.kind].title : copy.title}
                </Heading>
                <p className="mt-1 text-12 text-text-secondary">
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
                    <p className="text-13 text-text-body">
                      <span className="font-mono">{pendingAction.spec.slug}</span>
                    </p>

                    {pendingAction.kind === "archive" && (
                      <TextField value={archiveReason} onChange={setArchiveReason}>
                        <Label className="block text-12 font-medium text-text-secondary mb-1.5">
                          Reason (optional)
                        </Label>
                        <Input
                          placeholder="Shipped in #212, all issues closed"
                          className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
                        />
                      </TextField>
                    )}

                    {pendingAction.kind === "supersede" && (
                      <div>
                        <p
                          id="supersede-target-label"
                          className="block text-12 font-medium text-text-secondary mb-1.5"
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
                          <p className="mt-1.5 text-12 text-text-secondary">
                            This project has no other specification to point at.
                          </p>
                        )}
                      </div>
                    )}

                    <p className="text-12 text-text-secondary">
                      Written to{" "}
                      <code className="font-mono">
                        .specifications/{pendingAction.spec.slug}/manifest.json
                      </code>
                      . Left uncommitted for you to review.
                    </p>

                    <div aria-live="polite">
                      {lifecycleError && (
                        <p className="flex items-start gap-1.5 text-12 text-danger-text">
                          <AlertTriangle size={12} className="shrink-0 mt-0.5" aria-hidden />
                          <span>{lifecycleError}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
                    <Button
                      onPress={dismissPending}
                      className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={confirmPending}
                      isDisabled={
                        lifecycleMutation.isPending ||
                        (pendingAction.kind === "supersede" && supersedeTarget.length === 0)
                      }
                      className="flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface not-disabled:active:bg-accent-active"
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
                      <p className="text-12 font-medium text-text-secondary">Discovered specs</p>

                      {isLoading && (
                        <div className="flex items-center gap-2 text-13 text-text-secondary py-3">
                          <Spinner />
                          Discovering specs...
                        </div>
                      )}

                      {isError && (
                        <div className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-surface px-3 py-2">
                          <AlertTriangle size={14} className="text-danger-text shrink-0 mt-0.5" />
                          <p className="text-13 text-danger-text">
                            {error instanceof Error ? error.message : "Failed to discover specs"}
                          </p>
                        </div>
                      )}

                      {showEmptyDiscovery && (
                        <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center">
                          <p className="text-13 text-text-secondary">
                            No specs found in this project.
                          </p>
                          <p className="mt-1 text-12 text-text-secondary">
                            Add a{" "}
                            <code className="font-mono">
                              .specifications/&lt;slug&gt;/test-cases.json
                            </code>{" "}
                            or enter a path below.
                          </p>
                        </div>
                      )}

                      {showInvalidSpecs && (
                        <div className="rounded-lg border border-accent-border bg-accent-muted px-3 py-2.5 space-y-2">
                          <p className="flex items-start gap-1.5 text-12 font-medium text-accent-text">
                            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                            <span>
                              {invalidSpecs.length === 1
                                ? "1 spec file does not match the schema and was skipped:"
                                : `${invalidSpecs.length} spec files do not match the schema and were skipped:`}
                            </span>
                          </p>
                          <ul className="space-y-1.5">
                            {invalidSpecs.map((spec) => (
                              <li key={spec.path} className="text-12">
                                <p className="font-medium text-text-body">{spec.slug}</p>
                                <p className="font-mono text-11 text-text-secondary truncate">
                                  {spec.path}
                                </p>
                                <ul className="mt-0.5 list-disc pl-4 text-11 text-accent-text">
                                  {spec.errors.slice(0, 3).map((err, i) => (
                                    <li key={i}>{err}</li>
                                  ))}
                                  {spec.errors.length > 3 && (
                                    <li className="list-none text-text-secondary">
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
                          <div className="w-10 h-10 flex items-center justify-center rounded-full bg-bg-hover text-success-text mb-3">
                            <Check size={16} strokeWidth={2.5} aria-hidden />
                          </div>
                          <p className="text-14 font-semibold text-text-primary">
                            Every discovered spec has all test cases passed
                          </p>
                          <p className="mt-1 max-w-[380px] text-13 text-text-secondary">
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
                                  `w-full flex items-center gap-2 px-3 py-2 rounded-control text-13 font-medium outline-none transition-colors ${
                                    isPressed
                                      ? "bg-bg-pressed text-text-body"
                                      : isHovered
                                        ? "bg-bg-hover text-text-secondary"
                                        : "text-text-secondary"
                                  } ${
                                    isFocusVisible
                                      ? "ring-2 ring-focus-ring ring-offset-2 ring-offset-bg-surface"
                                      : ""
                                  }`
                                }
                              >
                                <ChevronRight
                                  size={14}
                                  aria-hidden
                                  className={`shrink-0 transition-transform duration-200 ${
                                    allPassedExpanded ? "rotate-90" : ""
                                  }`}
                                />
                                <span>
                                  All passed{" "}
                                  <span className="font-normal">
                                    · {allPassed.length} spec{allPassed.length === 1 ? "" : "s"}
                                  </span>
                                </span>
                              </Button>
                              {allPassedExpanded && (
                                // role=group: aria-label is ARIA-prohibited on a
                                // role-less div (#967).
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
                                  `w-full flex items-center gap-2 px-3 py-2 rounded-control text-13 font-medium outline-none transition-colors ${
                                    isPressed
                                      ? "bg-bg-pressed text-text-body"
                                      : isHovered
                                        ? "bg-bg-hover text-text-secondary"
                                        : "text-text-secondary"
                                  } ${
                                    isFocusVisible
                                      ? "ring-2 ring-focus-ring ring-offset-2 ring-offset-bg-surface"
                                      : ""
                                  }`
                                }
                              >
                                <Archive size={14} aria-hidden className="shrink-0" />
                                <span>
                                  Show archived{" "}
                                  <span className="font-normal">
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
                                // role-less div (#967).
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
                      <Label className="block text-12 font-medium text-text-secondary mb-1.5">
                        Or enter a path
                      </Label>
                      <Input
                        placeholder=".specifications/<slug>/test-cases.json"
                        className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 font-mono text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
                      />
                      <div
                        id="manual-path-status"
                        className="mt-1.5 min-h-[1.25rem] text-12"
                        aria-live="polite"
                      >
                        {manualState.status === "validating" && (
                          <span className="flex items-center gap-1.5 text-text-secondary">
                            <Loader2 size={12} className="animate-spin" />
                            Validating...
                          </span>
                        )}
                        {manualState.status === "valid" && (
                          <span className="flex items-center gap-1.5 text-success-text">
                            <Check size={12} />
                            Valid: {manualState.slug} ({manualState.caseCount}{" "}
                            {manualState.caseCount === 1 ? "case" : "cases"})
                          </span>
                        )}
                        {manualState.status === "invalid" && (
                          <span className="flex items-start gap-1.5 text-danger-text">
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
                      <p className="flex items-start gap-1.5 px-5 pb-3 text-12 text-danger-text">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" aria-hidden />
                        <span>{lifecycleError}</span>
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
                    <Button
                      onPress={() => {
                        reset();
                        close();
                      }}
                      className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={handleCreate}
                      isDisabled={!canCreate}
                      className="flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-control transition-colors outline-none not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      {isCreating ? copy.busyLabel : copy.confirmLabel}
                    </Button>
                  </div>
                </>
              )}
              <Popover
                triggerRef={menuTriggerRef}
                // The popover renders as a dialog, which needs a name. Under a
                // MenuTrigger it was labelled by its trigger; say the same thing here.
                aria-label={menuSpec ? `Actions for ${menuSpec.slug}` : undefined}
                isOpen={menuSpec !== null}
                onOpenChange={(open) => {
                  if (!open) closeRowMenu();
                }}
                placement="bottom end"
                offset={4}
                className="animate-rise-in bg-bg-surface border border-border rounded-control shadow-elevation-0 p-1 min-w-[11rem]"
              >
                {menuSpec && (
                  <Menu
                    aria-label={`Actions for ${menuSpec.slug}`}
                    id={menuId}
                    autoFocus={menuFocus}
                    className="outline-none"
                    onAction={(key) => {
                      const spec = menuSpec;
                      closeRowMenu();
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
                    {menuSpec.lifecycle.archived ? (
                      <MenuItem id="restore" className={LIFECYCLE_MENU_ITEM_CLASS}>
                        <ArchiveRestore size={14} className="shrink-0" aria-hidden />
                        <span>
                          Restore
                          <span className="block text-11 text-text-secondary">
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
                )}
              </Popover>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
