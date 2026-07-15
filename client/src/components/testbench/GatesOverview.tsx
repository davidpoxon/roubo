import { useState } from "react";
import { Button, Checkbox, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { AlertTriangle, ChevronRight, GitMerge, Split, X } from "lucide-react";
import type { GateState, InvalidGateSpec } from "../../lib/api";
import { ApiError } from "../../lib/api";
import { useGates, useMergeGates, useSplitGate } from "../../hooks/useGates";
import GateStateIndicator from "./GateStateIndicator";
import Spinner from "../Spinner";

// Gates overview (#702/#703, FR-001/FR-002/FR-012, AC1). One card per effective
// gate (one gate per phase by default, derived server-side; an operator merge /
// split replaces the affected cards). Each card shows the gate's id, its
// evaluated status, and the covering slice unit ids the unresolved gating cases
// trace to (the gate's `covers`, per FR-012).
//
// Operator override (#703, FR-002, US-007): the toolbar exposes a merge mode
// (select two or more gates, then combine them into one) and each non-passed
// gate exposes a split control (assign its covering WU- ids to two parts). Both
// write through the gate-override store server-side, leaving the externally
// authored work-units.json untouched. The server guards a signed-off (passed)
// gate with a 409, which the controls surface inline (AC3).
//
// Live-update: the list is React Query backed; the merge / split mutations
// invalidate the gates query so the combined / split cards replace the originals
// on success (TC-022 S001-O01, TC-023 S001-O01).

const STRINGS = {
  // The gate's covering work units (what its unresolved cases trace to). This is
  // NOT the upstream blocker line: it lists the gate's OWN covers (issue #433
  // relabel, previously mislabeled "Blocked by").
  covers: "Covers",
  // The genuine upstream dependency line: verify gates this phase is blocked by
  // until they are signed off (issue #433, FR-001).
  blockedByUpstream: "Blocked by",
  gatingCount: (n: number) => `${n} gating ${n === 1 ? "case" : "cases"}`,
  mergeMode: "Merge",
  mergeCancel: "Cancel",
  mergeHint: "Select two or more gates to combine, then confirm.",
  mergeConfirm: (n: number) => `Combine ${n} gates`,
  split: "Split",
  splitTitle: (gateId: string) => `Split ${gateId}`,
  splitIntro:
    "Assign each covering work unit to part A or part B. Every unit must be assigned to exactly one part.",
  splitPartA: "Part A",
  splitPartB: "Part B",
  splitCancel: "Cancel",
  splitConfirm: "Split into two gates",
  splitting: "Splitting…",
  merging: "Combining…",
  noCovers:
    "This gate exposes no covering work units to split on. Splitting needs at least two assignable units.",
  invalidTitle: (n: number) =>
    n === 1
      ? "1 spec has an invalid work-units.json and was skipped"
      : `${n} specs have an invalid work-units.json and were skipped`,
};

// Warning banner for present-but-invalid specs (#371). A spec whose work-units.json
// exists but fails contract validation is skipped by the aggregate load (the #802
// per-spec resilience), which previously left the operator with only the bare "no
// verify gates yet" empty state. This surfaces each skipped spec by slug plus its
// validation messages so the misconfiguration is actionable, not silent. It is a
// non-interactive status region (role="alert"), so it uses a styled element in the
// codebase's amber warning idiom rather than a React Aria interactive component.
function InvalidSpecsWarning({ invalidSpecs }: { invalidSpecs: InvalidGateSpec[] }) {
  return (
    <div
      role="alert"
      data-testid="invalid-specs-warning"
      className="shrink-0 flex flex-col gap-1.5 rounded-lg ring-1 ring-inset ring-amber-500/40 bg-amber-500/10 px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle
          size={14}
          aria-hidden
          className="shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">
          {STRINGS.invalidTitle(invalidSpecs.length)}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {invalidSpecs.map((spec) => (
          <li key={spec.slug} className="text-[12px] text-stone-600 dark:text-stone-400">
            <span className="font-mono text-stone-800 dark:text-stone-200">{spec.slug}</span>
            {": "}
            {spec.errors.join("; ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GateCard({
  gate,
  onOpen,
  selectable,
  selected,
  onToggleSelected,
  onSplit,
}: {
  gate: GateState;
  onOpen: (gateId: string) => void;
  selectable: boolean;
  selected: boolean;
  onToggleSelected: (gateId: string) => void;
  onSplit: (gate: GateState) => void;
}) {
  const isBlocked = gate.status !== "passed";
  const coveringUnits = gate.coveringUnitIds;
  // Splitting a signed-off gate is rejected server-side (AC3); hide the control
  // for a passed gate, and require at least two covering units to assign.
  const canSplit = isBlocked && coveringUnits.length >= 2;
  // Title by phase (milestone), falling back to the gate id when the unit carries
  // no milestone (e.g. a synthetic merged/split gate). When a milestone is present
  // the gate id becomes a mono sub-label; otherwise the id IS the (mono) title, so
  // it is never rendered twice (issue #433).
  const title = gate.milestone ?? gate.gateId;
  const showGateIdSubLabel = title !== gate.gateId;
  // The full gating-set count for this phase (issue #433). Optional-chained so a
  // partial fixture without the field renders no count line rather than crashing.
  const gatingCount = gate.gatingCaseIds?.length ?? 0;
  // Genuine upstream blockers: verify gates this phase depends on that are not yet
  // signed off (issue #433, FR-001). Distinct from `coveringUnits` (the gate's own
  // covers), which the relabeled line below lists.
  const blockedBy = gate.blockedBy ?? [];
  const hasUpstreamBlockers = blockedBy.length > 0;

  // Whole-card open (#804): the card body and the (decorative) chevron must open
  // the gate, not just the gate-id text. We use the React Aria clickable-card
  // overlay pattern: an absolutely-positioned Button fills the card and is the
  // open trigger, layered BENEATH the nested controls. The nested controls
  // (merge checkbox, Split) are lifted above it with `relative z-10` so their own
  // presses win and never bubble into open, which also avoids nesting a button
  // inside a button (a11y). In merge mode the overlay toggles selection instead
  // of opening, so the whole card is a consistent pick target.
  return (
    <div
      data-testid="gate-card"
      data-selected={selected || undefined}
      data-blocked={hasUpstreamBlockers || undefined}
      className="group relative flex flex-col gap-2 rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/60 dark:bg-stone-900/40 px-4 py-3 transition-colors hover:ring-amber-500/40 data-[blocked]:ring-amber-500/50 data-[selected]:ring-amber-500"
    >
      <Button
        onPress={() => (selectable ? onToggleSelected(gate.gateId) : onOpen(gate.gateId))}
        data-testid="gate-open"
        aria-label={selectable ? `Select ${gate.gateId} to merge` : `Open gate ${gate.gateId}`}
        className="absolute inset-0 rounded-lg outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-amber-500"
      />
      <div className="flex items-center justify-between gap-3 w-full min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {selectable ? (
            <Checkbox
              isSelected={selected}
              onChange={() => onToggleSelected(gate.gateId)}
              aria-label={`Select ${gate.gateId} to merge`}
              data-testid="gate-merge-checkbox"
              className="relative z-10 flex items-center justify-center w-4 h-4 rounded border border-stone-300 dark:border-stone-700 data-[selected]:bg-amber-500 data-[selected]:border-amber-500 outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-amber-500 shrink-0 cursor-pointer"
            >
              {selected && <span className="w-1.5 h-1.5 rounded-sm bg-stone-950" />}
            </Checkbox>
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          )}
          <div className="flex flex-col min-w-0">
            <span
              data-testid="gate-title"
              className={
                "truncate transition-colors group-hover:text-stone-900 dark:group-hover:text-stone-100 " +
                (showGateIdSubLabel
                  ? "text-[13px] font-medium text-stone-800 dark:text-stone-200"
                  : "font-mono text-[12px] text-stone-600 dark:text-stone-300")
              }
            >
              {title}
            </span>
            {showGateIdSubLabel && (
              <span className="font-mono text-[10px] text-stone-500 dark:text-stone-500 truncate">
                {gate.gateId}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canSplit && !selectable && (
            <Button
              onPress={() => onSplit(gate)}
              data-testid="gate-split-trigger"
              className="relative z-10 flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-800/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Split size={11} aria-hidden />
              {STRINGS.split}
            </Button>
          )}
          <GateStateIndicator status={gate.status} />
          <ChevronRight aria-hidden="true" className="w-4 h-4 text-stone-400 dark:text-stone-600" />
        </div>
      </div>
      {gatingCount > 0 && (
        <p data-testid="gate-gating-count" className="text-xs text-stone-500 dark:text-stone-400">
          {STRINGS.gatingCount(gatingCount)}
        </p>
      )}
      {hasUpstreamBlockers && (
        <p
          data-testid="gate-blocked-by"
          className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle size={12} aria-hidden className="shrink-0" />
          <span className="min-w-0">
            {STRINGS.blockedByUpstream}{" "}
            <span className="font-mono text-amber-800 dark:text-amber-300">
              {blockedBy.join(", ")}
            </span>
          </span>
        </p>
      )}
      {isBlocked && coveringUnits.length > 0 && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {STRINGS.covers}{" "}
          <span className="font-mono text-stone-700 dark:text-stone-300">
            {coveringUnits.join(", ")}
          </span>
        </p>
      )}
    </div>
  );
}

// Split dialog: assign each of the source gate's covering WU- ids to part A or
// part B. The default seed puts the first half in A and the rest in B so the
// confirm is enabled immediately (a valid partition). Confirm posts the split;
// a 409 (signed-off) or 400 (non-partition) is surfaced inline.
function SplitDialog({
  gate,
  isPending,
  error,
  onConfirm,
  onClose,
}: {
  gate: GateState;
  isPending: boolean;
  error: string | null;
  onConfirm: (parts: { label: string; coversWorkUnitIds: string[] }[]) => void;
  onClose: () => void;
}) {
  const covers = gate.coveringUnitIds;
  const mid = Math.ceil(covers.length / 2);
  // assignment[wu] is "A" or "B".
  const [assignment, setAssignment] = useState<Record<string, "A" | "B">>(() =>
    Object.fromEntries(covers.map((wu, i) => [wu, i < mid ? "A" : "B"] as const)),
  );

  const partA = covers.filter((wu) => assignment[wu] === "A");
  const partB = covers.filter((wu) => assignment[wu] === "B");
  // A valid split needs each part to be non-empty (two signable gates).
  const valid = partA.length > 0 && partB.length > 0;

  function setPart(wu: string, part: "A" | "B") {
    setAssignment((prev) => ({ ...prev, [wu]: part }));
  }

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-md mx-4 flex flex-col max-h-[85vh]">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none flex flex-col min-h-0 max-h-[inherit] overflow-hidden">
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60 shrink-0 flex items-center justify-between gap-3">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100 font-mono"
            >
              {STRINGS.splitTitle(gate.gateId)}
            </Heading>
            <Button
              onPress={onClose}
              isDisabled={isPending}
              aria-label="Close"
              className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
            >
              <X size={16} aria-hidden />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-3">
            <p className="text-sm text-stone-700 dark:text-stone-300 leading-relaxed">
              {STRINGS.splitIntro}
            </p>
            <ul className="flex flex-col gap-1.5" data-testid="split-assignments">
              {covers.map((wu) => (
                <li key={wu} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12px] text-stone-700 dark:text-stone-300 break-all">
                    {wu}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {(["A", "B"] as const).map((part) => (
                      <Button
                        key={part}
                        onPress={() => setPart(wu, part)}
                        isDisabled={isPending}
                        data-testid={`split-assign-${wu}-${part}`}
                        data-active={assignment[wu] === part || undefined}
                        className="px-2 py-0.5 text-[11px] font-medium rounded-md ring-1 ring-inset ring-stone-200 dark:ring-stone-700 text-stone-500 dark:text-stone-400 data-[active]:bg-amber-500 data-[active]:text-stone-950 data-[active]:ring-amber-500 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      >
                        {part}
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {error && (
              <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60 shrink-0">
            <Button
              onPress={onClose}
              isDisabled={isPending}
              data-testid="split-cancel"
              className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {STRINGS.splitCancel}
            </Button>
            <Button
              isDisabled={!valid || isPending}
              onPress={() =>
                onConfirm([
                  { label: "A", coversWorkUnitIds: partA },
                  { label: "B", coversWorkUnitIds: partB },
                ])
              }
              data-testid="split-confirm"
              className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 active:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {isPending ? STRINGS.splitting : STRINGS.splitConfirm}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function GatesOverview({
  projectId,
  specSlug,
  onOpenGate,
}: {
  projectId: string;
  specSlug?: string;
  onOpenGate: (gateId: string) => void;
}) {
  // Scope the gate list to the bench's focused spec (issue #549): the Batches tab
  // must show only the focused spec's batches, matching how the Cases tab scopes
  // to `focusedSpecPath`, instead of aggregating every spec's gates project-wide.
  // With no focused spec there is nothing to scope to, so the query is disabled and
  // an empty "focus a spec" state renders below (mirrors the Cases path's handling
  // of a missing focused spec).
  const { data, isLoading, isError, error } = useGates(projectId, specSlug, {
    enabled: specSlug !== undefined,
  });
  const mergeMutation = useMergeGates(projectId);
  const splitMutation = useSplitGate(projectId);

  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [splitTarget, setSplitTarget] = useState<GateState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function toggleSelected(gateId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gateId)) next.delete(gateId);
      else next.add(gateId);
      return next;
    });
  }

  function exitMergeMode() {
    setMergeMode(false);
    setSelected(new Set());
    setActionError(null);
  }

  async function confirmMerge() {
    setActionError(null);
    try {
      await mergeMutation.mutateAsync([...selected]);
      exitMergeMode();
    } catch (err) {
      setActionError(errorMessage(err, "Could not combine the selected gates."));
    }
  }

  async function confirmSplit(parts: { label: string; coversWorkUnitIds: string[] }[]) {
    if (!splitTarget) return;
    setActionError(null);
    try {
      await splitMutation.mutateAsync({ gateId: splitTarget.gateId, parts });
      setSplitTarget(null);
    } catch (err) {
      setActionError(errorMessage(err, "Could not split the gate."));
    }
  }

  // No focused spec (issue #549): there is nothing to scope the batches to, so the
  // query is disabled. Show a "focus a spec" empty state rather than the all-project
  // gates (the leak this fixes) or a misleading error from the disabled query.
  if (specSlug === undefined) {
    return (
      <div className="py-8">
        <p className="text-sm text-stone-500 dark:text-stone-600">
          Focus a spec to see its batches.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-600 py-8">
        <Spinner />
        Loading batches...
      </div>
    );
  }

  if (isError || !data) {
    const message =
      error instanceof Error ? error.message : "Could not load the batches for this project.";
    return (
      <div className="py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{message}</p>
      </div>
    );
  }

  const gates = data.gates;
  const invalidSpecs = data.invalidSpecs;

  // Empty state (AC3) fires ONLY when there are genuinely no gates AND no skipped
  // invalid specs. If a spec's work-units.json was present-but-invalid (#371),
  // fall through to the warning banner below rather than the misleading "no verify
  // gates yet", so a misconfiguration is never indistinguishable from an empty
  // project.
  if (gates.length === 0 && invalidSpecs.length === 0) {
    return (
      <div className="py-8">
        <p className="text-sm text-stone-500 dark:text-stone-600">
          This project has no verify gates yet.
        </p>
      </div>
    );
  }

  // Gates all dropped because the only verify-unit-bearing spec(s) failed
  // validation: show the warning naming the spec + failure, not an empty state.
  if (gates.length === 0) {
    return (
      <div className="py-8">
        <InvalidSpecsWarning invalidSpecs={invalidSpecs} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 overflow-hidden flex-1 min-h-0">
      <div className="flex items-center justify-between gap-2 shrink-0">
        {mergeMode ? (
          <>
            <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.mergeHint}</p>
            <div className="flex items-center gap-2">
              <Button
                onPress={exitMergeMode}
                isDisabled={mergeMutation.isPending}
                data-testid="merge-cancel"
                className="px-2.5 py-1 text-[11px] font-medium rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                {STRINGS.mergeCancel}
              </Button>
              <Button
                onPress={confirmMerge}
                isDisabled={selected.size < 2 || mergeMutation.isPending}
                data-testid="merge-confirm"
                className="px-3 py-1 text-[11px] font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                {mergeMutation.isPending ? STRINGS.merging : STRINGS.mergeConfirm(selected.size)}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
              Batches
            </span>
            {gates.length >= 2 && (
              <Button
                onPress={() => {
                  setMergeMode(true);
                  setActionError(null);
                }}
                data-testid="merge-mode-trigger"
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-800/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <GitMerge size={12} aria-hidden />
                {STRINGS.mergeMode}
              </Button>
            )}
          </>
        )}
      </div>

      {invalidSpecs.length > 0 && <InvalidSpecsWarning invalidSpecs={invalidSpecs} />}

      {actionError && (
        <p
          role="alert"
          data-testid="overview-error"
          className="text-[12px] text-red-500 dark:text-red-400 shrink-0"
        >
          {actionError}
        </p>
      )}

      <div
        role="list"
        aria-label="Verification batches"
        className="flex flex-col gap-2 overflow-auto flex-1 min-h-0"
      >
        {gates.map((gate) => (
          <div role="listitem" key={gate.gateId}>
            <GateCard
              gate={gate}
              onOpen={onOpenGate}
              selectable={mergeMode}
              selected={selected.has(gate.gateId)}
              onToggleSelected={toggleSelected}
              onSplit={(g) => {
                setActionError(null);
                setSplitTarget(g);
              }}
            />
          </div>
        ))}
      </div>

      {splitTarget && (
        <SplitDialog
          gate={splitTarget}
          isPending={splitMutation.isPending}
          error={actionError}
          onConfirm={confirmSplit}
          onClose={() => {
            setSplitTarget(null);
            setActionError(null);
          }}
        />
      )}
    </div>
  );
}
