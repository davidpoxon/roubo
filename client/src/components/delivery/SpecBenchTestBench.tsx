import { useCallback, useId, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Label, TextArea, TextField } from "react-aria-components";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";
import type { ProvisionalCase } from "@roubo/shared/delivery-observation-contract";
import { ownValue } from "@roubo/shared/delivery-reducer";
import type { Case, CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";
import * as api from "../../lib/api";
import { deliveryReadErrorOf } from "../../lib/api";
import { deliveryQueryKey, useDelivery, useSittingStage } from "../../hooks/useDelivery";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useSetStatusOverride } from "../../hooks/useTestbenchMarks";
import { useTestbenchPlan } from "../../hooks/useTestbenchPlan";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import StatusIndicator from "../ui/StatusIndicator";
import { focusRing } from "../ui/focus-ring";
import { FIELD_LABEL_CLASS, inputClass, STATUS_DOT_CLASSES, type StatusTone } from "../ui/styles";
import { Tab, TabList, TabPanel, Tabs } from "../ui/Tabs";
import CaseDetail from "../testbench/CaseDetail";
import TestBenchPanel from "../testbench/TestBenchPanel";
import { staleCaseIdsOf } from "../testbench/rollup";
import { STATUS_DOT, STATUS_LABEL } from "../testbench/statusLabels";
import { TestbenchApiContext, type TestbenchApi } from "../testbench/TestbenchApiContext";
import { DeliveryPanel } from "./DeliveryPanel";
import GateSitting from "./GateSitting";
import { sittingPhase, type DeliverySittingView } from "./gate-sitting-model";
import ProvisionalMarkCard from "./ProvisionalMark";
import { readErrorTitle } from "./delivery-read-error";
import { DELIVERY_STARTUP_HEAD, useDeliveryStartup } from "./delivery-startup";
import { specCasesPath } from "./spec-cases-path";
import { provisionalMarkStatus, readProvisionalMark } from "./provisional-mark-model";

// The Test bench tab of a Spec Bench (SB-FR-026, SB-FR-027, SB-US-009). With no
// gate sitting, it shows the spec's full TestBench, read-only (#1653). With a
// sitting, it shows two views: Gate sitting, described below, and All cases,
// the same read-only TestBench.
//
// The Gate sitting view is laid
// out as the design draws it (#1626): the gate sitting's banner for its phase,
// with the stage control, then a Cases panel beside a Case panel. The Cases
// panel lists the gate's cases, the escalated ones by default or the whole
// gating set; the Case panel shows the chosen case on the TestBench case
// surface (CaseDetail). Until the sitting opens, the cases can be read but not
// staged or marked. A mark, from the case's status control,
// from the Mark row, or from its Not met evidence form, goes through the
// TestBench's case status route, which the server resolves through the
// TestbenchHostResolver into the workspace's test-results.json. A Not met mark
// with evidence carries a note and a screenshot, and the server files a fix
// unit below the gate that keeps it blocked.
//
// Each case also has a Stage control (SB-FR-025): it replays the case's state
// recipe in the pinned checkout through the stage route and shows the staged
// state, or says that the case opened cold when it has no recipe.
//
// The cases of the list enter with the `stagger.gate-cases` orchestration of
// DESIGN.md: `rise-in`, 40ms apart in forward order. It moves no focus, and
// under reduced motion the cases appear at once.

/** The delay between two cases of the stagger (DESIGN.md `stagger.gate-cases`). */
export const GATE_CASES_STAGGER_MS = 40;

const SCREENSHOT_TYPES = "image/png,image/jpeg,image/webp";

/** The line the tab shows above the read-only TestBench while no sitting is open. */
export const NO_SITTING_NOTICE =
  "No gate sitting is open. The cases can be read now. Marks open with a gate sitting.";

/**
 * The line above the read-only TestBench while the delivery record cannot be
 * read. The sitting state is then unknown, so it claims none.
 */
export const UNREAD_SITTING_NOTICE = "The cases can be read now. Marks open with a gate sitting.";

type TestBenchView = "sitting" | "all";

/** Hides a view of the tab that is not selected. It stays mounted, and inert. */
function hiddenWhileInert({ isInert }: { isInert: boolean }): CSSProperties | undefined {
  return isInert ? { display: "none" } : undefined;
}

/** The line the tab shows while the delivery session has not written its record yet. */
export const DELIVERY_STARTING_NOTICE = "A gate sitting opens when the delivery reaches a gate.";

/**
 * The line the tab shows while no record exists and the start-up has stopped:
 * the launch failed or stalled, the session ended, or the bench is unavailable.
 */
export const DELIVERY_STOPPED_NOTICE =
  "No gate sitting opens until the delivery runs. The Delivery tab names the cause.";

// `onOpenDelivery` opens the bench's Delivery tab, where the start-up of the
// delivery shows while its record is missing.
export default function SpecBenchTestBench({
  bench,
  onOpenDelivery,
}: {
  bench: Bench;
  onOpenDelivery?: (() => void) | undefined;
}) {
  const delivery = useDelivery(bench.projectId, bench.id);
  const sitting = delivery.data?.sitting;
  const readError = delivery.isError ? deliveryReadErrorOf(delivery.error) : undefined;
  // No record yet is the delivery starting, not a fault (see DeliveryStartup).
  // The line names the same phase as the Delivery tab, so a launch that failed
  // is not shown as a wait.
  const starting = readError?.code === "DELIVERY_RECORD_MISSING";
  const startup = useDeliveryStartup(bench, starting);
  const head = startup && DELIVERY_STARTUP_HEAD[startup.phase];
  const waiting = head?.tone === "preparing";
  // The full TestBench of the spec (#1653), read-only: outside a sitting the
  // server refuses every write, and inside one the marks go through the
  // sitting's own surface, which holds the escalated split and files fix units.
  const allCases = (
    <TestBenchPanel
      projectId={bench.projectId}
      benchId={bench.id}
      focusedSpecPath={specCasesPath(bench.focusedSpecPath)}
      benchStatus={bench.status}
      readOnly
    />
  );
  return (
    <section
      aria-label="Test bench"
      data-testid="specbench-testbench"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      {delivery.isPending && (
        <p role="status" className="text-13 text-text-secondary">
          Reading the delivery record...
        </p>
      )}
      {startup && head && (
        <div
          role="status"
          data-testid="specbench-delivery-starting"
          data-phase={startup.phase}
          className="flex flex-wrap items-center gap-3 rounded-control border border-border bg-bg-surface px-3 py-2 text-13"
        >
          <StatusIndicator tone={head.tone} label={head.label} />
          <span className="text-text-secondary">
            {waiting ? DELIVERY_STARTING_NOTICE : DELIVERY_STOPPED_NOTICE}
          </span>
          {onOpenDelivery !== undefined && (
            <Button onPress={onOpenDelivery}>Open the delivery</Button>
          )}
        </div>
      )}
      {delivery.isError && !starting && (
        <Callout
          role="alert"
          title={readError ? readErrorTitle(readError) : "The delivery could not be read"}
        >
          {delivery.error.message}
        </Callout>
      )}
      {/* The reads of the TestBench do not need the delivery record, so the
          cases show when the record cannot be read too. The sitting state is
          then unknown, so the surface stays read-only and the line claims no
          sitting state. */}
      {(delivery.isError || (delivery.isSuccess && sitting === undefined)) && (
        <>
          <p
            role="status"
            data-testid="specbench-no-sitting"
            className="text-13 text-text-secondary"
          >
            {delivery.isError ? UNREAD_SITTING_NOTICE : NO_SITTING_NOTICE}
          </p>
          {allCases}
        </>
      )}
      {delivery.isSuccess && sitting !== undefined && (
        // A sitting shows first. The tab opens on it when the delivery reaches a
        // gate, and All cases keeps the whole spec one press away. Both views
        // stay mounted and the hidden one is not displayed, so a switch keeps
        // the sitting's drafts, staged states and held split, and the chosen
        // case of All cases.
        <Tabs
          defaultSelectedKey={"sitting" satisfies TestBenchView}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabList aria-label="Test bench view">
            <Tab id={"sitting" satisfies TestBenchView}>Gate sitting</Tab>
            <Tab id={"all" satisfies TestBenchView}>All cases</Tab>
          </TabList>
          <TabPanel
            id={"sitting" satisfies TestBenchView}
            aria-label="Gate sitting"
            className="min-h-0 flex-1 overflow-auto pt-4"
            shouldForceMount
            style={hiddenWhileInert}
          >
            <Sitting bench={bench} snapshot={delivery.data} sitting={sitting} />
          </TabPanel>
          <TabPanel
            id={"all" satisfies TestBenchView}
            className="flex min-h-0 flex-1 flex-col pt-4"
            shouldForceMount
            style={hiddenWhileInert}
          >
            {allCases}
          </TabPanel>
        </Tabs>
      )}
    </section>
  );
}

function Sitting({
  bench,
  snapshot,
  sitting,
}: {
  bench: Bench;
  snapshot: DeliverySnapshotResponse;
  sitting: DeliverySittingView;
}) {
  const phase = sittingPhase(sitting);
  const open = phase === "open";
  const gateCases = useGateCases(bench, snapshot, sitting.gateId);
  const { passed: automationPassed, held } = useAutomationPassed(sitting.gateId, open, gateCases);
  // Nothing is staged or marked before the split is held, so no mark can be
  // part of it.
  const writable = open && held;
  const queryClient = useQueryClient();
  // The fix unit error of the last mark of each case, which the case surface
  // shows beside it.
  const [fixUnitErrors, setFixUnitErrors] = useState<Record<string, string>>({});
  const readDelivery = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: deliveryQueryKey(bench.projectId, bench.id),
    });
  }, [queryClient, bench.projectId, bench.id]);
  // The marks go through the plain routes, then the delivery is read again, so
  // a fix unit a Not met mark filed shows on the sitting at once.
  const markApi = useMemo<TestbenchApi>(
    () => ({
      setStatusOverride: async (...args) => {
        const caseId = args[2];
        try {
          const response = await api.setStatusOverride(...args);
          setFixUnitErrors((current) => {
            const next = Object.fromEntries(
              Object.entries(current).filter(([id]) => id !== caseId),
            );
            return response.fixUnitError === undefined
              ? next
              : { ...next, [caseId]: response.fixUnitError.error };
          });
          return response;
        } finally {
          readDelivery();
        }
      },
    }),
    [readDelivery],
  );
  return (
    <div className="space-y-4">
      <GateSitting
        sitting={sitting}
        titleAs="h2"
        facts={
          open ? (
            <SittingCounts gateCases={gateCases} automationPassed={automationPassed} />
          ) : undefined
        }
        actions={<SittingStageControl bench={bench} sitting={sitting} />}
      />
      {!open && (
        <p className="text-13 text-text-secondary">
          The cases can be read now. Stage and Mark open with the sitting.
        </p>
      )}
      <TestbenchApiContext.Provider value={markApi}>
        <SittingCases
          bench={bench}
          snapshot={snapshot}
          sitting={sitting}
          open={open}
          writable={writable}
          gateCases={gateCases}
          automationPassed={automationPassed}
          fixUnitErrors={fixUnitErrors}
          onMarked={readDelivery}
        />
      </TestbenchApiContext.Provider>
    </div>
  );
}

// Opens a sitting that is ready, and closes one in any other phase. While the
// build comes up, Open the sitting shows disabled beside Close the sitting.
function SittingStageControl({ bench, sitting }: { bench: Bench; sitting: DeliverySittingView }) {
  const stage = useSittingStage(bench.projectId, bench.id);
  const phase = sittingPhase(sitting);
  return (
    <>
      {phase !== "open" && (
        <Button
          variant={phase === "ready" ? "primary" : undefined}
          onPress={() => stage.mutate({ action: "open", gateId: sitting.gateId })}
          isDisabled={phase !== "ready" || stage.isPending}
        >
          Open the sitting
        </Button>
      )}
      {phase !== "ready" && (
        <Button onPress={() => stage.mutate({ action: "close" })} isDisabled={stage.isPending}>
          Close the sitting
        </Button>
      )}
      {stage.isError && (
        <p role="alert" className="basis-full text-right text-12 text-danger-text">
          {stage.error.message}
        </p>
      )}
    </>
  );
}

// The cases of the sitting's gate, read from the plan, with their results.
type GateCases = ReturnType<typeof useGateCases>;

function useGateCases(bench: Bench, snapshot: DeliverySnapshotResponse, gateId: string) {
  // Read again on every mount, so the escalated split is held from results as
  // they are now, not from a cached read.
  const plan = useTestbenchPlan(bench.projectId, bench.id, { refetchOnMount: "always" });
  const gateCaseIds = ownValue(snapshot.gatesById, gateId)?.gate.cases ?? [];
  const cases = plan.data
    ? gateCaseIds.flatMap((caseId) => {
        const found = plan.data.plan.cases.find((c) => c.id === caseId);
        return found === undefined ? [] : [found];
      })
    : [];
  const caseResults = plan.data?.results?.caseResults ?? {};
  // The live cases whose result was judged against an earlier version of the
  // case (#1696). Undefined when the server sends no per-case currency.
  const staleCaseIds = plan.data
    ? staleCaseIdsOf(plan.data.plan.cases, plan.data.results, plan.data.currentCaseIds)
    : undefined;
  return { plan, cases, caseResults, staleCaseIds };
}

// A case that automation verified as passed: it has a verification record and
// its status derived from its observation marks is passed. The rest of the
// gate's cases are escalated to the operator.
function passedByAutomation(result: CaseResult | undefined): boolean {
  return (
    result !== undefined && result.verification !== undefined && result.derivedStatus === "passed"
  );
}

// The ids of the gate's cases that automation passed. An operator's
// observation mark recomputes a case's derived status, so a live reading would
// move a case between the lists, change the counts and change the chosen case.
// So the split is read once and held for the gate while this tab stays
// mounted: when the sitting is open and the read of its cases that this tab
// made on mount has loaded. The plan read refetches on every mount, so a
// cached read that predates results written while the tab was away is never
// held. Stage and the marks stay disabled until the split is held, so no mark
// can be part of it. Before the sitting opens nothing can be marked here, so
// the split is read live. A case that joins the gate later counts as escalated.
function useAutomationPassed(
  gateId: string,
  open: boolean,
  { plan, cases, caseResults }: GateCases,
): { passed: ReadonlySet<string>; held: boolean } {
  const [frozen, setFrozen] = useState<{ gateId: string; passed: ReadonlySet<string> }>();
  const held = frozen?.gateId === gateId ? frozen.passed : undefined;
  if (held !== undefined) return { passed: held, held: true };
  const live = new Set(
    cases
      .filter((testCase) => passedByAutomation(ownValue(caseResults, testCase.id)))
      .map((testCase) => testCase.id),
  );
  const freshRead = plan.isSuccess && plan.isFetchedAfterMount && !plan.isFetching;
  if (open && freshRead && cases.length > 0) {
    setFrozen({ gateId, passed: live });
    return { passed: live, held: true };
  }
  return { passed: live, held: false };
}

// The open banner's counts: the gate's cases that automation passed, and those
// escalated to the operator.
function SittingCounts({
  gateCases: { plan, cases },
  automationPassed,
}: {
  gateCases: GateCases;
  automationPassed: ReadonlySet<string>;
}) {
  if (!plan.isSuccess || cases.length === 0) return null;
  const passed = cases.filter((testCase) => automationPassed.has(testCase.id)).length;
  return (
    <span data-testid="sitting-counts" className="min-w-0 text-text-body">
      {passed} of {cases.length} passed by automation · {cases.length - passed} escalated to you
    </span>
  );
}

type CaseFilter = "escalated" | "gating";

// What the case's Stage control answered, or that it is still staging.
type StageOutcome =
  | { status: "pending" }
  | { status: "success"; report: api.StageCaseReport }
  | { status: "error"; error: Error };

// What a case keeps while another case is chosen: only the chosen case's
// panel is mounted, so its staged state, its Not met evidence draft, a mark
// still in flight and the error of its last mark are held here, by case id.
interface CaseMemory {
  stage?: StageOutcome;
  evidenceOpen: boolean;
  note: string;
  file?: File | undefined;
  markPending: boolean;
  markError?: string | undefined;
}

const EMPTY_CASE_MEMORY: CaseMemory = { evidenceOpen: false, note: "", markPending: false };

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function SittingCases({
  bench,
  snapshot,
  sitting,
  open,
  writable,
  gateCases: { plan, cases, caseResults, staleCaseIds },
  automationPassed,
  fixUnitErrors,
  onMarked,
}: {
  bench: Bench;
  snapshot: DeliverySnapshotResponse;
  sitting: DeliverySittingView;
  open: boolean;
  writable: boolean;
  gateCases: GateCases;
  automationPassed: ReadonlySet<string>;
  fixUnitErrors: Record<string, string>;
  onMarked: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [filter, setFilter] = useState<CaseFilter>("escalated");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [memory, setMemory] = useState<ReadonlyMap<string, CaseMemory>>(new Map());
  const setStatus = useSetStatusOverride();
  const remember = useCallback((caseId: string, change: Partial<CaseMemory>) => {
    setMemory((all) => {
      const next = new Map(all);
      next.set(caseId, { ...(all.get(caseId) ?? EMPTY_CASE_MEMORY), ...change });
      return next;
    });
  }, []);
  // The case's Stage control (SB-FR-025): replays its state recipe in the
  // pinned checkout through the stage route. The answer is kept by case id, so
  // it survives a switch to another case while the replay runs.
  const stageCase = (caseId: string) => {
    remember(caseId, { stage: { status: "pending" } });
    void api.stageTestbenchCase(bench.projectId, bench.id, caseId).then(
      (report) => remember(caseId, { stage: { status: "success", report } }),
      (err: unknown) => remember(caseId, { stage: { status: "error", error: asError(err) } }),
    );
  };
  // A mark from the Mark row or the Not met evidence form. A Not met mark with
  // evidence that is written closes and clears the case's evidence draft.
  const markCase = (caseId: string, override: CaseStatus, evidence?: api.CaseMarkEvidence) => {
    remember(caseId, { markPending: true, markError: undefined });
    const vars = { projectId: bench.projectId, benchId: bench.id, caseId, override };
    void setStatus.mutateAsync(evidence === undefined ? vars : { ...vars, evidence }).then(
      () =>
        remember(
          caseId,
          evidence === undefined
            ? { markPending: false }
            : { markPending: false, evidenceOpen: false, note: "", file: undefined },
        ),
      (err: unknown) => remember(caseId, { markPending: false, markError: asError(err).message }),
    );
  };
  if (plan.isPending) {
    return (
      <p role="status" className="text-13 text-text-secondary">
        Reading the cases...
      </p>
    );
  }
  if (plan.isError) {
    return (
      <Callout role="alert" title="The cases could not be read">
        {plan.error.message}
      </Callout>
    );
  }
  // The agent's provisional marks on the gate's cases (SB-FR-038): an
  // operator's mark on such a case confirms or changes it.
  const provisionalCases =
    ownValue(snapshot.gatesById, sitting.gateId)?.gate.provisionalCases ?? [];
  const blockers = sitting.fixUnitBlockers ?? [];
  if (cases.length === 0) {
    return <p className="text-13 text-text-secondary">The gate has no case to mark.</p>;
  }
  const escalated = cases.filter((testCase) => !automationPassed.has(testCase.id));
  const shown = filter === "escalated" ? escalated : cases;
  const selected = shown.find((testCase) => testCase.id === selectedId) ?? shown[0];
  const listName =
    filter === "escalated"
      ? `Escalated cases of gate ${sitting.gateId}`
      : `Gating set of gate ${sitting.gateId}`;
  return (
    <div className="@container">
      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.3fr)]">
        <DeliveryPanel title="Cases" meta={`escalated ${escalated.length} · all ${cases.length}`}>
          <Tabs selectedKey={filter} onSelectionChange={(key) => setFilter(key as CaseFilter)}>
            <TabList aria-label="Case filter" className="px-3">
              <Tab id="escalated">Escalated</Tab>
              <Tab id="gating">Gating set</Tab>
            </TabList>
            {(["escalated", "gating"] as const).map((id) => (
              <TabPanel key={id} id={id}>
                {shown.length === 0 ? (
                  <p className="px-3 py-2.5 text-13 text-text-secondary">
                    No case of this gate is escalated. Gating set lists all {cases.length}.
                  </p>
                ) : (
                  <ul aria-label={listName}>
                    {shown.map((testCase, index) => (
                      <li
                        key={testCase.id}
                        data-testid="sitting-case"
                        data-case-id={testCase.id}
                        className={reducedMotion ? undefined : "animate-rise-in"}
                        style={
                          reducedMotion
                            ? undefined
                            : {
                                animationDelay: `${index * GATE_CASES_STAGGER_MS}ms`,
                                animationFillMode: "both",
                              }
                        }
                      >
                        <CaseRow
                          testCase={testCase}
                          result={ownValue(caseResults, testCase.id)}
                          passedByAutomation={automationPassed.has(testCase.id)}
                          selected={testCase.id === selected?.id}
                          onSelect={() => setSelectedId(testCase.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </TabPanel>
            ))}
          </Tabs>
        </DeliveryPanel>
        {selected === undefined ? (
          <DeliveryPanel title="Case">
            <p data-testid="sitting-case-none" className="px-3 py-2.5 text-13 text-text-secondary">
              No case is escalated. Choose a case from Gating set to see it here.
            </p>
          </DeliveryPanel>
        ) : (
          <div className="min-w-0">
            <DeliveryPanel
              title="Case"
              label={`Case ${selected.id}`}
              meta={
                <span className="font-mono">
                  {selected.id} · L{selected.level}
                </span>
              }
            >
              <div className="p-3">
                <SittingCase
                  key={selected.id}
                  projectId={bench.projectId}
                  benchId={bench.id}
                  testCase={selected}
                  open={open}
                  writable={writable}
                  result={ownValue(caseResults, selected.id)}
                  stale={staleCaseIds?.includes(selected.id) === true}
                  fixRef={blockers.find((blocker) => blocker.caseId === selected.id)?.fixRef}
                  fixUnitError={ownValue(fixUnitErrors, selected.id)}
                  provisional={provisionalCases.find((entry) => entry.case === selected.id)}
                  memory={memory.get(selected.id) ?? EMPTY_CASE_MEMORY}
                  onRemember={(change) => remember(selected.id, change)}
                  onStage={() => stageCase(selected.id)}
                  onMark={(override, evidence) => markCase(selected.id, override, evidence)}
                  onMarked={onMarked}
                />
              </div>
            </DeliveryPanel>
          </div>
        )}
      </div>
    </div>
  );
}

// One row of the Cases list: the case's status, its id and level, and its
// title. Pressing it shows the case in the Case panel. A case that automation
// passed reads dimmed while its status is still passed.
function CaseRow({
  testCase,
  result,
  passedByAutomation,
  selected,
  onSelect,
}: {
  testCase: Case;
  result: CaseResult | undefined;
  passedByAutomation: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = result?.statusOverride?.status ?? result?.derivedStatus ?? "not_started";
  const dimmed = passedByAutomation && status === "passed";
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={`grid w-full cursor-pointer grid-cols-[auto_6.5rem_minmax(0,1fr)] items-center gap-3 border-b border-l-2 border-b-border px-3 py-2.5 text-left text-12 transition-colors hover:bg-bg-hover ${
        selected ? "border-l-accent bg-bg-hover" : "border-l-transparent"
      } ${dimmed ? "opacity-60" : ""} ${focusRing} focus-visible:ring-inset`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
      />
      <span className="font-mono text-text-body">
        {testCase.id} · L{testCase.level}
      </span>{" "}
      <span className="min-w-0">
        <span className="block text-13 text-text-primary">{testCase.title}</span>{" "}
        <span className="block text-11 text-text-secondary">{STATUS_LABEL[status]}</span>
      </span>
    </button>
  );
}

// One case of the gate: the TestBench case surface (CaseDetail), with its own
// status control and, under its heading and before its steps, the case's Stage
// control; then the agent's provisional mark when it has one, and the Mark row.
// Until the sitting opens, Stage, the marks and Confirm are disabled. Met and
// Still blocked write through the
// same case status route as the status control; Not met opens the evidence of
// a Not met mark, a note and a screenshot, that the same route takes. The
// provisional mark's Confirm writes the agent's mark through that route, with
// the operator as author. The case's staged state, evidence draft and mark
// state come from SittingCases, which keeps them while another case is chosen.
function SittingCase({
  projectId,
  benchId,
  testCase,
  open,
  writable,
  result,
  stale,
  fixRef,
  fixUnitError,
  provisional,
  memory,
  onRemember,
  onStage,
  onMark,
  onMarked,
}: {
  projectId: string;
  benchId: number;
  testCase: Case;
  open: boolean;
  // Open, with the escalated split held: Stage and the marks can be used.
  writable: boolean;
  result: CaseResult | undefined;
  // The result was judged against an earlier version of the case (#1696).
  stale: boolean;
  fixRef: string | undefined;
  fixUnitError: string | undefined;
  provisional: ProvisionalCase | undefined;
  memory: CaseMemory;
  onRemember: (change: Partial<CaseMemory>) => void;
  onStage: () => void;
  onMark: (override: CaseStatus, evidence?: api.CaseMarkEvidence) => void;
  onMarked: () => void;
}) {
  const evidencePanelId = useId();
  const { evidenceOpen, markPending, markError } = memory;
  const stagePending = memory.stage?.status === "pending";
  const mark = (override: CaseStatus) => onMark(override);
  const markDisabled = !writable || markPending;
  return (
    <div data-testid="testbench-case-surface" data-case-id={testCase.id} className="space-y-4">
      <CaseDetail
        projectId={projectId}
        benchId={benchId}
        testCase={testCase}
        result={result}
        stale={stale}
        onMarked={onMarked}
        marksDisabled={!writable}
        beforeSteps={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 rounded-control border border-border-strong bg-bg-base px-3 py-2.5 text-12">
              <span className="min-w-0 flex-1 text-text-body">
                Stage replays the case&apos;s state recipe in the pinned checkout, or opens the case
                cold when it has none.
              </span>
              <Button variant="primary" onPress={onStage} isDisabled={!writable || stagePending}>
                Stage <span className="sr-only">{testCase.id}</span>
              </Button>
            </div>
            <CaseStageOutcome caseId={testCase.id} stage={memory.stage} />
          </div>
        }
      />
      {provisional !== undefined && (
        <ProvisionalMarkCard
          entry={provisional}
          reading={readProvisionalMark(provisional, result)}
          isConfirming={markDisabled}
          onConfirm={() => mark(provisionalMarkStatus(provisional.mark))}
        />
      )}
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 font-mono text-11 font-medium uppercase tracking-label text-text-secondary">
            Mark
          </span>
          <Button onPress={() => mark("passed")} isDisabled={markDisabled}>
            <MarkDot tone="active" />
            <span className="sr-only">Mark {testCase.id}</span> Met
          </Button>
          <Button
            aria-expanded={evidenceOpen}
            aria-controls={evidencePanelId}
            onPress={() => onRemember({ evidenceOpen: !evidenceOpen })}
            isDisabled={markDisabled}
          >
            <MarkDot tone="error" />
            <span className="sr-only">Mark {testCase.id}</span> Not met with evidence
          </Button>
          <Button onPress={() => mark("blocked")} isDisabled={markDisabled}>
            <MarkDot tone="idle" />
            <span className="sr-only">Mark {testCase.id}</span> Still blocked
          </Button>
        </div>
        <p className="text-12 text-text-secondary">
          Not met takes a note and a screenshot as its evidence, and files a fix unit below the
          gate.
        </p>
      </div>
      <div id={evidencePanelId} hidden={!evidenceOpen || !open}>
        {evidenceOpen && open && (
          <NotMetEvidenceForm
            caseId={testCase.id}
            isPending={markPending}
            note={memory.note}
            file={memory.file}
            onNoteChange={(note) => onRemember({ note })}
            onFileChange={(file) => onRemember({ file })}
            onCancel={() => onRemember({ evidenceOpen: false, note: "", file: undefined })}
            onSubmit={(evidence) => onMark("failed", evidence)}
          />
        )}
      </div>
      {markError !== undefined && (
        <p role="alert" className="text-12 text-danger-text">
          {markError}
        </p>
      )}
      {fixUnitError !== undefined && (
        <p role="alert" className="text-12 text-danger-text">
          {fixUnitError}
        </p>
      )}
      {fixRef !== undefined && (
        <p className="text-12 text-text-secondary">
          Fix unit <span className="font-mono">{fixRef}</span> blocks the gate.
        </p>
      )}
    </div>
  );
}

function MarkDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      className={`mr-1.5 inline-block h-2 w-2 rounded-full ${STATUS_DOT_CLASSES[tone]}`}
    />
  );
}

const STEP_STATUS_LABEL: Record<api.StageStepReport["status"], string> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
};

// The steps of a replay, each with its status, its detail, and the URL an
// open-url step asks the operator to open.
function StageSteps({ report }: { report: api.StageCaseReport }) {
  if (report.steps.length === 0) return null;
  return (
    <ol aria-label={`Steps of the state recipe of ${report.caseId}`} className="space-y-1">
      {report.steps.map((step) => (
        <li key={step.index} data-step-status={step.status} className="text-12 text-text-body">
          <span className="font-mono">{step.kind}</span> {STEP_STATUS_LABEL[step.status]}
          {step.detail !== undefined && <>: {step.detail}</>}
          {step.url !== undefined && (
            <>
              {" "}
              <a
                href={step.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-text underline"
              >
                {step.url}
              </a>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

// What the case's Stage control answered: the staged state after 200, the
// opened-cold notice after 404, and the server's message, with the step report
// of a failed step, after any other refusal.
function CaseStageOutcome({ caseId, stage }: { caseId: string; stage: StageOutcome | undefined }) {
  if (stage === undefined) return null;
  if (stage.status === "pending") {
    return (
      <p role="status" className="text-12 text-text-secondary">
        Staging {caseId}...
      </p>
    );
  }
  if (stage.status === "success") {
    const report = stage.report;
    return (
      <section
        aria-label={`Staged state of ${caseId}`}
        data-testid="case-staged-state"
        className="space-y-1 rounded-control border border-border p-2"
      >
        <p role="status" className="text-12 text-text-body">
          {caseId} is staged at commit <span className="font-mono">{report.commit}</span>. Look for:{" "}
          {report.observation.description}
          {report.observation.url !== undefined && (
            <>
              {" "}
              <a
                href={report.observation.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-text underline"
              >
                {report.observation.url}
              </a>
            </>
          )}
        </p>
        <StageSteps report={report} />
      </section>
    );
  }
  if (api.isRecipeNotFound(stage.error)) {
    return (
      <p role="status" data-testid="case-opened-cold" className="text-12 text-text-secondary">
        {caseId} opened cold: it has no state recipe.
      </p>
    );
  }
  const report = api.stageFailureReport(stage.error);
  return (
    <div className="space-y-1">
      <p role="alert" className="text-12 text-danger-text">
        {stage.error.message}
      </p>
      {report !== undefined && <StageSteps report={report} />}
    </div>
  );
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The screenshot could not be read"));
    reader.readAsDataURL(file);
  });
}

// The evidence of a Not met mark: a note and a screenshot.
function NotMetEvidenceForm({
  caseId,
  isPending,
  note,
  file,
  onNoteChange,
  onFileChange,
  onCancel,
  onSubmit,
}: {
  caseId: string;
  isPending: boolean;
  note: string;
  file: File | undefined;
  onNoteChange: (note: string) => void;
  onFileChange: (file: File | undefined) => void;
  onCancel: () => void;
  onSubmit: (evidence: api.CaseMarkEvidence) => void;
}) {
  const fileId = useId();
  const [readError, setReadError] = useState<string | undefined>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setReadError(undefined);
    const evidence: api.CaseMarkEvidence = {};
    if (note.trim().length > 0) evidence.note = note;
    if (file !== undefined) {
      try {
        evidence.screenshot = await readDataUrl(file);
      } catch (err) {
        setReadError((err as Error).message);
        return;
      }
    }
    onSubmit(evidence);
  };
  return (
    <form
      aria-label={`Not met evidence for ${caseId}`}
      onSubmit={(event) => void submit(event)}
      className="space-y-2"
    >
      <TextField value={note} onChange={onNoteChange}>
        <Label className={FIELD_LABEL_CLASS}>Note</Label>
        <TextArea rows={3} className={inputClass({ className: "w-full" })} />
      </TextField>
      <div>
        <label htmlFor={fileId} className={FIELD_LABEL_CLASS}>
          Screenshot
        </label>
        <input
          id={fileId}
          type="file"
          accept={SCREENSHOT_TYPES}
          onChange={(event) => onFileChange(event.target.files?.[0])}
          className="text-12 text-text-body"
        />
        {/* A file input cannot be given a file back, so after a switch to
            another case and back the input reads empty: this line names the
            screenshot the draft still holds. */}
        {file !== undefined && (
          <p data-testid="not-met-screenshot-chosen" className="text-12 text-text-secondary">
            Screenshot chosen: {file.name}
          </p>
        )}
      </div>
      {readError !== undefined && (
        <p role="alert" className="text-12 text-danger-text">
          {readError}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" isDisabled={isPending}>
          Mark Not met
        </Button>
        <Button onPress={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
