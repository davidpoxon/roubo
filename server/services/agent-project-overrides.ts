import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import {
  AgentProjectOverrideSchema,
  zodIssuesToValidationErrors,
  type AgentProjectOverride,
  type ConfigFieldError,
  type OrphanedAgentOverride,
  type PluginManifest,
} from "@roubo/shared";
import { atomicWrite, getRouboDir } from "./state.js";
import { getEffectiveAgentConfig } from "./agent-overrides.js";

// Project-level agent configuration overrides (AP-FR-004, issue #509).
//
// One layer below `agent-overrides.ts`. App-level defaults live in
// `~/.roubo/agents/_global/<pluginId>.yaml`; a project's overrides of those
// defaults live in `~/.roubo/agents/<projectId>/<pluginId>.yaml`. What keeps
// the two namespaces from colliding is NOT the SAFE_PROJECT_ID allowlist below,
// which does accept a leading underscore: it is that a projectId is a
// registered project's `config.project.name`, which `ProjectConfigSchema.name`
// constrains to `/^[a-z0-9-]+$/`, and that both routes 404 on an unregistered
// id. So `_global` cannot arrive here as a projectId.
//
// Keeping the per-plugin file key at the project layer preserves the structural
// isolation the app layer already has (AP-TC-003, AP-TC-009, AP-TC-015): two
// plugin ids can never resolve to the same path, in any project.
//
// The override file stores ONLY the fields the project overrides. A key present
// means "overridden"; a key absent means "inherits". Per-field inherit is
// therefore a property of the stored record rather than a parallel set of
// flags, and an inherited field tracks later app-default changes with no write
// at all (AP-TC-010 S003, AP-TC-016 S002).

export class AgentProjectOverrideError extends Error {
  constructor(
    message: string,
    public code: "INVALID_PROJECT_ID" | "INVALID_PLUGIN_ID" | "YAML_PARSE" | "SCHEMA",
    public fieldErrors?: ConfigFieldError[],
  ) {
    super(message);
    this.name = "AgentProjectOverrideError";
  }
}

function getAgentsDir(): string {
  return path.join(getRouboDir(), "agents");
}

// Both path segments are constrained exactly as `integration-overrides.ts`
// constrains a projectId: ASCII letters/digits/dot/dash/underscore, no leading
// dot, so "..", ".", ".env" and every traversal shape are rejected before the
// value reaches the filesystem.
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const SAFE_PLUGIN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

/**
 * The directory holding one project's agent overrides. Guarded by the same
 * allowlist plus post-resolve containment check the file path below uses, so a
 * hostile projectId cannot escape `~/.roubo/agents` even via the directory
 * listing path.
 */
function resolveProjectAgentDir(projectId: string): string {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    throw new AgentProjectOverrideError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  // Strip any path components as defence in depth; combined with the regex
  // above this means the value reaching path.resolve cannot contain separators
  // or traversal segments. This shape is what CodeQL's js/path-injection
  // sanitizer recognises.
  const safeId = path.basename(projectId);
  if (safeId !== projectId) {
    throw new AgentProjectOverrideError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  const root = getAgentsDir();
  const dir = path.resolve(root, safeId);
  if (!dir.startsWith(root + path.sep)) {
    throw new AgentProjectOverrideError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  return dir;
}

/** The override file for one (project, plugin) pair. Both segments are guarded. */
export function resolveProjectAgentPath(projectId: string, pluginId: string): string {
  const dir = resolveProjectAgentDir(projectId);
  if (!SAFE_PLUGIN_ID.test(pluginId)) {
    throw new AgentProjectOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PLUGIN_ID");
  }
  const safeId = path.basename(pluginId);
  if (safeId !== pluginId) {
    throw new AgentProjectOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PLUGIN_ID");
  }
  const filePath = path.resolve(dir, `${safeId}.yaml`);
  if (!filePath.startsWith(dir + path.sep)) {
    throw new AgentProjectOverrideError(`Invalid pluginId: ${pluginId}`, "INVALID_PLUGIN_ID");
  }
  return filePath;
}

/**
 * The saved override envelope for one (project, plugin) pair, or `null` when
 * the project overrides nothing for that plugin. Throws
 * `AgentProjectOverrideError` on malformed YAML or a mismatched envelope.
 */
export function loadProjectAgentOverride(
  projectId: string,
  pluginId: string,
): AgentProjectOverride | null {
  const filePath = resolveProjectAgentPath(projectId, pluginId);
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, "utf-8");
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (e) {
    throw new AgentProjectOverrideError(
      `Failed to parse ${filePath}: ${(e as Error).message}`,
      "YAML_PARSE",
    );
  }

  const result = AgentProjectOverrideSchema.safeParse(raw);
  if (!result.success) {
    const fieldErrors = zodIssuesToValidationErrors(result.error.issues);
    throw new AgentProjectOverrideError(
      `Invalid agent project override at ${filePath}: ${fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`,
      "SCHEMA",
      fieldErrors,
    );
  }
  return result.data;
}

/**
 * Save one project's override subset for one plugin, replacing any previous
 * value. An empty record removes the file rather than writing an empty
 * envelope: "override nothing" and "no override file" must be the same state,
 * or a later app-default change would resolve differently depending on which
 * one a project happened to be in.
 */
export function saveProjectAgentOverride(
  projectId: string,
  pluginId: string,
  config: Record<string, unknown>,
): AgentProjectOverride {
  const envelope: AgentProjectOverride = { schemaVersion: 1, config };
  const result = AgentProjectOverrideSchema.safeParse(envelope);
  if (!result.success) {
    const fieldErrors = zodIssuesToValidationErrors(result.error.issues);
    throw new AgentProjectOverrideError(
      `Refusing to save invalid agent project override: ${fieldErrors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`,
      "SCHEMA",
      fieldErrors,
    );
  }

  const filePath = resolveProjectAgentPath(projectId, pluginId);
  if (Object.keys(result.data.config).length === 0) {
    fs.rmSync(filePath, { force: true });
    return result.data;
  }

  fs.mkdirSync(resolveProjectAgentDir(projectId), { recursive: true });
  atomicWrite(filePath, YAML.stringify(result.data));
  return result.data;
}

/**
 * Best-effort delete of one (project, plugin) override file. Resolves through
 * the same guards as load/save. A missing file is not an error: callers want
 * "after this, this project overrides nothing for this plugin".
 */
export function removeProjectAgentOverride(projectId: string, pluginId: string): void {
  const filePath = resolveProjectAgentPath(projectId, pluginId);
  fs.rmSync(filePath, { force: true });
}

/**
 * Every plugin id this project has an override file for, installed or not. The
 * directory is the source of truth, which is what makes an orphaned override
 * discoverable at all (AP-TC-008): an uninstalled plugin appears in no manifest
 * list, so nothing else would ever mention it.
 */
export function listProjectOverridePluginIds(projectId: string): string[] {
  const dir = resolveProjectAgentDir(projectId);
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.slice(0, -".yaml".length))
    .filter((id) => SAFE_PLUGIN_ID.test(id))
    .sort();
}

/**
 * The effective config for one plugin: app defaults with only the overridden
 * fields replaced (AP-TC-005, AP-TC-016).
 *
 * A shallow per-field overlay, deliberately not a deep merge. The override
 * record holds exactly the fields the project overrides, so the presence of a
 * key IS the override toggle: absent keys fall through to the app default and
 * therefore track later app-default changes (AP-TC-010 S003).
 *
 * Pure and filesystem-free by design. Resolution sits on the launch chain whose
 * end-to-end budget is verified in S9 (AP-TC-048); the obligation here is that
 * this function costs O(fields) and touches no I/O.
 */
export function mergeAgentConfig(
  appDefaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { ...appDefaults, ...overrides };
}

/** One installed agent plugin's two layers plus the resolved overlay. */
export interface ResolvedProjectAgentConfig {
  pluginId: string;
  appDefaults: Record<string, unknown>;
  overrides: Record<string, unknown>;
  effective: Record<string, unknown>;
}

export interface ProjectAgentResolution {
  resolved: ResolvedProjectAgentConfig[];
  orphaned: OrphanedAgentOverride[];
}

/**
 * Resolves one project's agent configuration against the installed agent
 * manifests.
 *
 * Orphan handling lives here, at the boundary, rather than in `mergeAgentConfig`:
 * a stored override whose plugin id matches no installed manifest is returned
 * flagged, with NO effective config synthesised for it. That is the whole point
 * of AP-TC-008: nothing may fabricate defaults for a plugin that is not
 * installed, and the other plugins' effective configs must be unaffected.
 *
 * A per-plugin read failure degrades to "no overrides for that plugin" rather
 * than failing the whole project, matching how `getEffectiveAgentConfig` treats
 * one unreadable app-level file.
 */
export function resolveProjectAgentConfigs(
  projectId: string,
  manifests: PluginManifest[],
): ProjectAgentResolution {
  const installed = new Set(manifests.map((m) => m.id));

  const resolved = manifests.map((manifest) => {
    const appDefaults = getEffectiveAgentConfig(manifest.id);
    const overrides = readOverridesOrEmpty(projectId, manifest.id);
    return {
      pluginId: manifest.id,
      appDefaults,
      overrides,
      effective: mergeAgentConfig(appDefaults, overrides),
    };
  });

  const orphaned: OrphanedAgentOverride[] = listProjectOverridePluginIds(projectId)
    .filter((pluginId) => !installed.has(pluginId))
    .map((pluginId) => ({ pluginId, reason: "not-installed" as const }));

  return { resolved, orphaned };
}

/**
 * One project's stored override record for one plugin, or `{}` when there is
 * none. A malformed or schema-invalid file is swallowed to `{}` so one bad file
 * degrades that plugin to "inherits everything" rather than breaking the whole
 * project settings screen. An invalid id is NOT swallowed: that is a rejected
 * input, not a recoverable state.
 */
export function getProjectAgentOverrides(
  projectId: string,
  pluginId: string,
): Record<string, unknown> {
  return readOverridesOrEmpty(projectId, pluginId);
}

function readOverridesOrEmpty(projectId: string, pluginId: string): Record<string, unknown> {
  try {
    return loadProjectAgentOverride(projectId, pluginId)?.config ?? {};
  } catch (err) {
    if (
      err instanceof AgentProjectOverrideError &&
      err.code !== "INVALID_PROJECT_ID" &&
      err.code !== "INVALID_PLUGIN_ID"
    ) {
      return {};
    }
    throw err;
  }
}
