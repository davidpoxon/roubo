import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import { cleanEnv } from "./env.js";

const MAX_LOG_LINES = 5000;

interface ManagedProcess {
  id: string;
  process?: ChildProcess;
  logs: string[];
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

  const pushLog = (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        managed.logs.push(line);
        if (managed.logs.length > MAX_LOG_LINES) {
          managed.logs.shift();
        }
      }
    }
  };

  proc.stdout?.on("data", pushLog);
  proc.stderr?.on("data", pushLog);

  proc.on("close", (code) => {
    managed.alive = false;
    managed.exitCode = code;
  });

  proc.on("error", (err) => {
    managed.alive = false;
    managed.logs.push(`[process error] ${err.message}`);
  });

  processes.set(id, managed);

  if (proc.pid === undefined) {
    throw new Error(`Failed to start process "${id}": no PID assigned`);
  }

  return { pid: proc.pid };
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

export function getProcessLogs(id: string, tail = 200): string[] {
  const managed = processes.get(id);
  if (!managed) return [];
  return managed.logs.slice(-tail);
}

export function getProcessPid(id: string): number | undefined {
  return processes.get(id)?.process?.pid ?? undefined;
}

export function clearProcessLogs(id: string): void {
  processes.delete(id);
}

export function storeCommandLogs(id: string, stdout: string, stderr: string): void {
  const lines: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length > 0) lines.push(line);
  }
  for (const line of stderr.split("\n")) {
    if (line.length > 0) lines.push(line);
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
