import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import * as tar from "tar";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_PLUGIN_IDS, DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import { computePackageDigest } from "../services/marketplace-integrity.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import { resolveFocusedSpec } from "../lib/testbench-spec-discovery.js";
import { computePlanHash } from "../lib/testbench-store.js";
import { writeResults } from "../lib/testbench-results-write.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";
import * as state from "../services/state.js";
import { ONLY_TO_DO_NOTICE_MARKER } from "@roubo/shared";
import * as pluginEnableState from "../services/plugin-enable-state.js";
import { removeOverride, saveOverride } from "../services/integration-overrides.js";
import { cutListQueryService } from "../services/cut-list-query-service.js";
import * as catalogClient from "../services/catalog-client.js";
import { PROJECT_ID_RE, resolveWithin } from "../lib/safe-path.js";
import { IntegrationConfigSchema, type AssignedIssue, type IntegrationConfig } from "@roubo/shared";
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
      command: "true"${deployComponent}
ports:
  app:
    base: ${portBase}
benches:
  max: 5${enforceIssueDependencies ? "\n  enforceIssueDependencies: true" : ""}
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
    // #313 (CPHM-TC-041): drop any throwaway fresh-launch seed sandbox left by
    // the fresh-launch-seed-journey drift guard so its tmp user root + seed
    // bundle never leak into a later spec (NFR-018). No-op when no sandbox exists.
    cleanupFreshLaunchState();
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

// #313 (CPHM-TC-041): the fresh-launch first-run seed drift guard drives a
// GENUINE offline seed pass (plugin-manager.seedFromBundled) rather than the
// bundled-overlay stand-in the rest of the e2e harness models seeded plugins as
// (ensureBundledPluginsEnabled). The harness wires github-com as a bundled
// overlay and does not carry process/database at all, so asserting "exactly the
// three defaults seeded into the user root (source 'user'), ghe/jira un-seeded,
// idempotent relaunch" needs the real seed service exercised end-to-end.
//
// The seam isolates the seed into throwaway tmp dirs: a tmp user root and a tmp
// seed bundle synthesised here (three host-compatible stub artifacts + a seed
// catalog.json, mirroring `makeSeedBundle` in plugin-manager.test.ts). It
// temporarily points ROUBO_USER_PLUGINS_DIR / ROUBO_SEED_DIR at those tmp dirs
// around the `seedFromBundled()` call and restores them in a finally, so the
// live plugin-manager and any later spec are untouched (NFR-018). Deliberately
// NOT wired via playwright.config's ROUBO_SEED_DIR: a global seed dir would make
// the server's boot seed install into the committed e2e/fixtures user-plugins
// dir, polluting it and colliding with the harness's stub-plugin discovery.
interface FreshLaunchState {
  userRoot: string;
  seedDir: string;
}
let freshLaunchState: FreshLaunchState | null = null;

const SEED_FIXTURE_VERSION = "1.0.0";

// Synthesise a host-compatible seed manifest (mirrors `seedIntegrationManifest`
// / `seedComponentManifest` in plugin-manager.test.ts). `roubo: ^1.3.0` matches
// pluginManager.HOST_API_VERSION so installSeedArtifact's assertCompatible
// passes; the stub never spawns (the seed lands in a tmp root the live manager
// never discovers), so the artifact body is a placeholder.
function seedFixtureManifest(id: string, kind: "integration" | "component"): string {
  const lines = [
    `id: ${id}`,
    `name: ${id} seed fixture`,
    `version: ${SEED_FIXTURE_VERSION}`,
    `description: Seed ${kind} fixture`,
    `kind: ${kind}`,
    "roubo: ^1.3.0",
    "entry: ./dist/index.js",
  ];
  if (kind === "component") {
    lines.push("contractVersion: 1");
  }
  lines.push(
    "permissions:",
    "  network:",
    "    hosts: []",
    "  credentials:",
    "    slots: []",
    "  filesystem:",
    "    paths: []",
    "  processes: false",
  );
  if (kind === "component") {
    lines.push("  ports:", "    names:", "      - http", "  docker: false");
  }
  lines.push("");
  return lines.join("\n");
}

// Build a throwaway seed bundle on disk under `seedDir`: one gzip tarball per
// seed plugin plus a catalog.json pinning each unpacked-artifact digest. The
// digest is computed over the same source tree that is packed, so it equals the
// digest installSeedArtifact recomputes over the unpacked staging tree, and the
// fail-closed integrity check (CPHM-NFR-001) passes for an untampered artifact.
async function buildFreshLaunchSeedBundle(seedDir: string): Promise<void> {
  const specs: Array<{ id: string; kind: "integration" | "component" }> = [
    { id: "github-com", kind: "integration" },
    { id: "process", kind: "component" },
    { id: "database", kind: "component" },
  ];
  const entries: Array<{ id: string; version: string; integrity: string }> = [];
  for (const spec of specs) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-e2e-seed-src-"));
    try {
      fs.writeFileSync(
        path.join(src, "roubo-plugin.yaml"),
        seedFixtureManifest(spec.id, spec.kind),
        "utf-8",
      );
      fs.mkdirSync(path.join(src, "dist"), { recursive: true });
      fs.writeFileSync(path.join(src, "dist", "index.js"), "module.exports = {};\n", "utf-8");
      const tgz = path.join(seedDir, `${spec.id}-${SEED_FIXTURE_VERSION}.tgz`);
      await tar.c({ gzip: true, file: tgz, cwd: src }, ["roubo-plugin.yaml", "dist"]);
      const integrity = await computePackageDigest(src);
      entries.push({ id: spec.id, version: SEED_FIXTURE_VERSION, integrity });
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(
    path.join(seedDir, "catalog.json"),
    JSON.stringify({
      payload: { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", entries },
    }),
    "utf-8",
  );
}

interface SeedPluginSnapshot {
  // The directory name under the user root (the installed plugin id).
  id: string;
  // The `id:` declared by the installed roubo-plugin.yaml, proving a real,
  // host-compatible manifest landed on disk (the "usable offline" proof for
  // S004: discovery + spawn pick this up unchanged, CPHM-NFR-005).
  manifestId: string | null;
  // Whether the installed artifact's entry script is present on disk.
  hasEntry: boolean;
}

// Read the `id:` an installed plugin's roubo-plugin.yaml declares, or null when
// the manifest is missing or carries no id line.
function readSeedManifestId(pluginDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(pluginDir, "roubo-plugin.yaml"), "utf-8");
    const match = /^id:\s*(\S+)/m.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Snapshot the seeded user root: one entry per installed plugin directory, with
// the manifest id it declares and whether its entry script is present. Sorted by
// id for a stable assertion order.
function readSeededRoot(userRoot: string): SeedPluginSnapshot[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(userRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SeedPluginSnapshot[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    const dir = path.join(userRoot, dirent.name);
    out.push({
      id: dirent.name,
      manifestId: readSeedManifestId(dir),
      hasEntry: fs.existsSync(path.join(dir, "dist", "index.js")),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

interface SeedMarkerSnapshot {
  present: boolean;
  seedVersion: number | null;
  seededIds: string[];
  seededAt: string | null;
}

// Read + parse the idempotency marker (.seed-version.json) the seed pass writes
// into the user root. `present: false` (with empty fields) when no marker exists.
function readSeedMarker(markerPath: string): SeedMarkerSnapshot {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
      seedVersion?: unknown;
      seededIds?: unknown;
      seededAt?: unknown;
    };
    return {
      present: true,
      seedVersion: typeof parsed.seedVersion === "number" ? parsed.seedVersion : null,
      seededIds: Array.isArray(parsed.seededIds)
        ? parsed.seededIds.filter((x): x is string => typeof x === "string")
        : [],
      seededAt: typeof parsed.seededAt === "string" ? parsed.seededAt : null,
    };
  } catch {
    return { present: false, seedVersion: null, seededIds: [], seededAt: null };
  }
}

function restoreEnvVar(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    // Reflect.deleteProperty (not the `delete` operator on a computed key) to
    // satisfy @typescript-eslint/no-dynamic-delete.
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = prev;
  }
}

function cleanupFreshLaunchState(): void {
  if (!freshLaunchState) return;
  for (const dir of [freshLaunchState.userRoot, freshLaunchState.seedDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: tolerate a missing dir or a transient unlink failure.
    }
  }
  freshLaunchState = null;
}

// POST /test/__seed-fresh-launch (#313, CPHM-TC-041): drive a genuine offline
// first-run seed of the default plugins and report the result, so the
// fresh-launch-seed-journey drift guard can assert the integrated seed run
// matches the authoritative case. Gated by ROUBO_E2E; production builds 404 the
// URL.
//
// Body: { relaunch?: boolean }. `relaunch: false` (the default) is a fresh first
// launch: a new clean tmp user root + a freshly synthesised tmp seed bundle, then
// `seedFromBundled()`. `relaunch: true` reuses the same sandbox from the prior
// fresh launch and runs `seedFromBundled()` again to prove the marker makes the
// second launch a no-op (idempotent). Returns the seed set, whether this pass
// actually seeded (`seededNow`: true on the genuine first run, false on an
// idempotent relaunch), the installed-plugin snapshot, and the idempotency
// marker.
router.post("/__seed-fresh-launch", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  const body = (req.body ?? {}) as { relaunch?: unknown };
  let relaunch = false;
  if (body.relaunch !== undefined) {
    if (typeof body.relaunch !== "boolean") {
      return res.status(400).json({ error: "relaunch must be a boolean" });
    }
    relaunch = body.relaunch;
  }
  if (relaunch && !freshLaunchState) {
    return res
      .status(409)
      .json({ error: "no prior fresh launch to relaunch; call with relaunch:false first" });
  }

  const prevUserDir = process.env.ROUBO_USER_PLUGINS_DIR;
  const prevSeedDir = process.env.ROUBO_SEED_DIR;
  try {
    let sandbox: FreshLaunchState;
    if (relaunch) {
      sandbox = freshLaunchState as FreshLaunchState;
    } else {
      // Drop any prior sandbox so each first launch starts from a truly clean
      // machine (no marker, no installed plugins).
      cleanupFreshLaunchState();
      const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-e2e-fresh-user-"));
      const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-e2e-fresh-seed-"));
      await buildFreshLaunchSeedBundle(seedDir);
      sandbox = { userRoot, seedDir };
      freshLaunchState = sandbox;
    }

    process.env.ROUBO_USER_PLUGINS_DIR = sandbox.userRoot;
    process.env.ROUBO_SEED_DIR = sandbox.seedDir;

    // Whether the idempotency marker already existed BEFORE this pass: false on a
    // genuine first launch (the seed installs), true on a relaunch (the seed
    // short-circuits). seedMarkerPath() reads the env override set just above.
    const markerPath = pluginManager.__test.seedMarkerPath();
    const markerExistedBefore = fs.existsSync(markerPath);

    await pluginManager.seedFromBundled();

    const installed = readSeededRoot(sandbox.userRoot);
    const marker = readSeedMarker(markerPath);

    res.status(200).json({
      seedSet: [...pluginManager.SEED_PLUGIN_IDS],
      seededNow: !markerExistedBefore,
      installed,
      marker,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__seed-fresh-launch failed:", message);
    res.status(500).json({ error: message });
  } finally {
    // Restore the env so the override never leaks into the live plugin-manager
    // or a later spec (NFR-018).
    restoreEnvVar("ROUBO_USER_PLUGINS_DIR", prevUserDir);
    restoreEnvVar("ROUBO_SEED_DIR", prevSeedDir);
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
