import { useState } from "react";
import { Button } from "react-aria-components";
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
}

export default function IssueAssignControl({
  projectId,
  externalId,
  assignees,
  capturedUserId,
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
        className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-stone-500/15 text-stone-400 outline-none transition-colors hover:bg-stone-500/25 focus-visible:ring-1 focus-visible:ring-amber-500"
      >
        {label}
      </Button>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-2.5 py-1.5"
        >
          <AlertCircle size={12} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-800 dark:text-red-300 leading-relaxed">{error}</p>
        </div>
      )}
    </div>
  );
}
