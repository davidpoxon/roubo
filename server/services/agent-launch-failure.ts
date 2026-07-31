import type { AgentLaunchFailure, AgentLaunchFailureAction } from "@roubo/shared";
import type { AgentVersionProbeResult } from "./agent-version-probe.js";

// Agent launch-failure detection and wording (issue #519, AP-FR-015, AP-NFR-003).
//
// Implements spike #504's AC2 classifier verbatim. A PTY has no separate stderr
// fd, so "capture stderr" means: buffer the merged stream from byte zero, and
// when the child exits inside the early window the buffer IS the error text.
// Observed failures are under 300 bytes arriving within ~110ms, so the session's
// existing ring buffer is far more than enough.
//
// The heuristic in one sentence: a launch failure requires all three signals
// together, exit inside the window AND a nonzero code AND nonempty output.
// Timing alone would misclassify a fast `--version` exit, exit code alone would
// misclassify a session that dies at 6s, and nonzero-with-zero-output is the
// missing-binary exec arm (node-pty's spawn helper fails after the fork on
// macOS, so an absent binary does not throw: the child exits 1 with no output).

/** How long after spawn an exit still counts as a launch failure (spike #504). */
export const EARLY_EXIT_WINDOW_MS = 5000;

/** Cap on the captured agent output carried to the client. */
const MAX_CAPTURE_BYTES = 4096;

export type PtyExitClass =
  "launch-failure" | "missing-binary" | "fast-clean-exit" | "session-ended";

export interface PtyExitSignals {
  exitCode: number;
  /** Milliseconds from spawn to exit. */
  timeToExitMs: number;
  /** Bytes captured from the merged PTY stream. */
  outputBytes: number;
  windowMs?: number;
}

/**
 * Classify a PTY exit against spike #504's counterexamples.
 *
 * - `claude --version` exits 0 in 48ms: fast-clean-exit, never a failure.
 * - `sh -c 'sleep 6; exit 3'` exits nonzero at 6019ms: session-ended, outlived
 *   the window, so it is a session that died rather than one that never started.
 * - An absent binary exits 1 in 6ms with zero output: missing-binary, where the
 *   right message is about the binary rather than the flags.
 * - `codex --enable-auto-mode` exits 2 in 52ms with 278 bytes: launch-failure,
 *   and those bytes are what the user needs to read.
 */
export function classifyPtyExit(signals: PtyExitSignals): PtyExitClass {
  const windowMs = signals.windowMs ?? EARLY_EXIT_WINDOW_MS;
  if (signals.timeToExitMs > windowMs) return "session-ended";
  if (signals.exitCode === 0) return "fast-clean-exit";
  // 127 is command-not-found. It arrives WITH output ("sh: codex: command not
  // found"), so the three-signal rule alone would read it as a launch failure
  // and show the user a shell diagnostic as if it were the agent's own words.
  if (signals.exitCode === SHELL_COMMAND_NOT_FOUND) return "missing-binary";
  return signals.outputBytes > 0 ? "launch-failure" : "missing-binary";
}

/** The exit code a shell reports for a command it could not find (spike #504 S3). */
const SHELL_COMMAND_NOT_FOUND = 127;

// CSI, OSC and the two-character escapes an agent TUI emits before it dies.
//
// Built from a string rather than written as a regex literal: ESC and BEL are
// control characters, and `no-control-regex` forbids them inside a literal. The
// pattern is the same either way, and the escapes stay readable as \u001b /
// \u0007 instead of being invisible bytes in the source.
const ESC = "\\u001b";
const ANSI_RE = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI: colours, cursor moves, screen clears
    `${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, // OSC: window titles, terminated by BEL or ST
    `${ESC}[@-Z\\\\-_]`, // the two-character escapes
  ].join("|"),
  "g",
);

/** Strip ANSI escape sequences so a captured error reads as plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * The captured agent output, ANSI-stripped, trimmed and truncated, or undefined
 * when the agent said nothing worth showing.
 */
export function captureOutput(raw: string): string | undefined {
  const clean = stripAnsi(raw).replace(/\r\n?/g, "\n").trim();
  if (clean.length === 0) return undefined;
  if (clean.length <= MAX_CAPTURE_BYTES) return clean;
  return `${clean.slice(0, MAX_CAPTURE_BYTES)}\n... (truncated)`;
}

/** Both recovery affordances, the pairing the prototype's error panel offers. */
const RECOVERY_ACTIONS: AgentLaunchFailureAction[] = ["open-plugin-settings", "retry"];

export interface AgentLaunchContextInfo {
  agentPluginId: string;
  agentName: string;
  /** The binary the launch resolved (or tried to resolve). */
  command: string;
  /** The pre-launch probe result, when the agent declared a probe. */
  compatibility?: AgentVersionProbeResult;
}

/** An agent CLI that could not be found anywhere (AP-TC-058). */
export function missingBinaryFailure(
  ctx: AgentLaunchContextInfo,
  detail: string,
  exit?: { exitCode: number; timeToExitMs: number },
): AgentLaunchFailure {
  return {
    class: "missing-binary",
    message: `${ctx.agentName} could not start: the "${ctx.command}" CLI was not found.`,
    guidance: `Install the agent CLI, or point ${ctx.agentName} at an existing install from its plugin settings. ${detail}`,
    agentPluginId: ctx.agentPluginId,
    agentName: ctx.agentName,
    ...(exit !== undefined && { exitCode: exit.exitCode, timeToExitMs: exit.timeToExitMs }),
    actions: RECOVERY_ACTIONS,
  };
}

/**
 * A `pty.spawn` throw, which spike #504 traced to node-pty's own spawn helper
 * being unusable. In that state every spawn fails, including known-good
 * binaries, so it is a Roubo install problem and is attributed to the host
 * rather than to the agent plugin.
 */
export function hostInstallBrokenFailure(
  ctx: AgentLaunchContextInfo,
  detail: string,
): AgentLaunchFailure {
  return {
    class: "host-install-broken",
    message: "Roubo could not open a terminal for this session.",
    guidance: `This is a Roubo install problem rather than an agent problem: no process could be spawned at all. Reinstall Roubo, or reinstall its dependencies, then try again. ${detail}`,
    agentPluginId: ctx.agentPluginId,
    agentName: ctx.agentName,
    actions: ["retry"],
  };
}

/** A detected CLI version below the plugin's declared floor (AP-TC-071). */
export function belowFloorFailure(
  ctx: Pick<AgentLaunchContextInfo, "agentPluginId" | "agentName">,
  probe: AgentVersionProbeResult,
): AgentLaunchFailure {
  return {
    class: "below-floor-version",
    message: `${ctx.agentName} requires CLI version ${probe.minVersion} or newer, but ${probe.detectedVersion} is installed.`,
    guidance: `Update the agent CLI to ${probe.minVersion} or newer, then launch again. Nothing was started, so no session is running.`,
    agentPluginId: ctx.agentPluginId,
    agentName: ctx.agentName,
    ...(probe.detectedVersion !== undefined && { detectedVersion: probe.detectedVersion }),
    ...(probe.minVersion !== undefined && { minVersion: probe.minVersion }),
    ...(probe.testedCeiling !== undefined && { testedCeiling: probe.testedCeiling }),
    actions: RECOVERY_ACTIONS,
  };
}

/**
 * An early nonzero exit with captured output: the agent started and rejected
 * something, so its own words are the error body (AP-TC-075, AP-TC-077).
 *
 * When the detected version is above the plugin's tested ceiling the failure is
 * additionally attributed to a probably-stale argument map, which is the whole
 * reason a non-blocking ceiling is worth carrying.
 */
export function earlyExitFailure(
  ctx: AgentLaunchContextInfo,
  exit: { exitCode: number; timeToExitMs: number; output: string },
): AgentLaunchFailure {
  const seconds = (exit.timeToExitMs / 1000).toFixed(1);
  const stale =
    ctx.compatibility?.status === "above-tested-ceiling"
      ? ` The ${ctx.agentName} plugin was only tested up to CLI ${ctx.compatibility.testedCeiling} and ${ctx.compatibility.detectedVersion} is installed, so its arguments may be stale.`
      : "";
  const captured = captureOutput(exit.output);
  return {
    class: "launch-failure",
    message: `${ctx.agentName} failed to launch: exited in ${seconds}s.`,
    guidance: `Check the agent's arguments in its plugin settings, or update the plugin.${stale}`,
    ...(captured !== undefined && { capturedOutput: captured }),
    agentPluginId: ctx.agentPluginId,
    agentName: ctx.agentName,
    ...(ctx.compatibility?.detectedVersion !== undefined && {
      detectedVersion: ctx.compatibility.detectedVersion,
    }),
    ...(ctx.compatibility?.testedCeiling !== undefined && {
      testedCeiling: ctx.compatibility.testedCeiling,
    }),
    exitCode: exit.exitCode,
    timeToExitMs: exit.timeToExitMs,
    actions: RECOVERY_ACTIONS,
  };
}

/**
 * The failure for a PTY exit, or `undefined` when the exit was not a launch
 * failure at all. The single seam `registerSession` calls on exit.
 */
export function classifyLaunchExit(
  ctx: AgentLaunchContextInfo,
  exit: { exitCode: number; timeToExitMs: number; output: string; windowMs?: number },
): AgentLaunchFailure | undefined {
  const cls = classifyPtyExit({
    exitCode: exit.exitCode,
    timeToExitMs: exit.timeToExitMs,
    outputBytes: Buffer.byteLength(exit.output, "utf8"),
    ...(exit.windowMs !== undefined && { windowMs: exit.windowMs }),
  });
  if (cls === "launch-failure") return earlyExitFailure(ctx, exit);
  if (cls === "missing-binary") {
    return missingBinaryFailure(
      ctx,
      `The process exited immediately with no output, which is what an unrunnable binary looks like. Tried: ${ctx.command}.`,
      { exitCode: exit.exitCode, timeToExitMs: exit.timeToExitMs },
    );
  }
  return undefined;
}

/**
 * A non-blocking compatibility notice, or `undefined` when the probe found
 * nothing worth saying. Above the tested ceiling the launch proceeds (agents
 * ship weekly, so a ceiling must never block); a probe that could not decide
 * likewise proceeds but says so rather than launching silently (AP-TC-074).
 */
export function compatibilityNotice(
  agentName: string,
  probe: AgentVersionProbeResult,
): string | undefined {
  if (probe.status === "above-tested-ceiling") {
    return (
      `${agentName} CLI ${probe.detectedVersion} is newer than the highest version this plugin was tested against ` +
      `(${probe.testedCeiling}). Launching anyway; if it misbehaves, update the plugin.`
    );
  }
  if (probe.status === "probe-failed") {
    return (
      `${agentName} CLI version could not be determined, so its compatibility was not checked. ` +
      `Launching anyway. ${probe.reason ?? ""}`.trim()
    );
  }
  return undefined;
}

/** Carries a structured failure out of the launch path to the HTTP layer. */
export class AgentLaunchFailureError extends Error {
  constructor(public readonly failure: AgentLaunchFailure) {
    super(failure.message);
    this.name = "AgentLaunchFailureError";
  }
}
