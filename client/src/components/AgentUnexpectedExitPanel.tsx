import { Button } from "react-aria-components";
import { OctagonAlert, X } from "lucide-react";
import type { SessionUnexpectedExit } from "@roubo/shared";
import { describeExitCause, formatRunTime, unexpectedExitHint } from "../lib/unexpected-exit";

const STRINGS = {
  headline: "The AI coding agent ended unexpectedly",
  dismiss: "Dismiss",
};

/**
 * `overlay` sits over the top of the xterm surface of the session that died, like
 * the launch-failure panel. `inline` sits in normal document flow in the bench
 * detail view, where the same event is kept as a notice until it is dismissed.
 */
export type AgentUnexpectedExitPanelVariant = "overlay" | "inline";

/**
 * The record of an agent that launched fine and then died on its own: a signal
 * or a nonzero exit, as opposed to the user closing the tab. The launch-failure
 * panel covers the session that never started; this covers the one that ran.
 * It names what ended the process so nobody has to read the raw transcript to
 * find out the agent was killed.
 */
export default function AgentUnexpectedExitPanel({
  exit,
  label,
  variant = "overlay",
  onDismiss,
}: {
  exit: SessionUnexpectedExit;
  /** The session's tab label, so a bench with several sessions says which one. */
  label?: string;
  variant?: AgentUnexpectedExitPanelVariant;
  onDismiss?: () => void;
}) {
  const hint = unexpectedExitHint(exit);
  const testId = variant === "inline" ? "agent-unexpected-exit-inline" : "agent-unexpected-exit";

  return (
    <div
      role="alert"
      data-testid={testId}
      className={
        variant === "overlay" ? "absolute inset-x-0 top-0 z-10 p-4 pointer-events-none" : "mb-6"
      }
    >
      <div
        className={
          variant === "overlay"
            ? "pointer-events-auto max-w-xl flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-surface px-4 py-3.5"
            : "flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-surface px-4 py-3.5"
        }
      >
        <OctagonAlert size={16} className="shrink-0 mt-0.5 text-danger-text" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-13 text-danger-text">{STRINGS.headline}</p>
          <p data-testid="agent-unexpected-exit-cause" className="mt-1 text-12 text-text-body">
            {`Ended with ${describeExitCause(exit)} after running for ${formatRunTime(exit.timeToExitMs)}.`}
          </p>
          {hint && <p className="mt-1 text-12 text-text-body leading-relaxed">{hint}</p>}
          {label && (
            <p
              data-testid="agent-unexpected-exit-label"
              className="mt-1 text-11 text-text-secondary"
            >
              {label}
            </p>
          )}
        </div>
        {onDismiss && (
          <Button
            onPress={onDismiss}
            aria-label={STRINGS.dismiss}
            data-testid="agent-unexpected-exit-dismiss"
            className="shrink-0 p-1 rounded-control text-danger-text hover:bg-bg-surface active:bg-bg-pressed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
