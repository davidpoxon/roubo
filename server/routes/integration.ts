import { Router } from "express";
import type {
  IntegrationCaptionKey,
  IntegrationConfig,
  IntegrationConfigUpdate,
  IntegrationOverride,
  PluginRecord,
  ProjectIntegrationState,
  SourceCandidatesResponse,
  SourceSelection,
} from "@roubo/shared";
import { IntegrationConfigSchema, SourceEntrySchema } from "@roubo/shared";
import { z } from "zod";
import * as projectRegistry from "../services/project-registry.js";
import * as pluginManager from "../services/plugin-manager.js";
import {
  IntegrationOverrideError,
  getEffectiveWithGlobal,
  loadOverride,
  saveOverride,
} from "../services/integration-overrides.js";
import {
  errorMessage,
  persistSecretFields,
  runIntegrationTest,
} from "../services/integration-test.js";
import { forgetProjectActivation, resolveSources } from "../services/plugin-activation.js";
import { getPluginFacetOptions, getPluginFilterFacets } from "../services/plugin-filter-facets.js";

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
  const effective = getEffectiveWithGlobal(committed ?? undefined, overrideEnvelope);

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

function validateSourceCandidatesResponse(raw: unknown): SourceCandidatesResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("plugin returned a non-object response");
  }
  const obj = raw as Record<string, unknown>;
  const shape = obj.shape;
  if (shape !== "multi-list" && shape !== "categorized-multi-list") {
    throw new Error(`plugin returned unknown shape: ${JSON.stringify(shape)}`);
  }
  if (shape === "multi-list") {
    if (!Array.isArray(obj.items)) {
      throw new Error("multi-list response must include an items array");
    }
    for (const item of obj.items) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof (item as Record<string, unknown>).externalId !== "string" ||
        typeof (item as Record<string, unknown>).label !== "string"
      ) {
        throw new Error("multi-list item missing required externalId or label");
      }
    }
  } else {
    if (!Array.isArray(obj.categories)) {
      throw new Error("categorized-multi-list response must include a categories array");
    }
    for (const cat of obj.categories) {
      if (
        cat === null ||
        typeof cat !== "object" ||
        typeof (cat as Record<string, unknown>).id !== "string" ||
        typeof (cat as Record<string, unknown>).label !== "string" ||
        !Array.isArray((cat as Record<string, unknown>).items)
      ) {
        throw new Error("category missing required id, label, or items");
      }
    }
  }
  return raw as SourceCandidatesResponse;
}

function validateSourceSelectionBody(body: unknown): SourceSelection {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid body: { sources: Record<string, SourceEntry[]> } required");
  }
  const sources = (body as Record<string, unknown>).sources;
  if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
    throw new Error("Invalid body: sources must be an object");
  }
  const out: SourceSelection = {};
  for (const [key, value] of Object.entries(sources as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new Error(`Invalid body: sources.${key} must be an array`);
    }
    const list: SourceSelection[string] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        list.push(entry);
        continue;
      }
      const parsed = SourceEntrySchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`Invalid body: sources.${key} entry: ${parsed.error.message}`);
      }
      const data = parsed.data;
      // The schema also accepts numbers and primitive numerics; the persisted
      // SourceSelection only carries string-or-object entries, so normalize.
      if (typeof data === "number") {
        list.push(String(data));
      } else if (typeof data === "string") {
        list.push(data);
      } else {
        const normalized: Exclude<SourceSelection[string][number], string> = {
          externalId: String(data.externalId),
        };
        if (data.includeCodeQLAlerts !== undefined) {
          normalized.includeCodeQLAlerts = data.includeCodeQLAlerts;
        }
        if (data.includeSecretScanningAlerts !== undefined) {
          normalized.includeSecretScanningAlerts = data.includeSecretScanningAlerts;
        }
        if (data.includeDependabotAlerts !== undefined) {
          normalized.includeDependabotAlerts = data.includeDependabotAlerts;
        }
        list.push(normalized);
      }
    }
    out[key] = list;
  }
  return out;
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
    // Switching plugin: any cached activation for this project (against the
    // old plugin) is meaningless. Cheaper to forget all and let the next
    // call re-push than to track per-plugin entries here.
    forgetProjectActivation(req.params.projectId);
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
  const effective = getEffectiveWithGlobal(committed, overrideEnvelope);
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

  const result = await runIntegrationTest(record, parsed.data.config);
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
    // Any source-bound call after this must re-push to pick up the new
    // instance / sources / advanced settings.
    forgetProjectActivation(req.params.projectId);
    res.json(buildState(req.params.projectId));
  } catch (err) {
    if (err instanceof IntegrationOverrideError) {
      res.status(400).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.get("/:projectId/integration/sources", async (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const committed: IntegrationConfig | null = project.config?.integration ?? null;
  const overrideEnvelope = loadOverride(req.params.projectId);
  const effective = getEffectiveWithGlobal(committed ?? undefined, overrideEnvelope);

  if (!effective.plugin) {
    res.status(409).json({ error: "No active integration plugin for this project" });
    return;
  }

  try {
    const raw = await pluginManager.invoke<unknown>(effective.plugin, "listSourceCandidates", {
      config: effective,
    });
    const response = validateSourceCandidatesResponse(raw);
    res.json(response);
  } catch (err) {
    res.status(502).json({ error: `Plugin listSourceCandidates failed: ${errorMessage(err)}` });
  }
});

router.get("/:projectId/integration/filter-facets", async (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const committed: IntegrationConfig | null = project.config?.integration ?? null;
  const overrideEnvelope = loadOverride(req.params.projectId);
  const effective = getEffectiveWithGlobal(committed ?? undefined, overrideEnvelope);

  if (!effective.plugin) {
    res.status(409).json({ error: "No active integration plugin for this project" });
    return;
  }

  try {
    const facets = await getPluginFilterFacets(effective.plugin);
    res.json(facets);
  } catch (err) {
    res.status(502).json({ error: `Plugin filterFacets failed: ${errorMessage(err)}` });
  }
});

router.get("/:projectId/integration/facet-options", async (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const facetId = req.query.facetId;
  if (typeof facetId !== "string" || facetId.length === 0) {
    res.status(400).json({ error: "Missing required query param: facetId" });
    return;
  }
  const search = req.query.search;
  if (search !== undefined && typeof search !== "string") {
    res.status(400).json({ error: "search must be a string" });
    return;
  }

  const committed: IntegrationConfig | null = project.config?.integration ?? null;
  const overrideEnvelope = loadOverride(req.params.projectId);
  const effective = getEffectiveWithGlobal(committed ?? undefined, overrideEnvelope);

  if (!effective.plugin) {
    res.status(409).json({ error: "No active integration plugin for this project" });
    return;
  }

  try {
    const options = await getPluginFacetOptions(effective.plugin, {
      facetId,
      sources: resolveSources(req.params.projectId),
      ...(typeof search === "string" && search.length > 0 ? { search } : {}),
    });
    res.json(options);
  } catch (err) {
    res.status(502).json({ error: `Plugin getFacetOptions failed: ${errorMessage(err)}` });
  }
});

router.put("/:projectId/integration/sources", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  let sources: SourceSelection;
  try {
    sources = validateSourceSelectionBody(req.body);
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
    return;
  }

  try {
    const existing = loadOverride(req.params.projectId);
    const next: IntegrationOverride = {
      schemaVersion: 1,
      integration: {
        ...(existing?.integration ?? {}),
      },
    };
    if (Object.keys(sources).length === 0) {
      delete next.integration.sources;
    } else {
      next.integration.sources = sources;
    }

    saveOverride(req.params.projectId, next);
    forgetProjectActivation(req.params.projectId);
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
