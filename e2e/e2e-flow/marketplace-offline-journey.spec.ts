import { expect, test } from "@playwright/test";
import type { MarketplaceCatalogSource, MarketplaceListing, PluginRecord } from "@roubo/shared";
import {
  fetchPluginRecord,
  loadAppShell,
  resetWithScenario,
  setMarketplaceReachable,
} from "./_support/scenario.js";

// CPHM-TC-051 (CPHM-FR-009 / CPHM-NFR-003 / CPHM-US-002, issue #314): end-to-end
// proof of the offline marketplace journey. The app degrades to the last-known
// catalog (the on-disk cache), bundled plugins keep running, a NEW install while
// the marketplace is unreachable is paused with a clear message (not a crash),
// and reconnecting un-pauses installs.
//
// The first-party SEED channel was retired (davidpoxon/roubo-development#621), so
// there is no bundled catalog floor: the offline degrade shows the LAST-VERIFIED
// CACHE. This journey therefore warms the cache with a reachable fetch first,
// then goes offline so the served catalog degrades to that cache. (Cold-start
// offline, with no warmed cache, bottoms out at an empty listing; that path is
// covered by catalog-client.test.ts.)
//
// This drives the live degrade chain (server/services/catalog-client.ts: the
// NETWORK -> CACHE resolver) and the real marketplace-unreachable gate
// (server/services/marketplace.ts:assertInstallable, surfaced as 503 by
// server/routes/marketplace.ts). The offline / online flip uses the
// ROUBO_E2E-gated `setMarketplaceReachable` seam: it forces the injected catalog
// fetch to fail (unreachable -> degrade to cache) or succeed (reachable ->
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
//   - S003 names an "offline warning banner" surface. That banner is now built
//     (client/src/components/marketplace/MarketplaceOfflineBanner.tsx, issue
//     #372): GET /api/marketplace/plugins surfaces the served catalog's `source`
//     and `fetchedAt`, and the Plugins view renders the banner when
//     `source !== "network"`. Its rendered copy (unreachable, last-verified shown,
//     fetched-Nh-ago, installs paused) is asserted by the React unit + a11y tests
//     (Marketplace.test.tsx / Marketplace.a11y.test.tsx). This Playwright leg
//     verifies S003 at the API data-contract boundary the banner renders from:
//     the GET /plugins response degrades `source` to cache and carries a
//     `fetchedAt`, which IS the "last verified catalog (fetched ...) shown" state.
//   - S005 names "Jira" as the new install. jira-self-hosted is not a suitable
//     subject, so this walks the block with `database`: a not-yet-installed
//     catalog entry (present in the warmed cache, absent from the installed set).

const SCENARIO = "default";
const NOW = "2026-06-28T10:00:00.000Z";

// Owning slice issue from this unit's blocked-by set, surfaced in failure
// messages so a red step points at one slice (issue #314 acceptance criterion 3).
const CATALOG_SLICE =
  "davidpoxon/roubo-development#306 (catalog-client: degrade chain + marketplace-unreachable gate)";

// A bundled plugin: github-com ships bundled with Roubo (source "bundled") in the
// e2e harness, so it is the "bundled plugin keeps running offline" subject for
// AC1/S004. It is also served by the warmed catalog cache.
const SEEDED_PLUGIN_ID = "github-com";

// The new-install subject for AC2/S005: a not-yet-installed catalog entry.
// `database` is a component entry present in the warmed catalog cache but absent
// from the e2e harness's installed set (it is neither a bundled overlay nor a
// user-plugin fixture), so installing it is a true NEW install that the
// unreachable gate must pause.
const NEW_INSTALL_ID = "database";

// The exact clear message assertInstallable throws (and the 503 body surfaces)
// when a new install is attempted while the marketplace is unreachable.
const UNREACHABLE_MESSAGE = `Can't install "${NEW_INSTALL_ID}" while the marketplace is unreachable. Already-installed plugins remain available; new installs resume when the marketplace is reachable again.`;

interface InstallErrorBody {
  error?: string;
  code?: string;
}

interface CatalogResponse {
  curated?: boolean;
  listings?: MarketplaceListing[];
  // The served catalog's provenance, surfaced for the offline / staleness banner
  // (issue #372): `source` degrades off "network" and `fetchedAt` is the cached
  // fetch timestamp (or null for an empty listing).
  source?: MarketplaceCatalogSource;
  fetchedAt?: string | null;
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("CPHM-TC-051: offline marketplace journey: bundled plugins keep running, a new install is paused clearly, reconnect resumes installs", async ({
  request,
  page,
}) => {
  // ---- S000 (setup): warm the on-disk catalog cache with a reachable fetch, so
  // the subsequent offline degrade shows the LAST-VERIFIED CACHE. The first-party
  // SEED floor was retired (#621), so without a warmed cache the offline listing
  // would bottom out empty and the marketplace-unreachable install gate (which
  // needs a resolvable entry) would have nothing to pause.
  const warmSource = await setMarketplaceReachable(request, true);
  expect(
    warmSource,
    `S000 diverged: expected a reachable fetch to warm the cache with the live ` +
      `"network" catalog but the source was "${warmSource}"; owning slice ${CATALOG_SLICE}`,
  ).toBe("network");

  // ---- S001: disconnect the marketplace.
  // Expected: the catalog source degrades off "network" to the last-verified
  // cache rather than staying live.
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
  // shown, new installs paused)". That banner is now built (issue #372): the
  // GET /api/marketplace/plugins response surfaces the `source` / `fetchedAt`
  // the Plugins view renders the banner from. The rendered copy is asserted by
  // the React unit + a11y tests; here we verify the API data contract that feeds
  // it: the offline listing degrades to the last-verified cache (the "last
  // verified catalog shown" state), and the response carries that source plus a
  // fetchedAt key (the "fetched 2h ago" staleness the banner shows).
  expect(
    offlineSource,
    `S003 diverged: expected the offline listing to come from the last-verified ` +
      `cache but the source was "${offlineSource}"; owning slice ${CATALOG_SLICE}`,
  ).toBe("cache");
  expect(
    s002Body.source,
    `S003 diverged: expected GET /plugins to surface the degraded "cache" source ` +
      `for the offline banner but the body source was "${s002Body.source}"; owning slice ${CATALOG_SLICE}`,
  ).toBe("cache");
  expect(
    "fetchedAt" in s002Body,
    `S003 diverged: expected GET /plugins to surface a fetchedAt field for the ` +
      `offline banner's staleness but it was absent; owning slice ${CATALOG_SLICE}`,
  ).toBe(true);

  // ---- S004: the bundled plugin is operational offline.
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
 * Assert a bundled plugin is running: present, source "bundled", status
 * "enabled". The message names the diverging step + expected/actual + owning
 * slice (issue #314 acceptance criterion 3).
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
