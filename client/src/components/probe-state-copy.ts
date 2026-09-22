import type { AgentChoiceProbeFailureCause } from "@roubo/shared";

// The words a probe-bound configuration field shows while its choice probe is
// loading or after it failed (#1274, APCC-FR-003). One agent-agnostic map keyed
// by the host's failure cause, so every agent plugin's probed field reads the
// same way and none of this copy names a specific AI coding agent (APCC-FR-006).
// Lives outside `ConfigSchemaForm.tsx` for the same fast-refresh reason as
// `config-schema-utils.ts`.

/** The status line beneath a probed field whose probe has not answered yet. */
export const PROBE_LOADING_TEXT = "Reading the available choices from the CLI.";

/** The empty control's text while the probe runs. */
export const PROBE_LOADING_PLACEHOLDER = "Reading choices...";

/** The empty control's text after the probe failed. */
export const PROBE_FAILED_PLACEHOLDER = "No choices available";

/** Appended to every remedy: an unset field is a valid choice, not a gap. */
const UNSET_NOTE = "Leaving this field unset is fine: the session uses your account default.";

export interface ProbeFailureCopy {
  /** What went wrong, as one sentence. */
  cause: string;
  /** What the user can do about it, ending with the unset-is-fine note. */
  remedy: string;
}

/**
 * The CLI's own words from a `probe-error` reason. The host reports a nonzero
 * exit as "`<command>` exited with code <n>: <first stderr line>", and that
 * stderr line is what tells a sign-in problem apart from any other failure, so
 * it is shown on its own. Any other reason shape is shown whole.
 */
function cliMessage(reason: string | undefined): string | undefined {
  const text = reason?.trim();
  if (!text) return undefined;
  const match = /exited with code -?\d+: (.+)$/s.exec(text);
  return (match?.[1] ?? text).trim();
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The cause and the remedy for one failed choice probe. `command-not-found`
 * and a CLI-reported `probe-error` (for example "not signed in") read
 * differently because the second quotes the CLI's own message (APCC-TC-016).
 */
export function probeFailureCopy(
  cause: AgentChoiceProbeFailureCause | undefined,
  reason: string | undefined,
): ProbeFailureCopy {
  switch (cause) {
    case "command-not-found":
      return {
        cause: "Could not read the choices: the CLI command was not found.",
        remedy: `Install the CLI, or add its folder to your PATH, then reopen this screen. ${UNSET_NOTE}`,
      };
    case "probe-error": {
      const message = cliMessage(reason);
      return {
        cause: message
          ? `Could not read the choices: ${sentence(message)}`
          : "Could not read the choices: the CLI command failed.",
        remedy: `Fix what the CLI reported, for example by signing in to it in a terminal, then reopen this screen. ${UNSET_NOTE}`,
      };
    }
    case "timeout":
      return {
        cause: "Could not read the choices: the CLI did not answer within 5 seconds.",
        remedy: `Check your network connection, then reopen this screen. ${UNSET_NOTE}`,
      };
    case "parse-error":
      return {
        cause: "Could not read the choices: the CLI listed no choices.",
        remedy: `Update the CLI to a version this plugin supports, then reopen this screen. ${UNSET_NOTE}`,
      };
    default:
      return {
        cause: "Could not read the choices.",
        remedy: `Reopen this screen to try again. ${UNSET_NOTE}`,
      };
  }
}
