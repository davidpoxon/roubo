import { exec, execFile } from "node:child_process";
import type { ResolvedTool, ToolResult } from "@roubo/shared";
import * as projectRegistry from "./project-registry.js";
import * as benchManager from "./bench-manager.js";
import { BenchError } from "./bench-manager.js";
import { buildTemplateContext, resolveTemplate, applyContainerOverrides } from "./config-parser.js";

export function getResolvedTools(projectId: string, benchId: number): ResolvedTool[] {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config)
    throw new BenchError(
      `Project '${projectId}' not found or has invalid config`,
      "PROJECT_NOT_FOUND",
    );

  const bench = benchManager.getBench(projectId, benchId);
  if (!bench)
    throw new BenchError(`Bench ${benchId} not found for project '${projectId}'`, "NOT_FOUND");

  const tools = project.config.tools;
  if (!tools || tools.length === 0) return [];

  const ctx = buildTemplateContext(project.config, benchId, bench.workspacePath);
  applyContainerOverrides(ctx, bench.assignedContainers);

  const hasUsers = (project.config.users?.length ?? 0) > 0;

  return tools.map((tool) => {
    const enabled = !tool.requires || bench.components[tool.requires]?.status === "running";

    return {
      name: tool.name,
      icon: tool.icon,
      type: tool.type,
      url: tool.url ? resolveTemplate(tool.url, ctx) : undefined,
      command: tool.command ? resolveTemplate(tool.command, ctx) : undefined,
      requires: tool.requires,
      login: tool.login,
      enabled,
      requiresUserPicker: hasUsers && !!tool.login,
    };
  });
}

export async function executeTool(
  projectId: string,
  benchId: number,
  toolIndex: number,
  userName?: string,
): Promise<ToolResult> {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config)
    return {
      success: false,
      error: `Project '${projectId}' not found or has invalid config`,
    };

  const bench = benchManager.getBench(projectId, benchId);
  if (!bench)
    return {
      success: false,
      error: `Bench ${benchId} not found for project '${projectId}'`,
    };

  const tools = project.config.tools;
  if (!tools || toolIndex < 0 || toolIndex >= tools.length) {
    return { success: false, error: `Invalid tool index: ${toolIndex}` };
  }

  const rawTool = tools[toolIndex];
  const enabled = !rawTool.requires || bench.components[rawTool.requires]?.status === "running";

  if (!enabled) {
    return {
      success: false,
      error: `Tool '${rawTool.name}' is disabled (required component '${rawTool.requires}' is not running)`,
    };
  }

  const hasUsers = (project.config.users?.length ?? 0) > 0;
  if (hasUsers && !!rawTool.login && !userName) {
    return {
      success: false,
      error: `Tool '${rawTool.name}' requires a user selection`,
    };
  }

  const selectedUser = userName
    ? project.config.users?.find((u) => u.name === userName)
    : undefined;
  const ctx = buildTemplateContext(project.config, benchId, bench.workspacePath);
  applyContainerOverrides(ctx, bench.assignedContainers);
  ctx.user = selectedUser?.properties;

  const url = rawTool.url ? resolveTemplate(rawTool.url, ctx) : undefined;
  const command = rawTool.command ? resolveTemplate(rawTool.command, ctx) : undefined;
  const login = rawTool.login
    ? {
        steps: rawTool.login.steps.map((step) =>
          step.value != null ? { ...step, value: resolveTemplate(step.value, ctx) } : step,
        ),
      }
    : undefined;

  try {
    if (rawTool.type === "browser" && url) {
      await execFileAsync("open", [url]);
    } else if (rawTool.type === "shell" && command) {
      await execAsync(command, bench.workspacePath);
    } else {
      return {
        success: false,
        error: `Tool '${rawTool.name}' has no URL or command`,
      };
    }
    return { success: true, login };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function execAsync(command: string, cwd?: string): Promise<void> {
  // exec is intentional: it passes the command to /bin/sh so the OS shell
  // handles argument quoting (e.g. `open -a "Rider" "/path with spaces"`).
  // All template values substituted into shell tool commands must be
  // trusted (internal paths, allocated ports, developer-controlled roubo.yaml
  // user properties) — never externally-sourced strings.
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
