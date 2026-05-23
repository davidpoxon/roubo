import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import {
  RouboConfigSchema,
  zodIssuesToValidationErrors,
  type ConfigFieldError,
} from "@roubo/shared";
import type { RouboConfig, AssignedContainer } from "@roubo/shared";
import { allocatePorts } from "./port-allocator.js";

export interface ParseResult {
  valid: boolean;
  config?: RouboConfig;
  errors?: string[];
  fieldErrors?: ConfigFieldError[];
}

function toParseResult(zodResult: ReturnType<typeof RouboConfigSchema.safeParse>): ParseResult {
  if (zodResult.success) {
    return { valid: true, config: zodResult.data as RouboConfig };
  }
  const fieldErrors = zodIssuesToValidationErrors(zodResult.error.issues);
  const errors = fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`);
  return { valid: false, errors, fieldErrors };
}

export function parseConfig(repoPath: string): ParseResult {
  const configPath = path.join(repoPath, ".roubo", "roubo.yaml");

  if (!fs.existsSync(configPath)) {
    return { valid: false, errors: [`roubo.yaml not found at ${configPath}`] };
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    raw = YAML.parse(content);
  } catch (e) {
    return {
      valid: false,
      errors: [`Failed to parse YAML: ${(e as Error).message}`],
    };
  }

  coerceEnvValues(raw);
  const legacyError = detectLegacyJigKeys(raw);
  if (legacyError) {
    return { valid: false, errors: [legacyError] };
  }
  return toParseResult(RouboConfigSchema.safeParse(raw));
}

export function validateConfigObject(config: unknown): ParseResult {
  const legacyError = detectLegacyJigKeys(config);
  if (legacyError) {
    return { valid: false, errors: [legacyError] };
  }
  return toParseResult(RouboConfigSchema.safeParse(config));
}

/**
 * Reports a specific actionable error when a roubo.yaml still uses the legacy
 * `blueprints:` top-level key or the older `project.blueprintSettings` nested
 * block. Without this hook the strict schema would surface a generic
 * "Unrecognized key" message that doesn't point users at the rename.
 */
function detectLegacyJigKeys(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if ("blueprints" in obj) {
    return "Found legacy top-level `blueprints:` key. Rename it to `jigs:` and rename `defaultBlueprint` -> `defaultJig`.";
  }
  const project = obj.project;
  if (project && typeof project === "object" && "blueprintSettings" in project) {
    return "Found legacy `project.blueprintSettings` block. Move its contents under a top-level `jigs:` key and rename `defaultBlueprintId` -> `defaultJig`.";
  }
  return null;
}

export interface ResolvedTemplateContext {
  ports: Record<string, number>;
  portHttps: Record<string, boolean>;
  workspace: string;
  components: Record<string, { connection?: string }>;
  user?: Record<string, string>;
}

export function resolveTemplate(template: string, ctx: ResolvedTemplateContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    const key = expr.trim();

    if (key.startsWith("ports.")) {
      const portName = key.slice("ports.".length);
      const port = ctx.ports[portName];
      if (port !== undefined) return String(port);
    }

    if (key.startsWith("urls.")) {
      const portName = key.slice("urls.".length);
      const port = ctx.ports[portName];
      if (port !== undefined) {
        const protocol = ctx.portHttps[portName] ? "https" : "http";
        return `${protocol}://localhost:${port}`;
      }
    }

    if (key === "workspace") return ctx.workspace;

    if (key.startsWith("user.")) {
      const propName = key.slice("user.".length);
      return ctx.user?.[propName] ?? "";
    }

    if (key.startsWith("components.")) {
      const parts = key.split(".");
      if (parts.length === 3 && parts[2] === "connection") {
        return ctx.components[parts[1]]?.connection ?? "";
      }
    }

    return `{{${key}}}`; // leave unresolved
  });
}

export function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function buildTemplateContext(
  config: RouboConfig,
  benchNumber: number,
  workspacePath: string,
): ResolvedTemplateContext {
  const ports = allocatePorts(config, benchNumber);

  const portHttps: Record<string, boolean> = {};
  for (const [name, portConfig] of Object.entries(config.ports)) {
    portHttps[name] = portConfig.https ?? false;
  }

  const components: Record<string, { connection?: string }> = {};
  for (const [name, component] of Object.entries(config.components)) {
    if (component.connection?.template) {
      const partialCtx: ResolvedTemplateContext = {
        ports,
        portHttps,
        workspace: workspacePath,
        components: {},
      };
      components[name] = {
        connection: resolveTemplate(component.connection.template, partialCtx),
      };
    } else {
      components[name] = {};
    }
  }

  return { ports, portHttps, workspace: workspacePath, components };
}

export function applyContainerOverrides(
  ctx: ResolvedTemplateContext,
  assignedContainers?: Record<string, AssignedContainer>,
): void {
  if (!assignedContainers) return;
  for (const [svc, assigned] of Object.entries(assignedContainers)) {
    ctx.ports[svc] = assigned.port;
  }
}

function coerceEnvValues(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const config = raw as Record<string, unknown>;

  if (config.components && typeof config.components === "object") {
    for (const component of Object.values(
      config.components as Record<string, Record<string, unknown>>,
    )) {
      for (const field of ["env", "envVars"] as const) {
        if (component[field] && typeof component[field] === "object") {
          const map = component[field] as Record<string, unknown>;
          for (const k of Object.keys(map)) {
            if (typeof map[k] !== "string") map[k] = String(map[k]);
          }
        }
      }
    }
  }

  if (config.inspection && typeof config.inspection === "object") {
    const inspection = config.inspection as Record<string, unknown>;
    if (inspection.env && typeof inspection.env === "object") {
      const map = inspection.env as Record<string, unknown>;
      for (const k of Object.keys(map)) {
        if (typeof map[k] !== "string") map[k] = String(map[k]);
      }
    }
  }
}

export function resolveServiceEnv(
  env: Record<string, string>,
  ctx: ResolvedTemplateContext,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = stripSurroundingQuotes(resolveTemplate(value, ctx));
  }
  return resolved;
}
