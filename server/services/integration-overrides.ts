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

// Per-plugin global defaults written from the global Plugins settings page
// live in `~/.roubo/integrations/_global/{pluginId}.yaml`. The leading
// underscore on the subdirectory keeps it outside the SAFE_PROJECT_ID
// namespace, so projectId-derived paths can never collide.
const GLOBAL_OVERRIDE_DIR_NAME = "_global";

function getGlobalOverrideDir(): string {
  return path.join(getIntegrationsDir(), GLOBAL_OVERRIDE_DIR_NAME);
}

// Plugin ids reaching the filesystem are constrained the same way projectIds
// are: ASCII letters/digits/dot/dash/underscore, no leading dot. Plugin
// manifests use kebab-case ids in practice (e.g. `github-com`), so this
// matches what real plugins ship.
const SAFE_PLUGIN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

function resolveGlobalOverridePath(pluginId: string): string {
  if (!SAFE_PLUGIN_ID.test(pluginId)) {
    throw new IntegrationOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PROJECT_ID");
  }
  const safeId = path.basename(pluginId);
  if (safeId !== pluginId) {
    throw new IntegrationOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PROJECT_ID");
  }
  const dir = getGlobalOverrideDir();
  const filePath = path.resolve(dir, `${safeId}.yaml`);
  if (!filePath.startsWith(dir + path.sep) && filePath !== dir) {
    throw new IntegrationOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PROJECT_ID");
  }
  return filePath;
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
  // Strip any path components a defender-in-depth check; combined with the
  // regex above this means the value reaching path.resolve cannot contain
  // separators or traversal segments. This shape is what CodeQL's
  // js/path-injection sanitizer recognises.
  const safeId = path.basename(projectId);
  if (safeId !== projectId) {
    throw new IntegrationOverrideError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  const dir = getIntegrationsDir();
  const filePath = path.resolve(dir, `${safeId}.yaml`);
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

export function loadGlobalOverride(pluginId: string): IntegrationOverride | null {
  const filePath = resolveGlobalOverridePath(pluginId);
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

export function saveGlobalOverride(pluginId: string, override: IntegrationOverride): void {
  const result = IntegrationOverrideSchema.safeParse(override);
  if (!result.success) {
    const fieldErrors = zodIssuesToValidationErrors(result.error.issues);
    throw new IntegrationOverrideError(
      `Refusing to save invalid integration override: ${fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`,
      "SCHEMA",
      fieldErrors,
    );
  }
  const filePath = resolveGlobalOverridePath(pluginId);
  fs.mkdirSync(getGlobalOverrideDir(), { recursive: true });
  atomicWrite(filePath, YAML.stringify(result.data));
}

// Layered effective config: committed (roubo.yaml) ⊕ global default (set
// from the Plugins settings page, keyed by the active plugin id) ⊕
// per-project override. Project beats global beats committed for every
// top-level field per `deepMergeIntegration`'s shallow-replace rules.
export function getEffectiveIntegrationConfig(
  committed: IntegrationConfig | undefined,
  globalOverride: IntegrationOverride | null,
  projectOverride: IntegrationOverride | null,
): IntegrationConfig {
  const withGlobal = deepMergeIntegration<IntegrationConfig>(
    committed ?? {},
    globalOverride?.integration ?? {},
  );
  return deepMergeIntegration<IntegrationConfig>(withGlobal, projectOverride?.integration ?? {});
}

// Convenience wrapper for per-project read paths. Resolves the active plugin
// from committed + per-project override (without the global layer), loads the
// global override for that plugin if any, then computes the final effective.
// A malformed global file is treated like a malformed per-project file: it
// is swallowed so a single bad file can't break the project read path.
export function getEffectiveWithGlobal(
  committed: IntegrationConfig | undefined,
  projectOverride: IntegrationOverride | null,
): IntegrationConfig {
  const tentative = getEffectiveIntegrationConfig(committed, null, projectOverride);
  const activePluginId = tentative.plugin;
  let globalOverride: IntegrationOverride | null = null;
  if (activePluginId) {
    try {
      globalOverride = loadGlobalOverride(activePluginId);
    } catch (err) {
      if (!(err instanceof IntegrationOverrideError)) throw err;
    }
  }
  return getEffectiveIntegrationConfig(committed, globalOverride, projectOverride);
}
