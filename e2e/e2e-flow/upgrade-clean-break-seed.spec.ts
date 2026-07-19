import { expect, test } from "@playwright/test";
import type { MarketplaceCatalogSource, MarketplaceListing, PluginRecord } from "@roubo/shared";
import {
  fetchPluginRecord,
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  setMarketplaceReachable,
} from "./_support/scenario.js";

// CPHM-TC-061 (CPHM-FR-008 / CPHM-NFR-005 / CPHM-US-001, issue #315): end-to-end
// drift guard for the clean-break upgrade journey. Prior bundled installs are
// dropped, the first-run seed provides the three defaults (github-com + the two
// component plugins) offline, an existing roubo.yaml binding process + database
// starts identically with no migration. ghe was extracted to the workplace
// third-party marketplace (davidpoxon/roubo-development#568), so it is no longer a
// first-party catalog entry; reinstalling it from a registered workplace source is
// owned by the third-party e2e suite, not this first-party drift guard.
//
// This is the integration-level drift guard for the journey: it walks the
// authoritative e2e_flow case .specifications/component-plugins-hosted-marketplace
// CPHM-TC-061 step for step (S001-S006). If that case changes, update this spec
// to match. It spans the two blocked-by slices below and asserts the integrated
// journey, not whatever any single slice implemented.
//
// Failure-output contract (issue #315 acceptance criterion 3): every assertion
// names the diverging step id, the expected-vs-actual, and the owning slice
// issue from this unit's blocked-by set (#309 / #310), so a red run localizes the
// drift to one attributable slice.
//
// HARNESS-MODEL RECONCILIATIONS (deliberate, mirroring the sibling
// marketplace-offline-journey.spec.ts). The built-app e2e harness cannot
// reproduce the LITERAL source-level clean-break/seed split, for three reasons
// rooted in how playwright.config.ts wires the server, so each step asserts the
// strongest observable invariant instead:
//   1. PluginSource is only "bundled" | "user" (shared/plugin-runtime-types.ts):
//      there is no "seeded" or "marketplace" source value to observe on
//      GET /api/plugins. So a seeded default is observed as its bundled-overlay
//      stand-in (source "bundled" + running), exactly as the offline-journey
//      spec treats github-com.
//   2. The harness sets ROUBO_BUNDLED_PLUGINS_DIR (-> e2e/fixtures/bundled-overlays)
//      so bundled discovery stays ON for the sibling project-settings specs.
//      Production's clean break (plugin-manager.bundledPluginsRoot() returns null,
//      CPHM-FR-008 / NFR-005) is therefore overridden here, so the physical
//      "drop bundled installs in place" is not observable. The post-debundle
//      invariant the harness CAN prove is that the defaults flow from the verified
//      marketplace catalog / seed, not a shipped bundled source tree.
//      ghe also ships as a bundled overlay here, so its installed state cannot show
//      "not seeded" directly; the spec asserts ghe is absent from the seed-default
//      set. Since #568 extracted ghe to the workplace third-party marketplace it is
//      no longer a first-party catalog entry, so its install-from-a-registered-source
//      is covered by the third-party e2e suite, not here.
//   3. No resources/seed bundle ships under ROUBO_SEED_DIR in the harness, so
//      seedFromBundled() is a no-op and the .seed-version.json marker is never
//      written, and there is no API that surfaces SEED_PLUGIN_IDS or the marker.
//      So S003 asserts the offline-seed floor (the catalog still serves with no
//      network) plus the seed-default-vs-marketplace-only split encoded as spec
//      constants grounded in SEED_PLUGIN_IDS, rather than reading a marker.
// The real per-artifact seed install, the clone/commit of a marketplace install,
// and github-com's full capability set are each their owning slice's concern
// (covered by their unit tests), so they are out of scope for this drift guard
// (issue #315 "Out of Scope"); this spec verifies the journey at the /api
// boundary.

const SCENARIO = "default";
const NOW = "2026-06-29T10:00:00.000Z";

// Owning slices from this unit's blocked-by set, surfaced in failure messages so
// a red step points at one slice (issue #315 acceptance criterion 3).
const SEED_SLICE =
  "davidpoxon/roubo-development#310 (plugin-manager first-run seed + clean-break upgrade)";
const PACKAGING_SLICE =
  "davidpoxon/roubo-development#309 (app-packaging seed bundle; remove BUNDLED_PLUGIN_IDS source-copy)";

// The first-run seed-default set (plugin-manager.SEED_PLUGIN_IDS): the github-com
// integration plus the two component plugins. Deliberately NOT the legacy
// integration-only BUNDLED_PLUGIN_IDS (github-com / ghe / jira-self-hosted), and
// the constant ghe is NOT a member is what makes S003-O02 ("ghe is not seeded")
// expressible against observable state.
const SEED_DEFAULT_IDS = ["github-com", "process", "database"] as const;

// The seed-default INTEGRATION, observed as its bundled-overlay stand-in
// (source "bundled" + running) per reconciliation #1.
const SEED_DEFAULT_INTEGRATION_ID = "github-com";

// The two seed-default COMPONENT plugins. They are catalog component entries the
// production seed would install; in this harness they are not pre-installed as
// overlays, so they are observed via the verified catalog and the fixture
// roubo.yaml bindings (S004) rather than as running records.
const SEED_DEFAULT_COMPONENT_IDS = ["process", "database"] as const;

// The extracted, non-seeded plugin: absent from SEED_DEFAULT_IDS and, since #568
// moved it to the workplace third-party marketplace, absent from the first-party
// catalog too. Its install-from-a-registered-source is owned by the third-party
// e2e suite (see the removed S005 note below).
const MARKETPLACE_ONLY_ID = "ghe";

// Fixture project for S004: its roubo.yaml binds the `app` component to `process`
// and a `deploy` component to `database` (writeFixtureRouboYaml + componentPlugin),
// modelling an existing config whose components bind process + database.
const FIXTURE_PROJECT_ID = "e2e-upgrade-seed";

interface CatalogResponse {
  curated?: boolean;
  listings?: MarketplaceListing[];
  source?: MarketplaceCatalogSource;
  fetchedAt?: string | null;
}

interface ConfigResponse {
  configValid?: boolean;
  config?: {
    components?: Record<string, { plugin?: { id?: string } }>;
  };
}

interface MigrationStatusResponse {
  schemaVersion?: number | null;
  migration?: { status?: string } | null;
  notices?: Record<string, string>;
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("CPHM-TC-061: clean-break upgrade drops bundled installs, seed provides the defaults offline, existing bindings start with no migration (ghe extracted to the workplace marketplace, #568)", async ({
  request,
  page,
}) => {
  // ---- S001: record the prior bundled plugin set and the existing roubo.yaml
  // bindings (the baseline). The seed-default integration github-com and the
  // marketplace-only integration ghe are both present and running in the prior
  // bundled build; both are the subjects the later steps track across the upgrade.
  const s001 = await request.get("/api/plugins");
  expect(
    s001.status(),
    `S001 diverged: expected GET /api/plugins to serve HTTP 200 for the prior-build ` +
      `baseline but got ${s001.status()}; owning slice ${SEED_SLICE}`,
  ).toBe(200);
  const baseline = await fetchPluginRecord(request, SEED_DEFAULT_INTEGRATION_ID);
  expectSeedDefaultRunning(baseline, "S001", SEED_SLICE);
  const ghBaseline = await fetchPluginRecord(request, MARKETPLACE_ONLY_ID);
  expect(
    ghBaseline?.status,
    `S001 diverged: expected the marketplace-only integration "${MARKETPLACE_ONLY_ID}" to be ` +
      `present and running in the prior bundled baseline but its record was ${JSON.stringify(
        ghBaseline,
      )}; owning slice ${PACKAGING_SLICE}`,
  ).toBe("enabled");

  // ---- S002: install and launch the de-bundled build for the first time.
  // Literal TC-061 expects the clean-break upgrade to drop the prior
  // bundled-discovered installs (none carried over in place). Per reconciliation
  // #2 the built-app harness forces bundled discovery on, so the physical drop is
  // not observable; the post-debundle invariant the harness proves is that the
  // de-bundled build serves its defaults from the verified, curated marketplace
  // catalog (the seed/catalog path), not a carried-over bundled source tree.
  await loadAppShell(page);
  const s002 = await request.get("/api/marketplace/plugins");
  expect(
    s002.status(),
    `S002 diverged: expected the de-bundled build to serve the curated catalog (HTTP 200) ` +
      `but got ${s002.status()}; owning slice ${PACKAGING_SLICE}`,
  ).toBe(200);
  const s002Body = (await s002.json()) as CatalogResponse;
  expect(
    s002Body.curated,
    `S002 diverged: expected the de-bundled build to source its defaults from the curated ` +
      `marketplace catalog (curated=true) rather than a carried-over bundled tree, but curated ` +
      `was ${JSON.stringify(s002Body.curated)}; owning slice ${PACKAGING_SLICE}`,
  ).toBe(true);
  expect(
    listingIds(s002Body).includes(SEED_DEFAULT_INTEGRATION_ID),
    `S002 diverged: expected the seed-default integration "${SEED_DEFAULT_INTEGRATION_ID}" to ` +
      `flow through the post-debundle catalog but it was absent from the listing; owning slice ${PACKAGING_SLICE}`,
  ).toBe(true);

  // ---- S003: allow first-run seeding to run with no network on the critical
  // path. Disconnect the marketplace, then assert the seed floor still serves
  // (offline) and the seed-default set vs the marketplace-only split.
  const offlineSource = await setMarketplaceReachable(request, false);
  expect(
    offlineSource,
    `S003 diverged: expected the catalog to degrade off "network" (no network on the seed ` +
      `critical path) but the source was "${offlineSource}"; owning slice ${SEED_SLICE}`,
  ).not.toBe("network");

  const s003 = await request.get("/api/marketplace/plugins");
  expect(
    s003.status(),
    `S003 diverged: expected the offline seed floor to serve HTTP 200 (no network) but got ` +
      `${s003.status()}; owning slice ${SEED_SLICE}`,
  ).toBe(200);
  const s003Body = (await s003.json()) as CatalogResponse;
  expect(
    ["cache", "seed"],
    `S003 diverged: expected the offline listing to come from the last-verified cache or the ` +
      `bundled seed but the source was "${s003Body.source}"; owning slice ${SEED_SLICE}`,
  ).toContain(s003Body.source);

  // S003-O01: the seed defaults are present offline. The github-com integration
  // is installed and running with no live network (observed as its bundled-overlay
  // stand-in per reconciliation #1), and the two seed-default component plugins
  // are served by the verified offline catalog (they ship in the production seed
  // bundle; here they are catalog entries the seed would install).
  const seededOffline = await fetchPluginRecord(request, SEED_DEFAULT_INTEGRATION_ID);
  expectSeedDefaultRunning(seededOffline, "S003", SEED_SLICE);
  const offlineIds = listingIds(s003Body);
  for (const id of SEED_DEFAULT_COMPONENT_IDS) {
    expect(
      offlineIds.includes(id),
      `S003-O01 diverged: expected the seed-default component "${id}" to be available offline ` +
        `(served from the bundled seed) but it was absent from the offline listing; owning slice ${SEED_SLICE}`,
    ).toBe(true);
  }

  // S003-O02: ghe is NOT seeded, and since #568 extracted it to the workplace
  // third-party marketplace it is NOT a first-party catalog entry either. It is
  // absent from both the seed-default set and the first-party offline listing;
  // reinstalling it from a registered workplace source is owned by the third-party
  // e2e suite (declared-source-consent-install-journey, marketplace-registration-
  // journey), not this first-party drift guard.
  expect(
    SEED_DEFAULT_IDS.includes(MARKETPLACE_ONLY_ID as (typeof SEED_DEFAULT_IDS)[number]),
    `S003-O02 diverged: expected "${MARKETPLACE_ONLY_ID}" to be excluded from the seed-default ` +
      `set ${JSON.stringify(SEED_DEFAULT_IDS)} (it is marketplace-only, not seeded); owning slice ${PACKAGING_SLICE}`,
  ).toBe(false);
  expect(
    offlineIds.includes(MARKETPLACE_ONLY_ID),
    `S003-O02 diverged: expected the extracted "${MARKETPLACE_ONLY_ID}" to be absent from the ` +
      `first-party offline listing (it moved to the workplace third-party marketplace, #568) but it ` +
      `was present; owning slice ${PACKAGING_SLICE}`,
  ).toBe(false);

  // ---- S004: load the existing unchanged roubo.yaml and start a bench whose
  // components bind process + database. CPHM-NFR-005: the config loads with no
  // migration and starts identically to the prior bundled build. Per
  // reconciliation #1/#2 the component runtimes are not pre-installed overlays
  // here, so "starts identically" is asserted at the config-load + no-migration
  // boundary: the existing roubo.yaml binds process + database and loads
  // unchanged, and no migration record is produced.
  const { projectId } = await registerFixtureProject(request, {
    projectId: FIXTURE_PROJECT_ID,
    componentPlugin: "database",
  });
  const s004 = await request.get(`/api/projects/${projectId}/config`);
  expect(
    s004.status(),
    `S004 diverged: expected the existing roubo.yaml to load (HTTP 200) with no migration but ` +
      `got ${s004.status()}; owning slice ${SEED_SLICE}`,
  ).toBe(200);
  const s004Body = (await s004.json()) as ConfigResponse;
  expect(
    s004Body.configValid,
    `S004 diverged: expected the existing roubo.yaml to be valid on load (no migration needed) ` +
      `but configValid was ${JSON.stringify(s004Body.configValid)}; owning slice ${SEED_SLICE}`,
  ).toBe(true);
  const components = s004Body.config?.components ?? {};
  const boundPluginIds = Object.values(components).map((c) => c.plugin?.id);
  for (const id of SEED_DEFAULT_COMPONENT_IDS) {
    expect(
      boundPluginIds.includes(id),
      `S004-O01 diverged: expected the unchanged roubo.yaml to still bind the "${id}" component ` +
        `identically (no migration) but the bound component plugins were ${JSON.stringify(
          boundPluginIds,
        )}; owning slice ${SEED_SLICE}`,
    ).toBe(true);
  }
  const migrationRes = await request.get("/api/migration/status");
  expect(
    migrationRes.status(),
    `S004-O01 diverged: expected GET /api/migration/status to serve HTTP 200 but got ` +
      `${migrationRes.status()}; owning slice ${SEED_SLICE}`,
  ).toBe(200);
  const migration = (await migrationRes.json()) as MigrationStatusResponse;
  expect(
    migration.migration ?? null,
    `S004-O01 diverged: expected the clean-break upgrade to require NO migration (CPHM-NFR-005), ` +
      `but a migration record was present: ${JSON.stringify(migration.migration)}; owning slice ${SEED_SLICE}`,
  ).toBeNull();

  // ---- S005 (removed): the original step reinstalled ghe from the FIRST-PARTY
  // marketplace and asserted the reconnected first-party catalog listed it. #568
  // extracted ghe to the workplace third-party marketplace, so ghe is no longer a
  // first-party catalog entry and is not reinstallable via the first-party
  // /api/marketplace/plugins/:id/install path. Installing it from a registered
  // workplace source (the real post-#568 behavior) is owned by the third-party e2e
  // suite (declared-source-consent-install-journey, marketplace-registration-journey).
  // The seed layer this guard exercises is being retired in
  // davidpoxon/roubo-development#621, which will rework this journey.

  // ---- S006: verify the seeded github-com behaves identically to its
  // previously-bundled self. Per reconciliation #1 the harness github-com is the
  // bundled-overlay stub, so the spec asserts the integration manifest CONTRACT is
  // intact across the upgrade (id, integration kind, and the `sources` config the
  // integration binds issue sources through), the observable stand-in for
  // "manifest + integration actions match the prior bundled build with 0
  // regressions". The full capability set is asserted by github-com's own unit
  // tests (out of scope for this drift guard).
  const seededGithub = await fetchPluginRecord(request, SEED_DEFAULT_INTEGRATION_ID);
  expectSeedDefaultRunning(seededGithub, "S006", SEED_SLICE);
  const manifest = seededGithub?.manifest;
  expect(
    manifest?.id,
    `S006-O01 diverged: expected the seeded github-com manifest id to match the prior bundled ` +
      `build ("${SEED_DEFAULT_INTEGRATION_ID}") but it was ${JSON.stringify(
        manifest?.id,
      )}; owning slice ${SEED_SLICE}`,
  ).toBe(SEED_DEFAULT_INTEGRATION_ID);
  expect(
    manifest?.kind,
    `S006-O01 diverged: expected the seeded github-com to remain an integration plugin (0 ` +
      `regressions) but its manifest kind was ${JSON.stringify(manifest?.kind)}; owning slice ${SEED_SLICE}`,
  ).toBe("integration");
  const configSchema = (manifest?.configSchema ?? {}) as {
    properties?: Record<string, unknown>;
  };
  expect(
    configSchema.properties !== undefined && "sources" in configSchema.properties,
    `S006-O01 diverged: expected the seeded github-com to expose its issue-source binding action ` +
      `(configSchema.properties.sources) like the prior bundled build but it was absent; owning slice ${SEED_SLICE}`,
  ).toBe(true);
});

/**
 * The catalog listing ids served by GET /api/marketplace/plugins.
 */
function listingIds(body: CatalogResponse): string[] {
  return (body.listings ?? []).map((l) => l.id);
}

/**
 * Assert a seed-default plugin is running: present, source "bundled" (the
 * harness stand-in for a seeded default, per reconciliation #1), status
 * "enabled". The message names the diverging step + expected/actual + owning
 * slice (issue #315 acceptance criterion 3).
 */
function expectSeedDefaultRunning(
  record: PluginRecord | undefined,
  stepId: string,
  slice: string,
): void {
  expect(
    record?.source,
    `${stepId} diverged: expected the seed-default "${SEED_DEFAULT_INTEGRATION_ID}" to be a ` +
      `running default (observed as a bundled overlay) but its record was ${JSON.stringify(
        record,
      )}; owning slice ${slice}`,
  ).toBe("bundled");
  expect(
    record?.status,
    `${stepId} diverged: expected the seed-default "${SEED_DEFAULT_INTEGRATION_ID}" to stay ` +
      `running (status "enabled") but it was "${record?.status}"; owning slice ${slice}`,
  ).toBe("enabled");
}
