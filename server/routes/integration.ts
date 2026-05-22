import { Router } from "express";
import type {
  CapturedUserId,
  IntegrationCaptionKey,
  IntegrationConfig,
  IntegrationConfigUpdate,
  IntegrationOverride,
  IntegrationTestErrorKind,
  IntegrationTestResult,
  PluginManifest,
  PluginRecord,
  ProjectIntegrationState,
} from "@roubo/shared";
import { CapturedUserIdSchema, IntegrationConfigSchema } from "@roubo/shared";
import { z } from "zod";
import * as projectRegistry from "../services/project-registry.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as credentialStore from "../services/credential-store.js";
import {
  IntegrationOverrideError,
  getEffectiveIntegrationConfig,
  loadOverride,
  saveOverride,
} from "../services/integration-overrides.js";

const router = Router();

function isEmptyBlock(block: IntegrationConfig | null | undefined): boolean {
  if (!block) return true;
  return Object.keys(block).length === 0;
}

function deriveCaptionKey(
  committed: IntegrationConfig | null,
  override: IntegrationConfig | null,
): IntegrationCaptionKey {
  const hasCommitted = !isEmptyBlock(committed);
  const hasOverride = !isEmptyBlock(override);
  if (hasCommitted && hasOverride) return "yaml-and-override";
  if (hasCommitted) return "yaml-only";
  if (hasOverride) return "override-only";
  return "none";
}

function buildState(projectId: string): ProjectIntegrationState {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new ProjectNotFoundError();

  const committed: IntegrationConfig | null = project.config?.integration ?? null;
  const overrideEnvelope = loadOverride(projectId);
  const override: IntegrationConfig | null = overrideEnvelope?.integration ?? null;
  const effective = getEffectiveIntegrationConfig(committed ?? undefined, overrideEnvelope);

  let plugin: ProjectIntegrationState["plugin"] = null;
  if (effective.plugin) {
    const installed = pluginManager.listInstalled();
    const record = installed.find((r) => r.id === effective.plugin) ?? null;
    plugin = {
      id: effective.plugin,
      installed: record !== null,
      status: record?.status ?? null,
      manifest: record?.manifest
        ? {
            name: record.manifest.name,
            configSchema: record.manifest.configSchema,
            permissions: record.manifest.permissions,
          }
        : null,
    };
  }

  return {
    effective,
    committed,
    override,
    plugin,
    captionKey: deriveCaptionKey(committed, override),
  };
}

function findPlugin(pluginId: string): PluginRecord | null {
  return pluginManager.listInstalled().find((r) => r.id === pluginId) ?? null;
}

function passwordFieldKeys(manifest: PluginManifest | null | undefined): string[] {
  if (!manifest?.configSchema) return [];
  const props = (manifest.configSchema as { properties?: Record<string, unknown> }).properties;
  if (!props) return [];
  const keys: string[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as { type?: unknown }).type === "string" &&
      (raw as { format?: unknown }).format === "password"
    ) {
      keys.push(key);
    }
  }
  return keys;
}

// Persist secret form values to the OS keyring before validateConfig runs so
// the plugin's `host.credentials.get` returns the freshly-typed value. Slot
// name follows the convention `key === manifest.permissions.credentials.slots[*].slot`;
// if the manifest doesn't declare a matching slot the field name itself is used
// (so a plugin that adds a password field without declaring a slot still works,
// at the cost of skipping the manifest's slot-description on the dialog hint).
async function persistSecretFields(
  pluginId: string,
  manifest: PluginManifest | null | undefined,
  config: Record<string, unknown>,
): Promise<void> {
  const keys = passwordFieldKeys(manifest);
  for (const key of keys) {
    const value = config[key];
    if (typeof value !== "string" || value.length === 0) continue;
    await credentialStore.set(pluginId, key, value);
  }
}

const TLS_PATTERNS = [
  /self.signed certificate/i,
  /DEPTH_ZERO_SELF_SIGNED_CERT/,
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE/,
  /unable to verify the first certificate/i,
  /CERT_[A-Z_]+/,
];
const NETWORK_PATTERNS = [/ENOTFOUND/, /ECONNREFUSED/, /ETIMEDOUT/, /EAI_AGAIN/];
const AUTH_PATTERNS = [/\b401\b/, /\b403\b/, /unauthor/i, /authenticat/i, /forbidden/i];

function classifyError(message: string): IntegrationTestErrorKind {
  if (TLS_PATTERNS.some((p) => p.test(message))) return "tls";
  if (NETWORK_PATTERNS.some((p) => p.test(message))) return "network";
  if (AUTH_PATTERNS.some((p) => p.test(message))) return "auth";
  return "other";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

const TestConnectionBodySchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

// Mirrors `IntegrationConfigSchema` but drops `plugin` and `pluginSource`
// (switching the plugin is the existing PUT route's job) and `pageSize` (not
// configurable from this dialog in v1).
const IntegrationConfigUpdateSchema = IntegrationConfigSchema.pick({
  instance: true,
  sources: true,
  advanced: true,
  capturedUserId: true,
}).strict();

class ProjectNotFoundError extends Error {
  constructor() {
    super("Project not found");
    this.name = "ProjectNotFoundError";
  }
}

router.get("/:projectId/integration", (req, res) => {
  try {
    res.json(buildState(req.params.projectId));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof IntegrationOverrideError) {
      res.status(500).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put("/:projectId/integration/override", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = req.body as { plugin?: unknown };
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.plugin !== "string" ||
    body.plugin.length === 0
  ) {
    res.status(400).json({ error: "Invalid body: { plugin: string } required" });
    return;
  }
  const plugin: string = body.plugin;

  try {
    // Switching the plugin clears sources (they are plugin-specific) but
    // preserves any user-set instance — the override schema lets every field
    // be independently optional.
    const existing = loadOverride(req.params.projectId);
    const next: IntegrationOverride = {
      schemaVersion: 1,
      integration: {
        ...(existing?.integration ?? {}),
        plugin,
      },
    };
    delete next.integration.sources;

    saveOverride(req.params.projectId, next);
    res.json(buildState(req.params.projectId));
  } catch (err) {
    if (err instanceof IntegrationOverrideError) {
      res.status(400).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/:projectId/integration/test", async (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const parsed = TestConnectionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body: { config: object } required" });
    return;
  }

  // Resolve the active plugin from the effective integration config so the
  // dialog cannot point at a plugin that hasn't been chosen for this project.
  const committed = project.config?.integration ?? undefined;
  let overrideEnvelope: IntegrationOverride | null = null;
  try {
    overrideEnvelope = loadOverride(req.params.projectId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
  }
  const effective = getEffectiveIntegrationConfig(committed, overrideEnvelope);
  const pluginId = effective.plugin;
  if (!pluginId) {
    res.status(503).json({ error: "no-active-integration" });
    return;
  }

  const record = findPlugin(pluginId);
  if (!record || record.status !== "enabled") {
    res.status(503).json({
      error: "plugin-not-enabled",
      pluginId,
      status: record?.status ?? null,
    });
    return;
  }

  try {
    await persistSecretFields(pluginId, record.manifest, parsed.data.config);
  } catch (err) {
    res.status(500).json({
      error: "credential-store-failed",
      message: errorMessage(err),
    });
    return;
  }

  let result: IntegrationTestResult;
  try {
    await pluginManager.invoke(pluginId, "validateConfig", parsed.data.config, {
      timeoutMs: 15_000,
    });
    const identity = await pluginManager.invoke<CapturedUserId>(
      pluginId,
      "getCurrentUser",
      parsed.data.config,
      { timeoutMs: 15_000 },
    );
    const parsedIdentity = CapturedUserIdSchema.safeParse(identity);
    if (!parsedIdentity.success) {
      result = {
        ok: false,
        error: {
          kind: "other",
          message: "Plugin returned an invalid getCurrentUser response.",
        },
      };
    } else {
      result = { ok: true, identity: parsedIdentity.data };
    }
  } catch (err) {
    const message = errorMessage(err);
    result = { ok: false, error: { kind: classifyError(message), message } };
  }

  res.json(result);
});

router.put("/:projectId/integration/config", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const parsed = IntegrationConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid body",
      fieldErrors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const update = parsed.data as IntegrationConfigUpdate;

  try {
    const existing = loadOverride(req.params.projectId);
    if (!existing?.integration.plugin) {
      // The Switch dialog must have already set a plugin; refuse to write
      // config for a project that has no active integration yet.
      res.status(409).json({ error: "no-active-integration" });
      return;
    }

    // Shallow per-top-level-key replace. Arrays inside `sources` are
    // replaced wholesale, matching the FR-023 contract.
    const nextIntegration: IntegrationConfig = { ...existing.integration };
    if (update.instance !== undefined) nextIntegration.instance = update.instance;
    if (update.sources !== undefined) nextIntegration.sources = update.sources;
    if (update.advanced !== undefined) nextIntegration.advanced = update.advanced;
    if (update.capturedUserId !== undefined) {
      nextIntegration.capturedUserId = update.capturedUserId;
    }

    const next: IntegrationOverride = {
      schemaVersion: 1,
      integration: nextIntegration,
    };
    saveOverride(req.params.projectId, next);
    res.json(buildState(req.params.projectId));
  } catch (err) {
    if (err instanceof IntegrationOverrideError) {
      res.status(400).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;
