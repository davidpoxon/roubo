import { expect, test } from "@playwright/test";
import type { MarketplaceListing, PluginRecord } from "@roubo/shared";
import {
  fetchPluginRecord,
  loadAppShell,
  resetWithScenario,
  setMarketplaceReachable,
} from "./_support/scenario.js";

// CPHM-TC-051 (CPHM-FR-009 / CPHM-NFR-003 / CPHM-US-002, issue #314): end-to-end
// proof of the offline marketplace journey. The app degrades to the last-known
// catalog + bundled seed, seeded (bundled) plugins keep running, a NEW install
// while the marketplace is unreachable is paused with a clear message (not a
// crash), and reconnecting un-pauses installs.
//
// This drives the live degrade chain (server/services/catalog-client.ts: the
// NETWORK -> CACHE -> SEED resolver) and the real marketplace-unreachable gate
// (server/services/marketplace.ts:assertInstallable, surfaced as 503 by
// server/routes/marketplace.ts). The offline / online flip uses the
// ROUBO_E2E-gated `setMarketplaceReachable` seam: it forces the injected catalog
// fetch to fail (unreachable -> degrade to cache/seed) or succeed (reachable ->
// network source) and busts the catalog memo so the served source flips within
// the spec, no real network required.
//
// Drift guard: this spec walks .specifications/component-plugins-hosted-marketplace
// case CPHM-TC-051 step for step (S001-S006). If that case changes, update this
// spec to match.
//
// Failure-output contract (issue #314 acceptance criterion 3): every assertion
// below names the diverging step id, the expected-vs-actual, and the owning
// slice issue from this unit's blocked-by set, so a red run localizes the drift
// to one attributable slice. The sole declared blocked_by is the catalog-client
// slice #306 (Milestone "Hosted marketplace: M3 App client"), which owns both
// the degrade chain (offline list non-empty) and the marketplace-unreachable
// install gate, so it is the localization target for every step here.
//
// Two reconciliations against the literal CPHM-TC-051 script, both deliberate:
//   - S003 names an "offline warning banner" surface. The Marketplace UI has no
//     such banner today (the GET /api/marketplace/plugins response carries no
//     degraded/source signal for the client to render): implementing it is app
//     behaviour, out of scope for this test issue (issue #314 hard gates are
//     AC1/AC2/AC3, not the banner verbatim). S003 is instead verified at the
//     catalog-client boundary (the served source degrades to cache/seed). The
//     missing banner is a divergence owned by the M3 App-client banner slice
//     (the #306 chain), reported here rather than built.
//   - S005 names "Jira" as the new install. But jira-self-hosted is a SEEDED
//     (bundled) catalog entry, so it cannot be the non-seeded install subject.
//     The block applies to ANY non-network install, so this walks it with
//     `database`: a genuinely non-seeded, not-yet-installed catalog entry.

const SCENARIO = "default";
const NOW = "2026-06-28T10:00:00.000Z";

// Owning slice issue from this unit's blocked-by set, surfaced in failure
// messages so a red step points at one slice (issue #314 acceptance criterion 3).
const CATALOG_SLICE =
  "davidpoxon/roubo-development#306 (catalog-client: degrade chain + marketplace-unreachable gate)";

// A genuinely seeded plugin: github-com ships bundled with Roubo (source
// "bundled") and is one of the seed-catalog entries, so it is the "seeded plugin
// runs offline" subject for AC1/S004.
const SEEDED_PLUGIN_ID = "github-com";

// The new-install subject for AC2/S005: a non-seeded (not bundled), not-yet-
// installed catalog entry. `database` is a component entry present in the seed
// catalog but absent from the e2e harness's installed set (it is neither a
// bundled overlay nor a user-plugin fixture), so installing it is a true NEW
// install that the unreachable gate must pause.
const NEW_INSTALL_ID = "database";

// The exact clear message assertInstallable throws (and the 503 body surfaces)
// when a new install is attempted while the marketplace is unreachable.
const UNREACHABLE_MESSAGE = `Can't install "${NEW_INSTALL_ID}" while the marketplace is unreachable. Seeded and already-installed plugins remain available; new installs resume when the marketplace is reachable again.`;

interface InstallErrorBody {
  error?: string;
  code?: string;
}

interface CatalogResponse {
  curated?: boolean;
  listings?: MarketplaceListing[];
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("CPHM-TC-051: offline marketplace journey: seeded plugins keep running, a new install is paused clearly, reconnect resumes installs", async ({
  request,
  page,
}) => {
  // ---- S001: disconnect the marketplace.
  // Expected: the catalog source degrades off "network" (to the last-verified
  // cache, or the bundled seed) rather than staying live.
  const offlineSource = await setMarketplaceReachable(request, false);
  expect(
    offlineSource,
    `S001 diverged: expected the catalog to degrade off "network" when the ` +
      `marketplace is unreachable but the source was "${offlineSource}"; owning slice ${CATALOG_SLICE}`,
  ).not.toBe("network");

  // ---- S002: launch the app and open the Plugins view. The built client shell
  // loads (no crash), and the marketplace plugin list is non-empty offline.
  // Expected: GET / -> 200 with #root attached, and GET /api/marketplace/plugins
  // -> 200 with a non-empty listing served from the degraded source.
  await loadAppShell(page);

  const s002 = await request.get("/api/marketplace/plugins");
  expect(
    s002.status(),
    `S002 diverged: expected the offline catalog to serve HTTP 200 (degraded, not ` +
      `a crash) but got ${s002.status()}; owning slice ${CATALOG_SLICE}`,
  ).toBe(200);
  const s002Body = (await s002.json()) as CatalogResponse;
  expect(
    s002Body.listings?.length ?? 0,
    `S002 diverged: expected a non-empty offline plugin list but got ` +
      `${s002Body.listings?.length ?? 0} listings; owning slice ${CATALOG_SLICE}`,
  ).toBeGreaterThan(0);

  // ---- S003: the offline indicator. The literal CPHM-TC-051 step reads an
  // "offline warning banner (marketplace unreachable, last verified catalog
  // shown, new installs paused)". No such banner surface exists in the
  // Marketplace UI today (see the header note): rather than build app behaviour
  // under a test issue, S003 is verified at the catalog-client boundary: the
  // listing is served from the last-verified cache or the bundled seed, which IS
  // the "last verified catalog shown" state the banner would describe.
  expect(
    ["cache", "seed"],
    `S003 diverged: expected the offline listing to come from the last-verified ` +
      `cache or the bundled seed but the source was "${offlineSource}"; owning slice ${CATALOG_SLICE}`,
  ).toContain(offlineSource);

  // ---- S004: the seeded plugin is operational offline.
  // Expected: GET /api/plugins shows the bundled github-com plugin running
  // (source "bundled", status "enabled") with no live network.
  const seededOffline = await fetchPluginRecord(request, SEEDED_PLUGIN_ID);
  expectSeededRunning(seededOffline, "S004");

  // ---- S005: click Install on a NEW (non-seeded, not-installed) plugin.
  // Expected: blocked with the clear marketplace-unreachable message (503), the
  // app does not crash, and the seeded plugin stays running.
  const s005 = await request.post(`/api/marketplace/plugins/${NEW_INSTALL_ID}/install`);
  const s005Body = (await s005.json()) as InstallErrorBody;
  expect(
    s005.status(),
    `S005 diverged: expected a new offline install to be paused with HTTP 503 ` +
      `(marketplace unreachable) but got ${s005.status()}; owning slice ${CATALOG_SLICE}`,
  ).toBe(503);
  expect(
    s005Body.code,
    `S005 diverged: expected install error code "marketplace-unreachable" but got ` +
      `${JSON.stringify(s005Body.code)}; owning slice ${CATALOG_SLICE}`,
  ).toBe("marketplace-unreachable");
  expect(
    s005Body.error,
    `S005 diverged: expected the clear unreachable message but got ` +
      `${JSON.stringify(s005Body.error)}; owning slice ${CATALOG_SLICE}`,
  ).toBe(UNREACHABLE_MESSAGE);

  // The app did not crash: the shell still serves and the seeded plugin is still
  // running after the blocked install.
  const afterBlockShell = await request.get("/api/plugins");
  expect(
    afterBlockShell.status(),
    `S005 diverged: the app did not stay healthy after a blocked install ` +
      `(GET /api/plugins returned ${afterBlockShell.status()}); owning slice ${CATALOG_SLICE}`,
  ).toBe(200);
  const seededAfterBlock = await fetchPluginRecord(request, SEEDED_PLUGIN_ID);
  expectSeededRunning(seededAfterBlock, "S005");

  // ---- S006: reconnect and re-open the Plugins view.
  // Expected: the live catalog is fetched + verified (source flips back to
  // "network"), which is precisely the condition that un-pauses installs
  // (assertInstallable only blocks while source !== "network"). The actual
  // clone/commit of the install is the installer slice's own concern (covered by
  // its unit tests, out of scope for this drift guard, issue #314 "Out of
  // Scope"); the un-pausing of the gate is the boundary verified here.
  const onlineSource = await setMarketplaceReachable(request, true);
  expect(
    onlineSource,
    `S006 diverged: expected reconnect to restore the live "network" catalog ` +
      `source (un-pausing installs) but the source was "${onlineSource}"; owning slice ${CATALOG_SLICE}`,
  ).toBe("network");

  // The reconnected catalog still serves the new-install entry, ready to install.
  const s006 = await request.get("/api/marketplace/plugins");
  expect(
    s006.status(),
    `S006 diverged: expected the reconnected catalog to serve HTTP 200 but got ` +
      `${s006.status()}; owning slice ${CATALOG_SLICE}`,
  ).toBe(200);
  const s006Body = (await s006.json()) as CatalogResponse;
  expect(
    s006Body.listings?.some((l) => l.id === NEW_INSTALL_ID) ?? false,
    `S006 diverged: expected the reconnected live catalog to list the now-installable ` +
      `"${NEW_INSTALL_ID}" entry; owning slice ${CATALOG_SLICE}`,
  ).toBe(true);
});

/**
 * Assert a seeded (bundled) plugin is running: present, source "bundled",
 * status "enabled". The message names the diverging step + expected/actual +
 * owning slice (issue #314 acceptance criterion 3).
 */
function expectSeededRunning(record: PluginRecord | undefined, stepId: string): void {
  expect(
    record?.source,
    `${stepId} diverged: expected the seeded plugin "${SEEDED_PLUGIN_ID}" to be a ` +
      `bundled plugin running offline but its record was ${JSON.stringify(record)}; ` +
      `owning slice ${CATALOG_SLICE}`,
  ).toBe("bundled");
  expect(
    record?.status,
    `${stepId} diverged: expected the seeded plugin "${SEEDED_PLUGIN_ID}" to stay ` +
      `running (status "enabled") offline but it was "${record?.status}"; owning slice ${CATALOG_SLICE}`,
  ).toBe("enabled");
}
