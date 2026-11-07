import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Label, TextArea, TextField } from "react-aria-components";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";
import type { ProvisionalCase } from "@roubo/shared/delivery-observation-contract";
import { ownValue } from "@roubo/shared/delivery-reducer";
import type { Case, CaseResult } from "@roubo/shared/testbench-contracts";
import * as api from "../../lib/api";
import { deliveryQueryKey, useDelivery, useSittingStage } from "../../hooks/useDelivery";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useSetStatusOverride } from "../../hooks/useTestbenchMarks";
import { useTestbenchPlan } from "../../hooks/useTestbenchPlan";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { FIELD_LABEL_CLASS, inputClass } from "../ui/styles";
import CaseDetail from "../testbench/CaseDetail";
import { TestbenchApiContext, type TestbenchApi } from "../testbench/TestbenchApiContext";
import {
  sittingPhase,
  type DeliverySittingPhase,
  type DeliverySittingView,
} from "./gate-sitting-model";
import ProvisionalMarkCard from "./ProvisionalMark";
import { provisionalMarkStatus, readProvisionalMark } from "./provisional-mark-model";

// The Test bench tab of a Spec Bench (SB-FR-026, SB-FR-027, SB-US-009): the
// gate sitting's three phases, its stage control, and, once the sitting is
// open, the escalated cases of its gate on the TestBench case surface
// (CaseDetail). A mark, from the case's status control or from its Not met
// evidence form, goes through the TestBench's case status route, which the
// server resolves through the TestbenchHostResolver into the workspace's
// test-results.json. A Not met mark with evidence carries a note and a
// screenshot, and the server files a fix unit below the gate that keeps it
// blocked.
//
// The cases enter with the `stagger.gate-cases` orchestration of DESIGN.md:
// `rise-in`, 40ms apart in forward order. It moves no focus, and under reduced
// motion the cases appear at once.

/** The delay between two cases of the stagger (DESIGN.md `stagger.gate-cases`). */
export const GATE_CASES_STAGGER_MS = 40;

const PHASES: { phase: DeliverySittingPhase; label: string }[] = [
  { phase: "preparing", label: "Waiting for build" },
  { phase: "ready", label: "Ready to sit" },
  { phase: "open", label: "Sitting open" },
];

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
  const blockers = sitting.fixUnitBlockers ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-13 font-medium text-text-primary">
          Gate <span className="font-mono">{sitting.gateId}</span>
        </h2>
        <SittingStageControl bench={bench} sitting={sitting} />
      </div>
      <ol aria-label="Sitting phases" className="flex flex-wrap gap-2">
        {PHASES.map((entry) => (
          <li
            key={entry.phase}
            data-phase={entry.phase}
            aria-current={entry.phase === phase ? "step" : undefined}
            className={`rounded-chip border px-2 py-0.5 text-12 ${
              entry.phase === phase
                ? "border-accent-border bg-accent-muted text-accent-text"
                : "border-border text-text-secondary"
            }`}
          >
            {entry.label}
          </li>
        ))}
      </ol>
      {sitting.blocked === true && (
        <p role="status" data-testid="sitting-gate-blocked" className="text-13 text-text-body">
          The gate is blocked by{" "}
          {blockers.length === 1 ? "a fix unit" : `${blockers.length} fix units`}:{" "}
          {blockers.map((blocker) => `${blocker.fixRef} (${blocker.caseId})`).join(", ")}
        </p>
      )}
      {phase === "open" ? (
        <TestbenchApiContext.Provider value={markApi}>
          <SittingCases
            bench={bench}
            snapshot={snapshot}
            sitting={sitting}
            fixUnitErrors={fixUnitErrors}
            onMarked={readDelivery}
          />
        </TestbenchApiContext.Provider>
      ) : (
        <p className="text-13 text-text-secondary">
          The escalated cases show here once the sitting opens.
        </p>
      )}
    </div>
  );
}

// Opens a sitting that is ready, and closes one in any other phase.
function SittingStageControl({ bench, sitting }: { bench: Bench; sitting: DeliverySittingView }) {
  const stage = useSittingStage(bench.projectId, bench.id);
  const ready = sittingPhase(sitting) === "ready";
  return (
    <div className="flex flex-col items-end gap-1">
      {ready ? (
        <Button
          variant="primary"
          onPress={() => stage.mutate({ action: "open", gateId: sitting.gateId })}
          isDisabled={stage.isPending}
        >
          Open the sitting
        </Button>
      ) : (
        <Button onPress={() => stage.mutate({ action: "close" })} isDisabled={stage.isPending}>
          Close the sitting
        </Button>
      )}
      {stage.isError && (
        <p role="alert" className="text-12 text-danger-text">
          {stage.error.message}
        </p>
      )}
    </div>
  );
}

function SittingCases({
  bench,
  snapshot,
  sitting,
  fixUnitErrors,
  onMarked,
}: {
  bench: Bench;
  snapshot: DeliverySnapshotResponse;
  sitting: DeliverySittingView;
  fixUnitErrors: Record<string, string>;
  onMarked: () => void;
}) {
  const plan = useTestbenchPlan(bench.projectId, bench.id);
  const reducedMotion = usePrefersReducedMotion();
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
  const gateView = ownValue(snapshot.gatesById, sitting.gateId);
  const gateCases = gateView?.gate.cases ?? [];
  // The agent's provisional marks on the gate's cases (SB-FR-038), and when the
  // gate became provisional: an operator's mark since then confirms or changes
  // a provisional mark.
  const provisionalCases = gateView?.gate.provisionalCases ?? [];
  const provisionalSince = gateView?.provisionalAt ?? null;
  const cases = gateCases.flatMap((caseId) => {
    const found = plan.data.plan.cases.find((c) => c.id === caseId);
    return found === undefined ? [] : [found];
  });
  const caseResults = plan.data.results?.caseResults ?? {};
  const blockers = sitting.fixUnitBlockers ?? [];
  if (cases.length === 0) {
    return <p className="text-13 text-text-secondary">The gate has no case to mark.</p>;
  }
  return (
    <ul aria-label={`Escalated cases of gate ${sitting.gateId}`} className="space-y-3">
      {cases.map((testCase, index) => (
        <li
          key={testCase.id}
          data-testid="sitting-case"
          data-case-id={testCase.id}
          className={reducedMotion ? undefined : "animate-rise-in"}
          style={
            reducedMotion
              ? undefined
              : { animationDelay: `${index * GATE_CASES_STAGGER_MS}ms`, animationFillMode: "both" }
          }
        >
          <SittingCase
            projectId={bench.projectId}
            benchId={bench.id}
            testCase={testCase}
            result={ownValue(caseResults, testCase.id)}
            fixRef={blockers.find((blocker) => blocker.caseId === testCase.id)?.fixRef}
            fixUnitError={ownValue(fixUnitErrors, testCase.id)}
            provisional={provisionalCases.find((entry) => entry.case === testCase.id)}
            provisionalSince={provisionalSince}
            onMarked={onMarked}
          />
        </li>
      ))}
    </ul>
  );
}

// One escalated case: the TestBench case surface (CaseDetail), whose status
// control marks it Met or Not met, and beside it the evidence of a Not met mark,
// a note and a screenshot, that the same case status route takes. A case the
// agent marked provisionally shows that mark above the surface, with its
// evidence and a Confirm control that writes the same mark through the same
// route, with the operator as author.
function SittingCase({
  projectId,
  benchId,
  testCase,
  result,
  fixRef,
  fixUnitError,
  provisional,
  provisionalSince,
  onMarked,
}: {
  projectId: string;
  benchId: number;
  testCase: Case;
  result: CaseResult | undefined;
  fixRef: string | undefined;
  fixUnitError: string | undefined;
  provisional: ProvisionalCase | undefined;
  provisionalSince: string | null;
  onMarked: () => void;
}) {
  const evidencePanelId = useId();
  const setStatus = useSetStatusOverride();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  return (
    <div
      data-testid="testbench-case-surface"
      data-case-id={testCase.id}
      className="space-y-3 rounded-control border border-border bg-bg-surface p-3"
    >
      {provisional !== undefined && (
        <ProvisionalMarkCard
          entry={provisional}
          reading={readProvisionalMark(provisional, result, provisionalSince)}
          isConfirming={setStatus.isPending}
          onConfirm={() =>
            setStatus.mutate({
              projectId,
              benchId,
              caseId: testCase.id,
              override: provisionalMarkStatus(provisional.mark),
            })
          }
        />
      )}
      <CaseDetail
        projectId={projectId}
        benchId={benchId}
        testCase={testCase}
        result={result}
        onMarked={onMarked}
      />
      <div>
        <Button
          aria-expanded={evidenceOpen}
          aria-controls={evidencePanelId}
          onPress={() => setEvidenceOpen((open) => !open)}
          isDisabled={setStatus.isPending}
        >
          Mark {testCase.id} Not met with evidence
        </Button>
      </div>
      <div id={evidencePanelId} hidden={!evidenceOpen}>
        {evidenceOpen && (
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
