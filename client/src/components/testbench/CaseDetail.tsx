import { Button } from "react-aria-components";
import { ChevronLeft } from "lucide-react";
import type { Case, CaseResult } from "@roubo/shared/testbench-contracts";
import StatusIndicator from "./StatusIndicator";
import ObservationMarkControl from "./ObservationMarkControl";
import StatusOverrideControl from "./StatusOverrideControl";
import { useMarkObservation, useSetStatusOverride } from "../../hooks/useTestbenchMarks";

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
  // Invoked when the reviewer dismisses the detail (back to the list).
  onBack?: () => void;
}

const SECTION_LABEL =
  "font-mono text-[11px] uppercase tracking-wider text-stone-500 dark:text-stone-500 mt-6 mb-2";

export default function CaseDetail({
  projectId,
  benchId,
  testCase,
  result,
  onBack,
}: CaseDetailProps) {
  const markObservation = useMarkObservation();
  const setStatusOverride = useSetStatusOverride();

  const derivedStatus = result?.derivedStatus ?? "not_started";
  const override = result?.statusOverride?.status;
  const effectiveStatus = override ?? derivedStatus;
  const marks = result?.observationMarks ?? {};

  return (
    <div
      className="flex flex-col min-h-0 overflow-auto"
      aria-label={`Case detail: ${testCase.title}`}
    >
      {onBack && (
        <Button
          onPress={onBack}
          className="inline-flex items-center gap-1 self-start text-xs font-medium text-stone-500 dark:text-stone-400 rounded-md px-1.5 py-1 -ml-1.5 outline-none transition-colors hover:text-stone-700 dark:hover:text-stone-200 focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <ChevronLeft aria-hidden="true" className="w-4 h-4" />
          All cases
        </Button>
      )}

      <div className="flex items-start justify-between gap-4 mt-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {testCase.title}
          </h2>
          <div className="flex items-center gap-3 mt-1 font-mono text-[11px] text-stone-400 dark:text-stone-600">
            <span>{testCase.id}</span>
            <span>{testCase.level}</span>
            <span>{testCase.priority}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <StatusIndicator status={effectiveStatus} />
          <StatusOverrideControl
            derivedStatus={derivedStatus}
            override={override}
            isDisabled={setStatusOverride.isPending}
            onChange={(next) =>
              setStatusOverride.mutate({ projectId, benchId, caseId: testCase.id, override: next })
            }
          />
        </div>
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
                        markObservation.mutate({
                          projectId,
                          benchId,
                          caseId: testCase.id,
                          observationId: observation.id,
                          result: res,
                        })
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
