import { Router } from "express";
import type {
  GlobalPluginIntegrationState,
  IntegrationConfig,
  IntegrationConfigUpdate,
  IntegrationOverride,
  InstallErrorCode,
} from "@roubo/shared";
import { IntegrationConfigSchema, declaredCategories, isFullyAcknowledged } from "@roubo/shared";
import { z } from "zod";
import { getConsent, upsertConsent } from "../services/plugin-consent-state.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as pluginInstaller from "../services/plugin-installer.js";
import {
  IntegrationOverrideError,
  loadGlobalOverride,
  saveGlobalOverride,
} from "../services/integration-overrides.js";
import {
  errorMessage,
  persistSecretFields,
  runIntegrationTest,
} from "../services/integration-test.js";
import { forgetPluginActivation } from "../services/plugin-activation.js";
import { filterAdvancedAgainstManifest } from "../services/plugin-config-filter.js";

const router = Router();

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LOG_LINES = 5000;

function badId(id: string): boolean {
  return !PLUGIN_ID_RE.test(id);
}

function known(id: string): boolean {
  return pluginManager.listInstalled().some((r) => r.id === id);
}

function installErrorStatus(code: InstallErrorCode): number {
  switch (code) {
    case "invalid-input":
    case "clone-failed":
    case "missing-manifest":
    case "invalid-manifest":
    case "incompatible-host":
      return 400;
    case "duplicate-id":
      return 409;
    case "unknown-token":
    case "update-target-missing":
      return 404;
    // Marketplace channel-integrity codes (issue #622). They do not normally
    // arise on the raw install path (it threads no catalog digest), but the
    // switch must stay exhaustive over InstallErrorCode.
    case "revoked":
      return 410;
    case "integrity-failed":
      return 422;
    case "catalog-unverified":
      return 502;
    case "internal":
      return 500;
  }
}

function sendInstallError(
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  err: unknown,
): void {
  if (err instanceof pluginInstaller.InstallError) {
    res.status(installErrorStatus(err.code)).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: (err as Error).message, code: "internal" });
}

router.get("/", (_req, res) => {
  res.json({
    hostApiVersion: pluginManager.HOST_API_VERSION,
    plugins: pluginManager.listInstalled(),
  });
});

router.post("/install", async (req, res) => {
  const body = (req.body ?? {}) as { source?: unknown; value?: unknown };
  if (body.source !== "git" && body.source !== "local") {
    res.status(400).json({
      error: "source must be 'git' or 'local'",
      code: "invalid-input",
    });
    return;
  }
  if (typeof body.value !== "string" || body.value.trim().length === 0) {
    res.status(400).json({ error: "value must be a non-empty string", code: "invalid-input" });
    return;
  }
  try {
    const preview =
      body.source === "git"
        ? await pluginInstaller.previewFromGitUrl(body.value)
        : await pluginInstaller.previewFromLocalPath(body.value);
    res.status(200).json(preview);
  } catch (err) {
    sendInstallError(res, err);
  }
});

router.post("/install/:token/confirm", async (req, res) => {
  const token = req.params.token;
  if (!pluginInstaller.isValidStagingToken(token)) {
    res.status(400).json({ error: "Invalid staging token", code: "invalid-input" });
    return;
  }
  try {
    const plugin = await pluginInstaller.commit(token);
    res.status(201).json({ plugin });
  } catch (err) {
    sendInstallError(res, err);
  }
});

router.post("/install/:token/cancel", async (req, res) => {
  const token = req.params.token;
  if (!pluginInstaller.isValidStagingToken(token)) {
    res.status(400).json({ error: "Invalid staging token", code: "invalid-input" });
    return;
  }
  try {
    await pluginInstaller.cancel(token);
    res.status(204).end();
  } catch (err) {
    sendInstallError(res, err);
  }
});

router.post("/:id/enable", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  try {
    await pluginManager.enable(id);
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.post("/:id/disable", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  try {
    await pluginManager.disable(id);
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.post("/:id/restart", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  try {
    await pluginManager.restart(id);
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.delete("/:id", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  try {
    await pluginManager.uninstall(id);
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.get("/:id/logs", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }

  const fileRaw = (req.query.file as string | undefined) ?? "current";
  if (fileRaw !== "current" && fileRaw !== "previous") {
    res.status(400).json({ error: "file must be 'current' or 'previous'" });
    return;
  }

  let lines = 500;
  if (req.query.lines !== undefined) {
    const parsed = Number(req.query.lines);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LOG_LINES) {
      res.status(400).json({ error: `lines must be a positive integer up to ${MAX_LOG_LINES}` });
      return;
    }
    lines = parsed;
  }

  try {
    const result = await pluginManager.readLogs(id, fileRaw, lines);
    res.json({ lines: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Permission consent (issue #615, CP-FR-011 / CP-FR-012 / CP-NFR-001) -----
//
// v1's declare-then-enforce model: the consumer is shown every permission
// category the plugin's manifest declares and must acknowledge them before the
// plugin runs. GET returns the declared permissions plus whether the plugin is
// first-party (bundled); a non-first-party plugin is labeled unsandboxed in the
// UI. POST persists a ConsentRecord, rejecting (400) a body that omits any
// declared category. The consent gate at the component-start seam
// (component-plugin-registry) reads the persisted record.

const ConsentBodySchema = z
  .object({
    acknowledgedCategories: z.array(z.string().min(1)),
  })
  .strict();

router.get("/:id/consent", (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  const record = pluginManager.listInstalled().find((r) => r.id === id);
  if (!record) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  if (!record.manifest) {
    res.status(409).json({ error: `Plugin ${id} has no valid manifest` });
    return;
  }
  const consent = getConsent(id);
  res.json({
    declared: record.manifest.permissions,
    firstParty: record.source === "bundled",
    ...(consent ? { consentedAt: consent.consentedAt } : {}),
  });
});

router.post("/:id/consent", (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  const record = pluginManager.listInstalled().find((r) => r.id === id);
  if (!record) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  if (!record.manifest) {
    res.status(409).json({ error: `Plugin ${id} has no valid manifest` });
    return;
  }

  const parsed = ConsentBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body: { acknowledgedCategories: string[] } required" });
    return;
  }

  const permissions = record.manifest.permissions;
  if (!isFullyAcknowledged(permissions, parsed.data.acknowledgedCategories)) {
    res.status(400).json({
      error: "All declared permission categories must be acknowledged",
      declared: declaredCategories(permissions),
    });
    return;
  }

  const saved = upsertConsent(id, parsed.data.acknowledgedCategories);
  res.status(200).json(saved);
});

// --- Global integration config (Plugins settings page) -----------------
//
// These endpoints back the Configure dialog when it is opened from the
// global Plugins settings page rather than from a project's Issue source
// tile. They write the per-plugin global default to
// `~/.roubo/integrations/_global/{pluginId}.yaml`, which layers between
// `roubo.yaml` and any per-project override in `getEffectiveWithGlobal`.
// Sources are intentionally per-project and rejected here.

const TestConnectionBodySchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

const GlobalConfigUpdateSchema = IntegrationConfigSchema.pick({
  instance: true,
  advanced: true,
  capturedUserId: true,
}).strict();

function buildGlobalState(pluginId: string): GlobalPluginIntegrationState | null {
  const record = pluginManager.listInstalled().find((r) => r.id === pluginId);
  if (!record) return null;

  let globalEnvelope: IntegrationOverride | null = null;
  try {
    globalEnvelope = loadGlobalOverride(pluginId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
  }
  const effective: IntegrationConfig = {
    plugin: pluginId,
    ...(globalEnvelope?.integration ?? {}),
  };

  return {
    effective,
    plugin: {
      id: pluginId,
      installed: true,
      status: record.status,
      manifest: record.manifest
        ? {
            name: record.manifest.name,
            configSchema: record.manifest.configSchema,
            permissions: record.manifest.permissions,
            defaultIntegrationConfig: record.manifest.defaultIntegrationConfig,
          }
        : null,
    },
  };
}

router.get("/:id/integration", (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }

  try {
    const state = buildGlobalState(id);
    if (!state) {
      res.status(404).json({ error: `Unknown plugin: ${id}` });
      return;
    }
    res.json(state);
  } catch (err) {
    if (err instanceof IntegrationOverrideError) {
      res.status(500).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.post("/:id/integration/test", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  const record = pluginManager.listInstalled().find((r) => r.id === id);
  if (!record) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  if (record.status !== "enabled") {
    res.status(503).json({
      error: "plugin-not-enabled",
      pluginId: id,
      status: record.status,
    });
    return;
  }

  const parsed = TestConnectionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body: { config: object } required" });
    return;
  }

  try {
    await persistSecretFields(id, record.manifest, parsed.data.config);
  } catch (err) {
    res.status(500).json({
      error: "credential-store-failed",
      message: errorMessage(err),
    });
    return;
  }

  const result = await runIntegrationTest(record, parsed.data.config);
  res.json(result);
});

router.put("/:id/integration/config", (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }

  // Reject `sources` explicitly. They are inherently per-project and the
  // dialog never sends them in global mode, but a buggy client should get
  // a clear 400 rather than silently writing an incoherent global file.
  if (
    req.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body) &&
    "sources" in (req.body as Record<string, unknown>)
  ) {
    res.status(400).json({
      error: "Invalid body: 'sources' may not be set on global configs (they are per-project)",
    });
    return;
  }

  const parsed = GlobalConfigUpdateSchema.safeParse(req.body);
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
  const update = parsed.data as Omit<IntegrationConfigUpdate, "sources">;

  try {
    let existing: IntegrationOverride | null = null;
    try {
      existing = loadGlobalOverride(id);
    } catch (err) {
      if (!(err instanceof IntegrationOverrideError)) throw err;
      // Treat a malformed existing file as "no existing override" so the
      // user can recover by saving a fresh value.
    }

    const nextIntegration: IntegrationConfig = { ...(existing?.integration ?? {}) };
    // Persist `plugin: id` so the file is self-describing even if it is
    // ever read in isolation; the filename-encoded id remains the source
    // of truth for the merge layer.
    nextIntegration.plugin = id;
    if (update.instance !== undefined) nextIntegration.instance = update.instance;
    if (update.advanced !== undefined) {
      // Issue #125: strip any keys not in the manifest schema before writing,
      // so a save touching this plugin canonicalises stale leftovers like
      // `advanced.sources: ""` out of the on-disk YAML.
      const manifest = pluginManager.listInstalled().find((r) => r.id === id)?.manifest ?? null;
      const cleaned = filterAdvancedAgainstManifest(
        id,
        update.advanced,
        manifest,
        "persist-global",
      );
      if (cleaned) {
        nextIntegration.advanced = cleaned;
      } else {
        delete nextIntegration.advanced;
      }
    }
    if (update.capturedUserId !== undefined) {
      nextIntegration.capturedUserId = update.capturedUserId;
    }

    const next: IntegrationOverride = { schemaVersion: 1, integration: nextIntegration };
    saveGlobalOverride(id, next);
    // Global change affects every project that inherits from this plugin's
    // defaults; invalidate them all so the next source-bound call re-pushes.
    forgetPluginActivation(id);

    const state = buildGlobalState(id);
    if (!state) {
      res.status(500).json({ error: "Failed to load saved global state" });
      return;
    }
    res.json(state);
  } catch (err) {
    if (err instanceof IntegrationOverrideError) {
      res.status(400).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

// WU-050: opportunistic re-check endpoint. Called from PluginsTab,
// PluginConfigureDialog, and IssueQueuePanel via react-query whenever those
// surfaces mount. Passes `{ force: true }` so the handler bypasses the
// plugin-manager's 30s value cache but still participates in the per-plugin
// in-flight dedup that coalesces concurrent calls. (Invalidating the cache
// here would also drop the in-flight entry and defeat that dedup.)
router.get("/:id/connection-status", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  const rec = pluginManager.listInstalled().find((r) => r.id === id);
  if (!rec) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  if (rec.status !== "enabled") {
    res.json({ state: "disabled" });
    return;
  }
  const state = buildGlobalState(id);
  const config = state?.effective ?? { plugin: id };
  const status = await pluginManager.getConnectionStatus(
    id,
    config as unknown as Record<string, unknown>,
    { force: true, trigger: "ui-recheck" },
  );
  res.json(status);
});

export default router;
