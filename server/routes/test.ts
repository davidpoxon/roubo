import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_PLUGIN_IDS, DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import { resolveFocusedSpec } from "../lib/testbench-spec-discovery.js";
import {
  computePlanHash,
  MissingPlanError,
  readPlanAndResults,
  setStatusOverride,
} from "../lib/testbench-store.js";
import { writeResults } from "../lib/testbench-results-write.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";
import * as state from "../services/state.js";
import { ONLY_TO_DO_NOTICE_MARKER } from "@roubo/shared";
import * as pluginEnableState from "../services/plugin-enable-state.js";
import { removeOverride, saveOverride } from "../services/integration-overrides.js";
import { cutListQueryService } from "../services/cut-list-query-service.js";
import * as catalogClient from "../services/catalog-client.js";
import * as marketplace from "../services/marketplace.js";
import * as sourcesState from "../services/marketplace-sources-state.js";
import * as pluginProvenanceState from "../services/plugin-provenance-state.js";
import * as credentialStore from "../services/credential-store.js";
import { PROJECT_ID_RE, resolveWithin } from "../lib/safe-path.js";
import {
  IntegrationConfigSchema,
  type AssignedIssue,
  type IntegrationConfig,
  type MarketplaceCatalogEntry,
} from "@roubo/shared";
import {
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  validateTestCases,
  type CaseResult,
  type CaseStatus,
  type TestCasesPlan,
  type TestResultsFile,
} from "@roubo/shared/testbench-contracts";

const router: Router = Router();

// Defence-in-depth rate limit on the e2e harness surface. These routes only
// respond when ROUBO_E2E=1 (production builds 404 them), but they touch the
// filesystem and the projects.json store, so we cap requests per minute per IP
// to prevent runaway specs or a misbehaving caller from saturating disk I/O.
// Mirrors the pattern in plugins-github-oauth.ts. Also satisfies CodeQL
// `js/missing-rate-limiting` on the file-system access in
// /__register-fixture-project.
//
// #466: the full Playwright suite (workers: 1) fires well over 120 /test/*
// requests inside a single 60s window (many __reset + __register-fixture-project
// + __seed-* calls), so the limiter's window fills mid-suite and later
// fixture-registering specs get a 429, breaking 10x determinism (NFR-018). Exempt
// the e2e run itself via `skip: isE2eRateLimitExempt`, which returns true only
// when ROUBO_E2E=1. This keeps CodeQL `js/missing-rate-limiting` satisfied
// (the middleware stays statically applied to the router: skip is a runtime
// predicate, not a removal of the limiter) and keeps production protected
// (ROUBO_E2E !== "1" is never skipped, so the limiter still caps the 404 surface
// outside the e2e harness).
export const isE2eRateLimitExempt = (): boolean => process.env.ROUBO_E2E === "1";

const testRouteRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: isE2eRateLimitExempt,
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
  // so /__reset can rm them alongside `repoPath`. `wipePersistedTestState`
  // truncates `state.json` (dropping the bench row), but the tmpdir on disk
  // would otherwise survive between specs.
  seededWorkspacePaths: string[];
}
const fixtureProjects = new Map<string, FixtureProjectEntry>();

// Drop everything one fixture project wrote to disk. Each step is wrapped in
// try/catch so a single failure does not skip the others: the caller wants
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

// Default port base for a fixture project. High enough to keep collisions with
// a developer's pre-existing dev projects unlikely.
const FIXTURE_DEFAULT_PORT_BASE = 39100;

// Minimum roubo.yaml that satisfies RouboConfigSchema (project, layout,
// components ≥1, ports ≥1, benches). The single port uses a high base to
// keep collisions with a developer's pre-existing dev projects unlikely;
// the component never actually runs because the fixture stops after
// registerProject + saveOverride. `benches.max` is set to 5 (rather than 1)
// so the `seedBenches` option below can pin multiple persisted benches
// without violating the config cap.
//
// CLI-TC-062 (#573): a spec that registers two fixture projects at once (e.g.
// to prove per-project config independence across plugins) must give each a
// distinct `portBase`, since the port allocator rejects overlapping ranges.
function writeFixtureRouboYaml(
  repoPath: string,
  projectId: string,
  repo?: string,
  portBase: number = FIXTURE_DEFAULT_PORT_BASE,
  componentPlugin: string | null = null,
  enforceIssueDependencies = false,
  declaredMarketplaces: string[] = [],
  componentBinding: { name: string; pluginId: string } | null = null,
): void {
  const dotRoubo = path.join(repoPath, ".roubo");
  fs.mkdirSync(dotRoubo, { recursive: true });
  // TC-164/167/177: when a spec passes `projectRepo`, emit it under `project.repo`
  // so `deriveGithubSources` (which reads `config.project.repo`) returns a
  // non-empty repo set and the Configure modal's derived-sources preview renders
  // its success state instead of the "could not see this repository" fallback.
  const repoLine = repo ? `\n  repo: ${repo}` : "";
  // CP-TC-028 (#626): bind a `deploy` component to the requested imperative
  // component plugin (e.g. `clasp-deploy-stub`). The component carries no
  // config (the stub's start hook needs none); the binding alone makes the
  // bench's `deploy` component resolve to the plugin via the component registry.
  const deployComponent = componentPlugin
    ? `
  deploy:
    plugin:
      id: ${componentPlugin}
    config: {}`
    : "";
  // CPHMTP-TC-073 (#575): bind an arbitrary named component to an arbitrary
  // plugin id, which may be UNINSTALLED (e.g. an `apps-script` component bound to
  // `google-clasp`, served only by a declared third-party marketplace). The
  // binding stays valid at config-load (unknown-plugin bindings are tolerated,
  // see project-registry.applyComponentBindingValidation) and surfaces the
  // not-installed missing-plugin resolution at bench-start.
  const extraComponent = componentBinding
    ? `
  ${componentBinding.name}:
    plugin:
      id: ${componentBinding.pluginId}
    config: {}`
    : "";
  // CPHMTP-TC-073 (#575): declare one or more third-party marketplaces so the
  // project-open flow offers to register the declared-but-unregistered source.
  // Each entry is a URL only (never a credential), matching the strict schema.
  const marketplacesBlock =
    declaredMarketplaces.length > 0
      ? `\nmarketplaces:\n${declaredMarketplaces.map((url) => `  - url: ${url}`).join("\n")}`
      : "";
  const yaml = `project:
  name: ${projectId}
  displayName: Roubo E2E Fixture
  type: web${repoLine}
layout:
  type: single-repo
components:
  app:
    plugin:
      id: process
    config:
      command: "true"${deployComponent}${extraComponent}
ports:
  app:
    base: ${portBase}
benches:
  max: 5${enforceIssueDependencies ? "\n  enforceIssueDependencies: true" : ""}${marketplacesBlock}
`;
  fs.writeFileSync(path.join(dotRoubo, "roubo.yaml"), yaml, "utf-8");
}

interface ResetBody {
  scenario?: unknown;
  now?: unknown;
  bundledPluginsDisabled?: unknown;
}

interface ParsedResetConfig {
  scenario: string | null;
  now: string | null;
  // WU-066 (TC-171/TC-172): when true, the reset writes every bundled plugin
  // id as "disabled" in plugins-state.json instead of force-enabling them, so
  // the project-load Enable-plugin prompt fires for the next spec.
  bundledPluginsDisabled: boolean;
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
  for (const name of [
    "projects.json",
    "state.json",
    // #571 (CPHMTP-TC-011): the third-party marketplace registry and the plugin
    // provenance ledger the marketplace-removal journey seeds. Wiped alongside the
    // rest so a seeded source / orphan stamp never leaks into a later spec (NFR-018).
    "marketplace-sources.json",
    "plugins-provenance.json",
  ]) {
    const file = path.join(rouboDir, name);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best-effort: tolerate a missing file or a transient unlink failure.
    }
  }
  // #575 (CPHMTP-TC-073): drop the per-source marketplace catalog caches
  // (`marketplace/sources/<id>/catalog-cache.json`, written by the
  // third-party client and by the __seed-source-catalog seam). Without an
  // explicit wipe a source registered + seeded by the declared-source journey
  // would leak into a later spec (its offer would be absent, its cache would
  // serve stale entries), breaking 10x determinism (NFR-018). Paired with the
  // marketplace-sources.json removal above and the in-memory resets in
  // /__reset, so a later spec starts with no registered third-party sources.
  // #571 (CPHMTP-TC-011): also drops the per-source cache tree the
  // __seed-marketplace-source seam pre-creates (`marketplace/sources/<id>/`).
  try {
    fs.rmSync(path.join(rouboDir, "marketplace"), { recursive: true, force: true });
  } catch {
    // Best-effort: tolerate a missing directory or a transient unlink failure.
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
  // Drop the persistent first-page cut-list snapshot cache
  // (`issue-snapshots/`, written by DiskSnapshotStore). It survives a process
  // restart by design, so without an explicit wipe a snapshot written by one
  // scenario would be served as a disk-hit to a later scenario sharing the same
  // cache key (same fixture projectId + plugin + instance), rendering stale or
  // wrong issues. Clearing it here keeps successive specs starting clean.
  try {
    fs.rmSync(path.join(rouboDir, "issue-snapshots"), { recursive: true, force: true });
  } catch {
    // Best-effort: tolerate a missing directory or a transient unlink failure.
  }
}

function parseResetBody(body: ResetBody | undefined): ParsedResetConfig | string {
  const scenarioRaw = body?.scenario;
  const nowRaw = body?.now;
  const bundledRaw = body?.bundledPluginsDisabled;
  let scenario: string | null = null;
  let now: string | null = null;
  let bundledPluginsDisabled = false;
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
  if (bundledRaw !== undefined && bundledRaw !== null) {
    if (typeof bundledRaw !== "boolean") {
      return "bundledPluginsDisabled must be a boolean";
    }
    bundledPluginsDisabled = bundledRaw;
  }
  return { scenario, now, bundledPluginsDisabled };
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
//
// CPHM-TC-082 (#317): `errored-component-stub` is a component-kind fixture whose
// entry file (./dist/index.js) is intentionally absent. Left enabled it would
// fail the #759 pre-spawn host check at every boot and land `errored` in every
// spec's plugin list; forcing it disabled here keeps it out of unrelated specs.
// The errored-banner drift guard enables it on demand (POST /api/plugins/
// errored-component-stub/enable) to drive the real missing-entry errored state.
const FAILURE_FIXTURE_PLUGIN_IDS = ["broken-plugin", "errored-component-stub"] as const;
function disableFailureFixturePlugins(): void {
  for (const id of FAILURE_FIXTURE_PLUGIN_IDS) {
    pluginEnableState.setPluginEnabled(id, false);
  }
}

// WU-066 (TC-171/TC-172): inverse of `ensureBundledPluginsEnabled`. Writes
// every bundled plugin id as "disabled" so the project-load Enable-plugin
// prompt fires when the next spec navigates to a project that references one
// of those ids. Selected via the optional `{ bundledPluginsDisabled: true }`
// body param on /__reset; the default (force-enabled) is preserved so
// existing project-settings specs are unaffected.
function ensureBundledPluginsDisabled(): void {
  for (const id of BUNDLED_PLUGIN_IDS) {
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
    // #571 (CPHMTP-TC-011): drop the in-process caches for the plugin provenance
    // ledger and the ROUBO_E2E in-memory keyring that wipePersistedTestState just
    // cleared on disk, so a seeded provenance row / credential never bleeds into
    // the next spec (NFR-018). The load helpers return null on an absent file, but
    // the saved `lastKnown` snapshot would otherwise survive a corrupt-file
    // fallback. (The marketplace-sources snapshot + per-source client cache are
    // reset in the #575 block below.)
    pluginProvenanceState.__test.reset();
    credentialStore.__test.resetE2EKeyring();
    // #568: restore the cut-list disk-cache bypass to its env-derived default.
    // The cut-list-refresh drift guard (CLI-TC-017) un-bypasses the disk path
    // via /test/__set-cut-list-disk-cache to reach the warm-snapshot serve;
    // without this restore that toggle would leak the warm path into the next
    // spec, breaking 10x determinism (NFR-018). wipePersistedTestState already
    // wiped issue-snapshots/, so the next warm spec starts from a clean disk.
    cutListQueryService.restoreBypassDefault();
    // #314 (CPHM-TC-051): restore the marketplace catalog client to its
    // reachable (network) default so the offline-journey toggle
    // (POST /test/__set-marketplace-reachable) never leaks an "unreachable"
    // state into a later spec (NFR-018). No-op outside ROUBO_E2E.
    await catalogClient.__setE2EMarketplaceReachable(true);
    // #575 (CPHMTP-TC-073): drop the in-memory marketplace-sources snapshot and
    // the per-source third-party client cache. wipePersistedTestState already
    // removed marketplace-sources.json + the per-source caches on disk, but the
    // sources-state module memoises the last-loaded state and the marketplace
    // service memoises one client per source; without clearing both, a source
    // registered by the declared-source journey would survive the reset in
    // memory and leak into a later spec (NFR-018).
    sourcesState.__test.reset();
    marketplace.__test.resetSourceClients();
    // Reload project-registry before re-initializing plugin-manager so
    // discovery sees the right project set.
    projectRegistry.__test.reset();
    projectRegistry.initialize();
    // TC-001 (#438): drop the in-memory bench map and re-hydrate from the now
    // empty state.json. A spec that drove the REAL create path (e.g. the
    // create-a-TestBench journey) left a persisted bench in bench-manager's
    // Map; `wipePersistedTestState` truncated state.json but the Map itself
    // survives a reset, so without this the next spec's bench list would still
    // show the previous run's bench (breaking 10x determinism, NFR-018). Runs
    // after project-registry init so the rehydrate sees the right project set.
    benchManager.__test.reloadFromState();
    // Apply the pinning AFTER project-registry init and BEFORE plugin-manager
    // initialize: initialize() is what spawns the plugin processes, and the
    // pinning must be in place at spawn time so spawnPlugin sees it.
    pluginManager.__test.setE2EConfig({ scenario: parsed.scenario, now: parsed.now });
    // WU-068 (#159): force-enable the bundled plugin ids before initialize()
    // runs. The migrate seed (greenfield install path) writes them as
    // "disabled" by default, which suppresses spawn under ROUBO_E2E too, so
    // /api/plugins/github-com/connection-status would otherwise return
    // { state: "disabled" } and the project-settings specs that target the
    // bundled-overlay slot (github-com / ghe / jira-self-hosted) could never
    // observe a connected state. Doing this in __reset keeps the override
    // scoped to the e2e gate.
    // WU-066 (TC-171/TC-172): when the caller passes { bundledPluginsDisabled:
    // true }, write the inverse instead: every bundled id is disabled so the
    // project-load Enable-plugin prompt fires for the spec.
    if (parsed.bundledPluginsDisabled) {
      ensureBundledPluginsDisabled();
    } else {
      ensureBundledPluginsEnabled();
    }
    disableFailureFixturePlugins();
    await pluginManager.initialize();
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__reset failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__seed-notice (#574): stamp the only-to-do default-change notice
// marker (FR-018, issue #558) with a fixed ISO 8601 timestamp so the
// OnlyToDoNoticeBanner renders for the e2e upgrade-banner journey (TC-047).
//
// The boot-time `seedOnlyToDoNotice` path either omits the marker, or seeds it
// as the `"seeded"` sentinel on a fresh install (which the banner never
// surfaces), and `/test/__reset` truncates state.json entirely, so a spec has
// no other way to reach the "existing install, banner should show once" state.
// This route writes the marker directly. The value must be a real ISO timestamp
// (not `"seeded"`) for the banner to show; the spec passes a fixed one so the
// localStorage dismissal key is deterministic. Gated by ROUBO_E2E so production
// builds 404 the URL; the testRouteRateLimiter still applies.
//
// Body: { at?: string }. `at` defaults to a fixed ISO timestamp; when supplied
// it must be a parseable ISO-8601 string and must not be the `"seeded"`
// sentinel (which would leave the banner hidden and defeat the seed's purpose).
const DEFAULT_NOTICE_AT = "2026-06-01T12:00:00.000Z";
const NOTICE_SEEDED_SENTINEL = "seeded";
router.post("/__seed-notice", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as { at?: unknown };
  let at = DEFAULT_NOTICE_AT;
  if (body.at !== undefined) {
    if (typeof body.at !== "string" || body.at.length === 0) {
      return res.status(400).json({ error: "at must be a non-empty string when provided" });
    }
    if (body.at === NOTICE_SEEDED_SENTINEL) {
      return res
        .status(400)
        .json({ error: `at must not be the "${NOTICE_SEEDED_SENTINEL}" sentinel` });
    }
    if (Number.isNaN(new Date(body.at).getTime())) {
      return res.status(400).json({ error: "at must be a parseable ISO-8601 string" });
    }
    at = body.at;
  }
  try {
    const current = state.loadState();
    state.saveState({
      ...current,
      notices: { ...(current.notices ?? {}), [ONLY_TO_DO_NOTICE_MARKER]: at },
    });
    res.status(200).json({ marker: ONLY_TO_DO_NOTICE_MARKER, at });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__seed-notice failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__set-cut-list-disk-cache (#568): toggle whether the persistent
// cut-list disk snapshot is bypassed at runtime. Under the e2e harness
// (ROUBO_E2E=1) the CutListQueryService bypasses the disk path by default so a
// snapshot written by one scenario is never served to a later one (NFR-018). The
// cut-list-refresh drift guard (CLI-TC-017) needs the warm-snapshot serve, which
// only happens on a disk hit, so it un-bypasses the disk via this endpoint after
// the per-spec reset. /test/__reset restores the env-derived default, so the
// warm path never leaks into another spec. Gated by ROUBO_E2E; production 404s.
//
// Body: { enabled: boolean }. `true` un-bypasses the disk (warm path reachable),
// `false` re-enables the bypass.
router.post("/__set-cut-list-disk-cache", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  cutListQueryService.setDiskCacheEnabled(body.enabled);
  res.status(200).json({ ok: true, enabled: body.enabled });
});

// POST /test/__set-marketplace-reachable (#314, CPHM-TC-051): flip the catalog
// client between reachable (network source) and unreachable (degrade to
// cache/seed) at runtime, so the marketplace-offline-journey e2e can walk the
// offline -> install-blocked -> reconnect path without real network. The toggle
// busts the catalog memo so the served source flips on the next read; the
// response carries the freshly resolved `source` so the spec can assert the
// degrade/reconnect at the catalog-client boundary. /test/__reset restores
// reachable:true so the toggle never leaks into a later spec (NFR-018). Gated by
// ROUBO_E2E; production builds 404 the URL.
//
// Body: { reachable: boolean }.
router.post("/__set-marketplace-reachable", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as { reachable?: unknown };
  if (typeof body.reachable !== "boolean") {
    return res.status(400).json({ error: "reachable must be a boolean" });
  }
  try {
    const source = await catalogClient.__setE2EMarketplaceReachable(body.reachable);
    res.status(200).json({ ok: true, reachable: body.reachable, source });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__set-marketplace-reachable failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__seed-source-catalog (#575, CPHMTP-TC-073): seed a registered
// third-party source's per-source catalog CACHE so it deterministically serves
// the given entries with NO real network. Registering a source is a pure write
// (CPHMTP-NFR-003) and the declared ACME URL (ghe.acme.internal) is unreachable
// under the harness, so the source's NETWORK -> CACHE degrade chain would
// otherwise bottom out empty. This writes the cache the chain degrades to (via
// catalogClient.seedThirdPartyCacheForE2E, keyed to the same cache dir + shape
// the third-party client reads) and drops any memoised client for the source so
// the next listing/resolution rebuilds and reads it. The
// declared-source-consent-install-journey drift guard uses this to make a
// registered ACME source serve `google-clasp`, so the missing-plugin bench-start
// resolution names ACME (registered). /test/__reset clears the sources +
// per-source caches so nothing leaks into a later spec (NFR-018). Gated by
// ROUBO_E2E; production builds 404 the URL.
//
// Body: { sourceId: string, entries: MarketplaceCatalogEntry[], fetchedAt?: string }.
router.post("/__seed-source-catalog", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as {
    sourceId?: unknown;
    entries?: unknown;
    fetchedAt?: unknown;
  };
  if (typeof body.sourceId !== "string" || body.sourceId.length === 0) {
    return res.status(400).json({ error: "sourceId must be a non-empty string" });
  }
  if (!Array.isArray(body.entries)) {
    return res.status(400).json({ error: "entries must be an array" });
  }
  if (body.fetchedAt !== undefined && typeof body.fetchedAt !== "string") {
    return res.status(400).json({ error: "fetchedAt must be a string when provided" });
  }
  try {
    const cachePath = await catalogClient.seedThirdPartyCacheForE2E(
      body.sourceId,
      body.entries as MarketplaceCatalogEntry[],
      body.fetchedAt,
    );
    // Drop any client memoised before the seed so the next fan-out rebuilds and
    // reads the freshly written per-source cache.
    marketplace.invalidateSourceClient(body.sourceId);
    res.status(200).json({ ok: true, path: cachePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__seed-source-catalog failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__seed-marketplace-source (#571, CPHMTP-TC-011): stand up the
// preconditions for the marketplace-removal journey, which has no pure-UI path to
// reach ("a third-party source registered WITH a credential, and one plugin
// installed FROM it"). Registering a source is a UI flow, but installing a plugin
// from a specific third-party source is not scriptable end to end in the harness,
// so this seam writes the state directly, exactly as the shipping install commit
// would: it registers the source via sourcesState.addSource (which also stores the
// credential in the keyring), records a provenance-ledger row tying the target
// plugin to that source, and pre-creates the per-source catalog cache dir. It then
// re-derives the live plugin records from the ledger (the same rebuild a relaunch
// does) so the seeded plugin's record carries the source before the removal step.
// Gated by ROUBO_E2E; production builds 404 the URL.
//
// Body: { url?, pluginId?, credential? }. Defaults model the CPHMTP-TC-011
// preconditions (a credentialled third-party source, the e2e-stub plugin installed
// from it). Returns the generated { sourceId, sourceUrl, pluginId }.
const SEED_SOURCE_DEFAULT_URL = "https://marketplace.e2e-remove.test/catalog.json";
const SEED_SOURCE_DEFAULT_PLUGIN_ID = "e2e-stub";
const SEED_SOURCE_DEFAULT_CREDENTIAL = "e2e-source-token";
const SEED_PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
router.post("/__seed-marketplace-source", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as { url?: unknown; pluginId?: unknown; credential?: unknown };
  const url =
    typeof body.url === "string" && body.url.length > 0 ? body.url : SEED_SOURCE_DEFAULT_URL;
  const credential =
    typeof body.credential === "string" && body.credential.length > 0
      ? body.credential
      : SEED_SOURCE_DEFAULT_CREDENTIAL;
  let pluginId = SEED_SOURCE_DEFAULT_PLUGIN_ID;
  if (body.pluginId !== undefined) {
    if (typeof body.pluginId !== "string" || !SEED_PLUGIN_ID_RE.test(body.pluginId)) {
      return res
        .status(400)
        .json({ error: "pluginId must be a kebab-case string matching /^[a-z][a-z0-9-]*$/" });
    }
    pluginId = body.pluginId;
  }
  try {
    const result = await sourcesState.addSource({ url, credential });
    if (result.outcome === "invalid-url") {
      return res.status(400).json({ error: `Invalid source URL: ${url}` });
    }
    const source = result.source;
    // Record the provenance row the install commit would have written, tying the
    // plugin to the just-registered source and marking it unsigned (unverified),
    // the trust treatment every third-party source carries.
    pluginProvenanceState.recordProvenance({
      pluginId,
      sourceId: source.id,
      sourceUrl: source.url,
      unverified: true,
    });
    // Pre-create the per-source catalog cache dir with a placeholder catalog so
    // S006 can prove the removal deletes it (the pure-write registration fetches
    // nothing, so nothing else would create it).
    const cacheDir = sourcesState.__test.sourceCacheDir(source.id);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "catalog.json"), "{}\n", "utf-8");
    // Re-derive the live records so the seeded plugin's record carries the source
    // provenance before the journey's removal step (the rebuild a relaunch does).
    pluginManager.__test.refreshProvenanceFromLedger();
    res.status(200).json({ sourceId: source.id, sourceUrl: source.url, pluginId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__seed-marketplace-source failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__refresh-plugin-provenance (#571, CPHMTP-TC-011): re-derive the live
// plugin records from the provenance ledger without a server restart. The orphan
// stamp a source removal writes to the ledger only reaches a record on its next
// rebuild (a relaunch in production); the marketplace-removal journey calls this
// AFTER the removal so the orphaned aftermath is observable in-session. Gated by
// ROUBO_E2E; production builds 404 the URL.
router.post("/__refresh-plugin-provenance", (_req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  pluginManager.__test.refreshProvenanceFromLedger();
  res.status(200).json({ ok: true });
});

// GET /test/__inspect-marketplace-source?id= (#571, CPHMTP-TC-011): read the
// on-disk aftermath of a source removal (S006) directly, so the drift guard can
// assert the registry row, the per-source catalog cache dir, and the keyring
// credential are all gone without the spec poking the filesystem/keyring itself.
// Gated by ROUBO_E2E; production builds 404 the URL.
const INSPECT_SOURCE_ID_RE = /^[a-z0-9-]+$/;
router.get("/__inspect-marketplace-source", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const id = req.query.id;
  if (typeof id !== "string" || !INSPECT_SOURCE_ID_RE.test(id)) {
    return res
      .status(400)
      .json({ error: "id query param must be a source slug matching /^[a-z0-9-]+$/" });
  }
  try {
    const registryPresent = sourcesState.listSources().some((s) => s.id === id);
    const cacheDirExists = fs.existsSync(sourcesState.__test.sourceCacheDir(id));
    const credentialPresent = (await sourcesState.readSourceCredential(id)) !== null;
    res.status(200).json({ registryPresent, cacheDirExists, credentialPresent });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__inspect-marketplace-source failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__register-fixture-project (#232): create a throwaway project
// whose active integration is the requested plugin, so a Playwright spec can
// drive surfaces that only render once a project is registered (e.g. the
// project Issue Source tile header in TC-168 placement C). The route writes
// a minimum roubo.yaml into an os.tmpdir() tree, registers it with
// project-registry, and saves an integration override pinning `plugin`.
// TC-164: `plugin` is optional. When omitted, the route registers the project
// without writing an override so the tile renders its UnconfiguredBody
// variant; the spec then drives the SwitchIntegrationDialog UI to pin a
// plugin from the unconfigured starting state.
// Cleanup runs in /test/__reset so successive specs start clean (NFR-018).
//
// Body: { projectId: string (kebab-case), plugin?: string }. Gated by
// ROUBO_E2E so production builds return 404.
interface RegisterFixtureBody {
  projectId?: unknown;
  plugin?: unknown;
  // TC-164/167/177: optional `project.repo` written into the fixture roubo.yaml
  // so the github-com Configure modal's derived-sources preview can reach its
  // success state (the preview reads `config.project.repo` via
  // `deriveGithubSources`). Independent of `integrationConfig`.
  projectRepo?: unknown;
  // CLI-TC-062 (#573): optional port base written into the fixture roubo.yaml.
  // A spec that registers two fixture projects at once must give each a
  // distinct base so the port allocator does not reject the second one's
  // overlapping range. Defaults to FIXTURE_DEFAULT_PORT_BASE when omitted.
  portBase?: unknown;
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
  // TC-001 (#438): optional list of specs to seed into the fixture repo so
  // TestBench spec discovery (`discoverSpecs`) and the create flow can run
  // against a real `.specifications/<slug>/test-cases.json`. Each entry writes
  // its `testCases` JSON to `<repoPath>/.specifications/<slug>/test-cases.json`.
  // TSPF-TC-010 (#486): an entry may also carry `seedResults` ("all-passed" |
  // "partial") to emit a hash-matching test-results.json so the spec lands in a
  // known verification classification for the partitioned-picker journey.
  seedSpecs?: unknown;
  // TC-001 (#438): when true, `git init` + an initial commit are run in the
  // fixture repo so a real TestBench worktree (`git worktree add`) can be
  // provisioned. Provisioning is also pinned to the local HEAD (worktreeSource
  // branchFromDefault/pullLatest both false) so it does not require an `origin`
  // remote the throwaway repo does not have.
  gitInit?: unknown;
  // CP-TC-028 (#626): optional id of a component plugin to bind a `deploy`
  // component to in the fixture roubo.yaml (in addition to the default `app`
  // process component). Lets the component-deploy e2e drive a bench whose
  // `deploy` component resolves to the imperative `clasp-deploy-stub` plugin.
  componentPlugin?: unknown;
  // TC-032 (#708): when true, the fixture roubo.yaml sets
  // `benches.enforceIssueDependencies: true` so the project-level config turns
  // the host's hard start-gate ON (resolveEnforceIssueDependencies reads
  // `project.config.benches.enforceIssueDependencies` first). The start-gate
  // e2e drives the blocked -> allowed journey against this, with no reliance on
  // the global setting default.
  enforceIssueDependencies?: unknown;
  // CPHMTP-TC-073 (#575): optional list of third-party marketplace URLs written
  // into the fixture roubo.yaml `marketplaces:` block, so the declared-source
  // registration-offer flow has a declared-but-unregistered source to act on.
  declaredMarketplaces?: unknown;
  // CPHMTP-TC-073 (#575): optional binding of an arbitrary named component to an
  // arbitrary (possibly UNINSTALLED) plugin id, e.g. `apps-script` -> `google-clasp`.
  // Distinct from `componentPlugin` (which always binds a `deploy` component to a
  // real, installed component plugin): this drives the missing-plugin bench-start
  // resolution for a plugin served only by a declared marketplace.
  componentBinding?: unknown;
}

interface SeedBenchInput {
  assignedIssue: AssignedIssue;
}

// TSPF-TC-010 (#486): the results-seed variants a fixture spec can request so a
// discovered spec lands in a KNOWN verification classification. `writeSeededSpecs`
// today writes only a test-cases.json, so every seeded spec is needs-attention
// (no results sidecar). The partitioned-picker journey needs both partitions
// populated, so this synthesizes a schema-valid, PLAN-HASH-MATCHING
// test-results.json from the seeded plan:
//   - "all-passed": every plan case effectively passed => the server classifies
//     the spec all-passed (it lands behind the picker's collapsed disclosure).
//   - "partial": all but the last case passed (at least one passed, at least one
//     not) => needs-attention with a real "P of M passed" per-row summary.
type SeedResultsMode = "all-passed" | "partial";
const SEED_RESULTS_MODES: readonly SeedResultsMode[] = ["all-passed", "partial"];

interface SeedSpecInput {
  slug: string;
  testCases: unknown;
  // TSPF-TC-010 (#486): optional results-seed. When set, the route synthesizes a
  // hash-matching test-results.json alongside test-cases.json so the spec lands in
  // the requested classification. Omitted => no sidecar (needs-attention, "no
  // results yet"), preserving the prior seedSpecs behaviour.
  seedResults?: SeedResultsMode;
}

interface ParsedRegisterFixture {
  projectId: string;
  // Omitted when the spec wants the fixture project registered with no
  // integration override, so `useProjectIntegration` returns `plugin: null`
  // and the IssueSourceTile renders its UnconfiguredBody variant (TC-164).
  plugin: string | null;
  integrationConfig?: IntegrationConfig;
  projectRepo?: string;
  portBase?: number;
  seedBenches: SeedBenchInput[];
  seedSpecs: SeedSpecInput[];
  gitInit: boolean;
  // CP-TC-028 (#626): id of the component plugin bound to a `deploy` component,
  // or null when the fixture project keeps only the default `app` component.
  componentPlugin: string | null;
  // TC-032 (#708): when true, the fixture roubo.yaml sets
  // `benches.enforceIssueDependencies: true`, turning the host start-gate ON.
  enforceIssueDependencies: boolean;
  // CPHMTP-TC-073 (#575): declared third-party marketplace URLs for the
  // `marketplaces:` block (empty when the fixture declares none).
  declaredMarketplaces: string[];
  // CPHMTP-TC-073 (#575): an extra component bound to an arbitrary plugin id, or
  // null when the fixture project keeps only the default `app` component.
  componentBinding: { name: string; pluginId: string } | null;
}

// TC-001 (#438): slug component of a `.specifications/<slug>/` feature folder.
// Kebab-case starting with a letter, matching the spec-slug allowlist the
// discovery + containment barriers enforce server-side.
const SPEC_SLUG_RE = /^[a-z][a-z0-9-]*$/;

function parseSeedSpecs(raw: unknown): SeedSpecInput[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "seedSpecs must be an array";
  const parsed: SeedSpecInput[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `seedSpecs[${i}] must be an object`;
    }
    const slug = (entry as { slug?: unknown }).slug;
    if (typeof slug !== "string" || !SPEC_SLUG_RE.test(slug)) {
      return `seedSpecs[${i}].slug must be a kebab-case string matching /^[a-z][a-z0-9-]*$/`;
    }
    const testCases = (entry as { testCases?: unknown }).testCases;
    if (testCases === undefined) {
      return `seedSpecs[${i}].testCases is required`;
    }
    // TSPF-TC-010 (#486): validate the optional results-seed. A sidecar can only
    // be synthesized from a schema-valid plan (its planHash must match what
    // discovery recomputes from test-cases.json), so when seedResults is set the
    // testCases must already parse as a valid plan; reject with a 400 here rather
    // than throwing mid-write.
    const seedResultsRaw = (entry as { seedResults?: unknown }).seedResults;
    let seedResults: SeedResultsMode | undefined;
    if (seedResultsRaw !== undefined) {
      if (
        typeof seedResultsRaw !== "string" ||
        !SEED_RESULTS_MODES.includes(seedResultsRaw as SeedResultsMode)
      ) {
        return `seedSpecs[${i}].seedResults must be one of ${SEED_RESULTS_MODES.join(", ")} when provided`;
      }
      const validation = validateTestCases(testCases);
      if (!validation.ok) {
        return `seedSpecs[${i}].testCases must be a valid test-cases plan when seedResults is set: ${validation.errors.join("; ")}`;
      }
      seedResults = seedResultsRaw as SeedResultsMode;
    }
    parsed.push({ slug, testCases, seedResults });
  }
  return parsed;
}

// TSPF-TC-010 (#486): synthesize a schema-valid test-results.json from a seeded
// plan so a fixture spec lands in the requested classification. The planHash is
// computed with computePlanHash (the same hash discovery recomputes), so the
// sidecar is hash-matching and never stale. Every case is left with an empty
// observationMarks map and a directly-set derivedStatus, which is the effective
// status discovery aggregates (statusOverride ?? derivedStatus ?? not_started).
function synthesizeSeededResults(plan: TestCasesPlan, mode: SeedResultsMode): TestResultsFile {
  const caseResults: Record<string, CaseResult> = {};
  plan.cases.forEach((planCase, index) => {
    // all-passed: every case passed. partial: all but the last case passed, so
    // the spec keeps at least one passed and at least one not-passed case (stays
    // needs-attention with a genuine "P of M passed" summary).
    const passed = mode === "all-passed" || index < plan.cases.length - 1;
    const derivedStatus: CaseStatus = passed ? "passed" : "not_started";
    caseResults[planCase.id] = { observationMarks: {}, derivedStatus, notes: [] };
  });
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash: computePlanHash(plan),
    caseResults,
    updatedAt: new Date().toISOString(),
  };
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
  // TC-164: `plugin` is optional so a spec can register a fixture project with
  // no integration override and exercise the IssueSourceTile UnconfiguredBody
  // path. When present it still must be a non-empty string.
  let plugin: string | null = null;
  if (pluginRaw !== undefined) {
    if (typeof pluginRaw !== "string" || pluginRaw.length === 0) {
      return "plugin must be a non-empty string when provided";
    }
    plugin = pluginRaw;
  }
  let integrationConfig: IntegrationConfig | undefined;
  if (body?.integrationConfig !== undefined) {
    if (plugin === null) {
      return "integrationConfig requires `plugin` to be provided";
    }
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
  let projectRepo: string | undefined;
  if (body?.projectRepo !== undefined) {
    if (typeof body.projectRepo !== "string" || body.projectRepo.length === 0) {
      return "projectRepo must be a non-empty string when provided";
    }
    projectRepo = body.projectRepo;
  }
  let portBase: number | undefined;
  if (body?.portBase !== undefined) {
    if (
      typeof body.portBase !== "number" ||
      !Number.isInteger(body.portBase) ||
      body.portBase <= 0
    ) {
      return "portBase must be a positive integer when provided";
    }
    portBase = body.portBase;
  }
  const seedBenches = parseSeedBenches(body?.seedBenches);
  if (typeof seedBenches === "string") return seedBenches;
  const seedSpecs = parseSeedSpecs(body?.seedSpecs);
  if (typeof seedSpecs === "string") return seedSpecs;
  let gitInit = false;
  if (body?.gitInit !== undefined) {
    if (typeof body.gitInit !== "boolean") return "gitInit must be a boolean when provided";
    gitInit = body.gitInit;
  }
  let componentPlugin: string | null = null;
  if (body?.componentPlugin !== undefined) {
    if (
      typeof body.componentPlugin !== "string" ||
      !FIXTURE_PROJECT_ID_RE.test(body.componentPlugin)
    ) {
      return "componentPlugin must be a kebab-case string matching /^[a-z][a-z0-9-]*$/ when provided";
    }
    componentPlugin = body.componentPlugin;
  }
  let enforceIssueDependencies = false;
  if (body?.enforceIssueDependencies !== undefined) {
    if (typeof body.enforceIssueDependencies !== "boolean") {
      return "enforceIssueDependencies must be a boolean when provided";
    }
    enforceIssueDependencies = body.enforceIssueDependencies;
  }
  // CPHMTP-TC-073 (#575): declared marketplace URLs. Each must be a non-empty
  // http(s) string; the strict RouboConfig parse re-validates the shape at load,
  // but rejecting an obviously bad value here keeps the 400 close to the caller.
  let declaredMarketplaces: string[] = [];
  if (body?.declaredMarketplaces !== undefined) {
    if (!Array.isArray(body.declaredMarketplaces)) {
      return "declaredMarketplaces must be an array of URL strings when provided";
    }
    for (const url of body.declaredMarketplaces) {
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        return "each declaredMarketplaces entry must be an http(s) URL string";
      }
    }
    declaredMarketplaces = body.declaredMarketplaces as string[];
  }
  // CPHMTP-TC-073 (#575): an extra component bound to an arbitrary plugin id.
  let componentBinding: { name: string; pluginId: string } | null = null;
  if (body?.componentBinding !== undefined) {
    const cb = body.componentBinding;
    if (cb === null || typeof cb !== "object" || Array.isArray(cb)) {
      return "componentBinding must be an object { name, pluginId } when provided";
    }
    const { name, pluginId } = cb as { name?: unknown; pluginId?: unknown };
    if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) {
      return "componentBinding.name must be a kebab-case string matching /^[a-z][a-z0-9-]*$/";
    }
    if (typeof pluginId !== "string" || !FIXTURE_PROJECT_ID_RE.test(pluginId)) {
      return "componentBinding.pluginId must be a kebab-case string matching /^[a-z][a-z0-9-]*$/";
    }
    componentBinding = { name, pluginId };
  }
  return {
    projectId: projectIdRaw,
    plugin,
    integrationConfig,
    projectRepo,
    portBase,
    seedBenches,
    seedSpecs,
    gitInit,
    componentPlugin,
    enforceIssueDependencies,
    declaredMarketplaces,
    componentBinding,
  };
}

// TC-001 (#438): write each seeded spec's test-cases.json into
// `<repoPath>/.specifications/<slug>/test-cases.json`. The slug was already
// validated against SPEC_SLUG_RE in parseSeedSpecs, so the join stays inside the
// repo's `.specifications` tree.
//
// TSPF-TC-010 (#486): when a spec carries `seedResults`, also emit a
// hash-matching test-results.json sidecar (via the shared writeResults primitive)
// synthesized from the seeded plan, so the spec lands in a known classification
// (all-passed / needs-attention-partial) for the partitioned-picker journey.
function writeSeededSpecs(repoPath: string, specs: SeedSpecInput[]): void {
  for (const spec of specs) {
    const specDir = path.join(repoPath, ".specifications", spec.slug);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(specDir, "test-cases.json"),
      `${JSON.stringify(spec.testCases, null, 2)}\n`,
      "utf-8",
    );
    if (spec.seedResults !== undefined) {
      // parseSeedSpecs already validated the plan when seedResults is set, so this
      // re-parse always succeeds; the guard keeps the plan-typed path honest.
      const validation = validateTestCases(spec.testCases);
      if (!validation.ok) {
        throw new Error(
          `seedResults requires a valid test-cases plan for "${spec.slug}": ${validation.errors.join("; ")}`,
        );
      }
      const results = synthesizeSeededResults(validation.data, spec.seedResults);
      writeResults(repoPath, spec.slug, `${JSON.stringify(results, null, 2)}\n`);
    }
  }
}

// TC-001 (#438): turn the throwaway fixture repo into a real git repository with
// one commit so `git worktree add` succeeds during TestBench provisioning. Uses
// a local identity + no GPG signing so it runs in a bare CI environment with no
// global git config. All work is local: no remote is added, which is why the
// caller also pins worktreeSource away from fetch/fast-forward.
function gitInitFixtureRepo(repoPath: string): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  run(["init", "--initial-branch=main"]);
  run(["config", "user.email", "e2e@roubo.test"]);
  run(["config", "user.name", "Roubo E2E"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["add", "-A"]);
  run(["commit", "--no-gpg-sign", "-m", "chore: seed e2e fixture repo"]);
}

router.post("/__register-fixture-project", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }

  const parsed = parseRegisterFixtureBody(req.body as RegisterFixtureBody | undefined);
  if (typeof parsed === "string") {
    return res.status(400).json({ error: parsed });
  }
  const {
    projectId,
    plugin,
    integrationConfig,
    projectRepo,
    portBase,
    seedBenches,
    seedSpecs,
    gitInit,
    componentPlugin,
    enforceIssueDependencies,
    declaredMarketplaces,
    componentBinding,
  } = parsed;

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
    writeFixtureRouboYaml(
      repoPath,
      projectId,
      projectRepo,
      portBase,
      componentPlugin,
      enforceIssueDependencies,
      declaredMarketplaces,
      componentBinding,
    );
    // TC-001 (#438): seed `.specifications/<slug>/test-cases.json` files BEFORE
    // git init so they ride into the initial commit, making them visible both
    // to spec discovery (which reads the repo root) and to the provisioned
    // worktree.
    if (seedSpecs.length > 0) {
      writeSeededSpecs(repoPath, seedSpecs);
    }
    if (gitInit) {
      gitInitFixtureRepo(repoPath);
    }
    const registered = projectRegistry.registerProject(repoPath);
    // TC-001 (#438): when the repo was git-initialised for a real worktree,
    // pin the worktree source to the local HEAD so provisioning does not try to
    // fetch/fast-forward from an `origin` remote the throwaway repo lacks.
    if (gitInit) {
      projectRegistry.updateProjectSettings(registered.id, {
        ...DEFAULT_PROJECT_SETTINGS,
        worktreeSource: { branchFromDefault: false, pullLatest: false },
      });
    }
    // TC-164: when `plugin` is omitted we skip writing an override so the
    // tile renders the UnconfiguredBody variant; the spec then drives the
    // SwitchIntegrationDialog UI to pin a plugin.
    if (plugin !== null) {
      saveOverride(projectId, {
        schemaVersion: 1,
        integration: { ...(integrationConfig ?? {}), plugin },
      });
    }
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
      // create from this route: either way, nothing to do here.
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

// TC-163 (#240): SIGKILL the live child of `pluginId` so the supervisor sees
// an unexpected exit and runs the real auto-restart / restart-budget path in
// plugin-manager. The Playwright spec calls this three times across the 5-min
// window to drive the plugin into `errored` deterministically. Production
// builds 404 the URL via the ROUBO_E2E gate; the handler itself also asserts
// the env var before SIGKILLing. Body: { pluginId: string }.
router.post("/__crash-plugin", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as { pluginId?: unknown };
  if (typeof body.pluginId !== "string" || !FIXTURE_PROJECT_ID_RE.test(body.pluginId)) {
    return res
      .status(400)
      .json({ error: "pluginId must be a kebab-case string matching /^[a-z][a-z0-9-]*$/" });
  }
  try {
    const { pid } = pluginManager.__test.crashRunningPlugin(body.pluginId);
    res.status(200).json({ ok: true, pid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "Unknown plugin" / "not running" both fall in here; 409 mirrors the
    // "no live process to crash" semantics rather than 500-ing on user error.
    res.status(409).json({ error: message });
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

// TC-043 (#440): resolve the on-disk `.specifications/<slug>/` directory for a
// provisioned TestBench, mirroring how the live TestBench routes (testbench.ts)
// resolve it. As of #493 the bench's focused spec (its plan + results sidecar) is
// read and written under the bench's OWN WORKTREE (`bench.workspacePath`), not
// the registered project repoPath. The slug is still resolved against the project
// repoPath, where `focusedSpecPath` was picked and validated, exactly as the live
// route does. Resolving the same way keeps the e2e harness faithful to the real
// read/write path. Returns the worktree root + slug, or an error string the
// caller maps to an HTTP status.
function resolveBenchSpecDir(
  projectId: string,
  benchId: number,
): { rootPath: string; slug: string } | { status: number; error: string } {
  const project = projectRegistry.getProject(projectId);
  if (!project || !project.config) {
    return { status: 404, error: `Project '${projectId}' not found` };
  }
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) {
    return { status: 404, error: "Bench not found" };
  }
  if (bench.variant !== "testbench" || bench.focusedSpecPath === undefined) {
    return { status: 400, error: "Bench is not a testbench or has no focused spec" };
  }
  // An error-state bench with a blank workspacePath must fail cleanly rather than
  // resolve to a bogus root, matching the live route's 400 (#493).
  const rootPath = bench.workspacePath;
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    return { status: 400, error: "Bench has no workspace path" };
  }
  let slug: string;
  try {
    slug = resolveFocusedSpec(project.repoPath, bench.focusedSpecPath).slug;
  } catch (err) {
    return { status: 400, error: `Invalid focusedSpecPath: ${(err as Error).message}` };
  }
  return { rootPath, slug };
}

// Parse + validate the { projectId, benchId } pair shared by the two TestBench
// harness endpoints below.
function parseBenchTarget(body: {
  projectId?: unknown;
  benchId?: unknown;
}): { projectId: string; benchId: number } | string {
  const { projectId, benchId } = body;
  if (typeof projectId !== "string" || !FIXTURE_PROJECT_ID_RE.test(projectId)) {
    return "projectId must be a kebab-case string matching /^[a-z][a-z0-9-]*$/";
  }
  if (typeof benchId !== "number" || !Number.isInteger(benchId) || benchId < 1) {
    return "benchId must be a positive integer";
  }
  return { projectId, benchId };
}

// POST /test/__rewrite-spec-cases (#440): overwrite the focused spec's
// test-cases.json for a provisioned TestBench, so the persist -> staleness ->
// reconcile e2e spec can drive a mid-test PLAN edit (remove a case, add a case)
// the create-a-TestBench UI does not expose. The path is resolved from the
// bench's worktree (see resolveBenchSpecDir), and the slug is re-validated
// through the same containment barrier the live routes use, so the write stays
// inside `<workspacePath>/.specifications/<slug>/` (#493). Gated by ROUBO_E2E;
// production builds 404 the URL.
//
// Body: { projectId: string, benchId: number, testCases: object }.
router.post("/__rewrite-spec-cases", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as { projectId?: unknown; benchId?: unknown; testCases?: unknown };
  const target = parseBenchTarget(body);
  if (typeof target === "string") {
    return res.status(400).json({ error: target });
  }
  if (
    body.testCases === null ||
    typeof body.testCases !== "object" ||
    Array.isArray(body.testCases)
  ) {
    return res.status(400).json({ error: "testCases must be an object" });
  }
  const resolved = resolveBenchSpecDir(target.projectId, target.benchId);
  if ("error" in resolved) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  try {
    // The slug came back through resolveFocusedSpec's SPEC_SLUG_RE barrier, so
    // the join stays inside the worktree's `.specifications` tree (matching
    // writeSeededSpecs above). Writing here (not repoPath) is what makes the
    // bench's next plan load observe the staleness edit (#493).
    const casesPath = path.join(
      resolved.rootPath,
      ".specifications",
      resolved.slug,
      "test-cases.json",
    );
    fs.writeFileSync(casesPath, `${JSON.stringify(body.testCases, null, 2)}\n`, "utf-8");
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__rewrite-spec-cases failed:", message);
    res.status(500).json({ error: message });
  }
});

// GET /test/__read-spec-results (#440): read the focused spec's
// test-results.json sidecar for a provisioned TestBench so the e2e spec can
// assert the on-disk integrity invariant (NFR-003): the flattened results retain
// the archived (orphaned) case after reconcile. Returns the parsed sidecar plus
// the source test-cases.json sha256 so the spec can prove the source plan's
// checksum is unchanged by reconcile (reconcile only ever writes results).
// Resolves the same way as the rewrite endpoint (rooted at the worktree, #493).
// Gated by ROUBO_E2E.
//
// Query: ?projectId=<id>&benchId=<n>.
router.get("/__read-spec-results", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const benchIdRaw = req.query.benchId;
  const target = parseBenchTarget({
    projectId: req.query.projectId,
    benchId: typeof benchIdRaw === "string" ? Number(benchIdRaw) : benchIdRaw,
  });
  if (typeof target === "string") {
    return res.status(400).json({ error: target });
  }
  const resolved = resolveBenchSpecDir(target.projectId, target.benchId);
  if ("error" in resolved) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  try {
    const specDir = path.join(resolved.rootPath, ".specifications", resolved.slug);
    const resultsPath = path.join(specDir, "test-results.json");
    const casesPath = path.join(specDir, "test-cases.json");
    let results: unknown = null;
    try {
      results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
    } catch {
      // No results sidecar yet (or unreadable): report null rather than 500.
      results = null;
    }
    const casesChecksum = createHash("sha256")
      .update(fs.readFileSync(casesPath, "utf-8"), "utf-8")
      .digest("hex");
    res.status(200).json({ results, casesChecksum });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__read-spec-results failed:", message);
    res.status(500).json({ error: message });
  }
});

// POST /test/__seed-spec-results (#487, TSPF-TC-011): seed a plan-hash-matching
// test-results.json sidecar for a discovered spec in a fixture project's repo, so
// the spec picker's server-side classification (verification.classification in
// GET /:projectId/testbench/specs) sorts that spec into the "all-passed" group.
// discoverSpecs reads the registered project repoPath, so the sidecar is written
// there (NOT a bench worktree). This is the only harness seam that makes a seeded
// spec classify all-passed: registerFixtureProject's seedSpecs writes the plan
// (test-cases.json) only. The partitioned-picker drift guards (#487 re-point, and
// its #486 create-flow sibling) both consume it.
//
// The sidecar is produced with the REAL store writer (setStatusOverride), so it
// carries the correct planHash (computePlanHash of the on-disk plan, applied
// inside the writer) and a contract-valid body: no hand-built JSON that could
// drift from the schema. Each targeted case is stamped with a "passed" status
// override. Omitting passCaseIds targets every plan case (a fully all-passed
// spec); passing a subset yields a needs-attention spec with a "P of M passed"
// summary, so one seam covers both partition groups. Gated by ROUBO_E2E;
// production builds 404 the URL.
//
// Body: { projectId: string, slug: string, passCaseIds?: string[] }.
router.post("/__seed-spec-results", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as {
    projectId?: unknown;
    slug?: unknown;
    passCaseIds?: unknown;
  };
  if (typeof body.projectId !== "string" || !FIXTURE_PROJECT_ID_RE.test(body.projectId)) {
    return res
      .status(400)
      .json({ error: "projectId must be a kebab-case string matching /^[a-z][a-z0-9-]*$/" });
  }
  if (typeof body.slug !== "string" || !SPEC_SLUG_RE.test(body.slug)) {
    return res
      .status(400)
      .json({ error: "slug must be a kebab-case string matching /^[a-z][a-z0-9-]*$/" });
  }
  let passCaseIds: string[] | undefined;
  if (body.passCaseIds !== undefined) {
    if (
      !Array.isArray(body.passCaseIds) ||
      !body.passCaseIds.every((id): id is string => typeof id === "string" && id.length > 0)
    ) {
      return res.status(400).json({ error: "passCaseIds must be an array of non-empty strings" });
    }
    passCaseIds = body.passCaseIds;
  }
  const project = projectRegistry.getProject(body.projectId);
  if (!project || !project.config) {
    return res.status(404).json({ error: `Project '${body.projectId}' not found` });
  }
  try {
    // Read the on-disk plan so the targeted case ids are validated against it and
    // the sidecar's planHash matches the hash discovery recomputes (the writer
    // stamps computePlanHash(plan) on every mutation).
    const { plan, planHash } = readPlanAndResults(project.repoPath, body.slug);
    const planCaseIds = new Set(plan.cases.map((c) => c.id));
    const targets = passCaseIds ?? plan.cases.map((c) => c.id);
    for (const caseId of targets) {
      if (!planCaseIds.has(caseId)) {
        return res.status(400).json({ error: `case id '${caseId}' is not in spec '${body.slug}'` });
      }
    }
    // Sequential (not parallel): each write load-or-inits from the prior file, so
    // concurrent writes would clobber one another. An effective "passed" status on
    // every plan case makes discovery classify the spec all-passed.
    for (const caseId of targets) {
      await setStatusOverride(project.repoPath, body.slug, caseId, "passed");
    }
    res.status(200).json({ ok: true, slug: body.slug, planHash, passedCaseIds: targets });
  } catch (err) {
    if (err instanceof MissingPlanError) {
      return res.status(400).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__seed-spec-results failed:", message);
    res.status(500).json({ error: message });
  }
});

// GET /test/__read-cut-list-cache-file (#567): read the persisted cut-list
// first-page snapshot file for a project so the warm-restart drift guard
// (CLI-TC-001) can assert its on-disk S003 invariants directly against disk: the
// file mode is exactly 0600 (CLI-NFR-001), and the parsed JSON content carries
// no credential or token fields. Modelled on /test/__read-spec-results: same
// ROUBO_E2E gate, same per-spec wipe/reset hygiene (the snapshot dir lives under
// `<rouboDir>/issue-snapshots/` and is wiped by wipePersistedTestState on every
// /__reset, so no snapshot leaks between specs). DiskSnapshotStore names each
// entry `<rouboDir>/issue-snapshots/<projectId>/<hash>.json`; the e2e flow primes
// exactly one snapshot, so this returns that single entry file.
//
// Query: ?projectId=<id>. Returns { path, mode, content }: `mode` is the file's
// permission bits (masked to 0o777, so the spec can compare against 0o600), and
// `content` is the parsed JSON envelope.
router.get("/__read-cut-list-cache-file", (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const projectId = req.query.projectId;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    return res
      .status(400)
      .json({ error: "projectId must be a kebab-case string matching the project-id allowlist" });
  }
  try {
    // Re-derive the project's snapshot directory through the resolveWithin
    // containment barrier (matching DiskSnapshotStore), so the projectId from the
    // HTTP boundary reaches the fs sinks already laundered (code-scanning
    // js/path-injection sanitizer).
    const snapshotsRoot = path.join(state.getRouboDir(), "issue-snapshots");
    const projectDir = resolveWithin(snapshotsRoot, projectId);
    let files: string[];
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    if (files.length === 0) {
      return res
        .status(404)
        .json({ error: `No cut-list snapshot found for project '${projectId}'` });
    }
    // The e2e flow primes exactly one snapshot; pick the single entry file.
    const filePath = resolveWithin(projectDir, files[0]);
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    res.status(200).json({ path: filePath, mode, content });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__read-cut-list-cache-file failed:", message);
    res.status(500).json({ error: message });
  }
});

export default router;
