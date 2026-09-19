import { Button } from "react-aria-components";
import { Link } from "react-router";
import { OctagonAlert } from "lucide-react";
import type { AgentLaunchFailure } from "@roubo/shared";

const AGENTS_SETTINGS_ROUTE = "/settings#ai-agents";

const STRINGS = {
  openSettings: "Open plugin settings",
  retry: "Retry",
  capturedLabel: "Captured agent output",
};

const ACTION_CLASS =
  "px-2.5 py-1 text-11 font-medium rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/**
 * The in-terminal error panel for a launch that never produced a working session
 * (AP-FR-015, AP-NFR-003). Every failure class lands here, so a dead terminal is
 * structurally impossible: the message says what failed, the captured agent
 * output (ANSI already stripped server-side) says why, and the two actions are
 * the recovery routes the failure declares.
 *
 * The panel overlays the xterm surface rather than replacing it, so whatever the
 * agent managed to print before dying stays readable underneath.
 */
export default function AgentLaunchFailurePanel({
  failure,
  onRetry,
}: {
  failure: AgentLaunchFailure;
  onRetry?: () => void;
}) {
  const showSettings = failure.actions.includes("open-plugin-settings");
  const showRetry = failure.actions.includes("retry") && onRetry !== undefined;

  return (
    <div
      role="alert"
      data-testid="agent-launch-failure"
      data-failure-class={failure.class}
      className="absolute inset-x-0 top-0 z-10 p-4 pointer-events-none"
    >
      <div className="pointer-events-auto max-w-xl flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-surface px-4 py-3.5">
        <OctagonAlert size={16} className="shrink-0 mt-0.5 text-danger-text" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-13 text-danger-text">{failure.message}</p>
          {failure.guidance && (
            <p className="mt-1 text-12 text-text-body leading-relaxed">{failure.guidance}</p>
          )}
          {failure.capturedOutput && (
            <pre
              aria-label={STRINGS.capturedLabel}
              data-testid="agent-launch-failure-output"
              className="mt-2.5 overflow-x-auto rounded bg-bg-surface px-2.5 py-1.5 font-mono text-11 text-danger-text whitespace-pre-wrap break-words"
            >
              {failure.capturedOutput}
            </pre>
          )}
          {(showSettings || showRetry) && (
            <div className="mt-3 flex gap-2">
              {showSettings && (
                <Link
                  to={AGENTS_SETTINGS_ROUTE}
                  data-testid="agent-launch-failure-settings"
                  className={ACTION_CLASS}
                >
                  {STRINGS.openSettings}
                </Link>
              )}
              {showRetry && (
                <Button
                  onPress={onRetry}
                  data-testid="agent-launch-failure-retry"
                  className={ACTION_CLASS}
                >
                  {STRINGS.retry}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
