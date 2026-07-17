// CPHMTP-TC-049 (e2e_flow, level 2): tamper rejection from a hostile source. A user
// registers a hostile marketplace source, its plugin lists with source provenance and
// no first-party verified treatment, and clicking Install fails CLOSED: guarded-fetch
// downloads the artifact, the installer recomputes sha256 over the fetched bytes, the
// recomputed digest does not match the declared one, and nothing is installed. The
// source stays registered so the user can retry from a corrected artifact.
//
// The "running system" here is the REAL, already-merged pipeline composed in process
// under vitest, not a mock of it:
//   - the REAL source registry (server/services/marketplace-sources-state.ts
//     addSource()), which validates the URL shape and persists the row as a PURE
//     WRITE with no network call to the candidate URL (CPHMTP-NFR-003);
//   - the REAL marketplace service (server/services/marketplace.ts), whose
//     listCatalog() fans out over the registered sources, stamps each entry with the
//     sourceId it came from, and forces `verified: false` on any non-first-party
//     entry; and whose install() builds the ThirdPartyInstallContext that makes the
//     per-artifact digest mandatory (CPHMTP-NFR-004);
//   - the REAL plugin installer (server/services/plugin-installer.ts
//     previewFromRelease), which routes the download through guarded-fetch scoped to
//     the source's consented origin, unpacks under zip-slip + size limits, and
//     recomputes the digest via the REAL marketplace-integrity primitives
//     (node:crypto sha256) before any staging entry is recorded.
//
// Real vs stood in. Real: the source registry (add + persist + load, including the
// real JSON write, schema validation and read-back), the listing fan-out and its
// provenance stamping, the install routing, the guarded download's origin scoping,
// the unpack, and the sha256 recompute + comparison. Stood in, at the process
// boundaries only: the catalog fetch (catalog-client is mocked so the hostile source
// serves its entry without a network round-trip), the network download (undici.fetch
// streams a REAL gzipped tarball built on disk), the plugin registry/runtime
// (plugin-manager), the provenance ledger's file IO (plugin-provenance-state), the OS
// keyring (credential-store), and the state directory (state.getRouboDir is
// redirected to a sandbox tmpdir so the journey NEVER writes the developer's real
// ~/.roubo). Redirecting the state dir rather than mocking the registry module keeps
// addSource() and its persistence real, which is exactly what S002-O02 asserts. The
// journey is deterministic, network-free, and runs under `npm test`.
//
// The TC-049 precondition that makes this the TAMPER journey and not a different one:
// the hostile catalog declares a VALID-FORMAT sha256 that does not match the served
// bytes. A malformed or absent digest is a DIFFERENT case: the installer treats it as
// unverifiable and fails pre-fetch with `missing-integrity` (CPHMTP-NFR-004, #559),
// which this journey deliberately does not assert. assertHostilePrecondition() below
// pins that distinction so the fixture cannot drift into the wrong code path.
//
// Drift guard: each it() is named after its CPHMTP-TC-049 step id and the step's
// expected observation is kept explicit, so a change to the authoritative
// CPHMTP-TC-049 in
// .specifications/component-plugins-hosted-marketplace-third-party/test-cases.json
// forces this test to be updated.
//
// Failure-output contract (AC: "On failure the test reports which e2e_flow step
// diverged, the expected-vs-actual at that step, and the owning slice issue(s) from
// Blocked by"): every assertion attaches an expected-vs-actual message naming the
// diverging step and the owning slice, so a red run localizes the integration drift
// to one attributable slice. The e2e/component-plugins/_support/step-runner.ts helper
// cannot be reused here: it imports `expect` from @playwright/test and so cannot be
// imported from a vitest suite. This follows the CPHMTP-TC-070 journey's precedent of
// hand-rolling the attribution via assertion messages instead.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { MarketplaceCatalogEntry, MarketplaceSource, PluginRecord } from "@roubo/shared";
import type { ThirdPartyCatalogResult, VerifiedCatalog } from "./catalog-client.js";

// ── Owning slices ──
// Each step localizes a divergence to the slice(s) that own its behaviour, so a red
// run points at one attributable issue rather than the whole journey. #574's
// blocked-by names the two install-path slices (#554, #559), but the journey also
// crosses the registration and listing slices it depends on, so those are named here
// too: the point of the contract is to name the slice that actually owns the
// diverging behaviour, and "blocked by" is a conservative superset, not a ceiling.
// All four are CLOSED (merged), so this unit is a drift guard over them.
const SLICE_SOURCE_REGISTRY =
  "#553 (marketplace source registry: add/list/remove persistence; registration is a pure write)";
const SLICE_GUARDED_FETCH =
  "#554 (guarded-fetch transport: SSRF/redirect guard, origin-scoped credential)";
const SLICE_MULTI_SOURCE_LISTING =
  "#557 (multi-source listing: merged catalog, per-entry provenance, parallel fetch)";
const SLICE_MANDATORY_DIGEST =
  "#559 (mandatory integrity digest and guarded artifact download for unsigned installs)";
// The web-client slice behind the rendered badge. It and #562 (registration consent
// dialog: raw URL, ack gate, consent-before-fetch) own the two observations this
// service-altitude journey cannot see; both are OPEN and absent from the codebase.
// See the deferred-gap notes on S002 and S003.
const SLICE_UNVERIFIED_BADGE =
  "#563 (unverified and orphaned badges plus provenance across surfaces)";

// ── Fixture identifiers (TC-049 preconditions) ──
// A hostile source standing by: its catalog declares a valid-format sha256 for the
// plugin but serves artifact bytes that do not match that digest.
const PLUGIN_ID = "hostile-widget";
const HOSTILE_CATALOG_URL = "https://hostile.example.invalid/catalog.json";
// The asset lives on the SAME origin as the catalog: guarded-fetch scopes a
// third-party download to the source's consented origin, so a cross-origin asset
// would be refused for that reason and never reach the digest recompute this journey
// is about (#554).
const HOSTILE_ASSET_URL = "https://hostile.example.invalid/hostile-widget-1.0.0.tgz";
// The valid-format sha256 the hostile catalog DECLARES. Correct shape
// (`sha256-` + 64 lowercase hex), so it is a usable digest the installer will compare
// against, and it cannot match the real artifact's digest.
const DECLARED_DIGEST = `sha256-${"b".repeat(64)}`;
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
// ~/.roubo/plugins-provenance.json (issue #558). Never reached on this journey (the
// install fails before commit), but mocked so a regression that DID reach it could
// not write the developer's own state dir. Its file IO is covered by
// plugin-provenance-state.test.ts.
vi.mock("./plugin-provenance-state.js", () => ({
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  getProvenance: vi.fn(() => null),
  markOrphanedBySource: vi.fn(),
}));

// The OS keyring boundary (TC-049 precondition: "OS keyring is available"). The
// hostile source registers WITHOUT a credential, so nothing here is exercised on the
// happy path; it is stubbed so no code path can spawn a real keyring process
// (`security find-generic-password`) during the journey.
vi.mock("./credential-store.js", () => ({
  set: vi.fn(async () => {}),
  get: vi.fn(async () => null),
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
import { computePackageDigest } from "./marketplace-integrity.js";
import { fetch } from "undici";
import { resolveWithin } from "../lib/safe-path.js";

// A complete, valid plugin manifest: the host parses and host-compat checks it before
// the digest is recomputed, so the journey must reach the integrity gate on a
// well-formed artifact. The ONLY thing wrong with this plugin is that its bytes do
// not match the digest the hostile catalog declared.
const MANIFEST = `id: ${PLUGIN_ID}
name: Hostile Widget
version: 1.0.0
description: A component served by an unsigned third-party source with a mismatched digest.
kind: component
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
let assetTgz: string; // path to the REAL gzipped tarball the hostile source serves
let trueDigest: string; // computePackageDigest of the served artifact (NOT what the catalog declares)
const tmpDirs: string[] = [];

async function trackTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Build the artifact the hostile source actually serves (roubo-plugin.yaml + a
// dist/index.js + package.json + README), then pack it into a REAL gzipped tarball.
// Its unpacked-directory digest (`trueDigest`) is what the host recomputes; the
// catalog declares DECLARED_DIGEST instead, and the gap between the two IS the tamper.
async function buildHostileArtifact(): Promise<void> {
  const src = await trackTmp("roubo-tc049-src-");
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "roubo-plugin.yaml"), MANIFEST, "utf8");
  await writeFile(
    path.join(src, "dist", "index.js"),
    "module.exports = { plugin: { id: 'hostile-widget' } };\n",
    "utf8",
  );
  await writeFile(
    path.join(src, "package.json"),
    `${JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", type: "commonjs", main: "dist/index.js" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(src, "README.md"), "# Hostile Widget\n", "utf8");

  trueDigest = await computePackageDigest(src);

  const out = await trackTmp("roubo-tc049-tgz-");
  assetTgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: assetTgz, cwd: src }, [
    "roubo-plugin.yaml",
    "dist/index.js",
    "package.json",
    "README.md",
  ]);
}

/**
 * Pin the TC-049 precondition. The declared digest must be VALID-FORMAT (so the
 * installer treats it as usable and compares against it) and must NOT equal the
 * served artifact's true digest (so the comparison is a MISMATCH). Without this
 * guard, a fixture drifting to a malformed digest would silently retarget the
 * journey at the `missing-integrity` pre-fetch refusal, a different code path and a
 * different TC.
 */
function assertHostilePrecondition(step: string): void {
  expect(
    PACKAGE_DIGEST_RE.test(DECLARED_DIGEST),
    `CPHMTP-TC-049 step ${step} diverged: the hostile source's precondition requires a VALID-FORMAT declared sha256 (a malformed one is treated as absent and fails pre-fetch with missing-integrity, a different journey), got "${DECLARED_DIGEST}". Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
  ).toBe(true);
  expect(
    DECLARED_DIGEST,
    `CPHMTP-TC-049 step ${step} diverged: the hostile source must serve bytes that do NOT match its declared digest, but the declared digest equals the served artifact's true digest ${trueDigest}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
  ).not.toBe(trueDigest);
}

// The hostile source's unsigned catalog: one release-type entry declaring a digest
// the served bytes do not match. `verified: true` is deliberate: a hostile source can
// claim anything it likes in its payload, and the host must ignore the claim for a
// non-first-party source (S003-O02).
function hostileEntry(): MarketplaceCatalogEntry {
  return {
    id: PLUGIN_ID,
    name: "Hostile Widget",
    kind: "component",
    version: "1.0.0",
    summary: "A component served by an unsigned third-party source with a mismatched digest.",
    source: { type: "release", assetUrl: HOSTILE_ASSET_URL, sha256: "sha256-asset" },
    provenance: "hostile.example.invalid",
    integrity: DECLARED_DIGEST,
    verified: true,
  };
}

// The first-party signed catalog serves nothing on this journey: TC-049's precondition
// is that no marketplace sources are registered, so the hostile source is the only
// thing in the listing beyond the built-in first-party row.
function emptyFirstPartyCatalog(): VerifiedCatalog {
  return { entries: [], source: "network", fetchedAt: "2026-07-01T00:00:00.000Z" };
}

function hostileCatalogResult(): ThirdPartyCatalogResult {
  return { entries: [hostileEntry()], source: "network", fetchedAt: "2026-07-01T00:00:00.000Z" };
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

/**
 * Register the hostile source and return the registry id minted for it. Used by the
 * later steps so each one is self-sufficient: the journey's steps share a sandbox
 * state file (they are ordered, like the CPHMTP-TC-070 journey's), but no step
 * depends on an id variable another step happened to assign. A re-registration of the
 * same URL resolves to the SAME row and id, so this is idempotent.
 */
async function registerHostileSource(step: string): Promise<string> {
  const result = await sourcesState.addSource({ url: HOSTILE_CATALOG_URL });
  if (result.outcome === "invalid-url") {
    throw new Error(
      `CPHMTP-TC-049 step ${step} diverged: expected the hostile catalog URL ${HOSTILE_CATALOG_URL} to be registrable, but the registry rejected it as invalid. Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
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
  sandbox.root = mkdtempSync(path.join(tmpdir(), "roubo-tc049-state-"));
  tmpDirs.push(sandbox.root);
  await buildHostileArtifact();
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
  pluginsRoot = await trackTmp("roubo-tc049-plugins-");
  vi.mocked(pluginManager.getUserPluginsRoot).mockReturnValue(pluginsRoot);
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(pluginManager.registerInstalled).mockReset();
  vi.mocked(fetch).mockReset();
  vi.mocked(catalogClient.getVerifiedCatalog).mockReset();
  vi.mocked(catalogClient.createThirdPartyCatalogClient).mockReset();
});

afterEach(async () => {
  await rm(pluginsRoot, { recursive: true, force: true });
});

describe("CPHMTP-TC-049: tamper rejection from a hostile source, fail closed with a clear error", () => {
  it("S001/S002: register the hostile catalog URL -> the source row is persisted and NO network call is made to it yet (S002-O02)", async () => {
    assertHostilePrecondition("S002");

    // Precondition: no marketplace sources are registered.
    expect(
      sourcesState.listSources(),
      `CPHMTP-TC-049 precondition diverged: expected no marketplace sources registered at the start of the journey, got ${JSON.stringify(
        sourcesState.listSources().map((s) => s.url),
      )}. Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
    ).toEqual([]);

    // S001 (Settings -> Marketplaces -> Add, enter the hostile URL) and the ACCEPT half
    // of S002 land on the same service call: addSource() is what the consent dialog's
    // accept button drives. The dialog itself is #562 and does not exist yet (see the
    // deferred-gap note below), so the journey drives the registry directly.
    const result = await sourcesState.addSource({ url: HOSTILE_CATALOG_URL });

    expect(
      result.outcome,
      `CPHMTP-TC-049 step S002 (S002-O02) diverged: expected accepting the consent dialog to persist a new source row for ${HOSTILE_CATALOG_URL}, got outcome "${result.outcome}". Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
    ).toBe("created");

    // S002-O02 (persistence leg): the row is really persisted, and reads back from the
    // real state file rather than only from the in-process cache.
    sourcesState.__test.reset();
    const persisted: MarketplaceSource[] = sourcesState.listSources();
    expect(
      persisted.map((s) => s.url),
      `CPHMTP-TC-049 step S002 (S002-O02) diverged: expected the accepted source row to be persisted and read back, got ${JSON.stringify(
        persisted.map((s) => s.url),
      )}. Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
    ).toEqual([HOSTILE_CATALOG_URL]);
    // Registered unsigned by construction: a third-party source has no signature chain.
    expect(
      persisted[0].unsigned,
      `CPHMTP-TC-049 step S002 (S002-O02) diverged: expected the hostile source to be registered as unsigned (no signature chain), got unsigned=${persisted[0].unsigned}. Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
    ).toBe(true);

    // S002-O02 (no-network leg): registration is a PURE WRITE. Nothing was fetched
    // from the candidate URL: no artifact download (undici.fetch), and no catalog
    // client was even constructed for the source, let alone asked for its catalog.
    expect(
      vi.mocked(fetch).mock.calls.length,
      `CPHMTP-TC-049 step S002 (S002-O02) diverged: expected NO network call to the candidate URL on registration (registration is a pure write; the first fetch happens on the next listing), but undici.fetch was called ${vi.mocked(fetch).mock.calls.length} time(s) with ${JSON.stringify(
        vi.mocked(fetch).mock.calls.map((c) => String(c[0])),
      )}. Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
    ).toBe(0);
    expect(
      vi.mocked(catalogClient.createThirdPartyCatalogClient).mock.calls.length,
      `CPHMTP-TC-049 step S002 (S002-O02) diverged: expected registration to construct no catalog client and fetch nothing from the candidate URL, but a third-party catalog client was built during addSource(). Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
    ).toBe(0);

    // ── Deferred gap, S002-O01 (attributed, NOT asserted here) ──
    // "The dialog shows the raw source URL and an arbitrary-code warning and defaults
    // to decline" is a web-client observation owned by #562, which is OPEN: the
    // Marketplaces settings UI and its registration consent dialog do not exist in the
    // codebase yet. A dialog's copy and its default-focused button are not observable
    // from a service call, so asserting them at this altitude would prove nothing.
    // #574's blocked-by names only the server slices (#554, #559), both merged, so
    // this journey is deliberately service-altitude. When #562 lands, S002-O01 belongs
    // in a Playwright spec under e2e/component-plugins/ driving the real dialog.
  });

  it("S003: open the Marketplace -> the hostile plugin lists with its source provenance and NO first-party verified styling (S003-O02)", async () => {
    // The registry row persists across the journey's steps; re-registering resolves to
    // the same row and id, so this step stands on its own.
    const sourceId = await registerHostileSource("S003");
    vi.mocked(catalogClient.getVerifiedCatalog).mockResolvedValue(emptyFirstPartyCatalog());
    vi.mocked(catalogClient.createThirdPartyCatalogClient).mockReturnValue({
      getCatalog: async () => hostileCatalogResult(),
    });

    // Opening the Marketplace fans the listing out over the registered sources.
    const { listings, sources } = await marketplace.listCatalog();
    const hostile = listings.find((l) => l.id === PLUGIN_ID);

    expect(
      hostile,
      `CPHMTP-TC-049 step S003 diverged: expected the listing fan-out to surface the hostile source's plugin "${PLUGIN_ID}", got listings ${JSON.stringify(
        listings.map((l) => l.id),
      )}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBeDefined();

    // S003-O01 (provenance leg): the entry is stamped with the source it came from, so
    // the UI can render "from hostile.example.invalid" against it.
    expect(
      hostile?.sourceId,
      `CPHMTP-TC-049 step S003 (S003-O01) diverged: expected the hostile entry to carry the sourceId provenance of the source that served it\n    expected: ${sourceId}\n    actual:   ${hostile?.sourceId}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(sourceId);
    // The source's own status row is in the fan-out, carrying the raw URL the UI shows.
    expect(
      sources.map((s) => s.url),
      `CPHMTP-TC-049 step S003 (S003-O01) diverged: expected the fan-out to report the hostile source's status row (the provenance the listing renders), got ${JSON.stringify(
        sources.map((s) => s.url),
      )}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toContain(HOSTILE_CATALOG_URL);

    // S003-O02: NO first-party verified styling. `verified` is the display-only
    // first-party curation flag, and it is derived from WHICH source served the entry,
    // never trusted from the entry payload. The fixture's entry claims
    // `verified: true`; the host must force it false because the source is not
    // first-party, or a hostile source could borrow the green first-party treatment.
    expect(
      hostileEntry().verified,
      `CPHMTP-TC-049 step S003 (S003-O02) diverged: the fixture must model a hostile source CLAIMING verified:true, otherwise the assertion below cannot prove the host ignores the claim. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(true);
    expect(
      hostile?.verified,
      `CPHMTP-TC-049 step S003 (S003-O02) diverged: expected NO first-party verified styling on the hostile entry (the host must derive the verified flag from the serving source, not from the entry payload, so an unsigned source cannot claim it)\n    expected: false\n    actual:   ${hostile?.verified}. Owning slices: ${SLICE_MULTI_SOURCE_LISTING} for the provenance stamping, ${SLICE_UNVERIFIED_BADGE} for the rendered badge.`,
    ).toBe(false);

    // ── Deferred gap, S003-O01 (badge half, attributed, NOT asserted here) ──
    // The provenance half of S003-O01 is asserted above. Its other half, "a
    // non-dismissible unverified badge", is a web-client observation owned by #563,
    // which is OPEN: the badge component does not exist in the codebase yet. Whether a
    // badge renders and whether it can be dismissed are not observable from a service
    // call; what IS observable, and is asserted above, is the server-side fact the
    // badge must be driven by (verified === false plus the sourceId stamp). When #563
    // lands, the badge's presence and non-dismissibility belong in a Playwright spec
    // under e2e/component-plugins/.
  });

  it("S004/S005: click Install -> guarded-fetch downloads, sha256 is recomputed, the mismatch is detected and the install fails closed (S004-O01/O02, S005-O01/O02/O03)", async () => {
    assertHostilePrecondition("S004");
    await registerHostileSource("S004");
    vi.mocked(catalogClient.getVerifiedCatalog).mockResolvedValue(emptyFirstPartyCatalog());
    vi.mocked(catalogClient.createThirdPartyCatalogClient).mockReturnValue({
      getCatalog: async () => hostileCatalogResult(),
    });
    fakeDownload(assetTgz);

    // S004 + S005-O02: clicking Install drives the REAL install(), which resolves the
    // entry to the hostile source, builds the ThirdPartyInstallContext (making the
    // digest mandatory and scoping the download to the consented origin), downloads via
    // guarded-fetch, unpacks, and recomputes sha256 over the fetched bytes. The
    // recomputed digest does not match DECLARED_DIGEST, so it must reject.
    const installed = marketplace.install(PLUGIN_ID);

    // S004-O02 + S005-O02: the mismatch is detected and surfaced as a clear,
    // integrity-specific error, not a generic failure. `integrity-failed` is the
    // distinct code for "the bytes do not match the published digest", as opposed to
    // `missing-integrity` ("the entry carries no usable digest"), which is the
    // different pre-fetch refusal this journey is not asserting.
    await expect(
      installed,
      `CPHMTP-TC-049 step S004 (S004-O02) / S005 (S005-O02) diverged: expected installing the hostile plugin to be REJECTED with code "integrity-failed" once the recomputed sha256 failed to match the declared digest ${DECLARED_DIGEST}, but the install did not reject with that code. Owning slices: ${SLICE_MANDATORY_DIGEST} for the digest recompute + comparison, ${SLICE_GUARDED_FETCH} for the download.`,
    ).rejects.toMatchObject({ code: "integrity-failed" });

    const error = await installed.catch((err: unknown) => err as Error);
    // S005-O02: the error explains that the INTEGRITY CHECK is what failed. (The "and
    // the plugin was not installed" half of the observation is proven by the
    // fail-closed assertions below, which show no record, no artifact, no execution,
    // rather than by the message's wording.)
    expect(
      error.message,
      `CPHMTP-TC-049 step S005 (S005-O02) diverged: expected a clear error explaining that the integrity check failed, got "${error.message}". Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toMatch(/integrity/i);

    // S004-O01: guarded-fetch really downloaded the artifact (the digest recompute ran
    // over FETCHED bytes, not over a short-circuit), and it was scoped to the hostile
    // source's own consented origin.
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.length,
      `CPHMTP-TC-049 step S004 (S004-O01) diverged: expected guarded-fetch to download the artifact from the hostile source before the digest was recomputed, but undici.fetch was never called. Owning slice: ${SLICE_GUARDED_FETCH}.`,
    ).toBeGreaterThan(0);
    expect(
      String(fetchCalls[0][0]),
      `CPHMTP-TC-049 step S004 (S004-O01) diverged: expected the artifact download to target the hostile source's declared asset URL on its consented origin\n    expected: ${HOSTILE_ASSET_URL}\n    actual:   ${String(fetchCalls[0][0])}. Owning slice: ${SLICE_GUARDED_FETCH}.`,
    ).toBe(HOSTILE_ASSET_URL);

    // S005-O01 (fail closed): no plugin record is written, no artifact is left on disk,
    // and no plugin code is executed.
    expect(
      await listStaging(),
      `CPHMTP-TC-049 step S005 (S005-O01) diverged: expected the install to fail closed with NO artifact left on disk, but the staging root still holds ${JSON.stringify(
        await listStaging(),
      )}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toEqual([]);
    expect(
      pluginInstaller.__test.listTokens(),
      `CPHMTP-TC-049 step S005 (S005-O01) diverged: expected NO staging entry to be recorded for a rejected artifact (a recorded token would be committable), got ${JSON.stringify(
        pluginInstaller.__test.listTokens(),
      )}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toEqual([]);
    await expect(
      stat(path.join(pluginsRoot, PLUGIN_ID)),
      `CPHMTP-TC-049 step S005 (S005-O01) diverged: expected NO plugin directory to exist for the rejected hostile plugin, but ${path.join(
        pluginsRoot,
        PLUGIN_ID,
      )} was created. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).rejects.toMatchObject({ code: "ENOENT" });
    // No plugin record written, and no plugin code executed: registerInstalled is the
    // one call that both records the plugin and hands it to the runtime, so its absence
    // is what "no record is written and no plugin code is executed" means here.
    expect(
      vi.mocked(pluginManager.registerInstalled).mock.calls.length,
      `CPHMTP-TC-049 step S005 (S005-O01) diverged: expected NO plugin record to be written and NO plugin code to be executed for a rejected artifact, but plugin-manager.registerInstalled was called ${vi.mocked(pluginManager.registerInstalled).mock.calls.length} time(s). Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(0);

    // S005-O03: the source REMAINS registered so the user can retry from a corrected
    // artifact, with no partial state stranded. A failed install must not deregister
    // the source it came from.
    sourcesState.__test.reset();
    const stillRegistered = sourcesState.listSources();
    expect(
      stillRegistered.map((s) => s.url),
      `CPHMTP-TC-049 step S005 (S005-O03) diverged: expected the hostile source to REMAIN registered after the failed install (so the user can retry from a corrected artifact), got ${JSON.stringify(
        stillRegistered.map((s) => s.url),
      )}. Owning slices: ${SLICE_SOURCE_REGISTRY} for the registry row, ${SLICE_MANDATORY_DIGEST} for the fail-closed install.`,
    ).toEqual([HOSTILE_CATALOG_URL]);
    // No partial state stranded: exactly one row, not a duplicate or a half-written one.
    expect(
      stillRegistered.length,
      `CPHMTP-TC-049 step S005 (S005-O03) diverged: expected exactly one registered source row with no partial state stranded after the failed install, got ${stillRegistered.length}. Owning slice: ${SLICE_SOURCE_REGISTRY}.`,
    ).toBe(1);
  });
});
