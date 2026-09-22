import { spawn } from "node:child_process";
import { cleanEnv } from "./env.js";

// The bounded spawn behind every host-executed probe (#1266, APCC-NFR-001).
//
// It lives apart from `runCommand` in exec.ts on purpose. That helper serves a
// dozen unrelated callers, buffers without limit, and reports a timeout only as a
// line appended to stderr, so a caller cannot tell a kill from an ordinary
// failure. A probe runs a third-party CLI on the user's behalf and parses what it
// prints, so it needs three things `runCommand` does not give: a hard ceiling on
// what it reads, a kill that cannot be ignored, and a flag that says which of the
// two happened.
//
// It is a module of its own so tests can replace the spawn without replacing the
// runner that calls it.

/** How long a probe may run before it is killed (model-probe spike: the CLI can hang forever). */
export const PROBE_TIMEOUT_MS = 5000;

/** The most output, across stdout and stderr together, a probe reads before it is killed. */
export const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

export interface ProbeSpawnBounds {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProbeSpawnOutput {
  code: number;
  stdout: string;
  stderr: string;
  /** The child was killed at the time bound. Absent means false. */
  timedOut?: boolean;
  /** The child was killed at the output bound, and the output is cut at it. Absent means false. */
  truncated?: boolean;
}

/**
 * Spawn `file` with `args` as argv and capture its output within `bounds`.
 *
 * No shell ever runs: `shell: false` is explicit, so a declared argument that
 * looks like shell syntax reaches the CLI as one literal argument (APCC-TC-021).
 * Nothing is written to stdin, and it is not even opened, so a CLI that stops to
 * ask a question reads end-of-file rather than waiting on the host.
 *
 * Never rejects. A child that fails to start resolves as exit code 1 with the
 * error message on stderr, the shape `runCommand` has always used, so a reader
 * sees one kind of failed run. A child killed at either bound resolves at once,
 * without waiting for its streams to close, because a grandchild holding the
 * pipe open must not hold the probe open with it.
 */
export function spawnProbe(
  file: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> | undefined,
  bounds: ProbeSpawnBounds,
): Promise<ProbeSpawnOutput> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let settled = false;

    const proc = spawn(file, [...args], {
      cwd,
      env: { ...cleanEnv(), ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const settle = (
      code: number,
      flags: { timedOut?: boolean; truncated?: boolean; error?: string } = {},
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = Buffer.concat(stderr).toString("utf8");
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: flags.error !== undefined ? err + flags.error : err,
        ...(flags.timedOut === true && { timedOut: true }),
        ...(flags.truncated === true && { truncated: true }),
      });
    };

    const kill = () => {
      proc.kill("SIGKILL");
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    };

    const timer = setTimeout(() => {
      kill();
      settle(1, { timedOut: true });
    }, bounds.timeoutMs);

    const capture = (into: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      const room = bounds.maxOutputBytes - captured;
      if (chunk.length > room) {
        into.push(chunk.subarray(0, room));
        captured = bounds.maxOutputBytes;
        kill();
        settle(1, { truncated: true });
        return;
      }
      into.push(chunk);
      captured += chunk.length;
    };

    proc.stdout?.on("data", capture(stdout));
    proc.stderr?.on("data", capture(stderr));
    proc.on("error", (err) => settle(1, { error: err.message }));
    proc.on("close", (code) => settle(code ?? 1));
  });
}
