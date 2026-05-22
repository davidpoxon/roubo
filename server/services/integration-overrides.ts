import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import {
  IntegrationOverrideSchema,
  deepMergeIntegration,
  zodIssuesToValidationErrors,
  type IntegrationConfig,
  type IntegrationOverride,
  type ConfigFieldError,
} from "@roubo/shared";
import { atomicWrite, getRouboDir } from "./state.js";

export class IntegrationOverrideError extends Error {
  constructor(
    message: string,
    public code: "INVALID_PROJECT_ID" | "YAML_PARSE" | "SCHEMA",
    public fieldErrors?: ConfigFieldError[],
  ) {
    super(message);
    this.name = "IntegrationOverrideError";
  }
}

function getIntegrationsDir(): string {
  return path.join(getRouboDir(), "integrations");
}

// Strict allowlist for projectId values that can appear in a filesystem path.
// We disallow anything other than ASCII letters, digits, dot, dash, and
// underscore; leading dots are rejected to block hidden-file and traversal
// shapes (".", "..", ".env" etc). This is in addition to the post-resolve
// containment check below and matches the guard pattern at state.ts:227.
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

function resolveOverridePath(projectId: string): string {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    throw new IntegrationOverrideError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  const dir = getIntegrationsDir();
  const filePath = path.resolve(dir, `${projectId}.yaml`);
  if (!filePath.startsWith(dir + path.sep) && filePath !== dir) {
    throw new IntegrationOverrideError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  return filePath;
}

export function loadOverride(projectId: string): IntegrationOverride | null {
  const filePath = resolveOverridePath(projectId);
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, "utf-8");
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (e) {
    throw new IntegrationOverrideError(
      `Failed to parse ${filePath}: ${(e as Error).message}`,
      "YAML_PARSE",
    );
  }

  const result = IntegrationOverrideSchema.safeParse(raw);
  if (!result.success) {
    const fieldErrors = zodIssuesToValidationErrors(result.error.issues);
    throw new IntegrationOverrideError(
      `Invalid integration override at ${filePath}: ${fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`,
      "SCHEMA",
      fieldErrors,
    );
  }
  return result.data;
}

export function saveOverride(projectId: string, override: IntegrationOverride): void {
  const result = IntegrationOverrideSchema.safeParse(override);
  if (!result.success) {
    const fieldErrors = zodIssuesToValidationErrors(result.error.issues);
    throw new IntegrationOverrideError(
      `Refusing to save invalid integration override: ${fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`,
      "SCHEMA",
      fieldErrors,
    );
  }
  const filePath = resolveOverridePath(projectId);
  fs.mkdirSync(getIntegrationsDir(), { recursive: true });
  atomicWrite(filePath, YAML.stringify(result.data));
}

export function getEffectiveIntegrationConfig(
  committed: IntegrationConfig | undefined,
  override: IntegrationOverride | null,
): IntegrationConfig {
  return deepMergeIntegration<IntegrationConfig>(committed ?? {}, override?.integration ?? {});
}
