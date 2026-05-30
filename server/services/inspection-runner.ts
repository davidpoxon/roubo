import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import treeKill from "tree-kill";
import type { InspectionRun } from "@roubo/shared";
import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import { buildTemplateContext, resolveServiceEnv } from "./config-parser.js";
import { parseCommand } from "./exec.js";
import { ServiceError } from "./service-error.js";
import { assertBenchOperable } from "./bench-operability.js";
import { createNotification, dismissOne } from "./notification.js";

interface InternalInspectionRun {
  run: InspectionRun;
  process: ChildProcess;
}

const runs = new Map<string, InternalInspectionRun>();

function runKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

let runCounter = 0;

export function startInspection(
  projectId: string,
  benchId: number,
  filter?: string,
): InspectionRun {
  const key = runKey(projectId, benchId);
  const existing = runs.get(key);
  if (existing && existing.run.status === "running") {
    throw new ServiceError(409, "An inspection run is already active for this bench");
  }

  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) throw new ServiceError(404, "Bench not found");

  // Refuse a non-operable bench (blank workspacePath, see bench-operability.ts):
  // path.resolve("", inspection.directory) would otherwise root the spawn cwd at the
  // server's own working directory.
  assertBenchOperable(bench, "be inspected");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config?.inspection)
    throw new ServiceError(400, "No inspection configuration for this project");

  const inspection = project.config.inspection;
  const ctx = buildTemplateContext(project.config, benchId, bench.workspacePath);
  const inspectionEnv = inspection.env ? resolveServiceEnv(inspection.env, ctx) : {};
  const cwd = path.resolve(bench.workspacePath, inspection.directory);

  const cmdParts = parseCommand(inspection.command);
  const command = cmdParts[0];
  const args = [...cmdParts.slice(1)];
  if (filter) {
    if (filter.length > 200) {
      throw new Error("Filter is too long (max 200 characters)");
    }
    if (/[;&|`$(){}!\n\\]/.test(filter)) {
      throw new Error("Filter contains invalid characters");
    }
    args.push("--grep", filter);
  }

  runCounter++;
  const run: InspectionRun = {
    id: `inspection-${Date.now()}-${runCounter}`,
    projectId: projectId,
    benchId: benchId,
    status: "running",
    filter,
    output: [],
    exitCode: null,
    startedAt: new Date().toISOString(),
  };

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...inspectionEnv },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const MAX_OUTPUT_LINES = 10_000;
  const pushOutput = (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        run.output.push(line);
      }
    }
    if (run.output.length > MAX_OUTPUT_LINES) {
      run.output.splice(0, run.output.length - MAX_OUTPUT_LINES);
    }
  };

  proc.stdout?.on("data", pushOutput);
  proc.stderr?.on("data", pushOutput);

  proc.on("close", (code) => {
    if (run.status === "aborted" || run.status === "error") return; // already handled
    run.exitCode = code;
    run.status = code === 0 ? "passed" : "failed";
    run.completedAt = new Date().toISOString();
    // Re-fetch bench for fresh state; bench may no longer exist if cleared while inspection ran
    const completedBench = benchManager.getBench(projectId, benchId);
    if (completedBench) {
      // Dismiss any stale inspection-complete notification before creating a fresh one so
      // the deduplication logic doesn't silently return an outdated result
      const stale = completedBench.notifications.find((n) => n.type === "inspection-complete");
      if (stale) dismissOne(completedBench, stale.id);
      createNotification(completedBench, "inspection-complete", undefined, { passed: code === 0 });
    }
  });

  proc.on("error", (err) => {
    run.output.push(`[error] ${err.message}`);
    run.status = "error";
    run.completedAt = new Date().toISOString();
    const errorBench = benchManager.getBench(projectId, benchId);
    if (errorBench) {
      const stale = errorBench.notifications.find((n) => n.type === "inspection-complete");
      if (stale) dismissOne(errorBench, stale.id);
      createNotification(errorBench, "inspection-complete", undefined, { passed: false });
    }
  });

  runs.set(key, { run, process: proc });
  return run;
}

export function getInspection(projectId: string, benchId: number): InspectionRun | undefined {
  return runs.get(runKey(projectId, benchId))?.run;
}

export function getInspectionOutput(
  projectId: string,
  benchId: number,
  since?: number,
): { run: InspectionRun; output: string[] } | undefined {
  const internal = runs.get(runKey(projectId, benchId));
  if (!internal) return undefined;

  const output =
    since !== undefined && since >= 0 ? internal.run.output.slice(since) : internal.run.output;

  return {
    run: { ...internal.run, output },
    output,
  };
}

export function stopInspection(projectId: string, benchId: number): boolean {
  const key = runKey(projectId, benchId);
  const internal = runs.get(key);
  if (!internal || internal.run.status !== "running") return false;

  const pid = internal.process.pid;
  if (pid) {
    treeKill(pid, "SIGTERM", (err) => {
      if (err) console.warn(`Failed to kill test process ${pid}:`, err.message);
    });
  }

  internal.run.status = "aborted";
  internal.run.exitCode = -1;
  internal.run.completedAt = new Date().toISOString();
  internal.run.output.push("[aborted by user]");

  return true;
}
