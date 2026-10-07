import type { SessionUnexpectedExit } from "@roubo/shared";

/**
 * How an agent session ended, in the words every surface shares: the terminal
 * line, the pane panel and the bench notice. `SIGKILL (exit 137)` when a wrapper
 * reported a killed child as an exit code, a bare `SIGKILL` when the child was
 * signalled directly and never produced one, `exit code 3` otherwise.
 */
export function describeExitCause(exit: SessionUnexpectedExit): string {
  if (exit.signal !== null) {
    return exit.exitCode !== null ? `${exit.signal} (exit ${exit.exitCode})` : exit.signal;
  }
  return `exit code ${exit.exitCode ?? "unknown"}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** A session's run time as a short phrase: `30 seconds`, `45 minutes`, `2 hours 5 minutes`. */
export function formatRunTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return plural(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(rest, "minute")}`;
}

/**
 * What the cause usually means, when it says something. A SIGKILL is never what
 * an agent does to itself, and the usual external sender is the system running
 * out of memory, so say so without claiming it. Absent for any other cause,
 * where a guess would be noise.
 */
export function unexpectedExitHint(exit: SessionUnexpectedExit): string | undefined {
  if (exit.signal === "SIGKILL") {
    return "The process was killed from outside the agent. This often means the system ran out of memory.";
  }
  return undefined;
}
