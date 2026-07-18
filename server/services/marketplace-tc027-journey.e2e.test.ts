// CPHMTP-TC-027 (e2e_flow, level 1): browse the combined catalog, filter to a
// registered workplace (third-party) source, and install an unsigned plugin from
// it whose per-artifact sha256 digest is verified before the install completes and
// whose install record stores the workplace-source provenance with unverified
// status. This is the integrated happy-path counterpart to the tamper journey
// (CPHMTP-TC-049): there the third-party install fails CLOSED on a digest mismatch;
// here an untampered artifact installs SUCCESSFULLY through the same real pipeline,
// and the provenance the badges render from is stamped on the install record.
//
// The "running system" here is the REAL, already-merged pipeline composed in process
// under vitest, not a mock of it:
//   - the REAL source registry (server/services/marketplace-sources-state.ts
//     addSource()), which validates the URL shape and persists the workplace source
//     row (with its attached credential) as a PURE WRITE with no network call to the
//     candidate URL (CPHMTP-NFR-003);
//   - the REAL marketplace service (server/services/marketplace.ts), whose
//     listCatalog() fans out over the first-party catalog AND the registered
//     workplace source, merges them into one list, stamps each entry with the
//     sourceId it came from, forces `verified: false` on any non-first-party entry,
//     and scopes the list to one source when a sourceId filter is passed; and whose
//     install() builds the ThirdPartyInstallContext that makes the per-artifact
//     digest MANDATORY (CPHMTP-NFR-004) and records the chosen source's provenance;
//   - the REAL plugin installer (server/services/plugin-installer.ts
//     previewFromRelease -> commit), which routes the download through guarded-fetch
//     scoped to the source's consented origin, unpacks under zip-slip + size limits,
//     recomputes the digest via the REAL marketplace-integrity primitives
//     (node:crypto sha256) before any staging entry is recorded, atomically moves the
//     artifact into the plugins dir on commit, and stamps the provenance ledger row.
//
// Real vs stood in. Real: the source registry (add + persist + load), the listing
// fan-out and its provenance stamping + verified-flag derivation, the source filter,
// the install routing, the download-cap + unpack, the sha256 recompute + comparison,
// the atomic commit, and the provenance stamping call. Stood in, at the process
// boundaries only: the catalog fetch (catalog-client is mocked so the first-party and
// workplace catalogs serve their entries without a network round-trip), the network
// download (undici.fetch streams a REAL gzipped tarball built on disk), the plugin
// registry/runtime (plugin-manager), the provenance ledger's file IO
// (plugin-provenance-state, whose write is covered by its own unit tests and asserted
// here via the recordProvenance call), the OS keyring (credential-store), and the
// state directory (state.getRouboDir is redirected to a sandbox tmpdir so the journey
// NEVER writes the developer's real ~/.roubo).
//
// One boundary is NOT stood in, and it is the one exception to "no network":
// guarded-fetch resolves the asset host and rechecks the resolved addresses BEFORE it
// calls fetchImpl, and plugin-installer injects no lookup seam, so the DNS lookup for
// the workplace host runs against the real resolver on every install run. No artifact
// bytes cross the network (those come from the mocked undici.fetch); only the lookup
// does. It is harmless here because the host lives under `.invalid` (RFC 2606 reserves
// it, so it cannot resolve) and recheckResolvedAddresses swallows a resolution
// failure, adding no block and no connect pin. This mirrors the CPHMTP-TC-049
// journey's precedent exactly.
//
// Why this is a service-altitude journey, not a Playwright DOM spec. The
// authoritative CPHMTP-TC-027 observations split into two kinds. The INTEGRATED
// behaviour (the merged multi-source listing, the per-entry provenance stamp, the
// verified-flag derivation, the source filter, the mandatory-digest verified install,
// and the install-record provenance) is asserted here against the real pipeline. The
// pure RENDER observations (the green vs amber chip styling, the "Unverified" pill,
// the "Not installed" affordance, and the SAME badge repeated in the plugin drawer,
// S007) are web-client facts asserted by the React unit + a11y tests
// (client/src/components/marketplace/Marketplace.test.tsx, MarketplaceCard.tsx via
// marketplace-journey-e2e.test.tsx, MarketplaceDrawer.test.tsx, ProvenanceBadge.test.tsx).
// This is the same producer/consumer split the sibling CPHMTP-TC-049 journey drew and
// documented, and the same in-process shape every other marketplace e2e_flow journey
// in this repo uses (marketplace-install-312-journey, marketplace-tc014-journey,
// marketplace-tc070-journey, marketplace-tamper-tc049-journey). Each render surface's
// provenance is DRIVEN by the server-side fact this journey pins: the install record
// grades unverified (unverified === true, sourceId !== first-party), which
// recordProvenance() maps to the one amber Unverified treatment across list, card, and
// drawer. Two harness realities force a distinct fixture id rather than the literal
// `ghe`: in the e2e/integration harness `ghe` is a bundled plugin (force-enabled and
// already installed) AND the first-party seed catalog serves a `ghe` entry, so a
// workplace `ghe` entry would collide cross-source (the pick-a-source ambiguity path,
// CPHMTP-TC-033/034, a DIFFERENT case) and read as already-installed. A distinct,
// non-bundled, non-first-party id keeps the journey the clean browse -> filter ->
// unverified -> install -> provenance path CPHMTP-TC-027 specifies.
//
// Drift guard: each it() is named after its CPHMTP-TC-027 step id(s) and the step's
// expected observation is kept explicit, so a change to the authoritative
// CPHMTP-TC-027 in
// .specifications/component-plugins-hosted-marketplace-third-party/test-cases.json
// forces this test to be updated.
//
// Failure-output contract (issue #572 AC: "On failure the test reports which e2e_flow
// step diverged, the expected-vs-actual at that step, and the owning slice issue(s)
// from Blocked by"): every assertion attaches an expected-vs-actual message naming the
// diverging step and the owning slice, so a red run localizes the integration drift to
// one attributable slice. The e2e/component-plugins/_support/step-runner.ts helper
// cannot be reused here: it imports `expect` from @playwright/test and so cannot be
// imported from a vitest suite. This follows the sibling journeys' precedent of
// hand-rolling the attribution via assertion messages instead.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceCatalogEntry, PluginRecord } from "@roubo/shared";
import type { ThirdPartyCatalogResult, VerifiedCatalog } from "./catalog-client.js";

// ── Owning slices ──
// #572's blocked-by set is {#557, #559, #560, #563}. Each step localizes a divergence
// to the slice that actually owns the diverging behaviour, so a red run points at one
// attributable issue rather than the whole journey. All four are CLOSED (merged), so
// this unit is a drift guard over them.
const SLICE_MULTI_SOURCE_LISTING =
  "#557 (multi-source listing: merged catalog, per-entry provenance stamp, source filter, parallel fetch)";
const SLICE_MANDATORY_DIGEST =
  "#559 (mandatory integrity digest + guarded artifact download for unsigned third-party installs)";
const SLICE_PROVENANCE_LEDGER =
  "#560 (install-record source provenance stored + surfaced across list/card/drawer)";
const SLICE_UNVERIFIED_BADGE =
  "#563 (persistent unverified badge + provenance across list, card, and drawer surfaces)";

// ── Fixture identifiers (TC-027 preconditions) ──
// The registered workplace source: consented as unsigned, with an attached credential
// (precondition 2). Its host carries "acme" so the server-derived chip label
// ("marketplace.acme.example.invalid") names the workplace, mirroring how the running
// server derives the chip label from the URL host rather than a literal "ACME
// workplace" string.
const WORKPLACE_CATALOG_URL = "https://marketplace.acme.example.invalid/catalog.json";
// The asset lives on the SAME origin as the catalog: guarded-fetch scopes a
// third-party download to the source's consented origin, so a cross-origin asset would
// be refused before reaching the digest recompute (#554/#559).
const WORKPLACE_ASSET_URL = "https://marketplace.acme.example.invalid/acme-hosted-widget-1.0.0.tgz";
const WORKPLACE_CREDENTIAL = "acme-workplace-token";
// A distinct, non-bundled, non-first-party id (see the header note on why not `ghe`).
const PLUGIN_ID = "acme-hosted-widget";
// A first-party catalog entry so the merged list demonstrably carries entries from
// BOTH sources (S001-O01) and a green first-party chip (S002-O01) alongside the amber
// workplace one. Never installed here; it exists to prove the combined + differentiated
// listing.
const FIRST_PARTY_PLUGIN_ID = "roubo-sample-component";
const PACKAGE_DIGEST_RE = /^sha256-[0-9a-f]{64}$/;

// The state dir the real registry writes to. Created eagerly and hoisted so the
// state.js mock factory (also hoisted) can close over it: the journey must never
// resolve state to the developer's real ~/.roubo.
const sandbox = vi.hoisted(() => ({ root: "" }));

vi.mock("./catalog-client.js", () => ({
  getVerifiedCatalog: vi.fn(),
  createThirdPartyCatalogClient: vi.fn(),
}));

vi.mock("./plugin-manager.js", () => ({
  HOST_API_VERSION: "1.3.0",
  getUserPluginsRoot: vi.fn(),
  listInstalled: vi.fn(() => [] as PluginRecord[]),
  registerInstalled: vi.fn(),
  uninstall: vi.fn(),
  uninstallForUpdate: vi.fn(),
}));

vi.mock("undici", () => ({
  fetch: vi.fn(),
  // guarded-fetch builds a connect-pinning Agent (issue #590); the mocked fetch
  // ignores the dispatcher, so a constructable stub is all this mock needs.
  Agent: vi.fn(),
}));

// The provenance ledger's persistence boundary: commit records the chosen source to
// ~/.roubo/plugins-provenance.json (issue #558/#560). Mocked so the journey cannot
// write the developer's own state dir; its file IO is covered by
// plugin-provenance-state.test.ts. This journey asserts the stamping happens (the
// recordProvenance call) and its arguments (the stored provenance), which is the
// server-side fact S006 and the persistent badge (S007) render from.
vi.mock("./plugin-provenance-state.js", () => ({
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  getProvenance: vi.fn(() => null),
  markOrphanedBySource: vi.fn(),
}));

// The OS keyring boundary (TC-027 precondition 2: the workplace source "has an
// attached credential"). Stubbed so no code path can spawn a real keyring process
// (`security find-generic-password`). `get` returns the attached credential so the
// install path's origin-scoped credential read is exercised end to end.
vi.mock("./credential-store.js", () => ({
  set: vi.fn(async () => {}),
  get: vi.fn(async () => WORKPLACE_CREDENTIAL),
  deleteSlot: vi.fn(async () => {}),
}));

// Redirect ONLY the state-directory resolution, keeping atomicWrite and the rest of
// state.js real, so the registry's write -> read-back round trip is genuine but lands
// in a sandbox tmpdir instead of ~/.roubo.
vi.mock("./state.js", async (importActual) => {
  const actual = await importActual<typeof import("./state.js")>();
  const { mkdirSync } = await import("node:fs");
  return {
    ...actual,
    getRouboDir: () => sandbox.root,
    ensureDirs: () => {
      mkdirSync(sandbox.root, { recursive: true });
    },
  };
});

import * as marketplace from "./marketplace.js";
import * as pluginInstaller from "./plugin-installer.js";
import * as catalogClient from "./catalog-client.js";
import * as pluginManager from "./plugin-manager.js";
import * as sourcesState from "./marketplace-sources-state.js";
import * as pluginProvenanceState from "./plugin-provenance-state.js";
import { computePackageDigest } from "./marketplace-integrity.js";
import { fetch } from "undici";
import { resolveWithin } from "../lib/safe-path.js";

// A complete, valid plugin manifest (the host parses and host-compat checks it before
// the digest is recomputed). `kind: integration` mirrors the ghe plugin the
// authoritative case names; the ONLY thing the journey turns on is that its unpacked
// bytes match the digest the workplace catalog declares.
const MANIFEST = `id: ${PLUGIN_ID}
name: ACME Hosted Widget
version: 1.0.0
description: An issue-source integration served by the ACME workplace marketplace (unsigned).
kind: integration
roubo: ^1.0.0
entry: dist/index.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;

type FetchResult = Awaited<ReturnType<typeof fetch>>;

let pluginsRoot: string;
let assetTgz: string; // path to the REAL gzipped tarball the workplace source serves
let trueDigest: string; // computePackageDigest of the served artifact = the catalog `integrity`
const tmpDirs: string[] = [];

async function trackTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Build the built artifact the workplace source serves (roubo-plugin.yaml + a runnable
// dist/index.js + package.json + README), then pack it into a REAL gzipped tarball. Its
// unpacked-directory digest (`trueDigest`) is what the host recomputes AND what the
// catalog declares, so the verify-before-commit passes for this untampered artifact.
async function buildWorkplaceArtifact(): Promise<void> {
  const src = await trackTmp("roubo-tc027-src-");
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "roubo-plugin.yaml"), MANIFEST, "utf8");
  await writeFile(
    path.join(src, "dist", "index.js"),
    "module.exports = { plugin: { id: 'acme-hosted-widget' } };\n",
    "utf8",
  );
  await writeFile(
    path.join(src, "package.json"),
    `${JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", type: "commonjs", main: "dist/index.js" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(src, "README.md"), "# ACME Hosted Widget\n", "utf8");

  trueDigest = await computePackageDigest(src);

  const out = await trackTmp("roubo-tc027-tgz-");
  assetTgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: assetTgz, cwd: src }, [
    "roubo-plugin.yaml",
    "dist/index.js",
    "package.json",
    "README.md",
  ]);
}

// Mock undici.fetch to stream the REAL tarball; a fresh read stream per call so the
// body can be consumed across re-staging.
function fakeDownload(tgzPath: string) {
  vi.mocked(fetch).mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: createReadStream(tgzPath),
      }) as unknown as FetchResult,
  );
}

// The workplace source's unsigned catalog entry: one release-type entry declaring the
// digest of the served bytes. `verified: true` is deliberate: an unsigned source can
// claim anything in its payload, and the host must ignore the claim for a
// non-first-party source (S002-O02).
function workplaceEntry(integrity: string): MarketplaceCatalogEntry {
  return {
    id: PLUGIN_ID,
    name: "ACME Hosted Widget",
    kind: "integration",
    version: "1.0.0",
    summary: "An issue-source integration served by the ACME workplace marketplace (unsigned).",
    source: { type: "release", assetUrl: WORKPLACE_ASSET_URL, sha256: "sha256-asset" },
    provenance: "marketplace.acme.example.invalid",
    integrity,
    verified: true,
  };
}

// The first-party signed catalog carries one curated entry so the merged list
// demonstrably spans BOTH sources and the two chip treatments (green first-party vs
// amber workplace) are both present. `verified: true` here is HONORED (it came through
// the first-party signed chain), unlike the workplace claim above.
function firstPartyEntry(): MarketplaceCatalogEntry {
  return {
    id: FIRST_PARTY_PLUGIN_ID,
    name: "Roubo Sample Component",
    kind: "component",
    version: "2.0.0",
    summary: "A curated first-party component, shown to prove the combined multi-source list.",
    source: {
      type: "release",
      assetUrl: "https://first-party.example.invalid/sample.tgz",
      sha256: "sha256-fp",
    },
    provenance: "github.com/davidpoxon/roubo-plugins",
    integrity: `sha256-${"a".repeat(64)}`,
    verified: true,
  };
}

function firstPartyCatalog(): VerifiedCatalog {
  return {
    entries: [firstPartyEntry()],
    source: "network",
    fetchedAt: "2026-07-01T00:00:00.000Z",
  };
}

function workplaceCatalogResult(integrity: string): ThirdPartyCatalogResult {
  return {
    entries: [workplaceEntry(integrity)],
    source: "network",
    fetchedAt: "2026-07-01T00:00:00.000Z",
  };
}

// Wire both catalog boundaries: the first-party signed chain and the workplace
// third-party client. `integrity` is the workplace entry's declared digest; passing
// `trueDigest` models an untampered artifact, a wrong value models tamper.
function setCatalogs(integrity: string): void {
  vi.mocked(catalogClient.getVerifiedCatalog).mockResolvedValue(firstPartyCatalog());
  vi.mocked(catalogClient.createThirdPartyCatalogClient).mockReturnValue({
    getCatalog: async () => workplaceCatalogResult(integrity),
  });
}

/**
 * Register the ACME workplace source (with its attached credential) and return the
 * registry id minted for it. Idempotent: a re-registration of the same URL resolves to
 * the SAME row and id, so each step stands on its own even though the steps share the
 * sandbox state file.
 */
async function registerWorkplaceSource(step: string): Promise<string> {
  const result = await sourcesState.addSource({
    url: WORKPLACE_CATALOG_URL,
    credential: WORKPLACE_CREDENTIAL,
  });
  if (result.outcome === "invalid-url") {
    throw new Error(
      `CPHMTP-TC-027 step ${step} diverged: expected the ACME workplace catalog URL ${WORKPLACE_CATALOG_URL} to be registrable as a consented unsigned source, but the registry rejected it as invalid. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    );
  }
  return result.source.id;
}

async function listStaging(): Promise<string[]> {
  try {
    return await readdir(resolveWithin(pluginInstaller.__test.stagingRoot()));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  sandbox.root = mkdtempSync(path.join(tmpdir(), "roubo-tc027-state-"));
  tmpDirs.push(sandbox.root);
  await buildWorkplaceArtifact();
});

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

beforeEach(async () => {
  pluginInstaller.__test.reset();
  marketplace.__test.resetSourceClients();
  pluginsRoot = await trackTmp("roubo-tc027-plugins-");
  vi.mocked(pluginManager.getUserPluginsRoot).mockReturnValue(pluginsRoot);
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(pluginManager.registerInstalled).mockReset();
  vi.mocked(fetch).mockReset();
  vi.mocked(catalogClient.getVerifiedCatalog).mockReset();
  vi.mocked(catalogClient.createThirdPartyCatalogClient).mockReset();
  vi.mocked(pluginProvenanceState.recordProvenance).mockReset();
});

afterEach(async () => {
  await rm(pluginsRoot, { recursive: true, force: true });
});

describe("CPHMTP-TC-027: browse, filter to a workplace source, install with the persistent unverified badge", () => {
  it("S001/S002: open the Browse screen -> one combined list spans both sources, each entry carries its source provenance, and the workplace entry gets NO first-party verified treatment", async () => {
    const sourceId = await registerWorkplaceSource("S001");
    setCatalogs(trueDigest);

    const { listings, sources } = await marketplace.listCatalog();

    // S001-O01: one combined list renders entries from BOTH the first-party catalog and
    // the ACME workplace marketplace.
    const ids = listings.map((l) => l.id);
    expect(
      ids,
      `CPHMTP-TC-027 step S001 (S001-O01) diverged: expected the merged listing to span BOTH the first-party catalog and the ACME workplace source, got listing ids ${JSON.stringify(ids)}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toEqual(expect.arrayContaining([FIRST_PARTY_PLUGIN_ID, PLUGIN_ID]));

    // S001-O02: the source rows the filter chips render from. "All sources" is a
    // client-side unscoped sentinel; the server supplies the first-party row and the
    // ACME workplace row (the two real chips), with the workplace chip's label derived
    // from the source URL host.
    const sourceIds = sources.map((s) => s.id);
    expect(
      sourceIds,
      `CPHMTP-TC-027 step S001 (S001-O02) diverged: expected the fan-out to describe exactly the first-party source and the registered ACME workplace source (the chip row), got ${JSON.stringify(sourceIds)}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toEqual([FIRST_PARTY_SOURCE_ID, sourceId]);
    const workplaceRow = sources.find((s) => s.id === sourceId);
    expect(
      workplaceRow?.url,
      `CPHMTP-TC-027 step S001 (S001-O02) diverged: expected the ACME workplace chip row to carry the registered source URL (the provenance the chip renders), got ${JSON.stringify(workplaceRow?.url)}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(WORKPLACE_CATALOG_URL);
    expect(
      workplaceRow?.label,
      `CPHMTP-TC-027 step S001 (S001-O02) diverged: expected the ACME workplace chip label to name the workplace (derived from the URL host), got ${JSON.stringify(workplaceRow?.label)}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toContain("acme");

    // S002-O01: the first-party entry keeps its first-party verified treatment (green
    // chip): it came through the signed chain, and its `verified` flag is honored.
    const firstParty = listings.find((l) => l.id === FIRST_PARTY_PLUGIN_ID);
    expect(
      firstParty?.sourceId,
      `CPHMTP-TC-027 step S002 (S002-O01) diverged: expected the first-party entry to carry the first-party source id, got ${JSON.stringify(firstParty?.sourceId)}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(FIRST_PARTY_SOURCE_ID);
    expect(
      firstParty?.verified,
      `CPHMTP-TC-027 step S002 (S002-O01) diverged: expected the first-party entry to keep its verified (green first-party) treatment, got verified=${firstParty?.verified}. Owning slices: ${SLICE_MULTI_SOURCE_LISTING} for the derivation, ${SLICE_UNVERIFIED_BADGE} for the rendered chip.`,
    ).toBe(true);

    // S002-O02: the workplace entry is stamped with the source it came from (so the UI
    // renders "from marketplace.acme.example" against it) and gets NO first-party
    // verified styling. `verified` is derived from WHICH source served the entry, never
    // trusted from the entry payload: the fixture CLAIMS verified:true and the host must
    // force it false because the source is not first-party, or a workplace source could
    // borrow the green treatment.
    const workplace = listings.find((l) => l.id === PLUGIN_ID);
    expect(
      workplace?.sourceId,
      `CPHMTP-TC-027 step S002 (S002-O02) diverged: expected the workplace entry to carry the sourceId provenance of the ACME source that served it\n    expected: ${sourceId}\n    actual:   ${workplace?.sourceId}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(sourceId);
    expect(
      workplaceEntry(trueDigest).verified,
      `CPHMTP-TC-027 step S002 (S002-O02) diverged: the fixture must model a workplace source CLAIMING verified:true, otherwise the assertion below cannot prove the host ignores the claim. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(true);
    expect(
      workplace?.verified,
      `CPHMTP-TC-027 step S002 (S002-O02) diverged: expected NO first-party verified styling on the workplace entry (the host must derive the verified flag from the serving source, not the entry payload)\n    expected: false\n    actual:   ${workplace?.verified}. Owning slices: ${SLICE_MULTI_SOURCE_LISTING} for the provenance stamping, ${SLICE_UNVERIFIED_BADGE} for the rendered amber Unverified chip.`,
    ).toBe(false);
  });

  it("S003: click the 'ACME workplace' filter chip -> the list narrows to only the workplace entries while the chip row stays complete", async () => {
    const sourceId = await registerWorkplaceSource("S003");
    setCatalogs(trueDigest);

    const scoped = await marketplace.listCatalog({ sourceId });

    // S003-O01: the list narrows to only entries whose provenance is the ACME workplace
    // source; the first-party entry drops out.
    const scopedIds = scoped.listings.map((l) => l.id);
    expect(
      scopedIds,
      `CPHMTP-TC-027 step S003 (S003-O01) diverged: expected scoping to the ACME workplace source to narrow the list to only its entries, got listing ids ${JSON.stringify(scopedIds)}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toEqual([PLUGIN_ID]);
    expect(
      scoped.listings.every((l) => l.sourceId === sourceId),
      `CPHMTP-TC-027 step S003 (S003-O01) diverged: expected every surviving listing to carry the ACME workplace sourceId, got ${JSON.stringify(scoped.listings.map((l) => l.sourceId))}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(true);

    // S003-O02: the chip row stays complete even while the listings are scoped to one
    // source, so "All sources" / "Roubo first-party" remain selectable (they become the
    // inactive chips in the UI). The server keeps describing every source in `sources`.
    expect(
      scoped.sources.map((s) => s.id),
      `CPHMTP-TC-027 step S003 (S003-O02) diverged: expected the scoped response to still describe EVERY source (so the full chip row renders with the workplace chip active and the others inactive), got ${JSON.stringify(scoped.sources.map((s) => s.id))}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toEqual([FIRST_PARTY_SOURCE_ID, sourceId]);
  });

  it("S004: the workplace ghe-equivalent entry is not installed and carries no verified treatment before install (the data the Unverified pill + Not installed state render from)", async () => {
    await registerWorkplaceSource("S004");
    setCatalogs(trueDigest);
    // Precondition 3: the plugin is available (not installed) from the workplace source.
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);

    const { listings } = await marketplace.listCatalog();
    const workplace = listings.find((l) => l.id === PLUGIN_ID);

    // S004-O01 (Not installed): the entry is not in the installed set, so the card
    // renders the Install affordance rather than an Installed badge.
    expect(
      workplace?.installed,
      `CPHMTP-TC-027 step S004 (S004-O01) diverged: expected the workplace entry to be NOT installed before install (so the card shows Install, not Installed), got installed=${workplace?.installed}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(false);
    // S004-O01 (Unverified pill): verified === false is the fact the persistent amber
    // Unverified pill renders from, on the card and every other surface.
    expect(
      workplace?.verified,
      `CPHMTP-TC-027 step S004 (S004-O01) diverged: expected the pre-install workplace entry to grade unverified (verified=false, the data the persistent Unverified pill renders from), got verified=${workplace?.verified}. Owning slices: ${SLICE_MULTI_SOURCE_LISTING} for the derivation, ${SLICE_UNVERIFIED_BADGE} for the rendered pill.`,
    ).toBe(false);
  });

  it("S005/S006: click Install -> the per-artifact sha256 is verified, the install succeeds, and the install record stores the workplace provenance with unverified=true", async () => {
    const sourceId = await registerWorkplaceSource("S005");
    setCatalogs(trueDigest);
    fakeDownload(assetTgz);

    // Precondition pin: the declared digest is a valid-format sha256 that EQUALS the
    // served artifact's true digest, so the success below is a genuine verify-PASS
    // (not a skipped check). The mismatch path is the sibling CPHMTP-TC-049.
    expect(
      PACKAGE_DIGEST_RE.test(trueDigest) && workplaceEntry(trueDigest).integrity === trueDigest,
      `CPHMTP-TC-027 step S005 (S005-O01) diverged: the workplace fixture must declare a valid-format sha256 equal to the served artifact's true digest so the install is a genuine verify-pass, got declared=${workplaceEntry(trueDigest).integrity} vs true=${trueDigest}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(true);

    // S005-O01 + S005-O02 (stage half): clicking Install drives the REAL install(),
    // which resolves the entry to the ACME workplace source, builds the
    // ThirdPartyInstallContext (making the digest mandatory + scoping the download to
    // the consented origin), downloads via guarded-fetch, unpacks, and recomputes sha256
    // over the fetched bytes. The recomputed digest MATCHES the declared one, so it
    // stages successfully rather than rejecting.
    const preview = await marketplace.install(PLUGIN_ID, sourceId);
    expect(
      preview.manifest.id,
      `CPHMTP-TC-027 step S005 (S005-O02) diverged: expected installing from the ACME workplace source to stage the workplace plugin, got staged manifest id ${JSON.stringify(preview.manifest.id)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(PLUGIN_ID);
    expect(
      preview.source,
      `CPHMTP-TC-027 step S005 (S005-O02) diverged: expected the staged install to route through the release download path for the workplace asset, got ${JSON.stringify(preview.source)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toEqual({ type: "release", assetUrl: WORKPLACE_ASSET_URL });

    // S005-O01 (verify half): guarded-fetch really downloaded the artifact from the
    // workplace asset URL before the digest was recomputed. That the install staged at
    // all (above) rather than throwing integrity-failed is what proves the recompute
    // matched; that undici.fetch ran over the declared asset URL is what proves the
    // digest was recomputed over FETCHED bytes, not short-circuited.
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.length,
      `CPHMTP-TC-027 step S005 (S005-O01) diverged: expected guarded-fetch to download the artifact before the digest was recomputed, but undici.fetch was never called. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBeGreaterThan(0);
    expect(
      String(fetchCalls[0][0]),
      `CPHMTP-TC-027 step S005 (S005-O01) diverged: expected the artifact download to target the workplace source's declared asset URL\n    expected: ${WORKPLACE_ASSET_URL}\n    actual:   ${String(fetchCalls[0][0])}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(WORKPLACE_ASSET_URL);

    // S005-O02 (commit half): committing atomically moves the unpacked artifact into
    // the plugins dir and the host registers it as a runnable plugin, so the card flips
    // to Installed. The provenance ledger row is stamped in the same commit (asserted as
    // S006 below).
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue({
      id: PLUGIN_ID,
      manifest: null,
      manifestPath: path.join(pluginsRoot, PLUGIN_ID, "roubo-plugin.yaml"),
      pluginDir: path.join(pluginsRoot, PLUGIN_ID),
      source: "user",
      status: "enabled",
      lastError: null,
      restartHistory: [],
      pid: null,
    });

    const record = await pluginInstaller.commit(preview.stagingToken);
    expect(
      record.id,
      `CPHMTP-TC-027 step S005 (S005-O02) diverged: expected the committed install to yield the workplace plugin's record, got ${JSON.stringify(record.id)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(PLUGIN_ID);
    expect(
      record.status,
      `CPHMTP-TC-027 step S005 (S005-O02) diverged: expected the installed workplace plugin to be enabled (Installed) after commit, got status ${JSON.stringify(record.status)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe("enabled");
    const target = path.join(pluginsRoot, PLUGIN_ID);
    expect(
      (await stat(path.join(target, "dist", "index.js"))).isFile(),
      `CPHMTP-TC-027 step S005 (S005-O02) diverged: expected the workplace plugin to be installed on disk with its runnable dist/, but ${path.join(target, "dist", "index.js")} is missing. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(true);
    expect(
      await listStaging(),
      `CPHMTP-TC-027 step S005 (S005-O02) diverged: expected the staging root to be empty after a committed install, got ${JSON.stringify(await listStaging())}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).not.toContain(preview.stagingToken);

    // S006-O01: the install record stores source provenance = the ACME workplace source
    // and unverified status = true. commit() stamps the provenance ledger row via
    // recordProvenance; its arguments ARE the stored record, and the amber Unverified
    // treatment on every surface (card, list, and the drawer of S007) is derived from
    // exactly this row (unverified === true, sourceId !== first-party).
    expect(
      vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length,
      `CPHMTP-TC-027 step S006 (S006-O01) diverged: expected the committed install to stamp exactly one provenance ledger row for the workplace plugin, got ${vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length} call(s). Owning slices: ${SLICE_PROVENANCE_LEDGER} for the ledger, ${SLICE_MANDATORY_DIGEST} for the install path that stamps it.`,
    ).toBe(1);
    const stored = vi.mocked(pluginProvenanceState.recordProvenance).mock.calls[0][0];
    expect(
      stored,
      `CPHMTP-TC-027 step S006 (S006-O01) diverged: expected the install record to store source provenance = the ACME workplace source (id + url) and unverified = true\n    expected: ${JSON.stringify({ pluginId: PLUGIN_ID, sourceId, sourceUrl: WORKPLACE_CATALOG_URL, unverified: true })}\n    actual:   ${JSON.stringify(stored)}. Owning slice: ${SLICE_PROVENANCE_LEDGER}.`,
    ).toEqual({
      pluginId: PLUGIN_ID,
      sourceId,
      sourceUrl: WORKPLACE_CATALOG_URL,
      unverified: true,
    });

    // ── S007 (persistent drawer badge, attributed, NOT re-asserted here) ──
    // "Open the plugin drawer for the newly installed ghe plugin -> the drawer shows the
    // SAME Unverified badge, confirming the badge is persistent across list, card, and
    // drawer surfaces" is a pure web-client render observation owned by #563. Whether a
    // badge renders in the drawer, and that it is the same non-dismissible pill the list
    // and card show, is not observable from a service call; it is asserted by
    // MarketplaceDrawer.test.tsx and ProvenanceBadge.test.tsx. What IS observable, and is
    // asserted immediately above, is the SINGLE server-side fact all three surfaces
    // render that badge from: the install record's stored provenance grades unverified
    // (unverified === true). recordProvenance()/listingProvenance() route the card, the
    // list, and the drawer through one trust derivation (trustTreatmentOf), so a change
    // that let the drawer diverge would first show up as this stored row changing.
  });

  it("S005-O01 (digest verification is load-bearing): a tampered workplace artifact is rejected before commit, so nothing is installed", async () => {
    // The tamper counter-case that makes the S005 success meaningful: if the workplace
    // catalog declares a digest the served bytes do NOT match, the install must fail
    // CLOSED before any plugin is committed. This proves the sha256 recompute is the live
    // gate the success path passed, not a skipped check. (The full tamper journey is
    // CPHMTP-TC-049; this is the minimal counter-assertion that keeps S005-O01 honest.)
    const wrongDigest = `sha256-${"0".repeat(64)}`;
    await registerWorkplaceSource("S005");
    setCatalogs(wrongDigest);
    fakeDownload(assetTgz);

    await expect(
      marketplace.install(PLUGIN_ID),
      `CPHMTP-TC-027 step S005 (S005-O01) diverged: expected a workplace artifact whose bytes do not match its declared digest to be REJECTED with code "integrity-failed" (the per-artifact sha256 must be verified before install completes), but the install did not reject with that code. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).rejects.toMatchObject({ code: "integrity-failed" });

    expect(
      await listStaging(),
      `CPHMTP-TC-027 step S005 (S005-O01) diverged: expected the rejected install to leave NO artifact staged, got ${JSON.stringify(await listStaging())}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toEqual([]);
    await expect(
      stat(path.join(pluginsRoot, PLUGIN_ID)),
      `CPHMTP-TC-027 step S005 (S005-O01) diverged: expected NO plugin directory for the rejected tampered artifact, but ${path.join(pluginsRoot, PLUGIN_ID)} was created. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length,
      `CPHMTP-TC-027 step S005 (S005-O01) diverged: expected the rejected install to stamp NO provenance row (no committed record), got ${vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length} call(s). Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(0);
  });
});
