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
      className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 bg-stone-100/95 dark:bg-stone-900/95 backdrop-blur-sm border-b border-stone-200 dark:border-stone-800 px-3 py-1.5 transition-opacity duration-200"
      role="status"
    >
      {state === "reconnecting" ? (
        <>
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
          <span className="text-xs font-mono text-stone-700 dark:text-stone-300">
            Reconnecting{attempt > 0 ? ` (attempt ${attempt})` : ""}...
          </span>
          {attempt > 5 && (
            <Button
              onPress={onRetry}
              className="ml-auto text-xs font-mono text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 px-2 py-0.5 rounded hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none"
            >
              Retry
            </Button>
          )}
        </>
      ) : (
        <>
          <span className="size-1.5 rounded-full bg-stone-300 dark:bg-stone-600 shrink-0" />
          <span className="text-xs font-mono text-stone-500">Process ended</span>
        </>
      )}
    </div>
  );
}
