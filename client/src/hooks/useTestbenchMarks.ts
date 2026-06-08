import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CaseResult,
  CaseStatus,
  ObservationMark,
  TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { deriveStatus } from "@roubo/shared/testbench-domain";
import * as api from "../lib/api";
import { testbenchPlanQueryKey, type TestbenchPlanData } from "./useTestbenchPlan";

// Observation-mark and status-override mutations for the case detail pane (#420,
// FR-007/FR-008/FR-010). Both apply an optimistic update to the cached plan so
// the mark round-trip feels instant (< 150ms, NFR-004), then reconcile with the
// authoritative CaseResult the server returns. The server is the source of truth:
// it stamps author + timestamp and recomputes derivedStatus; the client mirrors
// that with the shared deriveStatus only for the optimistic preview.
//
// Override precedence is server-enforced: statusOverride is stored distinctly and
// the displayed status is statusOverride ?? derivedStatus. A later mark never
// clears an existing override, so neither optimistic path touches statusOverride
// when marking an observation.

// All observation ids defined across a plan case's steps. The deriveStatus
// denominator is the full observation set, not just the marked ones.
function planCaseObservationIds(plan: TestCasesPlan, caseId: string): string[] {
  const planCase = plan.cases.find((c) => c.id === caseId);
  if (!planCase) return [];
  const ids: string[] = [];
  for (const step of planCase.steps) {
    for (const observation of step.observations) {
      ids.push(observation.id);
    }
  }
  return ids;
}

// Author placeholder for an optimistic mark/override. The server replaces this
// with the real git identity on the round-trip; it is never persisted from here.
const OPTIMISTIC_AUTHOR = { name: "", email: "" } as const;

// Produce an empty-but-valid CaseResult for a case that has no recorded result
// yet, so the first mark/override has somewhere to land optimistically.
function emptyCaseResult(): CaseResult {
  return { observationMarks: {}, derivedStatus: "not_started", notes: [] };
}

// Apply a pure update to one case's result inside a cached plan snapshot,
// returning a new TestbenchPlanData (never mutating the cached object).
function updateCaseResult(
  data: TestbenchPlanData,
  caseId: string,
  update: (result: CaseResult) => CaseResult,
): TestbenchPlanData {
  const results = data.results ?? { caseResults: {}, updatedAt: new Date().toISOString() };
  const current = results.caseResults[caseId] ?? emptyCaseResult();
  return {
    ...data,
    results: {
      ...results,
      caseResults: { ...results.caseResults, [caseId]: update(current) },
    },
  };
}

interface MarkVars {
  projectId: string;
  benchId: number;
  caseId: string;
  observationId: string;
  result: "pass" | "fail";
}

export function useMarkObservation() {
  const queryClient = useQueryClient();
  return useMutation<CaseResult, Error, MarkVars, { previous: TestbenchPlanData | undefined }>({
    mutationFn: ({ projectId, benchId, caseId, observationId, result }) =>
      api.markObservation(projectId, benchId, caseId, observationId, result),
    onMutate: async (vars) => {
      const key = testbenchPlanQueryKey(vars.projectId, vars.benchId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TestbenchPlanData>(key);
      if (previous) {
        queryClient.setQueryData<TestbenchPlanData>(
          key,
          updateCaseResult(previous, vars.caseId, (result) => {
            const mark: ObservationMark = {
              result: vars.result,
              author: OPTIMISTIC_AUTHOR,
              timestamp: new Date().toISOString(),
            };
            const observationMarks = { ...result.observationMarks, [vars.observationId]: mark };
            return {
              ...result,
              observationMarks,
              derivedStatus: deriveStatus(
                planCaseObservationIds(previous.plan, vars.caseId),
                observationMarks,
              ),
            };
          }),
        );
      }
      return { previous };
    },
    onError: (_err, vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          testbenchPlanQueryKey(vars.projectId, vars.benchId),
          context.previous,
        );
      }
    },
    onSettled: (_data, _err, vars) => {
      queryClient.invalidateQueries({
        queryKey: testbenchPlanQueryKey(vars.projectId, vars.benchId),
      });
    },
  });
}

interface OverrideVars {
  projectId: string;
  benchId: number;
  caseId: string;
  override: CaseStatus | null;
}

export function useSetStatusOverride() {
  const queryClient = useQueryClient();
  return useMutation<CaseResult, Error, OverrideVars, { previous: TestbenchPlanData | undefined }>({
    mutationFn: ({ projectId, benchId, caseId, override }) =>
      api.setStatusOverride(projectId, benchId, caseId, override),
    onMutate: async (vars) => {
      const key = testbenchPlanQueryKey(vars.projectId, vars.benchId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TestbenchPlanData>(key);
      if (previous) {
        queryClient.setQueryData<TestbenchPlanData>(
          key,
          updateCaseResult(previous, vars.caseId, (result) => {
            if (vars.override === null) {
              const next = { ...result };
              delete next.statusOverride;
              return next;
            }
            return {
              ...result,
              statusOverride: {
                status: vars.override,
                author: OPTIMISTIC_AUTHOR,
                timestamp: new Date().toISOString(),
              },
            };
          }),
        );
      }
      return { previous };
    },
    onError: (_err, vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          testbenchPlanQueryKey(vars.projectId, vars.benchId),
          context.previous,
        );
      }
    },
    onSettled: (_data, _err, vars) => {
      queryClient.invalidateQueries({
        queryKey: testbenchPlanQueryKey(vars.projectId, vars.benchId),
      });
    },
  });
}
