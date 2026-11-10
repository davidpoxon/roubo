import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { Label, TextArea, TextField } from "react-aria-components";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";
import type { ProvisionalCase } from "@roubo/shared/delivery-observation-contract";
import { ownValue } from "@roubo/shared/delivery-reducer";
import type { Case, CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";
import * as api from "../../lib/api";
import { deliveryQueryKey, useDelivery, useSittingStage } from "../../hooks/useDelivery";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useSetStatusOverride } from "../../hooks/useTestbenchMarks";
import { useTestbenchPlan } from "../../hooks/useTestbenchPlan";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { focusRing } from "../ui/focus-ring";
import { FIELD_LABEL_CLASS, inputClass, STATUS_DOT_CLASSES, type StatusTone } from "../ui/styles";
import { Tab, TabList, TabPanel, Tabs } from "../ui/Tabs";
import CaseDetail from "../testbench/CaseDetail";
import { STATUS_DOT, STATUS_LABEL } from "../testbench/statusLabels";
import { TestbenchApiContext, type TestbenchApi } from "../testbench/TestbenchApiContext";
import { DeliveryPanel } from "./DeliveryPanel";
import GateSitting from "./GateSitting";
import { sittingPhase, type DeliverySittingView } from "./gate-sitting-model";
import ProvisionalMarkCard from "./ProvisionalMark";
import { provisionalMarkStatus, readProvisionalMark } from "./provisional-mark-model";

// The Test bench tab of a Spec Bench (SB-FR-026, SB-FR-027, SB-US-009), laid
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

export default function SpecBenchTestBench({ bench }: { bench: Bench }) {
  const delivery = useDelivery(bench.projectId, bench.id);
  const sitting = delivery.data?.sitting;
  return (
    <section aria-label="Gate sitting" data-testid="specbench-testbench" className="space-y-4">
      {delivery.isPending && (
        <p role="status" className="text-13 text-text-secondary">
          Reading the delivery record...
        </p>
      )}
      {delivery.isError && (
        <Callout role="alert" title="The delivery could not be read">
          {delivery.error.message}
        </Callout>
      )}
      {delivery.isSuccess && sitting === undefined && (
        <p role="status" className="text-13 text-text-secondary">
          No gate sitting yet. The escalated cases of a gate show here once the delivery reaches it.
        </p>
      )}
      {delivery.isSuccess && sitting !== undefined && (
        <Sitting bench={bench} snapshot={delivery.data} sitting={sitting} />
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
  const automationPassed = useAutomationPassed(sitting.gateId, open, gateCases);
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
  const plan = useTestbenchPlan(bench.projectId, bench.id);
  const gateCaseIds = ownValue(snapshot.gatesById, gateId)?.gate.cases ?? [];
  const cases = plan.data
    ? gateCaseIds.flatMap((caseId) => {
        const found = plan.data.plan.cases.find((c) => c.id === caseId);
        return found === undefined ? [] : [found];
      })
    : [];
  const caseResults = plan.data?.results?.caseResults ?? {};
  return { plan, cases, caseResults };
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
// So the split is read once, when the sitting is open and its cases have
// loaded, and held for the gate while this tab stays mounted. Before the
// sitting opens nothing can be marked here, so the split is read live. A case
// that joins the gate later counts as escalated.
function useAutomationPassed(
  gateId: string,
  open: boolean,
  { plan, cases, caseResults }: GateCases,
): ReadonlySet<string> {
  const [frozen, setFrozen] = useState<{ gateId: string; passed: ReadonlySet<string> }>();
  const held = frozen?.gateId === gateId ? frozen.passed : undefined;
  if (held !== undefined) return held;
  const live = new Set(
    cases
      .filter((testCase) => passedByAutomation(ownValue(caseResults, testCase.id)))
      .map((testCase) => testCase.id),
  );
  if (open && plan.isSuccess && cases.length > 0) setFrozen({ gateId, passed: live });
  return live;
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

function SittingCases({
  bench,
  snapshot,
  sitting,
  open,
  gateCases: { plan, cases, caseResults },
  automationPassed,
  fixUnitErrors,
  onMarked,
}: {
  bench: Bench;
  snapshot: DeliverySnapshotResponse;
  sitting: DeliverySittingView;
  open: boolean;
  gateCases: GateCases;
  automationPassed: ReadonlySet<string>;
  fixUnitErrors: Record<string, string>;
  onMarked: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [filter, setFilter] = useState<CaseFilter>("escalated");
  const [selectedId, setSelectedId] = useState<string | undefined>();
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
        {/* One Case panel per case of the gate, the chosen one shown: a case
            keeps its staged state, its evidence draft and its errors while
            another case is chosen. */}
        {cases.map((testCase) => (
          <div key={testCase.id} hidden={testCase.id !== selected?.id} className="min-w-0">
            <DeliveryPanel
              title="Case"
              label={`Case ${testCase.id}`}
              meta={
                <span className="font-mono">
                  {testCase.id} · L{testCase.level}
                </span>
              }
            >
              <div className="p-3">
                <SittingCase
                  projectId={bench.projectId}
                  benchId={bench.id}
                  testCase={testCase}
                  open={open}
                  result={ownValue(caseResults, testCase.id)}
                  fixRef={blockers.find((blocker) => blocker.caseId === testCase.id)?.fixRef}
                  fixUnitError={ownValue(fixUnitErrors, testCase.id)}
                  provisional={provisionalCases.find((entry) => entry.case === testCase.id)}
                  onMarked={onMarked}
                />
              </div>
            </DeliveryPanel>
          </div>
        ))}
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
// the operator as author.
function SittingCase({
  projectId,
  benchId,
  testCase,
  open,
  result,
  fixRef,
  fixUnitError,
  provisional,
  onMarked,
}: {
  projectId: string;
  benchId: number;
  testCase: Case;
  open: boolean;
  result: CaseResult | undefined;
  fixRef: string | undefined;
  fixUnitError: string | undefined;
  provisional: ProvisionalCase | undefined;
  onMarked: () => void;
}) {
  const evidencePanelId = useId();
  const setStatus = useSetStatusOverride();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // The case's Stage control (SB-FR-025): replays its state recipe in the
  // pinned checkout through the stage route.
  const stage = useMutation<api.StageCaseReport, Error>({
    mutationFn: () => api.stageTestbenchCase(projectId, benchId, testCase.id),
  });
  const mark = (override: CaseStatus) =>
    setStatus.mutate({ projectId, benchId, caseId: testCase.id, override });
  const markDisabled = !open || setStatus.isPending;
  return (
    <div data-testid="testbench-case-surface" data-case-id={testCase.id} className="space-y-4">
      <CaseDetail
        projectId={projectId}
        benchId={benchId}
        testCase={testCase}
        result={result}
        onMarked={onMarked}
        marksDisabled={!open}
        beforeSteps={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 rounded-control border border-border-strong bg-bg-base px-3 py-2.5 text-12">
              <span className="min-w-0 flex-1 text-text-body">
                Stage replays the case&apos;s state recipe in the pinned checkout, or opens the case
                cold when it has none.
              </span>
              <Button
                variant="primary"
                onPress={() => stage.mutate()}
                isDisabled={!open || stage.isPending}
              >
                Stage <span className="sr-only">{testCase.id}</span>
              </Button>
            </div>
            <CaseStageOutcome caseId={testCase.id} stage={stage} />
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
            onPress={() => setEvidenceOpen((shown) => !shown)}
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
            isPending={setStatus.isPending}
            onCancel={() => setEvidenceOpen(false)}
            onSubmit={(evidence) =>
              setStatus.mutate(
                { projectId, benchId, caseId: testCase.id, override: "failed", evidence },
                { onSuccess: () => setEvidenceOpen(false) },
              )
            }
          />
        )}
      </div>
      {setStatus.isError && (
        <p role="alert" className="text-12 text-danger-text">
          {setStatus.error.message}
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
function CaseStageOutcome({
  caseId,
  stage,
}: {
  caseId: string;
  stage: UseMutationResult<api.StageCaseReport, Error, void>;
}) {
  if (stage.isPending) {
    return (
      <p role="status" className="text-12 text-text-secondary">
        Staging {caseId}...
      </p>
    );
  }
  if (stage.isSuccess) {
    const report = stage.data;
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
  if (stage.isError) {
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
  return null;
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
  onCancel,
  onSubmit,
}: {
  caseId: string;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (evidence: api.CaseMarkEvidence) => void;
}) {
  const fileId = useId();
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | undefined>();
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
      <TextField value={note} onChange={setNote}>
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
          onChange={(event) => setFile(event.target.files?.[0])}
          className="text-12 text-text-body"
        />
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
