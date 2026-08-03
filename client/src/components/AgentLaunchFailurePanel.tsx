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
  "px-2.5 py-1 text-[11px] font-medium rounded-md text-stone-300 bg-stone-800 hover:bg-stone-700 hover:text-stone-100 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

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
      <div className="pointer-events-auto max-w-xl flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/[0.06] backdrop-blur-sm px-4 py-3.5">
        <OctagonAlert size={16} className="shrink-0 mt-0.5 text-red-500" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[13px] text-stone-200">{failure.message}</p>
          {failure.guidance && (
            <p className="mt-1 text-xs text-stone-500 leading-relaxed">{failure.guidance}</p>
          )}
          {failure.capturedOutput && (
            <pre
              aria-label={STRINGS.capturedLabel}
              data-testid="agent-launch-failure-output"
              className="mt-2.5 overflow-x-auto rounded bg-stone-950/60 px-2.5 py-1.5 font-mono text-[11px] text-red-400/80 whitespace-pre-wrap break-words"
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
