import { expect, test } from "@playwright/test";
import {
  type FreshLaunchResult,
  loadAppShell,
  resetWithScenario,
  seedFreshLaunch,
} from "./_support/scenario.js";

// CPHM-TC-041 (CPHM-FR-004 / CPHM-FR-005 / CPHM-US-001 / CPHM-US-002, issue
// #313): end-to-end proof of the first-run journey. A clean first launch with no
// network seeds EXACTLY the three defaults (github-com, process, database) into
// the user root, verified, and a relaunch does not re-seed (idempotent). ghe and
// jira-self-hosted are NOT seeded (they are marketplace-only after the
// clean-break de-bundle).
//
// This drives the live seed service (server/services/plugin-manager.ts:
// seedFromBundled -> installSeedArtifact) through the ROUBO_E2E-gated
// `POST /test/__seed-fresh-launch` seam. The seam runs a GENUINE offline seed
// into an isolated throwaway tmp user root from a synthesised stub seed bundle
// (three host-compatible artifacts + a seed catalog.json), then reports the
// installed plugins + idempotency marker. The seed path is local-only (read the
// catalog, unpack each tarball, verify its digest fail-closed, rename into the
// user root, write the marker): there is no network on its critical path by
// construction (CPHM-NFR-002).
//
// Drift guard: this spec walks .specifications/component-plugins-hosted-marketplace
// case CPHM-TC-041 step for step (S001-S005). If that case changes, update this
// spec to match.
//
// Failure-output contract (issue #313 acceptance criterion 3): every assertion
// below names the diverging step id, the expected-vs-actual, and the owning slice
// issue from this unit's blocked-by set, so a red run localizes the drift to one
// attributable slice. The blocked-by set is #309 (app-packaging: ships the seed
// bundle + catalog) and #310 (plugin-manager: the first-run seed pass + the
// clean-break that stops bundling ghe/jira).
//
// Three reconciliations against the literal CPHM-TC-041 script, all deliberate:
//   - S001 names "the installer that ships resources/seed/ (three signed tarballs
//     + signed seed-catalog snapshot)". App-packaging owns the real bundle (#309);
//     this seam stands in a synthesised stub bundle of the same shape so the seed
//     service runs end-to-end. The genuine first-launch pass actually seeding
//     (seededNow) is the proof the bundle was present and read offline.
//   - S002-O02 names a toast ("First-run seed installed (offline, verified):
//     github-com, process, database"). That toast is a client surface; this leg
//     verifies the seed-result data contract it renders from: the pass seeded
//     exactly the three, with no network on the critical path.
//   - S004 names "exercise a seeded plugin (create a bench using the process
//     plugin) while still offline". Fully running a component plugin at e2e level
//     is out of scope for a seed drift guard (the slice's own tests cover spawn /
//     supervision). Mirroring CPHM-TC-051's S004 reconciliation, this asserts the
//     seeded `process` plugin is a real, usable on-disk install (a host-compatible
//     manifest whose id matches + its entry script present) that discovery + spawn
//     pick up unchanged offline (CPHM-NFR-005).

const SCENARIO = "default";
const NOW = "2026-06-28T10:00:00.000Z";

// Owning slice issues from this unit's blocked-by set, surfaced in failure
// messages so a red step points at one slice (issue #313 acceptance criterion 3).
const BUNDLE_SLICE =
  "davidpoxon/roubo-development#309 (app-packaging: seed bundle + signed seed catalog)";
const SEED_SLICE =
  "davidpoxon/roubo-development#310 (plugin-manager: first-run seed + clean-break de-bundle)";

// The three defaults the first-run seed installs, sorted (readSeededRoot returns
// the installed set id-sorted).
const SEED_IDS = ["database", "github-com", "process"];

// The former bundled integrations that are NOT seeded after the clean-break
// de-bundle: marketplace-only, installed on demand, never auto-seeded.
const MARKETPLACE_ONLY_IDS = ["ghe", "jira-self-hosted"];

// A seeded plugin used as the "usable offline" subject for S004.
const EXERCISED_SEED_ID = "process";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("CPHM-TC-041: fresh offline launch seeds exactly the three defaults, usable offline, and a relaunch does not re-seed", async ({
  request,
  page,
}) => {
  // ---- S001 + S002: clean first launch with no network installs the seed.
  // Expected: the genuine offline seed pass runs and actually seeds (the bundle
  // shipped by the installer was present and read with no network), and the app
  // reaches a usable state (the built shell loads without a crash).
  const first = await seedFreshLaunch(request);

  expect(
    first.seededNow,
    `S001 diverged: expected a clean first launch to run the offline seed and ` +
      `install the defaults (no marker present yet) but the pass did not seed; ` +
      `owning slice ${BUNDLE_SLICE}`,
  ).toBe(true);

  await loadAppShell(page);

  // The host targets exactly the three defaults (and NOT the legacy bundled
  // integration set): a guard on the seed set itself (S002-O02 / S003-O02).
  expect(
    [...first.seedSet].sort(),
    `S002 diverged: expected the host seed set to be exactly the three defaults ` +
      `but it was ${JSON.stringify(first.seedSet)}; owning slice ${SEED_SLICE}`,
  ).toEqual(SEED_IDS);

  // ---- S002-O02: the three defaults are the ones seeded (the data the toast
  // "First-run seed installed (offline, verified): github-com, process, database"
  // renders from). The marker records exactly the verified-and-installed set.
  expect(
    [...first.marker.seededIds].sort(),
    `S002 diverged: expected the offline seed to install exactly the three ` +
      `defaults but the marker recorded ${JSON.stringify(first.marker.seededIds)}; ` +
      `owning slice ${SEED_SLICE}`,
  ).toEqual(SEED_IDS);

  // ---- S003-O01: the installed-plugins screen shows github-com / process /
  // database as Seeded + Verified. On disk: the three (and only the three) are
  // installed into the user root, each from a host-compatible manifest whose id
  // matches its directory. "Verified" is implied by presence: installSeedArtifact
  // installs an artifact only after its digest passes the fail-closed integrity
  // check (CPHM-NFR-001), so an installed id is a verified id.
  expectSeededVerified(first, "S003");

  // ---- S003-O02: ghe and jira-self-hosted are NOT installed (marketplace-only).
  for (const id of MARKETPLACE_ONLY_IDS) {
    expect(
      first.installed.find((p) => p.id === id),
      `S003 diverged: expected "${id}" to be marketplace-only (NOT seeded on first ` +
        `launch) but it was installed into the user root; owning slice ${SEED_SLICE}`,
    ).toBeUndefined();
    expect(
      first.seedSet,
      `S003 diverged: expected "${id}" to be absent from the host seed set ` +
        `(marketplace-only) but it was present; owning slice ${SEED_SLICE}`,
    ).not.toContain(id);
  }

  // ---- S004: a seeded plugin is usable offline. The seeded `process` plugin is a
  // real, host-compatible install on disk (its manifest id matches and its entry
  // script is present), which discovery + spawn pick up unchanged offline
  // (CPHM-NFR-005). See the S004 reconciliation note in the header.
  const exercised = first.installed.find((p) => p.id === EXERCISED_SEED_ID);
  expect(
    exercised?.manifestId,
    `S004 diverged: expected the seeded "${EXERCISED_SEED_ID}" plugin to be a usable ` +
      `on-disk install with a matching manifest id but its record was ` +
      `${JSON.stringify(exercised)}; owning slice ${SEED_SLICE}`,
  ).toBe(EXERCISED_SEED_ID);
  expect(
    exercised?.hasEntry,
    `S004 diverged: expected the seeded "${EXERCISED_SEED_ID}" plugin to ship a ` +
      `runnable entry script offline but it was absent; owning slice ${SEED_SLICE}`,
  ).toBe(true);

  // ---- S005: close and relaunch the app (still offline). Re-running the seed
  // against the same sandbox must be a no-op: the marker short-circuits the pass.
  const relaunch = await seedFreshLaunch(request, { relaunch: true });

  // ---- S005-O01: no re-seed occurs and no first-run toast reappears. The marker
  // is present going in, so the pass does not seed, and it does not rewrite the
  // marker (the seededAt timestamp is unchanged).
  expect(
    relaunch.seededNow,
    `S005 diverged: expected the relaunch to be idempotent (the marker prevents a ` +
      `re-seed) but the pass seeded again; owning slice ${SEED_SLICE}`,
  ).toBe(false);
  expect(
    relaunch.marker.present,
    `S005 diverged: expected the idempotency marker to remain present after the ` +
      `relaunch but it was absent; owning slice ${SEED_SLICE}`,
  ).toBe(true);
  expect(
    relaunch.marker.seededAt,
    `S005 diverged: expected the relaunch to leave the marker untouched (no ` +
      `re-seed) but its seededAt changed from ${JSON.stringify(first.marker.seededAt)} ` +
      `to ${JSON.stringify(relaunch.marker.seededAt)}; owning slice ${SEED_SLICE}`,
  ).toBe(first.marker.seededAt);

  // ---- S005-O02: the same three plugins remain Seeded + Verified and usable.
  expectSeededVerified(relaunch, "S005");
});

/**
 * Assert a fresh-launch result shows exactly the three defaults Seeded +
 * Verified: the installed set is github-com / process / database (and only
 * those), each from a host-compatible manifest whose declared id matches its
 * directory and whose entry script is present. The message names the diverging
 * step + expected/actual + owning slice (issue #313 acceptance criterion 3).
 */
function expectSeededVerified(result: FreshLaunchResult, stepId: string): void {
  expect(
    result.installed.map((p) => p.id),
    `${stepId} diverged: expected exactly the three defaults seeded into the user ` +
      `root but the installed set was ${JSON.stringify(result.installed.map((p) => p.id))}; ` +
      `owning slice ${SEED_SLICE}`,
  ).toEqual(SEED_IDS);
  for (const record of result.installed) {
    expect(
      record.manifestId,
      `${stepId} diverged: expected the seeded "${record.id}" plugin to carry a ` +
        `host-compatible manifest whose id matches its directory but it was ` +
        `${JSON.stringify(record.manifestId)}; owning slice ${SEED_SLICE}`,
    ).toBe(record.id);
    expect(
      record.hasEntry,
      `${stepId} diverged: expected the seeded "${record.id}" plugin to ship its ` +
        `entry script (Verified + usable) but it was absent; owning slice ${SEED_SLICE}`,
    ).toBe(true);
  }
}
