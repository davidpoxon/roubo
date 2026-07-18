import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  fetchPluginRecord,
  inspectMarketplaceSource,
  loadAppShell,
  refreshPluginProvenance,
  resetWithScenario,
  seedMarketplaceSource,
} from "./_support/scenario.js";

// CPHMTP-TC-011 (CPHMTP-FR-009 / CPHMTP-US-006, issue #571): end-to-end proof of
// the "remove a third-party marketplace, then confirm the orphaned aftermath"
// journey against the integrated app. Removing a source is a cascade the operator
// consents to through a consequences dialog: the source's installed plugins stay
// installed and keep running but are marked orphaned (no update path until the
// source is re-registered), while the registry entry, cached catalog, and stored
// keyring credential are all deleted.
//
// This drives the shipped surfaces end to end: the Marketplaces settings list and
// its Remove seam (issue #561), the removal consequences dialog + confirmation
// toast (issue #564), and the orphan stamp the removal writes to the provenance
// ledger (issue #560), which the installed-plugins card renders through the shared
// ProvenanceBadge (issue #563). The removal itself runs the real
// DELETE /api/marketplace/sources/:id cascade (marketplace-sources-state.removeSource:
// registry-row delete, per-source cache-dir delete, keyring-credential delete, and
// the ledger orphan stamp).
//
// Drift guard: this spec walks .specifications/component-plugins-hosted-marketplace-third-party
// case CPHMTP-TC-011 step for step (S001-S006). If that case changes, update this
// spec to match.
//
// Failure-output contract (issue #571 acceptance criteria 6-7 / FR-020): every
// assertion below names the diverging step / observation id, the expected-vs-actual,
// and the owning slice issue from this unit's blocked-by set (#561 / #564 / #560),
// so a red run localizes the drift to one attributable slice.
//
// TEST SEAMS (there is no pure-UI path to the preconditions or to inspecting the
// on-disk aftermath, so three ROUBO_E2E-gated seams stand them up; see
// e2e/e2e-flow/_support/scenario.ts and server/routes/test.ts):
//   - seedMarketplaceSource: registers a credentialled third-party source and a
//     provenance-ledger row tying e2e-stub to it (the install commit's state), then
//     re-derives the live records so the record carries the source before removal.
//   - refreshPluginProvenance: re-derives the live records from the ledger after
//     the removal. The orphan stamp lands in the ledger at removal, but a
//     PluginRecord only reflects it on its next rebuild (a relaunch in production);
//     this drives that rebuild so the orphaned aftermath is observable in-session.
//   - inspectMarketplaceSource: reads the on-disk registry / cache / keyring for S006.
//   The keyring leg runs against a ROUBO_E2E in-memory keyring fake
//   (server/services/credential-store.ts) so the credential read/write/delete is
//   deterministic and portable in CI (headless Linux has no Secret Service).
//
// Three deliberate reconciliations against the literal CPHMTP-TC-011 script, each
// flagged inline as a FIDELITY NOTE below:
//   - S004-O01: the confirmation is a toast with no testid and no role
//     (ToastProvider.tsx), asserted by its text.
//   - S005-O02: the shipped orphaned pill reads "Orphaned" (not "Orphaned · source
//     removed"); the "source removed" reason ships as screen-reader-only context.
//   - S005-O03: the shipped former-source chip reads "Source: <host>" (not
//     "was: <source>"), and the installed card exposes no update control at all.

const SCENARIO = "default";
const NOW = "2026-07-18T10:00:00.000Z";
const PLUGIN_ID = "e2e-stub";

// Owning slices from this unit's blocked-by set (#571 AC7 / FR-020), surfaced in
// failure messages so a red step points at the slice that owns the behaviour.
const REGISTRY_SLICE =
  "davidpoxon/roubo-development#561 (Marketplaces settings list: source rows + Remove seam)";
const REMOVAL_SLICE =
  "davidpoxon/roubo-development#564 (removal consequences dialog + confirmation + cascade)";
const ORPHAN_SLICE =
  "davidpoxon/roubo-development#560 (orphan-stamp the provenance ledger on source removal)";

/**
 * Open a global Settings section by its hash. The built server's SPA fallback 404s
 * direct deep-link GETs (see the plugin-grid spec), so load the shell at "/" then
 * client-side navigate to the hash, which mounts ProjectSettings with the tab
 * pre-selected (defaultSelectedKey reads the hash on mount). Re-loading the shell
 * each call forces a fresh mount, so switching sections re-selects the tab and
 * re-fetches the section's queries.
 */
async function openSettingsSection(page: Page, section: "marketplaces" | "plugins"): Promise<void> {
  await loadAppShell(page);
  await page.evaluate((s) => {
    window.history.pushState({}, "", `/settings#${s}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, section);
}

/** Assert `row` mentions each phrase, labelling any miss with the observation id. */
async function expectRowMentions(
  row: Locator,
  phrases: RegExp[],
  obsId: string,
  slice: string,
): Promise<void> {
  for (const phrase of phrases) {
    await expect(
      row,
      `${obsId} diverged: expected the consequence row to mention ${phrase}; owning slice ${slice}`,
    ).toContainText(phrase);
  }
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("CPHMTP-TC-011: remove a marketplace end to end and confirm the orphaned aftermath", async ({
  request,
  page,
}) => {
  // ---- Preconditions: a third-party source registered WITH a credential, and one
  // plugin (e2e-stub) installed from it. Seeded directly (no pure-UI path installs
  // a plugin from a specific third-party source); the seam writes the same state
  // the install commit would and re-derives the record so it carries the source.
  const { sourceId, sourceUrl, pluginId } = await seedMarketplaceSource(request, {
    pluginId: PLUGIN_ID,
    credential: "e2e-source-token",
  });
  const sourceName = new URL(sourceUrl).host;

  // Precondition proof: the seeded plugin's record now carries the source, so the
  // removal's client-side orphan count (S004-O01) resolves to exactly this plugin.
  const seeded = await fetchPluginRecord(request, pluginId);
  expect(
    seeded?.sourceId,
    `Precondition diverged: expected the seeded plugin "${pluginId}" to record source "${sourceId}" ` +
      `before removal but its record was ${JSON.stringify(seeded)}; owning slice ${REGISTRY_SLICE}`,
  ).toBe(sourceId);

  // ---- S001: open Settings and select the Marketplaces section. The seeded
  // third-party row is present (and removable; the built-in first-party row is not).
  await openSettingsSection(page, "marketplaces");
  const row = page.locator(`[data-testid="marketplace-source-row"][data-source-id="${sourceId}"]`);
  await expect(
    row,
    `S001 diverged: expected the seeded third-party source row (${sourceId}) to appear in the ` +
      `Marketplaces list but it did not; owning slice ${REGISTRY_SLICE}`,
  ).toBeVisible();

  // ---- S002: click 'Remove…' on the third-party source row.
  // S002-O01: a consequences dialog appears titled 'Remove "<source>"?' showing the URL.
  await row.getByTestId("marketplace-source-remove").click();
  const dialog = page.getByTestId("marketplace-source-remove-dialog");
  await expect(
    dialog,
    `S002-O01 diverged: expected the removal consequences dialog to open on Remove; owning slice ${REMOVAL_SLICE}`,
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: `Remove "${sourceName}"?` }),
    `S002-O01 diverged: expected the dialog title 'Remove "${sourceName}"?'; owning slice ${REMOVAL_SLICE}`,
  ).toBeVisible();
  await expect(
    dialog.getByTestId("marketplace-source-remove-url"),
    `S002-O01 diverged: expected the dialog to show the source URL "${sourceUrl}"; owning slice ${REMOVAL_SLICE}`,
  ).toHaveText(sourceUrl);

  // ---- S003: read the three consequence rows.
  // S003-O01: keep row: the installed plugin stays installed and keeps running.
  await expectRowMentions(
    dialog.getByTestId("marketplace-source-remove-keep"),
    [/stays installed and keeps running/i],
    "S003-O01",
    REMOVAL_SLICE,
  );
  // S003-O02: warn row: the plugin is marked orphaned, no updates until re-registered.
  await expectRowMentions(
    dialog.getByTestId("marketplace-source-remove-orphan"),
    [/orphaned/i, /no updates/i, /re-register/i],
    "S003-O02",
    REMOVAL_SLICE,
  );
  // S003-O03: delete row: the registry entry, cached catalog, and stored credential deleted.
  await expectRowMentions(
    dialog.getByTestId("marketplace-source-remove-delete"),
    [/registry entry/i, /cached catalog/i, /stored credential/i],
    "S003-O03",
    REMOVAL_SLICE,
  );

  // ---- S004: click 'Remove marketplace'.
  await dialog.getByTestId("marketplace-source-remove-confirm").click();

  // S004-O01: a confirmation indicates the source was removed and 1 plugin orphaned.
  // FIDELITY NOTE: the shipped confirmation is a toast with NO testid and NO role
  // (client/src/components/ToastProvider.tsx), so it is asserted by its text; the
  // exact copy is "Removed <host>; 1 plugin orphaned" (MarketplacesTabPanel), a
  // faithful rendering of the case's abstract "removed ... and 1 plugin orphaned".
  await expect(
    page.getByText(/Removed .*; 1 plugin orphaned/).first(),
    `S004-O01 diverged: expected a confirmation reading "Removed <source>; 1 plugin orphaned"; owning slice ${REMOVAL_SLICE}`,
  ).toBeVisible();

  // S004-O02: the source row no longer appears in the Marketplaces list.
  await expect(
    row,
    `S004-O02 diverged: expected the removed source row (${sourceId}) to disappear from the list; owning slice ${REGISTRY_SLICE}`,
  ).toHaveCount(0);

  // The orphan stamp lands in the provenance ledger at removal, but a PluginRecord
  // only reflects it on its next rebuild (a relaunch); drive that rebuild so S005
  // observes the orphaned aftermath in-session (see refreshPluginProvenance).
  await refreshPluginProvenance(request);

  // ---- S005: open the installed plugins view.
  await openSettingsSection(page, "plugins");
  const card = page.locator(`[data-testid="plugin-card"][data-plugin-id="${pluginId}"]`);

  // S005-O01: the plugin is still installed and running.
  await expect(
    card,
    `S005-O01 diverged: expected the plugin "${pluginId}" to remain installed after its source was removed; owning slice ${ORPHAN_SLICE}`,
  ).toBeVisible();
  const afterRemoval = await fetchPluginRecord(request, pluginId);
  expect(
    afterRemoval?.status,
    `S005-O01 diverged: expected the orphaned plugin "${pluginId}" to keep running (status "enabled") ` +
      `but it was "${afterRemoval?.status}"; owning slice ${ORPHAN_SLICE}`,
  ).toBe("enabled");

  // S005-O02: badged Orphaned, and retains its Unverified badge.
  // FIDELITY NOTE: the shipped orphaned pill reads "Orphaned" (ProvenanceBadge), not
  // the case's "Orphaned · source removed"; the "source removed" reason ships as
  // screen-reader-only context on the pill, so the visible chip is the short word.
  await expect(
    card.getByTestId("provenance-orphaned"),
    `S005-O02 diverged: expected the plugin to be badged Orphaned after its source was removed; owning slice ${ORPHAN_SLICE}`,
  ).toBeVisible();
  await expect(
    card.getByTestId("provenance-trust"),
    `S005-O02 diverged: expected the plugin to retain its Unverified badge (data-treatment="unverified"); owning slice ${ORPHAN_SLICE}`,
  ).toHaveAttribute("data-treatment", "unverified");

  // S005-O03: shows the former source, and offers no update path.
  // FIDELITY NOTE: the shipped source chip reads "Source: <host>" (ProvenanceBadge
  // SourceChip, host derived from the retained sourceUrl), not the case's literal
  // "was: <source>"; and the installed card exposes NO update control at all, which
  // is how "offers no update path" ships (updates live on the Browse view, not here).
  const sourceChip = card.getByTestId("provenance-source");
  await expect(
    sourceChip,
    `S005-O03 diverged: expected the plugin to show its former source "${sourceName}"; owning slice ${ORPHAN_SLICE}`,
  ).toBeVisible();
  await expect(
    sourceChip,
    `S005-O03 diverged: expected the former-source chip to name the removed source host "${sourceName}"; owning slice ${ORPHAN_SLICE}`,
  ).toContainText(sourceName);
  await expect(
    card.getByRole("button", { name: /update/i }),
    `S005-O03 diverged: expected the installed card to offer no update path (no Update control); owning slice ${ORPHAN_SLICE}`,
  ).toHaveCount(0);

  // The orphaned aftermath at the data-contract boundary GET /api/plugins renders
  // from: the record reads orphaned:true and retains the former source url.
  expect(
    afterRemoval?.orphaned,
    `S005 diverged: expected GET /api/plugins to report the plugin orphaned:true after removal but got ` +
      `${JSON.stringify(afterRemoval?.orphaned)}; owning slice ${ORPHAN_SLICE}`,
  ).toBe(true);
  expect(
    afterRemoval?.sourceUrl,
    `S005 diverged: expected the orphaned record to retain the former source url "${sourceUrl}" (so it ` +
      `reads standalone once the source row is gone) but got "${afterRemoval?.sourceUrl}"; owning slice ${ORPHAN_SLICE}`,
  ).toBe(sourceUrl);

  // ---- S006: inspect on-disk registry, the source cache, and the OS keyring.
  // S006-O01: the registry entry, cached catalog, and keyring credential are all deleted.
  const inspected = await inspectMarketplaceSource(request, sourceId);
  expect(
    inspected.registryPresent,
    `S006-O01 diverged: expected the registry entry for source "${sourceId}" to be deleted; owning slice ${REMOVAL_SLICE}`,
  ).toBe(false);
  expect(
    inspected.cacheDirExists,
    `S006-O01 diverged: expected the cached catalog dir for source "${sourceId}" to be deleted; owning slice ${REMOVAL_SLICE}`,
  ).toBe(false);
  expect(
    inspected.credentialPresent,
    `S006-O01 diverged: expected the keyring credential for source "${sourceId}" to be deleted; owning slice ${REMOVAL_SLICE}`,
  ).toBe(false);
});
