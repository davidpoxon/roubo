import { useEffect, useId, useRef, useState } from "react";
import { Button, Input, Label, TextField, ToggleButton } from "react-aria-components";
import { X, ArrowRight, StickyNote, ChevronDown, Bot, Archive } from "lucide-react";
import type { Case, CaseResult } from "@roubo/shared/testbench-contracts";
import StatusIndicator from "./StatusIndicator";
import ObservationMarkControl from "./ObservationMarkControl";
import StatusOverrideControl from "./StatusOverrideControl";
import { NotesRail } from "./NotesRail";
import ReplacementPicker from "./ReplacementPicker";
import { caseObservationProgress } from "./rollup";
import { useElementWidth } from "./useElementWidth";
import { useMarkObservation, useSetStatusOverride } from "../../hooks/useTestbenchMarks";
import { caseLifecycleErrorMessage, useSetCaseLifecycle } from "../../hooks/useTestbenchPlan";

// The case-detail pane must be at least this wide (px) before the notes show as
// an inline side rail; below it the notes collapse into the bottom drawer. This
// is measured on the pane's own container (#524), not the viewport, so the rail
// only appears when the detail pane genuinely has room for a comfortable split.
// Collapsing the case list or the projects sidebar widens this container, which
// crosses the threshold and brings the inline rail back. Tunable single knob.
const NOTES_RAIL_MIN_WIDTH = 680;

// Case detail pane (#420, FR-007/FR-008/FR-009/FR-010, US-003/US-004/US-005).
//
// Renders one case in full: title, id/level/priority, preconditions, ordered
// steps, and each expected observation with a segmented pass/fail mark control.
// Per-case status derives live from the marks (server-recomputed derivedStatus)
// and is manually overridable via the status override control, with the override
// shown distinctly and taking precedence over later marks.
//
// The server is the source of truth: mark/override mutations PUT to the already-
// shipped #416 routes and return the authoritative CaseResult; the displayed
// status is statusOverride ?? derivedStatus. Optimistic cache updates in the
// mutation hooks keep the round-trip under 150ms (NFR-004) without a blocking
// refetch.
//
// Layout (#508, #522, #524): the case body and the notes sit in an internal
// split. When the detail pane's own container is wide enough (measured at
// runtime, not via a viewport breakpoint) the notes are a fixed right-hand side
// rail. When the container is narrower than NOTES_RAIL_MIN_WIDTH the rail is
// replaced by a bottom drawer: a "Notes (n)" toggle at the foot of the pane
// opens a CSS-positioned panel anchored to the bottom (no scrim, no modal
// overlay), so the steps get the full width while the drawer is closed. Exactly
// one notes surface renders at a time. A Close (X) button dismisses the pane;
// when the case reaches "passed" a Next button advances to the next case.

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface CaseDetailProps {
  projectId: string;
  benchId: number;
  testCase: Case;
  // The recorded result for this case, or undefined when nothing is marked yet.
  result: CaseResult | undefined;
  // Invoked when the reviewer dismisses the detail (closes the pane).
  onBack?: () => void;
  // Invoked to advance to the next case; only offered when the case is passed
  // and a next case exists (#508).
  onNext?: () => void;
  // Invoked after a mark or status-override write settles (#702, AC2). The batch
  // view uses this to invalidate the open gate's state so the gate-state panel
  // live-updates (pending / failed / passed / stale) as cases are marked. The
  // plain TestBench panel omits it, so existing behaviour is unchanged.
  onMarked?: () => void;
  // Invoked once a retire or supersede write succeeds (#775, AC4). The case has
  // just left the live list, which unmounts the control that applied the action,
  // so the panel uses this to move focus onto the archived entry the case landed
  // in and to announce the outcome. Omitted in a read-only render.
  onArchived?: (caseId: string) => void;
}

const SECTION_LABEL =
  "font-mono text-[11px] uppercase tracking-wider text-stone-500 dark:text-stone-500 mt-6 mb-2";

// Human gloss for the machine-verification method ladder (see
// VerificationSchema in shared/testbench-contracts.ts): the decisive tier that
// produced the case's derivedStatus when an external engine verified it.
const TIER_LABELS: Record<string, string> = {
  a: "drove the running system",
  b: "suite corroboration",
  c: "throwaway probe",
  d: "static inspection",
};

export default function CaseDetail({
  projectId,
  benchId,
  testCase,
  result,
  onBack,
  onNext,
  onMarked,
  onArchived,
}: CaseDetailProps) {
  const markObservation = useMarkObservation();
  const setStatusOverride = useSetStatusOverride();

  const derivedStatus = result?.derivedStatus ?? "not_started";
  const override = result?.statusOverride?.status;
  const effectiveStatus = override ?? derivedStatus;
  const marks = result?.observationMarks ?? {};
  const progress = caseObservationProgress(testCase, result);
  const showNext = effectiveStatus === "passed" && onNext !== undefined;

  const notes = result?.notes ?? [];
  const verification = result?.verification;

  // The left column scrolls independently. React reuses this DOM node across
  // case changes, so without resetting it the panel keeps the prior case's
  // scroll offset; reset to the top whenever the displayed case changes (#522).
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [testCase.id]);

  // Decide the notes layout from the space available to this pane (#524). The
  // measured width gates inline-rail vs bottom-drawer: collapsing the case list
  // or the projects sidebar widens this container and flips it back to the rail.
  const rootRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(rootRef);
  const showInlineRail = paneWidth >= NOTES_RAIL_MIN_WIDTH;

  return (
    <div
      ref={rootRef}
      // role=region: aria-label is ARIA-prohibited on a role-less div (issue
      // roubo-development#600), and the detail pane is a significant, navigable
      // surface worth a labelled landmark.
      role="region"
      className="relative flex flex-col min-h-0 flex-1"
      aria-label={`Case detail: ${testCase.title}`}
    >
      {(onBack || showNext) && (
        <div className="flex items-center justify-between gap-3 shrink-0">
          {showNext ? (
            <Button
              onPress={onNext}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 rounded-md px-2 py-1 outline-none transition-colors hover:bg-amber-50 dark:hover:bg-amber-950/30 focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              Next case
              <ArrowRight aria-hidden="true" className="w-4 h-4" />
            </Button>
          ) : (
            <span />
          )}
          {onBack && (
            <Button
              aria-label="Close case detail"
              onPress={onBack}
              className="inline-flex items-center justify-center text-stone-500 dark:text-stone-400 rounded-md p-1 outline-none transition-colors hover:text-stone-700 hover:bg-stone-100 dark:hover:text-stone-200 dark:hover:bg-stone-800 focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <X aria-hidden="true" className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}

      {/* Two-column split when the pane is wide enough: the case body scrolls on
          the left, notes sit in a right-hand side rail. When the pane is narrow
          the rail is replaced by a bottom drawer (rendered after this row) so the
          steps get the full width (#508, #522, #524). */}
      <div
        className={`flex min-h-0 flex-1 mt-2 ${
          showInlineRail ? "flex-row gap-6" : "flex-col gap-4"
        }`}
      >
        <div
          ref={scrollRef}
          className={`flex flex-col min-h-0 flex-1 overflow-auto pr-1 ${
            showInlineRail ? "basis-3/5" : ""
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
                {testCase.title}
              </h2>
              <div className="flex items-center gap-3 mt-1 font-mono text-[11px] text-stone-400 dark:text-stone-600">
                <span>{testCase.id}</span>
                <span>L{testCase.level}</span>
                <span>{testCase.type}</span>
                <span>{testCase.area}</span>
                {testCase.priority && <span>{testCase.priority}</span>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <StatusIndicator status={effectiveStatus} />
              <StatusOverrideControl
                derivedStatus={derivedStatus}
                override={override}
                isDisabled={setStatusOverride.isPending}
                onChange={(next) =>
                  setStatusOverride.mutate(
                    {
                      projectId,
                      benchId,
                      caseId: testCase.id,
                      override: next,
                    },
                    { onSettled: () => onMarked?.() },
                  )
                }
              />
              {verification && (
                <span
                  title={`Machine-verified: ${TIER_LABELS[verification.tier] ?? verification.tier} at ${verification.confidence} confidence`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-stone-100/80 dark:bg-stone-800/50 px-2 py-0.5 font-mono text-[11px] text-stone-500 dark:text-stone-400"
                >
                  <Bot className="w-3 h-3 shrink-0" aria-hidden />
                  tier {verification.tier} · {verification.confidence}
                </span>
              )}
            </div>
          </div>

          {/* Per-case observation progress (#508), distinct from the overall and
              per-level case rollups. role=status: aria-label is ARIA-prohibited
              on a role-less div (issue roubo-development#600), and the chip is a
              status readout that updates as observations are marked. */}
          <div
            role="status"
            className="mt-3 inline-flex items-center gap-2 self-start rounded-md bg-stone-100/80 dark:bg-stone-800/50 px-2.5 py-1 font-mono text-[11px] text-stone-500 dark:text-stone-400 tabular-nums"
            aria-label={`${progress.marked} of ${progress.total} observations marked`}
          >
            <span className="text-stone-700 dark:text-stone-300">
              {progress.marked}/{progress.total}
            </span>
            <span>observations marked</span>
          </div>

          {testCase.preconditions && testCase.preconditions.length > 0 && (
            <>
              <div className={SECTION_LABEL}>Preconditions</div>
              <ul className="flex flex-col gap-1">
                {testCase.preconditions.map((pre, i) => (
                  <li
                    key={i}
                    className="relative pl-4 text-[13px] text-stone-600 dark:text-stone-400 before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-stone-300 dark:before:bg-stone-600"
                  >
                    {pre}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className={SECTION_LABEL}>Steps and expected observations</div>
          <ol className="flex flex-col">
            {testCase.steps.map((step, index) => (
              <li
                key={step.id}
                className="py-3.5 border-t border-stone-100 dark:border-stone-800 first:border-t-0"
              >
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-xs text-stone-400 dark:text-stone-600 shrink-0">
                    {index + 1}
                  </span>
                  <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
                    {step.instruction}
                  </span>
                </div>
                <ul className="flex flex-col gap-2 mt-2.5 ml-6">
                  {step.observations.map((observation) => {
                    const mark = marks[observation.id];
                    return (
                      <li key={observation.id} className="flex items-center gap-3">
                        <span className="flex-1 text-[13px] text-stone-700 dark:text-stone-300 min-w-0">
                          {observation.expected}
                        </span>
                        <span className="font-mono text-[11px] text-stone-400 dark:text-stone-600 tabular-nums min-w-[3.5rem] text-right">
                          {mark ? formatTimestamp(mark.timestamp) : ""}
                        </span>
                        <ObservationMarkControl
                          expected={observation.expected}
                          value={mark?.result}
                          isDisabled={markObservation.isPending}
                          onMark={(res) =>
                            markObservation.mutate(
                              {
                                projectId,
                                benchId,
                                caseId: testCase.id,
                                observationId: observation.id,
                                result: res,
                              },
                              { onSettled: () => onMarked?.() },
                            )
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>

          {/* Machine verification (external engine, e.g. product-dev:verify):
              the decisive method tier, confidence, and evidence pointers that
              produced the derivedStatus. Read-only provenance; marks and
              overrides above remain the human surface. */}
          {verification && (
            <>
              <div className={SECTION_LABEL}>Machine verification</div>
              <div className="flex flex-col gap-1.5">
                <div className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                  tier {verification.tier} ({TIER_LABELS[verification.tier] ?? "unknown tier"}) ·{" "}
                  {verification.confidence} confidence · {verification.author.name}
                </div>
                {verification.evidence.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {verification.evidence.map((pointer, i) => (
                      <li
                        key={i}
                        className="relative pl-4 font-mono text-[11px] text-stone-600 dark:text-stone-400 break-all before:absolute before:left-0 before:top-[7px] before:w-1.5 before:h-1.5 before:rounded-full before:bg-stone-300 dark:before:bg-stone-600"
                      >
                        {pointer}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {/* Lifecycle actions (#772): the write path into the spec's own case
              file, kept at the foot of the case body so the review surface
              (steps, marks, notes) stays first. */}
          <LifecycleControls
            projectId={projectId}
            benchId={benchId}
            testCase={testCase}
            onArchived={onArchived}
          />
        </div>

        {/* Inline side rail, only when the pane is wide enough (#524). When
            narrow this is omitted entirely and the bottom drawer below takes
            over, so exactly one notes surface renders at a time. */}
        {showInlineRail && (
          <div className="flex flex-col min-h-0 basis-2/5 border-l border-stone-100 dark:border-stone-800 pl-6">
            {/* The label is a pinned header; NotesRail fills the remaining height
                and scrolls its notes list internally so the "Add a note" form
                stays reachable on a short pane (#806). */}
            <div className={`${SECTION_LABEL} mt-0 shrink-0`}>Notes</div>
            <NotesRail projectId={projectId} benchId={benchId} caseId={testCase.id} notes={notes} />
          </div>
        )}
      </div>

      {/* Bottom notes drawer, only when the pane is too narrow for the inline
          rail (#524). Keyed by the case id so it remounts (and so resets to
          closed) whenever a different case is selected, keeping the steps
          full-width on arrival without a setState-in-effect (#522). */}
      {!showInlineRail && (
        <NotesDrawer
          key={testCase.id}
          projectId={projectId}
          benchId={benchId}
          caseId={testCase.id}
          notes={notes}
        />
      )}
    </div>
  );
}

const FIELD_CLASS =
  "w-full rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-1.5 text-[13px] text-stone-800 dark:text-stone-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-500";
const FIELD_LABEL_CLASS = "text-[11px] font-medium text-stone-600 dark:text-stone-400";
const ACTION_CLASS =
  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-stone-700 dark:text-stone-200 bg-stone-200/70 dark:bg-stone-800/70 hover:bg-stone-200 dark:hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed outline-none transition-colors focus-visible:ring-2 focus-visible:ring-amber-500";

// Lifecycle controls for one live case (#772, SATCA-FR-019, SATCA-US-006).
//
// Retire takes a required reason; supersede takes a required replacement pointer
// plus an optional reason. The pointer is never typed: it is chosen in the
// two-stage ReplacementPicker (#774, SATCA-FR-028/FR-029), which lists the cases
// that actually exist and refuses to hand back a pointer the shared resolver
// reports as unresolvable. What lands here is therefore always a slug-qualified
// (or deliberately bare, same-spec) pointer that resolved at authoring time.
//
// The reversal of either action does NOT live here. Retiring removes the case
// from the live list (the rollup routes it to the Archived section), so the
// surface that applied the action is not the surface that can reverse it;
// Restore sits on the archived entry, which is where the case is still visible.
//
// A 409 is rendered as a reload prompt rather than a generic failure: the case
// file moved under the request, and reloading is the only useful next step.
//
// Each action's form is a disclosure, not a dialog: it is an inline panel, so it
// declares itself with aria-expanded and aria-controls on the toggle that opens
// it rather than borrowing modal semantics it does not have (#775, AC1/AC3).
function LifecycleControls({
  projectId,
  benchId,
  testCase,
  onArchived,
}: {
  projectId: string;
  benchId: number;
  testCase: Case;
  onArchived?: (caseId: string) => void;
}) {
  const [open, setOpen] = useState<"retire" | "supersede" | null>(null);
  const [reason, setReason] = useState("");
  // The confirmed pointer handed back by the picker, never keyboard input.
  const [replacement, setReplacement] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  // AC7: whichever way the picker is dismissed (Cancel, Escape, the overlay, or
  // a confirmed choice), focus returns to the control that opened it. Restored
  // here rather than left to the overlay's own restoration: the overlay restores
  // to whatever held focus when it mounted, which is not necessarily this
  // button. A passive effect (not the close handler) is what makes it stick,
  // because the overlay's own restore runs in the unmount cleanup, after any
  // focus call made from the handler that closed it.
  const chooseRef = useRef<HTMLButtonElement>(null);
  const pickerWasOpen = useRef(false);
  const retirePanelId = useId();
  const supersedePanelId = useId();
  const setLifecycle = useSetCaseLifecycle();
  const error = caseLifecycleErrorMessage(setLifecycle.error);

  useEffect(() => {
    if (pickerWasOpen.current && !pickerOpen) chooseRef.current?.focus();
    pickerWasOpen.current = pickerOpen;
  }, [pickerOpen]);

  // An already-archived case is reversible from the Archived section, not here.
  if (testCase.lifecycle) {
    return (
      <>
        <div className={SECTION_LABEL}>Lifecycle</div>
        <p
          data-testid="case-lifecycle-archived"
          className="text-[12px] text-stone-500 dark:text-stone-400"
        >
          This case is {testCase.lifecycle.state}. Restore it from the Archived section below.
        </p>
      </>
    );
  }

  const canRetire = reason.trim().length > 0 && !setLifecycle.isPending;
  const canSupersede = replacement.trim().length > 0 && !setLifecycle.isPending;

  const apply = (lifecycle: Parameters<typeof setLifecycle.mutate>[0]["lifecycle"]) => {
    setLifecycle.mutate(
      { projectId, benchId, caseId: testCase.id, lifecycle },
      {
        onSuccess: () => {
          setOpen(null);
          setReason("");
          setReplacement("");
          // The case is no longer live, so this whole control block is about to
          // unmount. Hand the panel the id it needs to place focus and announce
          // the outcome, instead of letting focus fall to the body (AC4).
          onArchived?.(testCase.id);
        },
      },
    );
  };

  return (
    <>
      <div className={SECTION_LABEL}>Lifecycle</div>
      <div className="flex flex-col gap-2">
        <p className="text-[12px] text-stone-500 dark:text-stone-400">
          Retiring or superseding writes the record into the spec&apos;s case file and leaves the
          change uncommitted for review. Recorded marks and notes are kept.
        </p>
        <div className="flex items-center gap-2">
          <Button
            data-testid="case-retire-open"
            aria-expanded={open === "retire"}
            aria-controls={retirePanelId}
            onPress={() => setOpen(open === "retire" ? null : "retire")}
            className={ACTION_CLASS}
          >
            <Archive aria-hidden="true" className="w-3.5 h-3.5" />
            Retire
          </Button>
          <Button
            data-testid="case-supersede-open"
            aria-expanded={open === "supersede"}
            aria-controls={supersedePanelId}
            onPress={() => setOpen(open === "supersede" ? null : "supersede")}
            className={ACTION_CLASS}
          >
            <ArrowRight aria-hidden="true" className="w-3.5 h-3.5" />
            Supersede
          </Button>
        </div>

        {open === "retire" && (
          <div
            id={retirePanelId}
            data-testid="case-retire-panel"
            className="flex flex-col gap-2 rounded-md bg-stone-100/70 dark:bg-stone-800/40 p-3"
          >
            <TextField
              value={reason}
              onChange={setReason}
              isRequired
              className="flex flex-col gap-1"
            >
              <Label className={FIELD_LABEL_CLASS}>Reason for retiring</Label>
              <Input data-testid="case-retire-reason" className={FIELD_CLASS} />
            </TextField>
            <div>
              <Button
                data-testid="case-retire-submit"
                isDisabled={!canRetire}
                onPress={() => apply({ state: "retired", reason: reason.trim() })}
                className={ACTION_CLASS}
              >
                {setLifecycle.isPending ? "Retiring..." : "Retire case"}
              </Button>
            </div>
          </div>
        )}

        {open === "supersede" && (
          <div
            id={supersedePanelId}
            data-testid="case-supersede-panel"
            className="flex flex-col gap-2 rounded-md bg-stone-100/70 dark:bg-stone-800/40 p-3"
          >
            <div className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Replacement case</span>
              <div className="flex items-center gap-2">
                <Button
                  ref={chooseRef}
                  data-testid="case-supersede-choose"
                  onPress={() => setPickerOpen(true)}
                  className={ACTION_CLASS}
                >
                  {replacement.length > 0 ? "Change replacement" : "Choose replacement case"}
                </Button>
                <span
                  data-testid="case-supersede-replacement"
                  className="font-mono text-[12px] text-stone-600 dark:text-stone-300"
                >
                  {replacement.length > 0 ? replacement : "None chosen yet"}
                </span>
              </div>
            </div>
            <ReplacementPicker
              isOpen={pickerOpen}
              onClose={() => setPickerOpen(false)}
              projectId={projectId}
              benchId={benchId}
              originCaseId={testCase.id}
              originCaseArea={testCase.area}
              onConfirm={setReplacement}
            />
            <TextField value={reason} onChange={setReason} className="flex flex-col gap-1">
              <Label className={FIELD_LABEL_CLASS}>Reason (optional)</Label>
              <Input data-testid="case-supersede-reason" className={FIELD_CLASS} />
            </TextField>
            <div>
              <Button
                data-testid="case-supersede-submit"
                isDisabled={!canSupersede}
                onPress={() =>
                  apply(
                    reason.trim().length > 0
                      ? {
                          state: "superseded",
                          replacement: replacement.trim(),
                          reason: reason.trim(),
                        }
                      : { state: "superseded", replacement: replacement.trim() },
                  )
                }
                className={ACTION_CLASS}
              >
                {setLifecycle.isPending ? "Superseding..." : "Supersede case"}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            data-testid="case-lifecycle-error"
            className="text-[12px] text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </div>
    </>
  );
}

interface NotesDrawerProps {
  projectId: string;
  benchId: number;
  caseId: string;
  notes: CaseResult["notes"];
}

// Bottom notes drawer for a narrow detail pane (#524). A lightweight CSS panel
// anchored to the bottom of the detail pane, opened by a "Notes (n)" toggle:
// no scrim, no modal overlay (#522). The toggle sits in the normal flow at the
// foot of the pane; the panel is absolutely positioned above it so the steps
// keep the full width while the drawer is closed. State lives here (not in the
// parent) so a parent `key={caseId}` remount resets it to closed on case change.
function NotesDrawer({ projectId, benchId, caseId, notes }: NotesDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="shrink-0 mt-2 border-t border-stone-100 dark:border-stone-800 pt-2">
      <ToggleButton
        isSelected={isOpen}
        onChange={setIsOpen}
        aria-controls={panelId}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-stone-600 dark:text-stone-300 outline-none transition-colors hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-inset ${
          isOpen ? "bg-stone-100 dark:bg-stone-800" : ""
        }`}
      >
        <StickyNote aria-hidden="true" className="w-3.5 h-3.5" />
        Notes ({notes.length})
        <ChevronDown
          aria-hidden="true"
          className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
      </ToggleButton>
      <div id={panelId} hidden={!isOpen}>
        {isOpen && (
          <div className="absolute inset-x-0 bottom-12 z-20 max-h-[60%] overflow-auto rounded-t-lg border-t border-x border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900 px-4 pb-4 pt-3 shadow-lg">
            <div className={`${SECTION_LABEL} mt-0`}>Notes</div>
            <NotesRail projectId={projectId} benchId={benchId} caseId={caseId} notes={notes} />
          </div>
        )}
      </div>
    </div>
  );
}
