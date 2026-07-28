import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import {
  AgentOverrideSchema,
  zodIssuesToValidationErrors,
  type AgentOverride,
  type ConfigFieldError,
} from "@roubo/shared";
import { atomicWrite, getRouboDir } from "./state.js";

// App-level agent configuration (AP-FR-002, issue #508).
//
// Every installed `agent`-kind plugin gets its own independent application-level
// config file at `~/.roubo/agents/_global/<pluginId>.yaml`. Mirrors the global
// half of `integration-overrides.ts` one layer down: same SAFE id allowlist,
// same post-resolve containment check, same atomic write, same YAML-only
// storage. What it deliberately does NOT reuse is the `IntegrationOverride`
// envelope, which is integration-shaped (sources, instance, advanced,
// capturedUserId) and means nothing to an agent.
//
// The per-plugin file key is what makes isolation structural rather than
// behavioural (AP-TC-003, AP-TC-009, AP-TC-015): two plugin ids can never
// resolve to the same path, so no sequence of interleaved saves, and no number
// of installed agent plugins, can make one plugin's config bleed into another's.

export class AgentOverrideError extends Error {
  constructor(
    message: string,
    public code: "INVALID_PLUGIN_ID" | "YAML_PARSE" | "SCHEMA",
    public fieldErrors?: ConfigFieldError[],
  ) {
    super(message);
    this.name = "AgentOverrideError";
  }
}

function getAgentsDir(): string {
  return path.join(getRouboDir(), "agents");
}

// App-level defaults written from the AI Agents settings screen live in
// `~/.roubo/agents/_global/<pluginId>.yaml`. The leading underscore keeps the
// subdirectory outside any future project-id namespace, so the project-level
// overrides of S8 can land beside it without a path collision.
const GLOBAL_OVERRIDE_DIR_NAME = "_global";

function getGlobalAgentDir(): string {
  return path.join(getAgentsDir(), GLOBAL_OVERRIDE_DIR_NAME);
}

// Plugin ids reaching the filesystem are constrained exactly as
// integration-overrides constrains them: ASCII letters/digits/dot/dash/
// underscore, no leading dot. Plugin manifests use kebab-case ids in practice
// (e.g. `claude-code`, `codex-cli`), so this matches what real plugins ship.
const SAFE_PLUGIN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

function resolveAgentConfigPath(pluginId: string): string {
  if (!SAFE_PLUGIN_ID.test(pluginId)) {
    throw new AgentOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PLUGIN_ID");
  }
  // Strip any path components as defence in depth; combined with the regex
  // above this means the value reaching path.resolve cannot contain separators
  // or traversal segments. This shape is what CodeQL's js/path-injection
  // sanitizer recognises.
  const safeId = path.basename(pluginId);
  if (safeId !== pluginId) {
    throw new AgentOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PLUGIN_ID");
  }
  const dir = getGlobalAgentDir();
  const filePath = path.resolve(dir, `${safeId}.yaml`);
  if (!filePath.startsWith(dir + path.sep) && filePath !== dir) {
    throw new AgentOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PLUGIN_ID");
  }
  return filePath;
}

/**
 * The saved app-level override envelope for one agent plugin, or `null` when
 * that plugin has never been configured. Throws `AgentOverrideError` on
 * malformed YAML or an envelope that does not match `AgentOverrideSchema`.
 */
export function loadAgentOverride(pluginId: string): AgentOverride | null {
  const filePath = resolveAgentConfigPath(pluginId);
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, "utf-8");
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (e) {
    throw new AgentOverrideError(
      `Failed to parse ${filePath}: ${(e as Error).message}`,
      "YAML_PARSE",
    );
  }

  const result = AgentOverrideSchema.safeParse(raw);
  if (!result.success) {
    const fieldErrors = zodIssuesToValidationErrors(result.error.issues);
    throw new AgentOverrideError(
      `Invalid agent override at ${filePath}: ${fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`,
      "SCHEMA",
      fieldErrors,
    );
  }
  return result.data;
}

/** Save one agent plugin's app-level config, replacing any previous value. */
export function saveAgentConfig(pluginId: string, config: Record<string, unknown>): AgentOverride {
  const envelope: AgentOverride = { schemaVersion: 1, config };
  const result = AgentOverrideSchema.safeParse(envelope);
  if (!result.success) {
    const fieldErrors = zodIssuesToValidationErrors(result.error.issues);
    throw new AgentOverrideError(
      `Refusing to save invalid agent config: ${fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`,
      "SCHEMA",
      fieldErrors,
    );
  }
  const filePath = resolveAgentConfigPath(pluginId);
  fs.mkdirSync(getGlobalAgentDir(), { recursive: true });
  atomicWrite(filePath, YAML.stringify(result.data));
  return result.data;
}

/**
 * Best-effort delete of one agent plugin's app-level config. Resolves through
 * the same path guard as load/save. A missing file is not an error: callers
 * want "after this, no config exists".
 */
export function removeAgentConfig(pluginId: string): void {
  const filePath = resolveAgentConfigPath(pluginId);
  fs.rmSync(filePath, { force: true });
}

/**
 * The effective app-level config for one agent plugin: the saved record, or an
 * empty record when nothing has been saved. A malformed or schema-invalid file
 * is swallowed to `{}` so one bad file cannot break the whole AI Agents screen
 * or a launch that only needs the other plugins (AP-TC-012). Callers that need
 * to surface the parse failure use `loadAgentOverride` directly.
 *
 * An INVALID_PLUGIN_ID is NOT swallowed: that is a rejected input, not a
 * recoverable state, and quietly returning `{}` would turn a path-traversal
 * attempt into a silent success.
 */
export function getEffectiveAgentConfig(pluginId: string): Record<string, unknown> {
  try {
    return loadAgentOverride(pluginId)?.config ?? {};
  } catch (err) {
    if (err instanceof AgentOverrideError && err.code !== "INVALID_PLUGIN_ID") return {};
    throw err;
  }
}
