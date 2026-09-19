import { Button } from "react-aria-components";
import type { ConnectionState } from "../hooks/useTerminalConnection";

export default function ReconnectBanner({
  state,
  attempt,
  onRetry,
}: {
  state: ConnectionState;
  attempt: number;
  onRetry: () => void;
}) {
  if (state === "connected" || state === "connecting") return null;

  return (
    <div
      className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 bg-bg-surface border-b border-border px-3 py-1.5 transition-opacity duration-200"
      role="status"
    >
      {state === "reconnecting" ? (
        <>
          <span className="size-1.5 rounded-full bg-status-preparing animate-status-pulse shrink-0" />
          <span className="text-12 font-mono text-text-body">
            Reconnecting{attempt > 0 ? ` (attempt ${attempt})` : ""}...
          </span>
          {attempt > 5 && (
            <Button
              onPress={onRetry}
              className="ml-auto text-12 font-mono text-text-secondary hover:text-text-primary px-2 py-0.5 rounded-control hover:bg-bg-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Retry
            </Button>
          )}
        </>
      ) : (
        <>
          <span className="size-1.5 rounded-full bg-status-idle shrink-0" />
          <span className="text-12 font-mono text-text-secondary">Process ended</span>
        </>
      )}
    </div>
  );
}
