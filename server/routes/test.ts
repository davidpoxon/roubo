import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_PLUGIN_IDS } from "@roubo/shared";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";
import * as state from "../services/state.js";
import * as pluginEnableState from "../services/plugin-enable-state.js";
import { removeOverride, saveOverride } from "../services/integration-overrides.js";
import { IntegrationConfigSchema, type AssignedIssue, type IntegrationConfig } from "@roubo/shared";

const router: Router = Router();

// Defence-in-depth rate limit on the e2e harness surface. These routes only
// respond when ROUBO_E2E=1 (production builds 404 them), but they touch the
// filesystem and the projects.json store, so we cap requests per minute per IP
// to prevent runaway specs or a misbehaving caller from saturating disk I/O.
// Mirrors the pattern in plugins-github-oauth.ts. Also satisfies CodeQL
// `js/missing-rate-limiting` on the file-system access in
// /__register-fixture-project.
const testRouteRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.use(testRouteRateLimiter);

const SCENARIO_NAME_RE = /^[a-z][a-z0-9-]*$/;

// Fixture-project ids must satisfy ProjectConfig.name (lowercase letters,
// digits, hyphens) AND start with a letter so SAFE_PROJECT_ID's first-char
// rule is also met. Kebab-case throughout.
const FIXTURE_PROJECT_ID_RE = /^[a-z][a-z0-9-]*$/;

// Track fixture projects created via POST /test/__register-fixture-project so
// the next /test/__reset can drop their on-disk artifacts (projects.json
// row, integration override file, tmp roubo.yaml tree). Lives in this module
// alongside the routes that touch it; the in-memory project-registry Map is
// cleared by the existing __test.reset() step further down.
interface FixtureProjectEntry {
  projectId: string;
  repoPath: string;
  // TC-161: workspace tmpdirs created for `seedBenches` entries. Tracked here
  // so /__reset can rm them alongside `repoPath` — `wipePersistedTestState`
  // truncates `state.json` (dropping the bench row), but the tmpdir on disk
  // would otherwise survive between specs.
  seededWorkspacePaths: string[];
}
const fixtureProjects = new Map<string, FixtureProjectEntry>();

// Drop everything one fixture project wrote to disk. Each step is wrapped in
// try/catch so a single failure does not skip the others — the caller wants
// "after this, the fixture is gone or we logged why it couldn't be."
function cleanupFixtureProject(entry: FixtureProjectEntry): void {
  try {
    removeOverride(entry.projectId);
  } catch (err) {
    console.error(
      `/test/__reset: failed to remove integration override for ${entry.projectId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    state.removeProject(entry.projectId);
  } catch (err) {
    console.error(
      `/test/__reset: failed to remove persisted project ${entry.projectId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    fs.rmSync(entry.repoPath, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `/test/__reset: failed to rm fixture repoPath ${entry.repoPath}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  for (const seededPath of entry.seededWorkspacePaths) {
    try {
      fs.rmSync(seededPath, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `/test/__reset: failed to rm seeded workspace ${seededPath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// Minimum roubo.yaml that satisfies RouboConfigSchema (project, layout,
// components ≥1, ports ≥1, benches). The single port uses a high base to
// keep collisions with a developer's pre-existing dev projects unlikely;
// the component never actually runs because the fixture stops after
// registerProject + saveOverride. `benches.max` is set to 5 (rather than 1)
// so the `seedBenches` option below can pin multiple persisted benches
// without violating the config cap.
function writeFixtureRouboYaml(repoPath: string, projectId: string): void {
  const dotRoubo = path.join(repoPath, ".roubo");
  fs.mkdirSync(dotRoubo, { recursive: true });
  const yaml = `project:
  name: ${projectId}
  displayName: Roubo E2E Fixture
  type: web
layout:
  type: single-repo
components:
  app:
    type: process
    command: "true"
ports:
  app:
    base: 39100
benches:
  max: 5
`;
  fs.writeFileSync(path.join(dotRoubo, "roubo.yaml"), yaml, "utf-8");
}

interface ResetBody {
  scenario?: unknown;
  now?: unknown;
}

interface ParsedResetConfig {
  scenario: string | null;
  now: string | null;
}

// Parse the optional { scenario, now } body that Playwright specs pass to pin
// the stubbed plugin to a specific scenario pack and frozen-now ISO. Returns
// the parsed config on success; returns an error message on validation failure
// so the caller can respond with 400.
// WU-069: helper for the /__reset path; safely truncates the on-disk state
// files the route owns and removes any per-project integration overrides
// dropped by a previous spec. Missing files / dirs are treated as success.
// Refuses to run when ROUBO_PRODUCTION is set, and also refuses if the
// resolved roubo dir does not look like a dev path (state.ts:resolveRouboDir
// returns `~/.roubo-dev/<bench>` in dev and `~/.roubo` in production). The
// path-shape check is defence-in-depth: `resolveRouboDir` runs once at
// module-load and caches the path, so by the time this function runs the
// env var may have been cleared by a caller while the cached path still
// points at the real `~/.roubo`. The /__reset route is also gated on
// ROUBO_E2E=1 (returns 404 otherwise), but the env vars are independent and
// the destructive op keeps its own guard rather than trusting only the
// caller.
function wipePersistedTestState(): void {
  if (process.env.ROUBO_PRODUCTION) {
    throw new Error("wipePersistedTestState refuses to run when ROUBO_PRODUCTION is set");
  }
  const rouboDir = state.getRouboDir();
  if (!rouboDir.includes(`${path.sep}.roubo-dev${path.sep}`)) {
    throw new Error(`wipePersistedTestState refuses to wipe a non-dev roubo dir: ${rouboDir}`);
  }
  for (const name of ["projects.json", "state.json"]) {
    const file = path.join(rouboDir, name);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best-effort: tolerate a missing file or a transient unlink failure.
    }
  }
  const integrationsDir = path.join(rouboDir, "integrations");
  try {
    const entries = fs.readdirSync(integrationsDir, { withFileTypes: true });
    for (const entry of entries) {
      // Preserve the `_global` defaults subdirectory (per-plugin globals),
      // which is not tied to any project and may have been seeded outside the
      // spec's setup.
      if (entry.name === "_global") continue;
      fs.rmSync(path.join(integrationsDir, entry.name), { recursive: true, force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function parseResetBody(body: ResetBody | undefined): ParsedResetConfig | string {
  const scenarioRaw = body?.scenario;
  const nowRaw = body?.now;
  let scenario: string | null = null;
  let now: string | null = null;
  if (scenarioRaw !== undefined && scenarioRaw !== null) {
    if (typeof scenarioRaw !== "string" || !SCENARIO_NAME_RE.test(scenarioRaw)) {
      return "scenario must be a kebab-case string matching /^[a-z][a-z0-9-]*$/";
    }
    scenario = scenarioRaw;
  }
  if (nowRaw !== undefined && nowRaw !== null) {
    if (typeof nowRaw !== "string") return "now must be an ISO-8601 string";
    const parsed = new Date(nowRaw);
    if (Number.isNaN(parsed.getTime())) return "now must be a parseable ISO-8601 string";
    now = nowRaw;
  }
  return { scenario, now };
}

// WU-068 (#159): mark every bundled plugin id (`github-com`, `ghe`,
// `jira-self-hosted`) as enabled in `~/.roubo/plugins-state.json`. The first
// `migrate.run()` on a greenfield install seeds these as "disabled" so the
// migration banner can prompt the user to opt-in; the e2e harness needs them
// running so the bundled-overlay slots (e2e/fixtures/bundled-overlays/) can
// surface stub scenario data. Called from `__reset` only, behind the
// ROUBO_E2E gate.
function ensureBundledPluginsEnabled(): void {
  for (const id of BUNDLED_PLUGIN_IDS) {
    pluginEnableState.setPluginEnabled(id, true);
  }
}

// TC-154 (#222): fixture plugins under e2e/fixtures/bundled-overlays/ whose
// entry script intentionally exits non-zero. Without an explicit "disabled"
// entry these would auto-enable at boot (isPluginEnabled defaults missing
// entries to enabled), crash on spawn, and land in `errored` status. The
// EnablePluginPromptModal gate (BenchDashboard.tsx) requires `disabled`, so
// the failure-path spec needs these to start disabled. Forcing them disabled
// in /__reset also keeps unrelated specs free of spawn-failure noise.
const FAILURE_FIXTURE_PLUGIN_IDS = ["broken-plugin"] as const;
function disableFailureFixturePlugins(): void {
  for (const id of FAILURE_FIXTURE_PLUGIN_IDS) {
    pluginEnableState.setPluginEnabled(id, false);
  }
}

// POST /test/__reset (FR-079): wipe module-level singletons so Playwright
// specs can start from a clean state without restarting the server. Gated by
// ROUBO_E2E so production builds return 404 for this URL. The e2e harness
// sets ROUBO_E2E=1 when launching the test server.
//
// Optional JSON body { scenario?, now? } pins the stubbed plugin (WU-063): the
// values are passed to plugin-manager so the next spawn appends them as
// --scenario / --now argv. Omitting the body resets the pinning to defaults.
router.post("/__reset", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }

  const parsed = parseResetBody(req.body as ResetBody | undefined);
  if (typeof parsed === "string") {
    return res.status(400).json({ error: parsed });
  }

  try {
    migrate.__test.reset();
    githubOauth.__test.reset();
    // Clear the connection-status cache before shutdown. shutdown() itself
    // clears `plugins` and `enableStateCache` but leaves the status maps
    // populated, which would otherwise survive the reset.
    pluginManager.__test.resetConnectionStatusCache();
    // Clear the TC-153 e2e log tap so each spec starts from an empty buffer.
    // The tap is the ROUBO_E2E=1-only mirror of the production-grade
    // structured log emitted by `recordConnectionStateTransition`.
    pluginManager.__test.resetE2EConnectionStateLogTap();
    await pluginManager.shutdown();
    // Drop any fixture projects registered via /test/__register-fixture-project
    // BEFORE clearing the in-memory map. Removing the projects.json rows now
    // means the subsequent initialize() reload sees a clean disk; otherwise
    // the fixture would survive every reset.
    for (const entry of fixtureProjects.values()) {
      cleanupFixtureProject(entry);
    }
    fixtureProjects.clear();
    // WU-069: also wipe persisted project + bench + integration-override state
    // on disk before initialize() re-reads it. This covers anything a
    // Playwright spec registered directly via /api/projects (i.e. without
    // going through /test/__register-fixture-project, which fixtureProjects
    // already tracks). The in-memory project-registry reset clears the Map,
    // but initialize() rehydrates from projects.json, so without this an
    // earlier spec's registration survives the reset and breaks 10x
    // determinism (NFR-018). Safe because the route is ROUBO_E2E-gated and
    // the helper itself refuses to run unless ROUBO_PRODUCTION is unset and
    // the resolved roubo dir lives under `.roubo-dev/`.
    wipePersistedTestState();
    // Reload project-registry before re-initializing plugin-manager so
    // discovery sees the right project set.
    projectRegistry.__test.reset();
    projectRegistry.initialize();
    // Apply the pinning AFTER project-registry init and BEFORE plugin-manager
    // initialize: initialize() is what spawns the plugin processes, and the
    // pinning must be in place at spawn time so spawnPlugin sees it.
    pluginManager.__test.setE2EConfig(parsed);
    // WU-068 (#159): force-enable the bundled plugin ids before initialize()
    // runs. The migrate seed (greenfield install path) writes them as
    // "disabled" by default, which suppresses spawn under ROUBO_E2E too, so
    // /api/plugins/github-com/connection-status would otherwise return
    // { state: "disabled" } and the project-settings specs that target the
    // bundled-overlay slot (github-com / ghe / jira-self-hosted) could never
    // observe a connected state. Doing this in __reset keeps the override
    // scoped to the e2e gate.
    ensureBundledPluginsEnabled();
    disableFailureFixturePlugins();
    await pluginManager.initialize();
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__reset failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__register-fixture-project (#232): create a throwaway project
// whose active integration is the requested plugin, so a Playwright spec can
// drive surfaces that only render once a project is registered (e.g. the
// project Issue Source tile header in TC-168 placement C). The route writes
// a minimum roubo.yaml into an os.tmpdir() tree, registers it with
// project-registry, and saves an integration override pinning `plugin`.
// Cleanup runs in /test/__reset so successive specs start clean (NFR-018).
//
// Body: { projectId: string (kebab-case), plugin: string }. Gated by
// ROUBO_E2E so production builds return 404.
interface RegisterFixtureBody {
  projectId?: unknown;
  plugin?: unknown;
  // WU-068: optional extra integration fields (instance, sources,
  // capturedUserId, etc.) merged into the saved override after `plugin`.
  // `plugin` on this nested object is rejected so the top-level field
  // remains the single source of truth for which plugin is pinned.
  integrationConfig?: unknown;
  // TC-161: optional list of benches to seed against the fixture project so
  // specs can exercise post-switch surfaces (e.g. the "Issue from previous
  // integration" badge on BenchCard) without driving the real
  // bench-provisioning UI. Each entry's `assignedIssue` is persisted onto a
  // freshly minted tmpdir-backed PersistedBench.
  seedBenches?: unknown;
}

interface SeedBenchInput {
  assignedIssue: AssignedIssue;
}

interface ParsedRegisterFixture {
  projectId: string;
  plugin: string;
  integrationConfig?: IntegrationConfig;
  seedBenches: SeedBenchInput[];
}

function parseSeedBenches(raw: unknown): SeedBenchInput[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "seedBenches must be an array";
  const parsed: SeedBenchInput[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `seedBenches[${i}] must be an object`;
    }
    const issueRaw = (entry as { assignedIssue?: unknown }).assignedIssue;
    if (issueRaw === null || typeof issueRaw !== "object" || Array.isArray(issueRaw)) {
      return `seedBenches[${i}].assignedIssue must be an object`;
    }
    const issue = issueRaw as Record<string, unknown>;
    if (typeof issue.number !== "number" || !Number.isInteger(issue.number) || issue.number < 0) {
      return `seedBenches[${i}].assignedIssue.number must be a non-negative integer`;
    }
    if (typeof issue.integrationId !== "string" || issue.integrationId.length === 0) {
      return `seedBenches[${i}].assignedIssue.integrationId must be a non-empty string`;
    }
    if (typeof issue.externalId !== "string" || issue.externalId.length === 0) {
      return `seedBenches[${i}].assignedIssue.externalId must be a non-empty string`;
    }
    if (typeof issue.title !== "string") {
      return `seedBenches[${i}].assignedIssue.title must be a string`;
    }
    parsed.push({
      assignedIssue: {
        number: issue.number,
        integrationId: issue.integrationId,
        externalId: issue.externalId,
        title: issue.title,
      },
    });
  }
  return parsed;
}

function parseRegisterFixtureBody(
  body: RegisterFixtureBody | undefined,
): ParsedRegisterFixture | string {
  const projectIdRaw = body?.projectId;
  const pluginRaw = body?.plugin;
  if (typeof projectIdRaw !== "string" || !FIXTURE_PROJECT_ID_RE.test(projectIdRaw)) {
    return "projectId must be a kebab-case string matching /^[a-z][a-z0-9-]*$/";
  }
  if (typeof pluginRaw !== "string" || pluginRaw.length === 0) {
    return "plugin must be a non-empty string";
  }
  let integrationConfig: IntegrationConfig | undefined;
  if (body?.integrationConfig !== undefined) {
    if (
      body.integrationConfig === null ||
      typeof body.integrationConfig !== "object" ||
      Array.isArray(body.integrationConfig)
    ) {
      return "integrationConfig must be an object";
    }
    if ("plugin" in (body.integrationConfig as Record<string, unknown>)) {
      return "integrationConfig must not include `plugin`; use the top-level field";
    }
    const parsed = IntegrationConfigSchema.safeParse(body.integrationConfig);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return `integrationConfig failed validation: ${issues}`;
    }
    integrationConfig = parsed.data;
  }
  const seedBenches = parseSeedBenches(body?.seedBenches);
  if (typeof seedBenches === "string") return seedBenches;
  return { projectId: projectIdRaw, plugin: pluginRaw, integrationConfig, seedBenches };
}

router.post("/__register-fixture-project", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }

  const parsed = parseRegisterFixtureBody(req.body as RegisterFixtureBody | undefined);
  if (typeof parsed === "string") {
    return res.status(400).json({ error: parsed });
  }
  const { projectId, plugin, integrationConfig, seedBenches } = parsed;

  if (fixtureProjects.has(projectId)) {
    return res.status(409).json({ error: `Fixture project '${projectId}' is already registered` });
  }

  let repoPath: string;
  try {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-e2e-fixture-"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to create tmpdir: ${message}` });
  }

  const seededWorkspacePaths: string[] = [];
  try {
    writeFixtureRouboYaml(repoPath, projectId);
    projectRegistry.registerProject(repoPath);
    saveOverride(projectId, {
      schemaVersion: 1,
      integration: { ...(integrationConfig ?? {}), plugin },
    });
    // TC-161: persist each seeded bench against the fixture project with a
    // real tmpdir workspacePath. The `assignedIssue` carries the
    // `integrationId` the spec needs to drive the previous-integration
    // badge on BenchCard. After all benches are written, reload bench-manager
    // so the in-memory map picks them up without restarting the server.
    const createdAt = new Date().toISOString();
    for (let i = 0; i < seedBenches.length; i += 1) {
      const seed = seedBenches[i];
      const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-e2e-seeded-bench-"));
      seededWorkspacePaths.push(workspacePath);
      state.addBench({
        id: i + 1,
        projectId,
        branch: `seed/${i + 1}`,
        workspacePath,
        ports: {},
        createdAt,
        assignedIssue: seed.assignedIssue,
        componentSetupState: {},
      });
    }
    if (seedBenches.length > 0) {
      benchManager.__test.reloadFromState();
    }
    fixtureProjects.set(projectId, { projectId, repoPath, seededWorkspacePaths });
    res.status(200).json({ projectId, repoPath });
  } catch (err) {
    // Roll back everything we may have touched so a failed call leaves no
    // trace. unregisterProject covers both the in-memory Map and the
    // projects.json row; removeOverride / rmSync are no-ops if the step
    // that would have written them never ran.
    try {
      projectRegistry.unregisterProject(projectId, { force: true });
    } catch {
      // Either the project was never registered, or it has benches we won't
      // create from this route — either way, nothing to do here.
    }
    try {
      removeOverride(projectId);
    } catch {
      // ditto
    }
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // ditto
    }
    for (const seededPath of seededWorkspacePaths) {
      try {
        fs.rmSync(seededPath, { recursive: true, force: true });
      } catch {
        // ditto
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__register-fixture-project failed:", message);
    res.status(500).json({ error: message });
  }
});

// TC-153 e2e tap reader. Returns the ROUBO_E2E=1-only buffer that mirrors
// every structured connection-state log line emitted by
// `recordConnectionStateTransition`. Gated by ROUBO_E2E so production builds
// return 404 for this URL. The Playwright harness (TC-169) uses this to
// assert transitions without scraping the server's stdout.
router.get("/__connection-state-log", (_req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  res.status(200).json({ entries: pluginManager.__test.getE2EConnectionStateLogTap() });
});

// TC-154 (#222): read the persisted plugin-enable-state file so a Playwright
// spec can assert the NFR-024 invariant ("plugin remains in its previous
// disabled state on spawn failure") without poking the filesystem from the
// test process. Gated by ROUBO_E2E.
router.get("/__plugin-enable-state", (_req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const state = pluginEnableState.loadEnableState();
  res.status(200).json({ plugins: state?.plugins ?? {} });
});

export default router;
