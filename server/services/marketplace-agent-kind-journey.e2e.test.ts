// AP-TC-117 / AP-TC-120 / AP-TC-122 (issue #522): marketplace distribution for the
// AGENT kind. An agent-kind listing installs in one click through consent and
// integrity-digest verification and moves to Installed (AP-TC-117); a tampered
// agent package fails digest verification, aborts, and writes nothing (AP-TC-120);
// and an agent whose CLI is absent from the machine still installs successfully,
// because the install path never touches the agent binary (AP-TC-122 S001).
//
// Why this journey exists at all, given the install pipeline already shipped.
// `server/services/plugin-installer.ts` contains the string "kind" exactly zero
// times: staging, unpack, digest recompute, consent gate and commit are all
// kind-agnostic, so nothing in AP-TC-117 / AP-TC-120 needed BUILDING for the third
// kind. What it needed was PROVING: AP-NFR-001 (the integrity guarantee) is
// asserted by AP-TC-120 alone, and an untested assumption that a path is
// kind-agnostic is exactly the assumption a later kind-gated optimisation breaks
// silently. This journey pins it.
//
// The "running system" here is the REAL, already-merged pipeline composed in
// process under vitest, not a mock of it:
//   - the REAL marketplace service (server/services/marketplace.ts), whose
//     listCatalog() annotates the agent entry with its install state and its
//     derived compatibility window, and whose install() runs the network gate and
//     routes on source.type;
//   - the REAL plugin installer (server/services/plugin-installer.ts
//     previewFromRelease -> commit), which streams the tarball under the download
//     cap, unpacks it under zip-slip + size limits, recomputes the unpacked
//     artifact's digest via the REAL marketplace-integrity primitives (node:crypto
//     sha256) BEFORE recording any staging entry, and atomically moves the artifact
//     into the plugins dir on commit;
//   - the REAL manifest schema, which is what enforces that an agent manifest
//     declares `processes: false`, so the fixture below is a genuinely valid agent
//     plugin rather than a component wearing an `agent` label;
//   - the REAL consent ledger (server/services/plugin-consent-state.ts), writing
//     and reading back through its own atomicWrite discipline.
//
// Stood in, at the process boundaries only: the catalog fetch (catalog-client is
// mocked so the entry is served without a network round-trip), the network download
// (undici.fetch streams a REAL gzipped tarball built on disk), the plugin
// registry/runtime (plugin-manager), the provenance ledger's file IO
// (plugin-provenance-state), and the state directory (state.getRouboDir is
// redirected to a sandbox tmpdir so the journey NEVER writes the developer's real
// ~/.roubo).
//
// The AP-TC-122 precondition, made real rather than asserted: the fixture's
// manifest declares a version probe naming a command that cannot exist on any
// machine (AGENT_CLI_COMMAND below). Nothing on the install path resolves it, which
// is the point: the install completes anyway. The UNCONFIGURED-state half of
// AP-TC-122 (the card showing CLI guidance instead of "Ready") is a web-client
// observation and is asserted in
// client/src/components/settings/agents/AgentPluginCard.test.tsx, where it is
// observable.
//
// Drift guard: each it() is named after its AP-TC id and step, so a change to the
// authoritative cases in .specifications/agent-plugins/test-cases.json forces this
// test to be updated.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { MarketplaceCatalogEntry, PluginRecord } from "@roubo/shared";
import type { VerifiedCatalog } from "./catalog-client.js";

// The state dir the real consent ledger writes to. Created eagerly and hoisted so
// the state.js mock factory (also hoisted) can close over it.
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

vi.mock("./plugin-provenance-state.js", () => ({
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  getProvenance: vi.fn(() => null),
  markOrphanedBySource: vi.fn(),
}));

vi.mock("./marketplace-sources-state.js", () => ({
  FIRST_PARTY_URL: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  listSources: vi.fn(() => []),
  readSourceCredential: vi.fn(async () => null),
}));

// Redirect ONLY the state-directory resolution, keeping atomicWrite and the rest
// of state.js real, so the consent ledger's write -> read-back round trip is
// genuine but lands in a sandbox tmpdir instead of ~/.roubo.
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
import * as consentState from "./plugin-consent-state.js";
import { computePackageDigest } from "./marketplace-integrity.js";
import { fetch } from "undici";
import { resolveWithin } from "../lib/safe-path.js";

const PLUGIN_ID = "gemini-cli";
const ASSET_URL = "https://releases.example.invalid/gemini-cli-0.4.0.tgz";

// AP-TC-122's precondition made structural: a probe command that cannot resolve on
// any machine, so "the agent CLI targeted by the plugin is not installed" is true by
// construction rather than by hoping the CI box lacks a real binary.
const AGENT_CLI_COMMAND = "roubo-nonexistent-agent-cli-ap-tc-122";

// A complete, valid AGENT manifest. `processes: false` is not decoration: the real
// PluginManifestSchema REFUSES a `processes` permission for kind agent (issue #632),
// so this fixture only parses because it is a genuine agent plugin.
const MANIFEST = `id: ${PLUGIN_ID}
name: Gemini CLI
version: 0.4.0
description: An agent plugin published to the marketplace as a built artifact.
kind: agent
roubo: ^1.0.0
entry: dist/index.js
contractVersion: 1
agentCompatibility:
  minVersion: 0.4.0
  testedCeiling: 0.6.1
  probe:
    command: ${AGENT_CLI_COMMAND}
    args:
      - --version
    parse: semver
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
  ports: false
  docker: false
`;

type FetchResult = Awaited<ReturnType<typeof fetch>>;

let pluginsRoot: string;
let assetTgz: string; // path to the REAL gzipped tarball the marketplace serves
let dirDigest: string; // computePackageDigest of the unpacked artifact = catalog `integrity`
const tmpDirs: string[] = [];

async function trackTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Build the published agent artifact on disk, then pack it into a REAL gzipped
// tarball. The unpacked-directory digest is the catalog entry's `integrity`, the
// value the host re-verifies before commit.
async function buildAgentArtifact(): Promise<void> {
  const src = await trackTmp("roubo-ap522-src-");
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "roubo-plugin.yaml"), MANIFEST, "utf8");
  await writeFile(
    path.join(src, "dist", "index.js"),
    "module.exports = { plugin: { id: 'gemini-cli' } };\n",
    "utf8",
  );
  await writeFile(
    path.join(src, "package.json"),
    `${JSON.stringify({ name: PLUGIN_ID, version: "0.4.0", type: "commonjs", main: "dist/index.js" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(src, "README.md"), "# Gemini CLI\n", "utf8");

  dirDigest = await computePackageDigest(src);

  const out = await trackTmp("roubo-ap522-tgz-");
  assetTgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: assetTgz, cwd: src }, [
    "roubo-plugin.yaml",
    "dist/index.js",
    "package.json",
    "README.md",
  ]);
}

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

function agentEntry(integrity: string): MarketplaceCatalogEntry {
  return {
    id: PLUGIN_ID,
    name: "Gemini CLI",
    kind: "agent",
    version: "0.4.0",
    summary: "Run benches on an AI coding agent.",
    source: { type: "release", assetUrl: ASSET_URL, sha256: "sha256-asset" },
    provenance: "github.com/davidpoxon/roubo-plugins",
    integrity,
    verified: true,
  };
}

function setCatalog(integrity: string) {
  const catalog: VerifiedCatalog = {
    entries: [agentEntry(integrity)],
    source: "network",
    fetchedAt: "2026-08-01T00:00:00.000Z",
  };
  vi.mocked(catalogClient.getVerifiedCatalog).mockResolvedValue(catalog);
}

function installedAgentRecord(): PluginRecord {
  return {
    id: PLUGIN_ID,
    manifest: {
      id: PLUGIN_ID,
      name: "Gemini CLI",
      version: "0.4.0",
      description: "An agent plugin published to the marketplace as a built artifact.",
      kind: "agent",
      roubo: "^1.0.0",
      entry: "dist/index.js",
      agentCompatibility: { minVersion: "0.4.0", testedCeiling: "0.6.1" },
      permissions: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
      },
    },
    manifestPath: path.join(pluginsRoot, PLUGIN_ID, "roubo-plugin.yaml"),
    pluginDir: path.join(pluginsRoot, PLUGIN_ID),
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
  } as PluginRecord;
}

async function listStaging(): Promise<string[]> {
  try {
    return await readdir(resolveWithin(pluginInstaller.__test.stagingRoot()));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  sandbox.root = mkdtempSync(path.join(tmpdir(), "roubo-ap522-state-"));
  tmpDirs.push(sandbox.root);
  await buildAgentArtifact();
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
  consentState.__test.reset();
  pluginsRoot = await trackTmp("roubo-ap522-plugins-");
  vi.mocked(pluginManager.getUserPluginsRoot).mockReturnValue(pluginsRoot);
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(pluginManager.registerInstalled).mockReset();
  vi.mocked(fetch).mockReset();
  await rm(path.join(sandbox.root, "plugins-consent.json"), { force: true });
});

afterEach(async () => {
  await rm(pluginsRoot, { recursive: true, force: true });
});

describe("AP-TC-117: one-click install moves a marketplace agent plugin into the Installed list", () => {
  it("S001: the agent entry lists as not-installed with an install affordance and a declared compatibility window", async () => {
    setCatalog(dirDigest);
    const { listings } = await marketplace.listCatalog();
    const agent = listings.find((l) => l.id === PLUGIN_ID);

    expect(
      agent,
      `AP-TC-117 step S001 diverged: expected the agent-kind entry "${PLUGIN_ID}" to list, got ${JSON.stringify(
        listings.map((l) => l.id),
      )}.`,
    ).toBeDefined();
    expect(agent?.kind).toBe("agent");
    // "Not yet installed" IS the install affordance at this altitude: the card
    // renders Install exactly when installed is false and updateAvailable is false.
    expect(agent?.installed).toBe(false);
    expect(agent?.updateAvailable).toBe(false);
  });

  it("S001/S002: install stages behind the consent gate, the digest is verified, and commit lands the plugin", async () => {
    setCatalog(dirDigest);
    fakeDownload(assetTgz);

    // S001-O01: install() STAGES and stops. It returns a preview carrying the
    // manifest's declared permissions and a staging token; nothing is committed
    // until the consumer confirms. That preview IS the single consent prompt: one
    // per install, and the only gate between staging and commit.
    const preview = await marketplace.install(PLUGIN_ID);
    expect(preview.manifest.id).toBe(PLUGIN_ID);
    expect(preview.manifest.kind).toBe("agent");
    expect(preview.source).toEqual({ type: "release", assetUrl: ASSET_URL });
    expect(pluginInstaller.isValidStagingToken(preview.stagingToken)).toBe(true);
    expect(
      await stat(path.join(pluginsRoot, PLUGIN_ID)).catch((e: NodeJS.ErrnoException) => e.code),
      "AP-TC-117 step S001 diverged: staging must not write the plugin directory before consent.",
    ).toBe("ENOENT");

    // S002-O01: the package integrity digest is verified. What proves it is the
    // PAIR: this preview exists only because the digest recomputed over the
    // unpacked artifact matched the catalog's declared `integrity`, and the
    // AP-TC-120 case below feeds the same pipeline the same bytes under a
    // mismatched declaration and gets `integrity-failed` instead of a preview.
    // Re-asserting the shape of `dirDigest` here would prove nothing: the test
    // computed that value itself.
    expect(preview.stagingToken).not.toBe("");

    // S002-O02: accepting completes the install with no further manual steps.
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(installedAgentRecord());
    const record = await pluginInstaller.commit(preview.stagingToken);
    expect(record.id).toBe(PLUGIN_ID);
    expect(record.status).toBe("enabled");

    const target = path.join(pluginsRoot, PLUGIN_ID);
    expect((await stat(path.join(target, "roubo-plugin.yaml"))).isFile()).toBe(true);
    expect((await stat(path.join(target, "dist", "index.js"))).isFile()).toBe(true);
    expect(pluginManager.registerInstalled).toHaveBeenCalledWith(target);
    expect(await listStaging()).not.toContain(preview.stagingToken);

    // Consent is NOT written by this layer: `marketplace.install()` and
    // `pluginInstaller.commit()` never touch the ledger. The route does it
    // (`POST /plugins/install/:token/confirm`, server/routes/plugins.ts), after
    // commit succeeds. So the call below STANDS IN for that route, and what it
    // pins is the ledger's own write/read-back round trip for an agent id, not
    // the install path. Without a consent record the agent registry refuses to
    // resolve the plugin (AP-TC-014 S002), which is what makes an installed agent
    // usable, so it is worth pinning here even though the install path is not
    // what mints it.
    consentState.upsertConsent(PLUGIN_ID, ["network"]);
    consentState.__test.reset();
    expect(consentState.hasConsent(PLUGIN_ID)).toBe(true);
  });

  it("S003: after install the agent listing reads as Installed rather than as an install candidate", async () => {
    setCatalog(dirDigest);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([installedAgentRecord()]);

    const { listings } = await marketplace.listCatalog();
    const agent = listings.find((l) => l.id === PLUGIN_ID);

    // S003-O01 / S003-O02: one flag drives both halves of the observation. The card
    // renders the "Installed" badge and NO install affordance for `installed: true`,
    // which is what "appears under Installed, no longer offered in Marketplace"
    // means on the shipped surface (the UX is one list with a state-aware card, not
    // two lists; see the note on the navigation mismatch in issue #522).
    expect(agent?.installed).toBe(true);
    expect(agent?.installedVersion).toBe("0.4.0");
    expect(agent?.updateAvailable).toBe(false);
    // And the derived window follows the installed manifest, so the post-install
    // card and the pre-install listing agree.
    expect(agent?.agentCompatibility).toEqual({ minVersion: "0.4.0", testedCeiling: "0.6.1" });
  });
});

describe("AP-TC-120: a tampered agent package fails digest verification and is not installed", () => {
  it("S001/S002/S003: the digest mismatch aborts the install and nothing is written", async () => {
    // The precondition: the catalog declares a VALID-FORMAT digest that the served
    // bytes do not match. A malformed or absent digest is a DIFFERENT refusal
    // (`missing-integrity`, pre-fetch), which this case is not about.
    const declared = `sha256-${"a".repeat(64)}`;
    expect(
      declared,
      "AP-TC-120 precondition diverged: the tampered fixture must declare a digest the artifact does not match.",
    ).not.toBe(dirDigest);
    setCatalog(declared);
    fakeDownload(assetTgz);

    // S002-O01/O02: the mismatch is detected and the install is rejected with the
    // integrity-specific code, not a generic failure.
    const installed = marketplace.install(PLUGIN_ID);
    await expect(
      installed,
      `AP-TC-120 step S002 diverged: expected installing a tampered agent package to reject with code "integrity-failed".`,
    ).rejects.toMatchObject({ code: "integrity-failed" });

    // S002-O03: the error says what failed, so the surface can state that the
    // package failed integrity verification rather than "install failed".
    const error = await installed.catch((err: unknown) => err as Error);
    expect(error.message).toMatch(/integrity/i);

    // S003-O01/O02: nothing was written. No staged artifact, no committable token,
    // no plugin directory, no runtime registration, and no consent-granted state.
    expect(
      await listStaging(),
      "AP-TC-120 step S003 diverged: a rejected artifact must leave nothing under the staging root.",
    ).toEqual([]);
    expect(
      pluginInstaller.__test.listTokens(),
      "AP-TC-120 step S003 diverged: a rejected artifact must record no committable staging entry.",
    ).toEqual([]);
    await expect(stat(path.join(pluginsRoot, PLUGIN_ID))).rejects.toMatchObject({ code: "ENOENT" });
    expect(pluginManager.registerInstalled).not.toHaveBeenCalled();
    // Weaker than it looks, and deliberately kept: consent is written by the
    // confirm ROUTE, not by this layer, so this asserts that the rejected install
    // left the ledger untouched rather than that some consent-writing call was
    // skipped. The load-bearing half of S003-O02 is the assertion above that no
    // committable staging token exists, which is what makes the confirm route
    // unreachable for this artifact in the first place.
    expect(
      consentState.hasConsent(PLUGIN_ID),
      "AP-TC-120 step S003 (S003-O02) diverged: a rejected install must leave no consent-granted state.",
    ).toBe(false);
  });

  it("S001-O01: verification runs over the FETCHED bytes, before anything is written", async () => {
    setCatalog(`sha256-${"a".repeat(64)}`);
    fakeDownload(assetTgz);

    await expect(marketplace.install(PLUGIN_ID)).rejects.toMatchObject({
      code: "integrity-failed",
    });

    // The artifact really was downloaded, so the recompute ran over fetched bytes
    // rather than short-circuiting on a declared value.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0][0])).toBe(ASSET_URL);
  });
});

describe("AP-TC-122 S001: an agent plugin whose CLI is absent still installs", () => {
  it("installs end to end although the manifest's probe command exists on no machine", async () => {
    setCatalog(dirDigest);
    fakeDownload(assetTgz);

    // S001-O01/O02: the package passes integrity verification and installation
    // completes, with the agent's own CLI nowhere on the box.
    const preview = await marketplace.install(PLUGIN_ID);
    expect(preview.manifest.agentCompatibility?.probe?.command).toBe(AGENT_CLI_COMMAND);

    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(installedAgentRecord());
    const record = await pluginInstaller.commit(preview.stagingToken);
    expect(record.status).toBe("enabled");

    // S001-O03: the plugin is present on disk and registered, i.e. Installed.
    expect((await stat(path.join(pluginsRoot, PLUGIN_ID, "roubo-plugin.yaml"))).isFile()).toBe(
      true,
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([installedAgentRecord()]);
    const { listings } = await marketplace.listCatalog();
    expect(listings.find((l) => l.id === PLUGIN_ID)?.installed).toBe(true);
  });
});
