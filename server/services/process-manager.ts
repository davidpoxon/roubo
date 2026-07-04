import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import type { ComponentLogLine } from "@roubo/shared";
import { cleanEnv } from "./env.js";

export const MAX_LOG_LINES = 5000;

interface ManagedProcess {
  id: string;
  process?: ChildProcess;
  /**
   * Structured per-line log buffer. Each entry carries its source (stdout vs
   * stderr) and a capture timestamp so the component logs surface can emit the
   * same { source, text, ts } shape for built-in components that plugin-backed
   * components push via host.component.reportLog (FR-014, NFR-004 parity).
   */
  logs: ComponentLogLine[];
  alive: boolean;
  exitCode: number | null;
}

const processes = new Map<string, ManagedProcess>();

export async function startProcess(
  id: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ pid: number }> {
  // Kill existing process with this ID if running
  if (processes.has(id)) {
    await stopProcess(id);
  }

  const proc = spawn(command, args, {
    cwd,
    env: { ...cleanEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const managed: ManagedProcess = {
    id,
    process: proc,
    logs: [],
    alive: true,
    exitCode: null,
  };

  const pushLog = appendLines(managed);

  proc.stdout?.on("data", (data: Buffer) => pushLog("stdout", data));
  proc.stderr?.on("data", (data: Buffer) => pushLog("stderr", data));

  proc.on("close", (code) => {
    managed.alive = false;
    managed.exitCode = code;
  });

  proc.on("error", (err) => {
    managed.alive = false;
    pushLog("stderr", `[process error] ${err.message}`);
  });

  processes.set(id, managed);

  if (proc.pid === undefined) {
    throw new Error(`Failed to start process "${id}": no PID assigned`);
  }

  return { pid: proc.pid };
}

/**
 * Run a command to completion and resolve with its exit code and a `timedOut`
 * flag. Unlike {@link startProcess}, which tracks a long-lived process, this
 * blocks until the command exits and is the one-shot primitive behind
 * `host.process.run` (architecture.md FR-022). `timeoutMs`, when > 0,
 * force-kills a hung run and resolves with a non-zero exit code rather than
 * rejecting, so a stuck deploy surfaces as a failed run, not an unhandled error.
 * `timedOut` is set true ONLY on the timer/force-kill path, so callers can name
 * the timeout at their surface (#411) rather than sniffing `exitCode === 124`
 * and mislabeling a process that genuinely exits 124. `exitCode` stays 124 on
 * the timeout path for back-compat. Output is captured into the managed log
 * buffer under `id` so `host.process.logs` can read it afterward.
 */
export function runProcess(
  id: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs = 0,
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: { ...cleanEnv(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const managed: ManagedProcess = {
      id,
      process: proc,
      logs: [],
      alive: true,
      exitCode: null,
    };
    processes.set(id, managed);

    const pushLog = appendLines(managed);

    proc.stdout?.on("data", (data: Buffer) => pushLog("stdout", data));
    proc.stderr?.on("data", (data: Buffer) => pushLog("stderr", data));

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const pid = proc.pid;
        if (pid) treeKill(pid, "SIGKILL", () => {});
        finish(() => {
          managed.alive = false;
          managed.exitCode = managed.exitCode ?? 124;
          resolve({ exitCode: managed.exitCode, timedOut: true });
        });
      }, timeoutMs);
    }

    proc.on("close", (code) => {
      managed.alive = false;
      managed.exitCode = code ?? 0;
      finish(() => resolve({ exitCode: managed.exitCode ?? 0, timedOut: false }));
    });

    proc.on("error", (err) => {
      managed.alive = false;
      appendLines(managed)("stderr", `[process error] ${err.message}`);
      finish(() => reject(err));
    });
  });
}

/**
 * Build the per-process line appender. Splits a chunk (Buffer or string) on
 * newlines, drops empties, stamps each surviving line with its source and a
 * monotonic-per-call ISO timestamp, and rolls the ring buffer at MAX_LOG_LINES.
 * Shared by startProcess / runProcess so both capture the same structured shape.
 */
function appendLines(managed: ManagedProcess) {
  return (source: "stdout" | "stderr", data: Buffer | string): void => {
    const text = typeof data === "string" ? data : data.toString();
    const ts = new Date().toISOString();
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      managed.logs.push({ source, text: line, ts });
      if (managed.logs.length > MAX_LOG_LINES) managed.logs.shift();
    }
  };
}

export function stopProcess(id: string): Promise<void> {
  return new Promise((resolve) => {
    const managed = processes.get(id);
    if (!managed || !managed.alive) {
      processes.delete(id);
      resolve();
      return;
    }

    const pid = managed.process?.pid;
    if (!pid) {
      processes.delete(id);
      resolve();
      return;
    }

    // Give process 5 seconds to exit gracefully before force-killing
    const timeout = setTimeout(() => {
      treeKill(pid, "SIGKILL", () => {
        processes.delete(id);
        resolve();
      });
    }, 5000);

    managed.process?.on("close", () => {
      clearTimeout(timeout);
      processes.delete(id);
      resolve();
    });

    treeKill(pid, "SIGTERM", (err) => {
      if (err) console.warn(`SIGTERM failed for PID ${pid}:`, err.message);
    });
  });
}

export function getProcessStatus(id: string): { alive: boolean; exitCode: number | null } {
  const managed = processes.get(id);
  if (!managed) return { alive: false, exitCode: null };
  return { alive: managed.alive, exitCode: managed.exitCode };
}

/**
 * Plain-text tail of a managed process's logs. This is the flattened shape the
 * broker's host.process.logs returns to a plugin; the structured component logs
 * surface uses {@link getProcessLogLines} instead.
 */
export function getProcessLogs(id: string, tail = 200): string[] {
  const managed = processes.get(id);
  if (!managed) return [];
  return managed.logs.slice(-tail).map((line) => line.text);
}

/**
 * Structured tail of a managed process's logs as ComponentLogLine[]. Backs the
 * built-in side of GET /components/:name/logs so built-in and plugin-backed
 * components return the identical { source, text, ts } shape (FR-014 parity).
 */
export function getProcessLogLines(id: string, tail = 200): ComponentLogLine[] {
  const managed = processes.get(id);
  if (!managed) return [];
  return managed.logs.slice(-tail).map((line) => ({ ...line }));
}

export function getProcessPid(id: string): number | undefined {
  return processes.get(id)?.process?.pid ?? undefined;
}

export function clearProcessLogs(id: string): void {
  processes.delete(id);
}

export function storeCommandLogs(id: string, stdout: string, stderr: string): void {
  const ts = new Date().toISOString();
  const lines: ComponentLogLine[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length > 0) lines.push({ source: "stdout", text: line, ts });
  }
  for (const line of stderr.split("\n")) {
    if (line.length > 0) lines.push({ source: "stderr", text: line, ts });
  }
  if (lines.length === 0) return;

  const existing = processes.get(id);
  if (existing) {
    existing.logs.push(...lines);
    while (existing.logs.length > MAX_LOG_LINES) existing.logs.shift();
  } else {
    processes.set(id, { id, logs: lines.slice(-MAX_LOG_LINES), alive: false, exitCode: null });
  }
}

export async function stopAllProcesses(): Promise<void> {
  const ids = Array.from(processes.keys());
  await Promise.all(ids.map((id) => stopProcess(id)));
}
