import { useState } from "react";
import { Select, Button, ListBox, ListBoxItem, Popover } from "react-aria-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronDown } from "lucide-react";
import * as api from "../lib/api";
import { ApiError } from "../lib/api";

interface Props {
  projectId: string;
  externalId: string;
  currentState: string;
  allowedTransitions: string[];
}

function extractPluginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = err.details;
    if (details && typeof details === "object" && "message" in details) {
      const m = (details as { message?: unknown }).message;
      if (typeof m === "string" && m.length > 0) return m;
    }
  }
  if (err instanceof Error && err.message.length > 0) return err.message;
  return "Transition failed";
}

export default function IssueTransitionDropdown({
  projectId,
  externalId,
  currentState,
  allowedTransitions,
}: Props) {
  const [optimisticState, setOptimisticState] = useState(currentState);
  const [prevCurrentState, setPrevCurrentState] = useState(currentState);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Reconcile with the source whenever the fetched currentState changes
  // (refetch, host crash recovery, or external transition). The local
  // optimistic value must never outlive the source's truth.
  if (currentState !== prevCurrentState) {
    setPrevCurrentState(currentState);
    setOptimisticState(currentState);
  }

  const mutation = useMutation({
    mutationFn: (transitionName: string) =>
      api.applyTransition(projectId, externalId, transitionName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bench-issue", projectId, externalId] });
    },
    onError: (err) => {
      setOptimisticState(currentState);
      setError(extractPluginErrorMessage(err));
    },
  });

  const hasTransitions = allowedTransitions.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {hasTransitions ? (
          <Select
            aria-label="Transition to"
            onSelectionChange={(key) => {
              const next = key as string;
              if (next === optimisticState) return;
              setError(null);
              setOptimisticState(next);
              mutation.mutate(next);
            }}
          >
            <Button
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-stone-500/15 text-stone-400 outline-none transition-colors hover:bg-stone-500/25 focus-visible:ring-1 focus-visible:ring-amber-500"
              data-testid="transition-trigger"
            >
              <span>{optimisticState}</span>
              <ChevronDown size={10} className="shrink-0" />
            </Button>
            <Popover className="min-w-[var(--trigger-width)] rounded-lg bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 shadow-xl py-1 z-50 overflow-auto max-h-60 transition-opacity duration-150 data-[entering]:opacity-0">
              <ListBox className="outline-none" aria-label="Available transitions">
                {allowedTransitions.map((t) => (
                  <ListBoxItem
                    key={t}
                    id={t}
                    textValue={t}
                    className="px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default transition-colors data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50"
                  >
                    {t}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
        ) : (
          <span
            data-testid="transition-pill-readonly"
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-stone-500/15 text-stone-400"
          >
            {optimisticState}
          </span>
        )}
      </div>

      {!hasTransitions && (
        <p className="text-[11px] text-stone-500 dark:text-stone-600">
          No transitions available from this state.
        </p>
      )}

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
