import { useId, useMemo, useRef, useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { AlertTriangle, Replace } from "lucide-react";
import {
  MAX_SUPERSESSION_DEPTH,
  resolveCase,
  type PointerRef,
  type Resolution,
  type ResolverPlan,
  type ResolverSpecLifecycle,
} from "@roubo/shared/lifecycle-resolver";
import { stampAriaModal } from "../../lib/aria-modal";
import { useReplacementCandidates } from "../../hooks/useReplacementCandidates";
import type { ReplacementCandidateCase } from "../../lib/api";
import Select from "../Select";
import Spinner from "../Spinner";

// Two-stage replacement picker with a live resolution preview (#774,
// SATCA-FR-028, SATCA-FR-029).
//
// Stage one is a specification selector defaulting to the case's own spec; stage
// two is a filterable, area-grouped list of that spec's cases with the case being
// superseded excluded. A free-text pointer invites a typo that only surfaces
// later as a fail-closed gate, and a single spec can carry 80 or more cases, so
// the choice is made from the entities that actually exist.
//
// The preview calls the SAME shared LifecycleResolver the gate calls, over the
// plans the server loaded for the pointer graph's closure. That is the decisive
// reason the resolver is pure and lives in shared code: a second implementation
// here would eventually disagree with the gate, and the disagreement would
// surface as an unexplainable stuck gate. No resolution rule is written in this
// file; it only renders what `resolveCase` returned.
//
// Confirmation is gated on the resolution's STATUS, never on an enumerated
// subset of unresolved reasons, so all six of the closed vocabulary's values
// refuse structurally and a seventh (if the resolver ever grew one) would refuse
// too. Dismissing the dialog writes nothing: the host owns the write and is only
// called from `onConfirm`.

// Qualify a chosen (slug, id) the way `parseReplacementPointer` reads it back: a
// bare id means "this spec", so only a cross-spec choice carries the slug. This
// is the one place the picker constructs pointer syntax, and it mirrors the
// resolver's parse rather than re-deriving it.
function qualifyPointer(slug: string, caseId: string, originSlug: string): string {
  return slug === originSlug ? caseId : `${slug}:${caseId}`;
}

function formatRef(ref: PointerRef, originSlug: string): string {
  return qualifyPointer(ref.slug, ref.caseId, originSlug);
}

function formatChain(chain: readonly PointerRef[], originSlug: string): string {
  return chain.map((ref) => formatRef(ref, originSlug)).join(" → ");
}

// The headline for each of the six closed unresolved reasons. Keyed by the
// resolver's own vocabulary so a reason can never fall through to a generic
// message; the shared "would not resolve" consequence line is rendered
// separately, under every one of them.
function unresolvedHeadline(resolution: Resolution): string {
  switch (resolution.reason) {
    case "cycle detected":
      return "That choice creates a cycle, which fails closed.";
    case "depth exceeded":
      return `The chain is longer than the depth limit of ${MAX_SUPERSESSION_DEPTH} hops, so it fails closed.`;
    case "target archived":
      return resolution.targetCaseState === "retired"
        ? "The chain lands in an archived specification, and that case is retired within it."
        : "The chain lands in an archived specification.";
    case "target not live":
      return "The chain ends at a retired case.";
    case "target missing":
      return "The chain reaches an id that exists in no loaded specification.";
    case "target spec not supplied":
      return "The chain leaves for a specification that is not in this workspace, so it cannot be checked.";
    default:
      return "This pointer cannot be resolved.";
  }
}

const FIELD_LABEL_CLASS = "block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1.5";
const INPUT_CLASS =
  "w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-amber-500";

export default function ReplacementPicker({
  isOpen,
  onClose,
  projectId,
  benchId,
  originCaseId,
  originCaseArea,
  onConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  benchId: number;
  // The case being superseded: excluded from its own spec's list, and the origin
  // of the hypothetical resolution the preview runs.
  originCaseId: string;
  // Its area, so the picker can order that area first and label it.
  originCaseArea: string;
  // Called with the slug-qualified pointer once a RESOLVABLE choice is confirmed.
  onConfirm: (pointer: string) => void;
}) {
  // null means "whatever the bench's focused spec is": the server answers with
  // it, so the picker does not have to know the slug before the first load.
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listId = useId();
  const optionPrefix = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError, error } = useReplacementCandidates(
    projectId,
    benchId,
    chosenSlug ?? undefined,
    { enabled: isOpen },
  );

  const originSlug = data?.originSlug ?? "";
  const activeSlug = data?.slug ?? chosenSlug ?? "";
  const isOwnSpec = activeSlug === originSlug;

  // The resolver takes maps; the wire shape is a plain object, so convert once
  // per payload rather than per keystroke.
  const plans = useMemo(() => {
    const map = new Map<string, ResolverPlan>();
    for (const [slug, plan] of Object.entries(data?.plans ?? {})) map.set(slug, plan);
    return map;
  }, [data]);
  const specLifecycles = useMemo(() => {
    const map = new Map<string, ResolverSpecLifecycle>();
    for (const [slug, record] of Object.entries(data?.specLifecycles ?? {})) map.set(slug, record);
    return map;
  }, [data]);

  // The case being superseded is excluded from its own spec's list: pointing a
  // case at itself is never the intent, and the resolver would call it a cycle.
  const available = useMemo<ReplacementCandidateCase[]>(() => {
    const cases = data?.plans[activeSlug]?.cases ?? [];
    return isOwnSpec ? cases.filter((entry) => entry.id !== originCaseId) : cases;
  }, [data, activeSlug, isOwnSpec, originCaseId]);

  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return available;
    return available.filter(
      (entry) =>
        entry.id.toLowerCase().includes(needle) ||
        entry.title.toLowerCase().includes(needle) ||
        entry.area.toLowerCase().includes(needle),
    );
  }, [available, query]);

  // Group by area, with the superseded case's own area first: supersession is
  // overwhelmingly within an area. Only meaningful inside the origin spec, so a
  // cross-spec list falls back to plain alphabetical order.
  const originArea = isOwnSpec ? originCaseArea : null;
  const groups = useMemo(() => {
    const byArea = new Map<string, ReplacementCandidateCase[]>();
    for (const entry of hits) {
      const bucket = byArea.get(entry.area);
      if (bucket) bucket.push(entry);
      else byArea.set(entry.area, [entry]);
    }
    return [...byArea.entries()].sort(([a], [b]) => {
      if (a === originArea) return -1;
      if (b === originArea) return 1;
      return a.localeCompare(b);
    });
  }, [hits, originArea]);

  // Render order, flattened: what the arrow keys walk and what
  // aria-activedescendant indexes into.
  const rows = useMemo(() => groups.flatMap(([, entries]) => entries.map((e) => e.id)), [groups]);

  // Switching specification clears the selection rather than carrying an id that
  // names a case in a different spec.
  const resetChoice = () => {
    setSelectedId(null);
    setQuery("");
  };

  // The active row is DERIVED from the selection rather than tracked separately,
  // so a filter that hides the selected row drops the selection with it: a
  // preview describing a row the reviewer can no longer see is worse than none.
  const activeIndex = selectedId === null ? -1 : rows.indexOf(selectedId);
  const activeId = activeIndex >= 0 ? rows[activeIndex] : null;

  const pointer = activeId !== null ? qualifyPointer(activeSlug, activeId, originSlug) : null;

  // The hypothetical: this case, as it WOULD be if superseded by the current
  // choice. Nothing is written; the resolution is a preview of the record the
  // confirm would create.
  const resolution: Resolution | null = useMemo(() => {
    if (pointer === null || originSlug.length === 0) return null;
    return resolveCase(
      originSlug,
      { id: originCaseId, lifecycle: { state: "superseded", replacement: pointer } },
      { plans, specLifecycles },
    );
  }, [pointer, originSlug, originCaseId, plans, specLifecycles]);

  // Gated on STATUS, not on a hand-listed subset of reasons (SATCA-FR-029).
  const canConfirm =
    resolution !== null && (resolution.status === "resolved" || resolution.status === "live");

  const handleClose = () => {
    setChosenSlug(null);
    resetChoice();
    onClose();
  };

  const handleConfirm = () => {
    if (!canConfirm || pointer === null) return;
    onConfirm(pointer);
    handleClose();
  };

  const moveActive = (delta: number) => {
    if (rows.length === 0) return;
    const next =
      activeIndex < 0
        ? delta > 0
          ? 0
          : rows.length - 1
        : Math.min(Math.max(activeIndex + delta, 0), rows.length - 1);
    setSelectedId(rows[next]);
    // Keep the active row in view. Guarded because jsdom implements no layout
    // and so ships no scrollIntoView, and a keyboard move must not throw there.
    const row = listRef.current?.querySelector(`[data-index="${next}"]`);
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  };

  const specItems = (data?.specs ?? []).map((spec) => ({
    value: spec.slug,
    label:
      spec.slug === originSlug
        ? `${spec.slug} (this spec)`
        : spec.archived
          ? `${spec.slug} (archived)`
          : spec.slug,
  }));

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-xl mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              <Replace size={15} className="text-amber-500" aria-hidden />
              Supersede {originCaseId}
            </Heading>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Choose the case that replaces it. Gate coverage transfers to your choice, followed
              transitively to the first live case.
            </p>
          </div>

          <div className="px-5 py-4 space-y-4">
            {isLoading && (
              <div className="flex items-center gap-2 py-3 text-sm text-stone-500 dark:text-stone-400">
                <Spinner />
                Loading cases...
              </div>
            )}

            {isError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-300/60 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-3 py-2">
                <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" aria-hidden />
                <p className="text-sm text-red-600 dark:text-red-400">
                  {error instanceof Error ? error.message : "Failed to load replacement cases"}
                </p>
              </div>
            )}

            {!isLoading && !isError && data && (
              <>
                <div>
                  <p id={`${listId}-spec-label`} className={FIELD_LABEL_CLASS}>
                    Specification
                  </p>
                  <Select
                    ariaLabel="Specification"
                    placeholder="Choose a specification"
                    items={specItems}
                    value={activeSlug}
                    onChange={(next) => {
                      setChosenSlug(next);
                      resetChoice();
                    }}
                  />
                  <p
                    data-testid="replacement-spec-hint"
                    className="mt-1.5 text-xs text-stone-500 dark:text-stone-400"
                  >
                    {isOwnSpec
                      ? `Defaults to this case's own specification, ${originSlug}.`
                      : `Choosing ${activeSlug} records a pointer qualified with its slug.`}
                  </p>
                </div>

                <div>
                  <label htmlFor={`${listId}-filter`} className={FIELD_LABEL_CLASS}>
                    Replacement case
                  </label>
                  <input
                    id={`${listId}-filter`}
                    type="text"
                    data-testid="replacement-filter"
                    role="combobox"
                    aria-expanded={rows.length > 0}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      activeIndex >= 0 ? `${optionPrefix}-${activeIndex}` : undefined
                    }
                    autoComplete="off"
                    placeholder="Filter by id, title, or area"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveActive(1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveActive(-1);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        handleConfirm();
                      }
                    }}
                    className={INPUT_CLASS}
                  />
                  <p
                    data-testid="replacement-count"
                    aria-live="polite"
                    className="mt-1.5 text-xs text-stone-500 dark:text-stone-400"
                  >
                    {hits.length} of {available.length} cases
                    {originArea !== null ? ", same area first" : ""}
                  </p>

                  {/* The listbox role (and with it the ARIA-permitted aria-label)
                      is dropped while the list is empty: a listbox owning no
                      option is a broken required-children relationship, and an
                      aria-label on a role-less div is ARIA-prohibited. The empty
                      state renders in the same container so the reviewer gets a
                      message rather than a blank panel. */}
                  <div
                    id={listId}
                    ref={listRef}
                    {...(rows.length > 0
                      ? ({ role: "listbox", "aria-label": "Replacement cases" } as const)
                      : {})}
                    data-testid="replacement-listbox"
                    className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-stone-200 dark:border-stone-800/60"
                  >
                    {rows.length === 0 ? (
                      <p
                        data-testid="replacement-empty"
                        className="px-3 py-5 text-center text-sm text-stone-500 dark:text-stone-400"
                      >
                        {available.length === 0
                          ? "This specification has no other case to point at."
                          : "No case matches that filter."}
                      </p>
                    ) : (
                      groups.map(([area, entries]) => (
                        <div key={area} role="group" aria-label={area}>
                          <p className="sticky top-0 bg-stone-50 dark:bg-stone-800/70 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
                            {area}
                            {area === originArea ? " · same area" : ""}
                          </p>
                          {entries.map((entry) => {
                            const index = rows.indexOf(entry.id);
                            const state = entry.lifecycle?.state ?? "live";
                            return (
                              <div
                                key={entry.id}
                                id={`${optionPrefix}-${index}`}
                                data-index={index}
                                data-testid={`replacement-option-${entry.id}`}
                                role="option"
                                aria-selected={activeId === entry.id}
                                onClick={() => setSelectedId(entry.id)}
                                className={`flex cursor-default items-baseline gap-2 px-3 py-1.5 text-sm ${
                                  activeIndex === index
                                    ? "bg-amber-50 dark:bg-amber-950/30"
                                    : "hover:bg-stone-50 dark:hover:bg-stone-800/40"
                                }`}
                              >
                                <span className="shrink-0 font-mono text-[11px] text-stone-500 dark:text-stone-400">
                                  {entry.id}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-stone-700 dark:text-stone-300">
                                  {entry.title}
                                </span>
                                <span className="shrink-0 font-mono text-[11px] text-stone-500 dark:text-stone-400">
                                  L{entry.level}
                                </span>
                                <span className="shrink-0 rounded-full bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 text-[10px] font-medium text-stone-600 dark:text-stone-300">
                                  {state}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* The preview. Rendered verbatim from the resolver's answer:
                    status, chain, reason, and the archived spec's supersededBy
                    remedy hint all come out of `resolveCase`. */}
                <div
                  data-testid="replacement-preview"
                  aria-live="polite"
                  className="rounded-lg border border-stone-200 dark:border-stone-800/60 bg-stone-50 dark:bg-stone-800/40 px-3 py-2.5 text-xs text-stone-600 dark:text-stone-400"
                >
                  {resolution === null ? (
                    <p>Select a replacement to see how it resolves.</p>
                  ) : resolution.status === "resolved" && resolution.chain.length === 2 ? (
                    <p>
                      Resolves directly to{" "}
                      <span className="font-mono text-stone-800 dark:text-stone-200">
                        {formatRef(resolution.resolvedTo as PointerRef, originSlug)}
                      </span>
                      , which is live. The gate will read its status.
                    </p>
                  ) : resolution.status === "resolved" ? (
                    <>
                      <p>
                        That case is itself superseded. The chain resolves to{" "}
                        <span className="font-mono text-stone-800 dark:text-stone-200">
                          {formatRef(resolution.resolvedTo as PointerRef, originSlug)}
                        </span>
                        .
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
                        {formatChain(resolution.chain, originSlug)}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-red-600 dark:text-red-400">
                        {unresolvedHeadline(resolution)}
                      </p>
                      <p className="mt-1 text-red-600 dark:text-red-400">
                        This pointer would not resolve, so the gate would stay non-passing.
                      </p>
                      {resolution.supersededBy !== null && (
                        <p className="mt-1">
                          That specification was superseded by{" "}
                          <span className="font-mono">{resolution.supersededBy}</span>. Choose a
                          case there instead.
                        </p>
                      )}
                      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
                        {formatChain(resolution.chain, originSlug)}
                      </p>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            <Button
              data-testid="replacement-cancel"
              onPress={handleClose}
              className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-900"
            >
              Cancel
            </Button>
            <Button
              data-testid="replacement-confirm"
              isDisabled={!canConfirm}
              onPress={handleConfirm}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-900"
            >
              Use this replacement
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
