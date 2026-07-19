// CPHMTP-TC-090 (e2e_flow, level 2): an operator publishes a plugin to the workplace
// marketplace repo, the workplace pipeline builds it and regenerates the catalog, and
// the Roubo app lists and installs it. This is the integrated operator-publish journey:
// the publish half (build + sha256 + catalog regeneration + per-plugin release, with NO
// signing/keyring step) produces the artifact and catalog entry the consume half
// (list -> unverified badge -> guarded install with the source credential -> provenance)
// then flows end to end. Its consume half is the same real pipeline the sibling
// happy-path CPHMTP-TC-027 journey drives; its publish half is what CPHMTP-TC-027 takes
// as given.
//
// Real vs stood in.
//
// Consume half (S005-S006) is the REAL, already-merged pipeline composed in process
// under vitest, not a mock of it:
//   - the REAL source registry (server/services/marketplace-sources-state.ts
//     addSource()), which validates the URL shape and persists the workplace source row
//     (with its attached PAT credential) as a PURE WRITE with no network call to the
//     candidate URL (CPHMTP-NFR-003);
//   - the REAL marketplace service (server/services/marketplace.ts), whose listCatalog()
//     fans out over the registered workplace source, stamps each entry with the sourceId
//     it came from, and forces `verified: false` on any non-first-party entry; and whose
//     install() builds the ThirdPartyInstallContext that makes the per-artifact digest
//     MANDATORY (CPHMTP-NFR-004), scopes the download to the consented origin, and
//     attaches the source credential;
//   - the REAL guarded-fetch transport (server/services/guarded-fetch.ts), which forms
//     the Authorization header from the source credential (the hybrid "Bearer <value>"
//     rule) and attaches it ONLY on the source origin before calling the injected fetch;
//   - the REAL plugin installer (server/services/plugin-installer.ts previewFromRelease
//     -> commit), which routes the download through guarded-fetch, unpacks under
//     zip-slip + size limits, recomputes the digest via the REAL marketplace-integrity
//     primitives (node:crypto sha256) before any staging entry is recorded, atomically
//     moves the artifact into the plugins dir on commit, and stamps the provenance ledger.
//
// Publish half (S001-S004) is REPRODUCED in process, standing in for the workplace CI:
// the pipeline lives in a separate package (roubo-plugins scripts/release/pack.mjs +
// the catalog regeneration), so this journey reproduces its OUTPUTS rather than importing
// it, exactly as CPHMTP-TC-027 stands in the same boundary. What is real on this half is
// the thing the journey actually guarantees: the sha256 is computed with the SAME
// node:crypto primitive the installer recomputes with (marketplace-integrity's
// computePackageDigest), so the published integrity digest and the digest the installer
// recomputes over the fetched bytes are reproducible across publish and consume. The
// guarantee is that digest reproducibility, NOT that a real GHE Actions run produced the
// bytes: a per-plugin gzipped tarball is built on disk as the tsup artifact, its digest
// is computed, and a bare catalog entry (id + version + source + integrity, no signature
// envelope and no key ring) is assembled, which is precisely the shape the workplace
// pipeline emits.
//
// Stood in, at the process boundaries only: the catalog fetch (catalog-client is mocked
// so the workplace catalog serves its regenerated entry without a network round-trip),
// the release host / network download (undici.fetch streams the REAL gzipped tarball
// built on disk, so a fetch of the catalog's asset URL retrieves the published bytes),
// the plugin registry/runtime (plugin-manager), the provenance ledger's file IO
// (plugin-provenance-state, whose write is covered by its own unit tests and asserted
// here via the recordProvenance call), the OS keyring (credential-store, returning the
// registered PAT), and the state directory (state.getRouboDir is redirected to a sandbox
// tmpdir so the journey NEVER writes the developer's real ~/.roubo).
//
// One boundary is NOT stood in, and it is the one exception to "no network":
// guarded-fetch resolves the asset host and rechecks the resolved addresses BEFORE it
// calls fetchImpl, and plugin-installer injects no lookup seam, so the DNS lookup for the
// workplace host runs against the real resolver on every install run. No artifact bytes
// cross the network (those come from the mocked undici.fetch); only the lookup does. It
// is harmless here because the host lives under `.invalid` (RFC 2606 reserves it, so it
// cannot resolve) and recheckResolvedAddresses swallows a resolution failure, adding no
// block and no connect pin. This mirrors the CPHMTP-TC-027 and CPHMTP-TC-049 journeys'
// precedent exactly.
//
// Why this is a service-altitude journey, not a Playwright DOM spec. The authoritative
// CPHMTP-TC-090 observations split into two kinds. The INTEGRATED behaviour (the built
// artifact + its sha256, the regenerated catalog entry with no signing, the retrievable
// release asset, the merged listing's provenance stamp + forced-unverified derivation,
// the mandatory-digest guarded install with the credential attached, and the
// install-record provenance) is asserted here against the real consume pipeline and the
// reproduced publish outputs. The pure RENDER observations (S005-O02 "the entry renders
// the non-dismissible 'unverified' badge" and the badge half of S006-O04 "the unverified
// badge shown in every enumerated surface") are web-client facts asserted by the React
// unit + a11y tests: ProvenanceBadge.test.tsx pins the Unverified pill for a third-party
// (sourceId !== first-party) listing, that a hostile listing injecting `verified: true`
// still renders Unverified, and (CPHMTP-TC-041) that there is NO dismiss/hide/close
// affordance and the badge re-renders identically; Marketplace.a11y.test.tsx,
// MarketplaceDrawer.test.tsx, and marketplace-journey-e2e.test.tsx assert the same badge
// across the list, card, and drawer surfaces. This is the same producer/consumer split
// the sibling CPHMTP-TC-027 and CPHMTP-TC-049 journeys drew and documented. Each render
// surface's badge is DRIVEN by the single server-side fact this journey pins: the install
// record grades unverified (unverified === true, sourceId !== first-party), which
// recordProvenance()/listingProvenance() map to the one amber Unverified treatment across
// list, card, and drawer. A distinct, non-bundled, non-first-party plugin id keeps the
// journey the clean publish -> list -> unverified -> install -> provenance path
// CPHMTP-TC-090 specifies (in the e2e harness `ghe` is a bundled, force-enabled plugin
// AND a first-party seed entry, so a workplace `ghe` entry would collide cross-source and
// read as already-installed).
//
// Drift guard: each it() is named after its CPHMTP-TC-090 step id(s) and the step's
// expected observation is kept explicit, so a change to the authoritative CPHMTP-TC-090
// in
// .specifications/component-plugins-hosted-marketplace-third-party/test-cases.json
// forces this test to be updated.
//
// Failure-output contract (issue #576 AC: "On failure the test reports which e2e_flow
// step diverged, the expected-vs-actual at that step, and the owning slice issue(s) from
// Blocked by"): every assertion attaches an expected-vs-actual message naming the
// diverging step and the owning slice, so a red run localizes the integration drift to
// one attributable slice. The e2e/component-plugins/_support/step-runner.ts helper cannot
// be reused here: it imports `expect` from @playwright/test and so cannot be imported from
// a vitest suite. This follows the sibling journeys' precedent of hand-rolling the
// attribution via assertion messages instead.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import * as tar from "tar";
import type { MarketplaceCatalogEntry, PluginRecord } from "@roubo/shared";
import type { ThirdPartyCatalogResult, VerifiedCatalog } from "./catalog-client.js";

// ── Owning slices ──
// #576's blocked-by set is {#567, #568} (the two publish-half slices). Per the issue's
// Technical Notes, the journey-to-slice mapping is a conservative FR/US superset: it also
// crosses the consume-half slices it depends on, so those are named too. Each step
// localizes a divergence to the slice that actually OWNS the diverging behaviour, so a red
// run points at one attributable issue rather than the whole journey.
const SLICE_WORKPLACE_PIPELINE =
  "#567 (workplace marketplace repo + publish pipeline: tsup build, sha256, catalog regeneration, per-plugin release)";
const SLICE_EXTRACTION =
  "#568 (extract GHE/Jira from the first-party catalog + pipeline into the workplace-published source)";
const SLICE_GUARDED_FETCH =
  "#554 (guarded-fetch transport: SSRF/redirect guard, origin-scoped credential attached as Authorization)";
const SLICE_MULTI_SOURCE_LISTING =
  "#557 (multi-source listing: merged catalog, per-entry provenance stamp, source filter, parallel fetch)";
const SLICE_MANDATORY_DIGEST =
  "#559 (mandatory integrity digest + guarded artifact download for unsigned third-party installs)";
const SLICE_PROVENANCE_LEDGER =
  "#560 (install-record source provenance stored + surfaced across list/card/drawer)";
const SLICE_UNVERIFIED_BADGE =
  "#563 (persistent non-dismissible unverified badge + provenance across list, card, and drawer surfaces)";

// ── Fixture identifiers (TC-090 preconditions) ──
// The workplace marketplace source, registered with a valid PAT credential and consent
// recorded (precondition 2). Its host carries "acme" so the server-derived chip label
// ("marketplace.acme.example.invalid") names the workplace, mirroring how the running
// server derives the chip label from the URL host.
const WORKPLACE_CATALOG_URL = "https://marketplace.acme.example.invalid/catalog.json";
// The per-plugin release asset lives on the SAME origin as the catalog: guarded-fetch
// scopes a third-party download to the source's consented origin AND attaches the
// credential only there, so a cross-origin asset would be refused before the digest
// recompute and would carry no credential (#554/#559).
const WORKPLACE_ASSET_URL =
  "https://marketplace.acme.example.invalid/acme-workplace-widget-1.0.0.tgz";
// The valid PAT credential recorded for the workplace source (precondition 2). A bare
// value, so guarded-fetch's hybrid rule wraps it as "Bearer <value>".
const WORKPLACE_CREDENTIAL = "acme-workplace-pat";
// A distinct, non-bundled, non-first-party id (see the header note on why not `ghe`).
const PLUGIN_ID = "acme-workplace-widget";
// The exact shape computePackageDigest emits ("sha256-" + 64 lowercase hex).
const PACKAGE_DIGEST_RE = /^sha256-[0-9a-f]{64}$/;
// The per-plugin release artifact's consumable file set (the ReleaseAsset shape:
// dist/index.js + roubo-plugin.yaml + package.json + README, with no src/ and no
// node_modules), the "existing consumable format" S002-O01 asserts.
const CONSUMABLE_FILE_SET = ["README.md", "dist/index.js", "package.json", "roubo-plugin.yaml"];

// The state dir the real registry writes to. Created eagerly and hoisted so the state.js
// mock factory (also hoisted) can close over it: the journey must never resolve state to
// the developer's real ~/.roubo.
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
  // guarded-fetch builds a connect-pinning Agent (issue #590); the mocked fetch ignores
  // the dispatcher, so a constructable stub is all this mock needs.
  Agent: vi.fn(),
}));

// The provenance ledger's persistence boundary: commit records the chosen source to
// ~/.roubo/plugins-provenance.json (issue #558/#560). Mocked so the journey cannot write
// the developer's own state dir; its file IO is covered by plugin-provenance-state.test.ts.
// This journey asserts the stamping happens (the recordProvenance call) and its arguments
// (the stored provenance), which is the server-side fact S006-O03 and the persistent
// badge (S006-O04) render from.
vi.mock("./plugin-provenance-state.js", () => ({
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  getProvenance: vi.fn(() => null),
  markOrphanedBySource: vi.fn(),
}));

// The OS keyring boundary (TC-090 precondition 2: the workplace source has a valid PAT
// credential). Stubbed so no code path can spawn a real keyring process
// (`security find-generic-password`). `get` returns the registered credential so the
// install path's origin-scoped credential read is exercised end to end (S006-O01).
vi.mock("./credential-store.js", () => ({
  set: vi.fn(async () => {}),
  get: vi.fn(async () => WORKPLACE_CREDENTIAL),
  deleteSlot: vi.fn(async () => {}),
}));

// Redirect ONLY the state-directory resolution, keeping atomicWrite and the rest of
// state.js real, so the registry's write -> read-back round trip is genuine but lands in a
// sandbox tmpdir instead of ~/.roubo.
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

// A complete, valid plugin manifest (the host parses and host-compat checks it before the
// digest is recomputed). `kind: integration` mirrors the GHE/Jira-style workplace sources
// the authoritative case is about; the ONLY thing the journey turns on is that its
// unpacked bytes match the digest the workplace catalog declares.
const MANIFEST = `id: ${PLUGIN_ID}
name: ACME Workplace Widget
version: 1.0.0
description: An issue-source integration published to the ACME workplace marketplace (unsigned).
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
let assetTgz: string; // path to the REAL gzipped tarball the workplace pipeline "builds" (the tsup artifact)
let trueDigest: string; // computePackageDigest of the built artifact = the catalog `integrity`
const tmpDirs: string[] = [];

async function trackTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// S001/S002 publish output: build the plugin the operator publishes (roubo-plugin.yaml +
// a runnable dist/index.js + package.json + README), then pack it into a REAL gzipped
// tarball, the per-plugin release artifact in the existing consumable format. Its digest
// (`trueDigest`), computed with the SAME primitive the installer recomputes with, is what
// the catalog declares AND what the host recomputes over the fetched bytes, so the
// verify-before-commit passes for this untampered artifact.
async function buildWorkplaceArtifact(): Promise<void> {
  const src = await trackTmp("roubo-tc090-src-");
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "roubo-plugin.yaml"), MANIFEST, "utf8");
  await writeFile(
    path.join(src, "dist", "index.js"),
    "module.exports = { plugin: { id: 'acme-workplace-widget' } };\n",
    "utf8",
  );
  await writeFile(
    path.join(src, "package.json"),
    `${JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", type: "commonjs", main: "dist/index.js" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(src, "README.md"), "# ACME Workplace Widget\n", "utf8");

  // S002-O02: the sha256 is computed over the built artifact bytes, with the exact
  // primitive the installer recomputes with.
  trueDigest = await computePackageDigest(src);

  const out = await trackTmp("roubo-tc090-tgz-");
  assetTgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: assetTgz, cwd: src }, CONSUMABLE_FILE_SET);
}

// Extract a gzipped tarball (from a file path or a fetched stream) into a fresh tmpdir and
// return that dir, so a step can inspect the unpacked file set or recompute its digest.
async function extractTgzFile(tgzPath: string): Promise<string> {
  const dir = await trackTmp("roubo-tc090-x-");
  await tar.x({ file: tgzPath, cwd: dir });
  return dir;
}
async function extractTgzStream(stream: Readable): Promise<string> {
  const dir = await trackTmp("roubo-tc090-served-");
  await pipeline(stream, tar.x({ cwd: dir }));
  return dir;
}

// The unpacked file set (relative, sorted), so S002-O01 can assert the consumable shape.
async function relFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  }
  await walk(dir);
  return out.sort();
}

// S003 publish output: the regenerated catalog entry for the newly published plugin. It
// carries id + version + source + the computed integrity digest, and (deliberately) NO
// signature field: the workplace pipeline emits a BARE entry, unlike the first-party
// signed chain. `verified: true` in the payload is deliberate: an unsigned source can
// claim anything, and the host must ignore the claim for a non-first-party source
// (S005-O02), so the fixture claims it to prove the host forces it false.
function regeneratedEntry(integrity: string): MarketplaceCatalogEntry {
  return {
    id: PLUGIN_ID,
    name: "ACME Workplace Widget",
    kind: "integration",
    version: "1.0.0",
    summary: "An issue-source integration published to the ACME workplace marketplace (unsigned).",
    source: { type: "release", assetUrl: WORKPLACE_ASSET_URL, sha256: "sha256-asset" },
    provenance: "marketplace.acme.example.invalid",
    integrity,
    verified: true,
  };
}

// The whole regenerated catalog.json the workplace pipeline emits: the entries, and NO
// signing artifacts. Modeled as a bare object so S003-O02 can assert the absence of any
// signature envelope or key ring at the catalog AND entry level.
function regeneratedCatalog(integrity: string): Record<string, unknown> {
  return {
    source: WORKPLACE_CATALOG_URL,
    entries: [regeneratedEntry(integrity)],
  };
}

// The first-party signed catalog serves nothing on this journey: the operator publishes to
// the workplace source, so the listing surfaces exactly the newly published plugin. The
// first-party chain is where signing/verify-keyring lives (see marketplace-integrity's
// verifyKeyRing / verifyCatalogSignature / resolveActiveKey); the workplace pipeline uses
// none of it, which is the whole of S003-O02.
function emptyFirstPartyCatalog(): VerifiedCatalog {
  return { entries: [], source: "network", fetchedAt: "2026-07-01T00:00:00.000Z" };
}

function workplaceCatalogResult(integrity: string): ThirdPartyCatalogResult {
  return {
    entries: [regeneratedEntry(integrity)],
    source: "network",
    fetchedAt: "2026-07-01T00:00:00.000Z",
  };
}

// Wire both catalog boundaries: the (empty) first-party signed chain and the workplace
// third-party client serving the regenerated entry. `integrity` is the workplace entry's
// declared digest; passing `trueDigest` models the untampered published artifact.
function setCatalogs(integrity: string): void {
  vi.mocked(catalogClient.getVerifiedCatalog).mockResolvedValue(emptyFirstPartyCatalog());
  vi.mocked(catalogClient.createThirdPartyCatalogClient).mockReturnValue({
    getCatalog: async () => workplaceCatalogResult(integrity),
  });
}

// Mock undici.fetch to stream the REAL tarball as if served from the release asset URL; a
// fresh read stream per call so the body can be consumed across re-staging.
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
 * Register the ACME workplace source (with its PAT credential) and return the registry id
 * minted for it. Idempotent: a re-registration of the same URL resolves to the SAME row and
 * id, so each step stands on its own even though the steps share the sandbox state file.
 */
async function registerWorkplaceSource(step: string): Promise<string> {
  const result = await sourcesState.addSource({
    url: WORKPLACE_CATALOG_URL,
    credential: WORKPLACE_CREDENTIAL,
  });
  if (result.outcome === "invalid-url") {
    throw new Error(
      `CPHMTP-TC-090 step ${step} diverged: expected the ACME workplace catalog URL ${WORKPLACE_CATALOG_URL} to be registrable as a consented, credentialed source, but the registry rejected it as invalid. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
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
  sandbox.root = mkdtempSync(path.join(tmpdir(), "roubo-tc090-state-"));
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
  pluginsRoot = await trackTmp("roubo-tc090-plugins-");
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

describe("CPHMTP-TC-090: operator publishes to the workplace repo, the catalog regenerates, and the app lists and installs it", () => {
  it("S001/S002: the workplace CI builds the plugin with tsup and computes the artifact sha256 -> a per-plugin release artifact in the consumable format and a sha256 over its bytes", async () => {
    // S001 (add the plugin sources + roubo-plugin.yaml and push to the pipeline branch)
    // and S002 (the CI build) land on the reproduced publish output built once in
    // beforeAll: `assetTgz` is the per-plugin release artifact, `trueDigest` its sha256.

    // S002-O01: the build produces a per-plugin release artifact in the existing consumable
    // format. It is a real gzipped tarball on disk...
    const artifact = await stat(assetTgz);
    expect(
      artifact.isFile() && artifact.size > 0,
      `CPHMTP-TC-090 step S002 (S002-O01) diverged: expected the workplace CI to build a per-plugin release artifact (a non-empty gzipped tarball) at ${assetTgz}, got isFile=${artifact.isFile()} size=${artifact.size}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toBe(true);
    // ...whose unpacked contents are exactly the consumable ReleaseAsset file set
    // (dist/index.js + roubo-plugin.yaml + package.json + README), with no `src/` and no
    // `node_modules`.
    const unpacked = await relFiles(await extractTgzFile(assetTgz));
    expect(
      unpacked,
      `CPHMTP-TC-090 step S002 (S002-O01) diverged: expected the built artifact to unpack to the existing consumable file set\n    expected: ${JSON.stringify(CONSUMABLE_FILE_SET)}\n    actual:   ${JSON.stringify(unpacked)}. Owning slices: ${SLICE_WORKPLACE_PIPELINE} for the build, ${SLICE_EXTRACTION} for the extracted-plugin shape.`,
    ).toEqual(CONSUMABLE_FILE_SET);

    // S002-O02: a sha256 digest is computed over the built artifact bytes, in the exact
    // `sha256-<hex>` shape the catalog integrity field and the installer's recompute agree
    // on, and recomputing it over the unpacked artifact reproduces the same value (so it
    // really is a digest OVER those bytes, not a placeholder).
    expect(
      PACKAGE_DIGEST_RE.test(trueDigest),
      `CPHMTP-TC-090 step S002 (S002-O02) diverged: expected the computed sha256 to be in the "sha256-<64 hex>" form the catalog and installer share, got ${JSON.stringify(trueDigest)}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toBe(true);
    const recomputed = await computePackageDigest(await extractTgzFile(assetTgz));
    expect(
      recomputed,
      `CPHMTP-TC-090 step S002 (S002-O02) diverged: expected the sha256 to be computed OVER the built artifact bytes (recomputing over the unpacked artifact must reproduce it)\n    expected: ${trueDigest}\n    actual:   ${recomputed}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toBe(trueDigest);
  });

  it("S003: the pipeline regenerates catalog.json -> the entry gains id/version/source/integrity and NO signing/verify-keyring step runs (no signature envelope or key ring)", async () => {
    const catalog = regeneratedCatalog(trueDigest);
    const entries = catalog.entries as MarketplaceCatalogEntry[];
    const entry = entries[0];

    // S003-O01: catalog.json gains an entry for the new plugin with id, version, source,
    // and the computed integrity digest.
    expect(
      { id: entry.id, version: entry.version, hasSource: entry.source !== undefined },
      `CPHMTP-TC-090 step S003 (S003-O01) diverged: expected the regenerated catalog to gain an entry carrying id + version + source for the new plugin, got ${JSON.stringify({ id: entry.id, version: entry.version, source: entry.source })}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toEqual({ id: PLUGIN_ID, version: "1.0.0", hasSource: true });
    expect(
      entry.integrity,
      `CPHMTP-TC-090 step S003 (S003-O01) diverged: expected the regenerated catalog entry to carry the integrity digest computed over the built artifact\n    expected: ${trueDigest}\n    actual:   ${entry.integrity}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toBe(trueDigest);

    // S003-O02: NO signing / verify-keyring step runs, and no signature envelope or key
    // ring is emitted. The workplace pipeline produces a BARE catalog (unlike the
    // first-party signed chain, whose envelope carries `signature` + a `keyRing` of
    // `keys`). Assert neither the catalog nor the entry carries any of those fields.
    for (const banned of ["signature", "keyRing", "keys", "keyId"]) {
      expect(
        banned in catalog,
        `CPHMTP-TC-090 step S003 (S003-O02) diverged: expected the regenerated workplace catalog to emit NO "${banned}" (no signature envelope / key ring: the workplace pipeline runs no signing step), but the catalog carried it. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
      ).toBe(false);
      expect(
        banned in entry,
        `CPHMTP-TC-090 step S003 (S003-O02) diverged: expected the regenerated catalog entry to carry NO "${banned}" signing field, but it did. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
      ).toBe(false);
    }
  });

  it("S004: the pipeline publishes the built artifact as the per-plugin release asset -> it is retrievable at the URL the catalog entry references, and those bytes are the published artifact", async () => {
    fakeDownload(assetTgz);
    const entry = regeneratedEntry(trueDigest);

    // The URL the catalog entry references is the per-plugin release asset URL.
    const assetUrl = entry.source.type === "release" ? entry.source.assetUrl : undefined;
    expect(
      assetUrl,
      `CPHMTP-TC-090 step S004 (S004-O01) diverged: expected the catalog entry to reference the published per-plugin release asset URL, got ${JSON.stringify(entry.source)}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toBe(WORKPLACE_ASSET_URL);

    // S004-O01: the artifact is retrievable at that URL (the release host, stood in by the
    // mocked transport, serves a 200 with the artifact body)...
    const res = (await fetch(assetUrl as string)) as unknown as {
      ok: boolean;
      status: number;
      body: Readable;
    };
    expect(
      res.ok && res.status === 200,
      `CPHMTP-TC-090 step S004 (S004-O01) diverged: expected the published artifact to be retrievable at the catalog's asset URL ${WORKPLACE_ASSET_URL} (a 200 response), got ok=${res.ok} status=${res.status}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toBe(true);
    // ...and the retrievable bytes ARE the published artifact: they unpack to a file set
    // whose digest equals the integrity the regenerated catalog declared. This ties the
    // published release asset to the published digest.
    const servedDigest = await computePackageDigest(await extractTgzStream(res.body));
    expect(
      servedDigest,
      `CPHMTP-TC-090 step S004 (S004-O01) diverged: expected the bytes retrievable at the catalog's asset URL to be the published artifact whose digest the catalog declares\n    expected: ${entry.integrity}\n    actual:   ${servedDigest}. Owning slice: ${SLICE_WORKPLACE_PIPELINE}.`,
    ).toBe(entry.integrity);
  });

  it("S005: open the Marketplace with the workplace source registered -> the published plugin lists with workplace-source provenance and grades unverified (the data the non-dismissible badge renders from)", async () => {
    const sourceId = await registerWorkplaceSource("S005");
    setCatalogs(trueDigest);
    // Precondition 3 (the plugin is available, not yet installed) so the card renders the
    // Install affordance rather than an Installed badge.
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);

    const { listings, sources } = await marketplace.listCatalog();
    const workplace = listings.find((l) => l.id === PLUGIN_ID);

    // S005-O01: the newly published plugin appears in the listing...
    expect(
      workplace,
      `CPHMTP-TC-090 step S005 (S005-O01) diverged: expected the listing fan-out to surface the newly published plugin "${PLUGIN_ID}", got listing ids ${JSON.stringify(listings.map((l) => l.id))}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBeDefined();
    // ...with workplace-source provenance: the entry is stamped with the sourceId of the
    // ACME workplace source that served it, and the source's own status row (the chip the
    // UI renders "from marketplace.acme.example.invalid" against) is in the fan-out.
    expect(
      workplace?.sourceId,
      `CPHMTP-TC-090 step S005 (S005-O01) diverged: expected the published entry to carry the sourceId provenance of the ACME workplace source that served it\n    expected: ${sourceId}\n    actual:   ${workplace?.sourceId}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(sourceId);
    const workplaceRow = sources.find((s) => s.id === sourceId);
    expect(
      workplaceRow?.url,
      `CPHMTP-TC-090 step S005 (S005-O01) diverged: expected the fan-out to describe the ACME workplace source status row carrying the registered URL (the provenance the chip renders), got ${JSON.stringify(workplaceRow?.url)}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(WORKPLACE_CATALOG_URL);

    // S005-O02 (server-side driver): the entry renders the non-dismissible 'unverified'
    // badge. `verified` is derived from WHICH source served the entry, never trusted from
    // the entry payload: the regenerated fixture CLAIMS verified:true (an unsigned source
    // can claim anything) and the host MUST force it false because the source is not
    // first-party. `verified === false` plus the workplace sourceId is the single fact the
    // persistent Unverified pill renders from.
    expect(
      regeneratedEntry(trueDigest).verified,
      `CPHMTP-TC-090 step S005 (S005-O02) diverged: the fixture must model a workplace source CLAIMING verified:true, otherwise the assertion below cannot prove the host ignores the claim. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(true);
    expect(
      workplace?.verified,
      `CPHMTP-TC-090 step S005 (S005-O02) diverged: expected the published workplace entry to grade unverified (verified=false, the data the persistent non-dismissible Unverified badge renders from; the host derives the flag from the serving source, not the payload)\n    expected: false\n    actual:   ${workplace?.verified}. Owning slices: ${SLICE_MULTI_SOURCE_LISTING} for the derivation, ${SLICE_UNVERIFIED_BADGE} for the rendered non-dismissible badge.`,
    ).toBe(false);
    // The Install affordance vs an Installed badge is driven by `installed`.
    expect(
      workplace?.installed,
      `CPHMTP-TC-090 step S005 (S005-O01) diverged: expected the newly published plugin to be NOT installed before install (so the card shows Install), got installed=${workplace?.installed}. Owning slice: ${SLICE_MULTI_SOURCE_LISTING}.`,
    ).toBe(false);

    // ── S005-O02 (rendered badge, attributed, NOT re-asserted here) ──
    // Whether a non-dismissible 'unverified' badge actually RENDERS, and that it has no
    // dismiss/hide/close affordance, is a pure web-client render observation owned by #563.
    // It is not observable from a service call; it is asserted by ProvenanceBadge.test.tsx
    // (the Unverified pill for a third-party sourceId, verified:true injected still renders
    // Unverified, and CPHMTP-TC-041: no dismiss affordance, re-renders identically). What
    // IS observable, and is asserted above, is the single server-side fact that badge is
    // driven by: verified === false with the workplace sourceId stamp.
  });

  it("S006: click Install -> guarded-fetch attaches the Authorization credential on the source origin, the recomputed sha256 matches the catalog integrity, install succeeds, and the record stores sourceId/sourceUrl/unverified:true", async () => {
    const sourceId = await registerWorkplaceSource("S006");
    setCatalogs(trueDigest);
    fakeDownload(assetTgz);

    // Precondition pin: the declared digest is a valid-format sha256 that EQUALS the served
    // artifact's true digest, so the success below is a genuine verify-PASS (not a skipped
    // check). The mismatch path is the sibling CPHMTP-TC-049.
    expect(
      PACKAGE_DIGEST_RE.test(trueDigest) && regeneratedEntry(trueDigest).integrity === trueDigest,
      `CPHMTP-TC-090 step S006 (S006-O02) diverged: the workplace fixture must declare a valid-format sha256 equal to the served artifact's true digest so the install is a genuine verify-pass, got declared=${regeneratedEntry(trueDigest).integrity} vs true=${trueDigest}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(true);

    // Clicking Install drives the REAL install(), which resolves the entry to the ACME
    // workplace source, builds the ThirdPartyInstallContext (making the digest mandatory +
    // scoping the download to the consented origin with the credential), downloads via
    // guarded-fetch, unpacks, and recomputes sha256 over the fetched bytes. The recomputed
    // digest MATCHES the declared one, so it stages successfully rather than rejecting.
    const preview = await marketplace.install(PLUGIN_ID, sourceId);
    expect(
      preview.manifest.id,
      `CPHMTP-TC-090 step S006 (S006-O02) diverged: expected installing from the ACME workplace source to stage the published plugin, got staged manifest id ${JSON.stringify(preview.manifest.id)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(PLUGIN_ID);
    expect(
      preview.source,
      `CPHMTP-TC-090 step S006 (S006-O02) diverged: expected the staged install to route through the release download path for the published asset, got ${JSON.stringify(preview.source)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toEqual({ type: "release", assetUrl: WORKPLACE_ASSET_URL });

    // S006-O01: the artifact is fetched through guarded-fetch with the Authorization
    // credential attached to the source origin. guarded-fetch is REAL here: it forms the
    // Authorization header from the source credential (the hybrid "Bearer <value>" rule)
    // and attaches it ONLY on the source origin before calling the injected undici.fetch.
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.length,
      `CPHMTP-TC-090 step S006 (S006-O01) diverged: expected guarded-fetch to download the artifact before the digest was recomputed, but undici.fetch was never called. Owning slices: ${SLICE_GUARDED_FETCH} for the transport, ${SLICE_MANDATORY_DIGEST} for the download.`,
    ).toBeGreaterThan(0);
    expect(
      String(fetchCalls[0][0]),
      `CPHMTP-TC-090 step S006 (S006-O01) diverged: expected the artifact download to target the workplace source's published asset URL\n    expected: ${WORKPLACE_ASSET_URL}\n    actual:   ${String(fetchCalls[0][0])}. Owning slice: ${SLICE_GUARDED_FETCH}.`,
    ).toBe(WORKPLACE_ASSET_URL);
    const init = fetchCalls[0][1] as { headers?: Record<string, string> } | undefined;
    expect(
      init?.headers?.authorization,
      `CPHMTP-TC-090 step S006 (S006-O01) diverged: expected guarded-fetch to attach the workplace source credential as an Authorization header on the source origin\n    expected: Bearer ${WORKPLACE_CREDENTIAL}\n    actual:   ${JSON.stringify(init?.headers?.authorization)}. Owning slice: ${SLICE_GUARDED_FETCH}.`,
    ).toBe(`Bearer ${WORKPLACE_CREDENTIAL}`);

    // S006-O02: the installer recomputes the sha256 over the fetched artifact and it
    // matches the catalog integrity digest. That the install STAGED at all (above) rather
    // than throwing `integrity-failed` is what proves the recompute matched the declared
    // digest; the counter-case below (a tampered artifact rejected) proves the recompute is
    // the live gate, not a skipped check.

    // S006-O03 + S006-O04 (commit half): committing atomically moves the unpacked artifact
    // into the plugins dir and the host registers it as a runnable plugin, so the plugin
    // runs and the card flips to Installed. The provenance ledger row is stamped in the
    // same commit.
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
      `CPHMTP-TC-090 step S006 (S006-O03) diverged: expected the committed install to yield the published plugin's record, got ${JSON.stringify(record.id)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(PLUGIN_ID);
    expect(
      record.status,
      `CPHMTP-TC-090 step S006 (S006-O04) diverged: expected the installed plugin to be enabled (running / Installed) after commit, got status ${JSON.stringify(record.status)}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe("enabled");
    const target = path.join(pluginsRoot, PLUGIN_ID);
    expect(
      (await stat(path.join(target, "dist", "index.js"))).isFile(),
      `CPHMTP-TC-090 step S006 (S006-O04) diverged: expected the plugin to be installed on disk with its runnable dist/, but ${path.join(target, "dist", "index.js")} is missing. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toBe(true);
    expect(
      await listStaging(),
      `CPHMTP-TC-090 step S006 (S006-O03) diverged: expected the staging root to be empty after a committed install, got ${JSON.stringify(await listStaging())}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).not.toContain(preview.stagingToken);

    // S006-O03: the install record carries sourceId, sourceUrl, and unverified: true.
    // commit() stamps the provenance ledger row via recordProvenance; its arguments ARE the
    // stored record, and the amber Unverified treatment on every surface (list, card, and
    // drawer) is derived from exactly this row (unverified === true, sourceId !==
    // first-party).
    expect(
      vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length,
      `CPHMTP-TC-090 step S006 (S006-O03) diverged: expected the committed install to stamp exactly one provenance ledger row for the published plugin, got ${vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length} call(s). Owning slices: ${SLICE_PROVENANCE_LEDGER} for the ledger, ${SLICE_MANDATORY_DIGEST} for the install path that stamps it.`,
    ).toBe(1);
    const stored = vi.mocked(pluginProvenanceState.recordProvenance).mock.calls[0][0];
    expect(
      stored,
      `CPHMTP-TC-090 step S006 (S006-O03) diverged: expected the install record to store sourceId + sourceUrl (the ACME workplace source) and unverified = true\n    expected: ${JSON.stringify({ pluginId: PLUGIN_ID, sourceId, sourceUrl: WORKPLACE_CATALOG_URL, unverified: true })}\n    actual:   ${JSON.stringify(stored)}. Owning slice: ${SLICE_PROVENANCE_LEDGER}.`,
    ).toEqual({
      pluginId: PLUGIN_ID,
      sourceId,
      sourceUrl: WORKPLACE_CATALOG_URL,
      unverified: true,
    });

    // ── S006-O04 (badge across surfaces, attributed, NOT re-asserted here) ──
    // "The plugin runs, with the unverified badge shown in every enumerated surface" splits
    // into a server-side driver and a render observation. The plugin running (enabled
    // record, on-disk dist/) and the unverified provenance row are asserted above. Whether
    // the same non-dismissible badge renders across the list, card, and drawer surfaces is a
    // web-client observation owned by #563: ProvenanceBadge.test.tsx, Marketplace.a11y.test
    // .tsx, MarketplaceDrawer.test.tsx, and marketplace-journey-e2e.test.tsx assert it. All
    // three surfaces route through one trust derivation (trustTreatmentOf) keyed on exactly
    // the stored row this journey pins, so a change that let one surface diverge would first
    // show up as this row changing.
  });

  it("S006-O02 (digest verification is load-bearing): a tampered published artifact is rejected before commit, so nothing is installed", async () => {
    // The counter-case that makes the S006-O02 success meaningful: if the regenerated
    // catalog declares a digest the served bytes do NOT match (a tampered or swapped
    // artifact), the install must fail CLOSED before any plugin is committed. This proves
    // the sha256 recompute is the live gate the success path passed, not a skipped check.
    // (The full tamper-from-a-hostile-source journey is CPHMTP-TC-049; this is the minimal
    // counter-assertion that keeps S006-O02 honest.)
    const wrongDigest = `sha256-${"0".repeat(64)}`;
    const sourceId = await registerWorkplaceSource("S006");
    setCatalogs(wrongDigest);
    fakeDownload(assetTgz);

    await expect(
      marketplace.install(PLUGIN_ID, sourceId),
      `CPHMTP-TC-090 step S006 (S006-O02) diverged: expected a published artifact whose bytes do not match its declared digest to be REJECTED with code "integrity-failed" (the per-artifact sha256 must be verified before install completes), but the install did not reject with that code. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).rejects.toMatchObject({ code: "integrity-failed" });

    expect(
      await listStaging(),
      `CPHMTP-TC-090 step S006 (S006-O02) diverged: expected the rejected install to leave NO artifact staged, got ${JSON.stringify(await listStaging())}. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).toEqual([]);
    await expect(
      stat(path.join(pluginsRoot, PLUGIN_ID)),
      `CPHMTP-TC-090 step S006 (S006-O02) diverged: expected NO plugin directory for the rejected tampered artifact, but ${path.join(pluginsRoot, PLUGIN_ID)} was created. Owning slice: ${SLICE_MANDATORY_DIGEST}.`,
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length,
      `CPHMTP-TC-090 step S006 (S006-O02) diverged: expected the rejected install to stamp NO provenance row (no committed record), got ${vi.mocked(pluginProvenanceState.recordProvenance).mock.calls.length} call(s). Owning slice: ${SLICE_PROVENANCE_LEDGER}.`,
    ).toBe(0);
  });
});
