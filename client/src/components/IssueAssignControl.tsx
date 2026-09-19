import { useState } from "react";
import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import type { CapturedUserId } from "@roubo/shared";
import * as api from "../lib/api";
import { extractPluginErrorMessage } from "../lib/plugin-error";

interface Props {
  projectId: string;
  externalId: string;
  assignees: Array<{ externalId: string; displayName: string }>;
  capturedUserId: CapturedUserId | undefined;
  // IP-WU-033: alert-backed benches render the control disabled with a documented
  // tooltip. The plugin guarantees `assignees: []` for these issues so write-
  // back would always fail; the disabled affordance tells the user why.
  isDisabled?: boolean;
  disabledTooltip?: string;
}

export default function IssueAssignControl({
  projectId,
  externalId,
  assignees,
  capturedUserId,
  isDisabled,
  disabledTooltip,
}: Props) {
  const meExternalId = capturedUserId?.externalId;
  const sourceAssigned =
    meExternalId !== undefined && assignees.some((a) => a.externalId === meExternalId);

  const [optimisticAssigned, setOptimisticAssigned] = useState(sourceAssigned);
  const [prevSourceAssigned, setPrevSourceAssigned] = useState(sourceAssigned);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Reconcile with the source whenever the fetched assignees change
  // (refetch, host crash recovery, or external assignment). The local
  // optimistic value must never outlive the source's truth.
  if (sourceAssigned !== prevSourceAssigned) {
    setPrevSourceAssigned(sourceAssigned);
    setOptimisticAssigned(sourceAssigned);
  }

  const mutation = useMutation({
    mutationFn: async (intent: { assign: boolean; userId: string }) => {
      if (intent.assign) {
        await api.assignIssueToUser(projectId, externalId, intent.userId);
      } else {
        await api.unassignIssueFromUser(projectId, externalId, intent.userId);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bench-issue", projectId, externalId] });
    },
    onError: (err) => {
      setOptimisticAssigned(sourceAssigned);
      setError(extractPluginErrorMessage(err, "Assignment failed"));
    },
  });

  if (!meExternalId) return null;

  const label = optimisticAssigned ? "Unassign me" : "Assign to me";
  const buttonClassName =
    "inline-flex items-center px-2 py-0.5 rounded-control text-11 font-medium bg-bg-hover text-text-body outline-none transition-colors hover:bg-bg-pressed focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-hover";

  if (isDisabled) {
    const disabledButton = (
      <Button
        data-testid="assign-control"
        aria-pressed={optimisticAssigned}
        isDisabled
        className={buttonClassName}
      >
        {label}
      </Button>
    );
    return (
      <div className="flex flex-col gap-1">
        {disabledTooltip ? (
          <TooltipTrigger delay={500}>
            {disabledButton}
            <Tooltip className="bg-bg-inverse text-text-on-inverse text-12 px-3 py-1.5 rounded-control shadow-elevation-0 max-w-xs">
              {disabledTooltip}
            </Tooltip>
          </TooltipTrigger>
        ) : (
          disabledButton
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        data-testid="assign-control"
        aria-pressed={optimisticAssigned}
        onPress={() => {
          setError(null);
          const nextAssigned = !optimisticAssigned;
          setOptimisticAssigned(nextAssigned);
          mutation.mutate({ assign: nextAssigned, userId: meExternalId });
        }}
        className={buttonClassName}
      >
        {label}
      </Button>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-surface px-2.5 py-1.5"
        >
          <AlertCircle size={12} className="text-danger-text shrink-0 mt-0.5" />
          <p className="text-11 text-danger-text leading-relaxed">{error}</p>
        </div>
      )}
    </div>
  );
}
