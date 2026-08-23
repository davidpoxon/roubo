// AP-TC-118 (issue #533, AP-WU-032): a THIRD-PARTY developer publishes an agent
// plugin against the published @roubo SDK, it appears as an agent-kind marketplace
// listing carrying its compatibility metadata, and it installs after integrity
// verification. This file walks S001-S006 of the authoritative case in
// .specifications/agent-plugins/test-cases.json, in order, one it() per step.
//
// This is a drift guard for an already-shipped journey, not new product behaviour.
// The work unit spans five slices (#519 compatibility metadata, #521 core purity,
// #522 marketplace distribution for agent-kind plugins, #523 the published SDK
// surface and authoring docs, #537 the Phase 2 verify gate), each of which is
// tested on its own; what nothing tested until now is that the five compose into
// the one journey a third-party author actually walks.
//
// The "running system" is the REAL, already-merged pipeline composed in process
// under vitest:
//   - the REAL published SDK package contract (plugin-sdk/package.json + the
//     src/index.ts barrel), imported for real so `defineAgentPlugin` is the actual
//     validating entry point rather than a name in a doc;
//   - the REAL manifest schema (shared/plugin-manifest.ts -> PluginManifestSchema),
//     which is what decides an agent-kind manifest is valid and what carries the
//     declared compatibility window through;
//   - the REAL integrity primitives (server/services/marketplace-integrity.ts ->
//     computePackageDigest over node:crypto sha256), used BOTH to mint the
//     publisher's digest and, inside the installer, to re-verify it;
//   - the REAL marketplace service (listCatalog -> annotate, install -> route on
//     source.type) and the REAL plugin installer (previewFromRelease -> commit).
//
// Stood in, at the process boundaries only, exactly as the sibling
// marketplace-agent-kind-journey.e2e.test.ts stands them in: the catalog fetch
// (catalog-client), the network download (undici.fetch streams a REAL gzipped
// tarball built on disk), the plugin registry/runtime (plugin-manager), the
// provenance ledger's file IO (plugin-provenance-state), the registered-source
// list (marketplace-sources-state), and the state directory (state.getRouboDir is
// redirected to a sandbox tmpdir so the journey NEVER writes the developer's real
// ~/.roubo).
//
// ── Reconciliation: what this guard proves, and what it deliberately does not ──
//
// 1. THE REGISTRY ROUND TRIP IS NOT EXERCISED, AND IS NOT PRETENDED TO BE.
//    AP-TC-118's precondition is that the published @roubo packages are installable
//    from the npm registry. A live `npm install @roubo/plugin-sdk` belongs to the
//    out-of-monorepo sandbox repos (roubo-test / roubo-test-integration), which
//    exist precisely so registry resolution is exercised somewhere real, and one of
//    which is currently unable to resolve its own dependencies. Running a network
//    install from a unit suite would make this guard non-hermetic and would fail for
//    registry reasons rather than integration-drift reasons, which is the opposite
//    of FR-020's attribution goal. So S001/S002 prove the PUBLISHED PACKAGE
//    CONTRACT: that the agent definition entry point and the agent contract types
//    are on the surface `files` + `exports` actually publish, and that the author's
//    project declares only registry-resolvable @roubo dependencies (no file:, link:,
//    workspace: or portal: specifier that would build here and break for everyone
//    else). That is the half a registry round trip would otherwise mask.
//
// 2. S005-O02 REACHES A GENUINELY PUBLISHED PLUGIN THROUGH TWO SOURCES, AND S005
//    EXERCISES BOTH. For a third-party published plugin the catalog entry is
//    `source.type: "release"`, and `readEntryManifest()` returns a manifest only for
//    an INSTALLED record or a `git` source with a local `directory`, so the manifest
//    derivation seam cannot reach that plugin pre-install. This guard originally
//    pinned that as an unsatisfiable gap; davidpoxon/roubo-development#722 closed it
//    by carrying the author-declared window on `MarketplaceCatalogEntry` itself,
//    with `annotate()` preferring the manifest and falling back to the entry. S005
//    below asserts both routes: a readable-manifest entry declaring nothing at the
//    entry level (the derivation seam alone), and the release shape a published
//    plugin actually has (the entry-level fallback). The "compatibility not
//    declared" fallback (AP-TC-121) is now reserved for a window neither source
//    declares.
//
// 3. "AS A DIFFERENT USER" (S005) has no harness at this altitude, so it is met
//    structurally, as the sibling guard meets it: a fresh sandbox state dir with no
//    install record and no consent entry, i.e. a machine that has never seen this
//    plugin.
//
// The S005/S006 RENDERED surface (the agent card, its compatibility line, and the
// Install affordance driving preview -> consent -> confirm) is guarded in
// client/src/components/marketplace/marketplace-tc118-publish-journey.e2e.test.tsx,
// where it is observable.
//
// Failure-output contract (AP-FR-020): every assertion carries an expected-vs-actual
// message naming the diverged step (and its observation id) plus the owning slice
// issue from this unit's blocked_by/covers set, so a red run localises the drift to
// one attributable slice rather than to "the journey".

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { parseManifest } from "@roubo/shared";
import type { MarketplaceCatalogEntry, PluginRecord } from "@roubo/shared";
import type { VerifiedCatalog } from "./catalog-client.js";

// The state dir the journey writes to. Created eagerly and hoisted so the state.js
// mock factory (also hoisted) can close over it.
const sandbox = vi.hoisted(() => ({ root: "" }));

vi.mock("./catalog-client.js", () => ({
  getVerifiedCatalog: vi.fn(),
  createThirdPartyCatalogClient: vi.fn(),
}));

vi.mock("./plugin-manager.js", () => ({
  HOST_API_VERSION: "1.5.0",
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

// Redirect ONLY the state-directory resolution, keeping atomicWrite and the rest of
// state.js real, so every write this journey makes is genuine but lands in a
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
import * as consentState from "./plugin-consent-state.js";
import { computePackageDigest } from "./marketplace-integrity.js";
import { fetch } from "undici";

// ── Owning slices (AP-FR-020) ──
//
// From this unit's blocked_by/covers set in .specifications/agent-plugins/
// issues.json: [#519, #521, #522, #523, #537]. Each step names the slice whose
// surface the step drives, so a divergence is attributable.
const SLICE_SDK = "#523 (publish the agent-plugin SDK surface and third-party authoring docs)";
const SLICE_COMPAT = "#519 (version gating, compatibility metadata, and launch-failure surfacing)";
const SLICE_MARKETPLACE = "#522 (marketplace distribution for agent-kind plugins)";
// #521 (core purity guard) and #537 (the Phase 2 verify gate) are in blocked_by
// because this journey cannot run before they land, but neither owns a step of its
// own: #521's guarantee is enforced by `npm run lint:agent-guard`, and #537 is the
// gate this unit reports into.
const SLICE_ALL = `${SLICE_SDK}, ${SLICE_COMPAT}, ${SLICE_MARKETPLACE}`;

// ── The published SDK, on disk ──
//
// server/services/ -> repo root, the same two-hop the marketplace service itself
// uses to locate a bundled plugin's source manifest.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK_DIR = path.join(REPO_ROOT, "plugin-sdk");

// The agent contract surface AP-TC-118 S001-O01 requires an author to be able to
// import. `defineAgentPlugin` + `SUPPORTED_AGENT_CONTRACT_VERSION` are values (they
// are imported for real below); the rest are the types docs/plugin-sdk.md's SDK
// reference table promises an agent author, and a type is only observable on the
// barrel's export list, so they are checked there.
const AGENT_CONTRACT_TYPES = [
  "AgentCapabilities",
  "AgentContract",
  "AgentContractMethodName",
  "AgentLaunchContext",
  "AgentLaunchDescriptor",
  "AgentPermissionsModel",
  "AgentPluginHandle",
  "DeclarativeAgentContract",
  "DefineAgentPluginOptions",
  "VersionProbeSpec",
  "WorkspaceWriteSpec",
] as const;

// ── The third-party plugin being published ──
//
// Deliberately not a first-party id: this case is about somebody OUTSIDE the
// monorepo shipping an agent plugin against the published packages.
const PLUGIN_ID = "acme-agent";
const PLUGIN_VERSION = "1.2.0";
const ASSET_URL = "https://releases.acme.example/acme-agent-1.2.0.tgz";
const PROVENANCE = "github.com/acme/roubo-acme-agent";

// The declared compatibility window (S003). Both bounds are bare major.minor.patch,
// which is what the schema enforces and what the listing renders.
const MIN_VERSION = "1.4.0";
const TESTED_CEILING = "2.1.7";

// A complete, valid AGENT manifest authored against the published SDK.
// `permissions.processes: false` is not decoration: the real PluginManifestSchema
// REFUSES a `processes` permission for kind agent (issue #632), so this fixture
// parses only because it is a genuine agent plugin.
const MANIFEST = `id: ${PLUGIN_ID}
name: ACME Agent
version: ${PLUGIN_VERSION}
description: A third-party agent plugin published to the hosted marketplace.
kind: agent
roubo: ^1.0.0
entry: dist/index.js
contractVersion: 1
agentCompatibility:
  minVersion: ${MIN_VERSION}
  testedCeiling: ${TESTED_CEILING}
  probe:
    command: acme-agent
    args:
      - --version
    parse: semver
permissions:
  network:
    hosts:
      - api.acme.example
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
  ports: false
  docker: false
`;

// The author's project manifest. Every @roubo dependency is a REGISTRY semver
// range: no `file:`, `link:`, `workspace:` or `portal:` specifier, which is the
// difference between a plugin that builds on its author's machine and one that
// builds for everybody (S002-O02).
const PLUGIN_PACKAGE_JSON = {
  name: "@acme/roubo-acme-agent",
  version: PLUGIN_VERSION,
  description: "A third-party agent plugin published to the hosted marketplace.",
  type: "module",
  main: "dist/index.js",
  dependencies: {
    "@roubo/plugin-sdk": "^0.4.0",
  },
  devDependencies: {
    typescript: "6.0.3",
  },
};

// The plugin's source, written against the DOCUMENTED agent definition entry point
// (docs/plugin-sdk.md, Agent quick start). Never executed here; it is the artefact
// S002-O02 inspects for an unpublished dependency.
const PLUGIN_SOURCE = `import { defineAgentPlugin } from "@roubo/plugin-sdk";

defineAgentPlugin({
  translateLaunch({ config, context }) {
    return {
      schemaVersion: 1,
      kind: "agent-launch",
      command: "acme-agent",
      args: ["--session", "{{sessionId}}", ...(config.extraArgs ?? [])],
      cwd: context.workspacePath,
    };
  },
});
`;

// The built entry the tarball actually ships, i.e. what `entry: dist/index.js`
// resolves to once the author has run their build.
const PLUGIN_BUILT_ENTRY = `import { defineAgentPlugin } from "@roubo/plugin-sdk";
defineAgentPlugin({
  translateLaunch({ context }) {
    return {
      schemaVersion: 1,
      kind: "agent-launch",
      command: "acme-agent",
      args: ["--session", "{{sessionId}}"],
      cwd: context.workspacePath,
    };
  },
});
`;

type FetchResult = Awaited<ReturnType<typeof fetch>>;

let pluginsRoot: string;
let publishedDir: string; // the unpacked artifact the author packs
let assetTgz: string; // the REAL gzipped tarball the marketplace serves
let publishedDigest: string; // computePackageDigest of the artifact = catalog `integrity`
const tmpDirs: string[] = [];

async function trackTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Build the published artifact on disk exactly as an author's `npm pack`-style
 * release would, then pack it into a REAL gzipped tarball. The digest over the
 * UNPACKED directory is the catalog entry's `integrity`, which is the value the
 * host recomputes and re-verifies before it commits anything.
 */
async function publishArtifact(): Promise<void> {
  publishedDir = await trackTmp("roubo-ap118-src-");
  await mkdir(path.join(publishedDir, "dist"), { recursive: true });
  await mkdir(path.join(publishedDir, "src"), { recursive: true });
  await writeFile(path.join(publishedDir, "roubo-plugin.yaml"), MANIFEST, "utf8");
  await writeFile(path.join(publishedDir, "dist", "index.js"), PLUGIN_BUILT_ENTRY, "utf8");
  await writeFile(path.join(publishedDir, "src", "index.ts"), PLUGIN_SOURCE, "utf8");
  await writeFile(
    path.join(publishedDir, "package.json"),
    `${JSON.stringify(PLUGIN_PACKAGE_JSON, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(publishedDir, "README.md"), "# ACME Agent\n", "utf8");

  publishedDigest = await computePackageDigest(publishedDir);

  const out = await trackTmp("roubo-ap118-tgz-");
  assetTgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: assetTgz, cwd: publishedDir }, [
    "roubo-plugin.yaml",
    "dist/index.js",
    "src/index.ts",
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

/**
 * The published entry as the hosted marketplace serves it: a release artifact,
 * carrying the compatibility window the author declared in the manifest at S003.
 * That entry-level declaration (issue #722) is what makes the window reachable
 * pre-install, since a release source has no local manifest to read.
 */
function releaseEntry(integrity: string): MarketplaceCatalogEntry {
  return {
    id: PLUGIN_ID,
    name: "ACME Agent",
    kind: "agent",
    version: PLUGIN_VERSION,
    summary: "Run benches on the ACME agent CLI.",
    source: { type: "release", assetUrl: ASSET_URL },
    provenance: PROVENANCE,
    integrity,
    verified: false,
    agentCompatibility: { minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING },
  };
}

/**
 * The SAME published plugin served through the one pre-install shape whose manifest
 * `readEntryManifest()` can actually read (a `git` source carrying a local
 * directory), and deliberately carrying NO entry-level declaration. Used by S005 to
 * prove the manifest derivation seam still produces the declared window on its own,
 * independently of the entry-level fallback.
 */
function readableManifestEntry(integrity: string): MarketplaceCatalogEntry {
  const entry = releaseEntry(integrity);
  delete entry.agentCompatibility;
  return {
    ...entry,
    source: {
      type: "git",
      url: "https://github.com/acme/roubo-acme-agent.git",
      directory: publishedDir,
    },
  };
}

function setCatalog(entry: MarketplaceCatalogEntry) {
  const catalog: VerifiedCatalog = {
    entries: [entry],
    source: "network",
    fetchedAt: "2026-08-03T00:00:00.000Z",
  };
  vi.mocked(catalogClient.getVerifiedCatalog).mockResolvedValue(catalog);
}

function installedRecord(): PluginRecord {
  return {
    id: PLUGIN_ID,
    manifest: {
      id: PLUGIN_ID,
      name: "ACME Agent",
      version: PLUGIN_VERSION,
      description: "A third-party agent plugin published to the hosted marketplace.",
      kind: "agent",
      roubo: "^1.0.0",
      entry: "dist/index.js",
      agentCompatibility: { minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING },
      permissions: {
        network: { hosts: ["api.acme.example"] },
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

/** Every dependency specifier that resolves to something the registry does not serve. */
const UNPUBLISHED_SPECIFIER = /^(file:|link:|workspace:|portal:|\.{1,2}\/|git\+|github:)/;

beforeAll(async () => {
  sandbox.root = mkdtempSync(path.join(tmpdir(), "roubo-ap118-state-"));
  tmpDirs.push(sandbox.root);
  await publishArtifact();
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
  // "As a different user" (S005): a machine that has never seen this plugin. No
  // install record, no consent entry, a fresh plugins root.
  pluginsRoot = await trackTmp("roubo-ap118-plugins-");
  vi.mocked(pluginManager.getUserPluginsRoot).mockReturnValue(pluginsRoot);
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(pluginManager.registerInstalled).mockReset();
  vi.mocked(fetch).mockReset();
  await rm(path.join(sandbox.root, "plugins-consent.json"), { force: true });
});

describe("AP-TC-118: a third-party agent plugin is published, listed, and installed", () => {
  // AP-TC-119 S001 makes the same claim about the published SDK surface (the
  // agent contract types and the definition entry point are exported), so this
  // row corroborates both cases rather than being duplicated under its own id.
  it("S001: the published @roubo SDK exposes the agent definition entry point and the agent contract types (AP-TC-119)", async () => {
    const pkg = JSON.parse(await readFile(path.join(SDK_DIR, "package.json"), "utf8")) as {
      name: string;
      private?: boolean;
      files?: string[];
      exports?: Record<string, { types?: string; import?: string }>;
      publishConfig?: { access?: string };
    };

    // S001-O01, first half: the surface is genuinely PUBLISHED. A private package,
    // or one whose `files` omits the built output, is not installable in a new
    // plugin project no matter what its barrel exports.
    expect(
      pkg.name,
      `AP-TC-118 step S001 (S001-O01) diverged: expected the SDK package to be published as "@roubo/plugin-sdk", got "${pkg.name}". Owning slice: ${SLICE_SDK}.`,
    ).toBe("@roubo/plugin-sdk");
    expect(
      pkg.private ?? false,
      `AP-TC-118 step S001 (S001-O01) diverged: expected the SDK package to be publishable, got private: ${String(pkg.private)}. Owning slice: ${SLICE_SDK}.`,
    ).toBe(false);
    expect(
      pkg.publishConfig?.access,
      `AP-TC-118 step S001 (S001-O01) diverged: expected the SDK to publish with public access, got "${pkg.publishConfig?.access}". Owning slice: ${SLICE_SDK}.`,
    ).toBe("public");
    expect(
      pkg.files ?? [],
      `AP-TC-118 step S001 (S001-O01) diverged: expected the published tarball to ship "dist", got files ${JSON.stringify(pkg.files)}. Owning slice: ${SLICE_SDK}.`,
    ).toContain("dist");
    expect(
      pkg.exports?.["."],
      `AP-TC-118 step S001 (S001-O01) diverged: expected the SDK to expose a root entry point with types and an import condition, got ${JSON.stringify(pkg.exports)}. Owning slice: ${SLICE_SDK}.`,
    ).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" });

    // S001-O01, second half: what is ON that surface. The barrel is imported for
    // real, so `defineAgentPlugin` is the actual validating entry point an author
    // calls, not a name in a doc.
    const sdk = await import("../../plugin-sdk/src/index.js");
    expect(
      typeof sdk.defineAgentPlugin,
      `AP-TC-118 step S001 (S001-O01) diverged: expected "defineAgentPlugin" to be importable from @roubo/plugin-sdk, got ${typeof sdk.defineAgentPlugin}. Owning slice: ${SLICE_SDK}.`,
    ).toBe("function");
    expect(
      sdk.SUPPORTED_AGENT_CONTRACT_VERSION,
      `AP-TC-118 step S001 (S001-O01) diverged: expected the SDK to publish the agent contract version an author pins against, got ${String(sdk.SUPPORTED_AGENT_CONTRACT_VERSION)}. Owning slice: ${SLICE_SDK}.`,
    ).toBe(1);
    // It is the REAL entry point, not a stub: it validates the contract version
    // synchronously, at definition time, before any connection exists.
    expect(
      () =>
        sdk.defineAgentPlugin({ translateLaunch: () => ({}) as never }, { contractVersion: 99 }),
      `AP-TC-118 step S001 (S001-O01) diverged: expected defineAgentPlugin to reject an incompatible contractVersion at definition time. Owning slice: ${SLICE_SDK}.`,
    ).toThrow(/contractVersion/);

    // The agent contract TYPES an author imports alongside it. Types are erased at
    // runtime, so the barrel's export list is where they are observable.
    const barrel = await readFile(path.join(SDK_DIR, "src", "index.ts"), "utf8");
    for (const typeName of AGENT_CONTRACT_TYPES) {
      expect(
        new RegExp(`\\b${typeName}\\b`).test(barrel),
        `AP-TC-118 step S001 (S001-O01) diverged: expected the agent contract type "${typeName}" to be exported from the @roubo/plugin-sdk barrel, got no export of that name. Owning slice: ${SLICE_SDK}.`,
      ).toBe(true);
    }
  });

  it("S002: the authored manifest validates as an agent-kind plugin and declares no unpublished dependency", async () => {
    // S002-O01: the REAL PluginManifestSchema is what decides this, and it is the
    // same schema the installer runs over the staged artifact in S006.
    const manifestPath = path.join(publishedDir, "roubo-plugin.yaml");
    const parsed = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    expect(
      parsed.ok,
      `AP-TC-118 step S002 (S002-O01) diverged: expected the authored manifest to validate, got ${parsed.ok ? "" : JSON.stringify(parsed.error)}. Owning slice: ${SLICE_SDK}.`,
    ).toBe(true);
    if (!parsed.ok) return;
    expect(
      parsed.manifest.kind,
      `AP-TC-118 step S002 (S002-O01) diverged: expected the manifest to validate as kind "agent", got "${parsed.manifest.kind}". Owning slice: ${SLICE_SDK}.`,
    ).toBe("agent");
    expect(
      parsed.manifest.entry,
      `AP-TC-118 step S002 (S002-O01) diverged: expected the manifest to point at the built agent entry, got "${parsed.manifest.entry}". Owning slice: ${SLICE_SDK}.`,
    ).toBe("dist/index.js");

    // S002-O02: the plugin builds against the PUBLISHED SDK. Every @roubo dependency
    // is a registry range, so nothing resolves to a path or a checkout that exists
    // only on the author's machine. This is the failure a live registry install
    // would otherwise be the only thing to catch.
    const authored = JSON.parse(
      await readFile(path.join(publishedDir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.entries(authored.dependencies ?? {});
    expect(
      deps.length,
      `AP-TC-118 step S002 (S002-O02) diverged: expected the plugin project to declare at least one @roubo dependency, got none. Owning slice: ${SLICE_SDK}.`,
    ).toBeGreaterThan(0);
    for (const [name, range] of [...deps, ...Object.entries(authored.devDependencies ?? {})]) {
      expect(
        UNPUBLISHED_SPECIFIER.test(range),
        `AP-TC-118 step S002 (S002-O02) diverged: expected every dependency to resolve from the registry, got "${name}": "${range}", which resolves to an unpublished artifact. Owning slice: ${SLICE_SDK}.`,
      ).toBe(false);
    }
    // And the @roubo dependency it declares is the package this repo actually
    // publishes, at a range the published version satisfies.
    const sdkPkg = JSON.parse(await readFile(path.join(SDK_DIR, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(
      Object.keys(authored.dependencies ?? {}),
      `AP-TC-118 step S002 (S002-O02) diverged: expected the plugin to depend on the published SDK package "${sdkPkg.name}", got ${JSON.stringify(Object.keys(authored.dependencies ?? {}))}. Owning slice: ${SLICE_SDK}.`,
    ).toContain(sdkPkg.name);
    const semver = (await import("semver")).default;
    const declaredRange = (authored.dependencies ?? {})[sdkPkg.name];
    expect(
      semver.satisfies(sdkPkg.version, declaredRange),
      `AP-TC-118 step S002 (S002-O02) diverged: expected the published SDK version ${sdkPkg.version} to satisfy the plugin's declared range "${declaredRange}". Owning slice: ${SLICE_SDK}.`,
    ).toBe(true);

    // The built entry really is written against the documented agent definition
    // entry point, imported from the published package rather than reached into.
    const builtEntry = await readFile(path.join(publishedDir, "dist", "index.js"), "utf8");
    expect(
      builtEntry,
      `AP-TC-118 step S002 (S002-O02) diverged: expected the built entry to register through defineAgentPlugin imported from "@roubo/plugin-sdk". Owning slice: ${SLICE_SDK}.`,
    ).toContain('from "@roubo/plugin-sdk"');
    expect(builtEntry).toContain("defineAgentPlugin(");
  });

  it("S003: the manifest carries the declared version floor and tested ceiling", async () => {
    const manifestPath = path.join(publishedDir, "roubo-plugin.yaml");
    const parsed = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // S003-O01: both bounds survive schema validation, unchanged. The schema is the
    // gate, so a bound it silently dropped (or rewrote) would land here.
    expect(
      parsed.manifest.agentCompatibility?.minVersion,
      `AP-TC-118 step S003 (S003-O01) diverged: expected the manifest to carry the version floor ${MIN_VERSION}, got "${parsed.manifest.agentCompatibility?.minVersion}". Owning slice: ${SLICE_COMPAT}.`,
    ).toBe(MIN_VERSION);
    expect(
      parsed.manifest.agentCompatibility?.testedCeiling,
      `AP-TC-118 step S003 (S003-O01) diverged: expected the manifest to carry the tested ceiling ${TESTED_CEILING}, got "${parsed.manifest.agentCompatibility?.testedCeiling}". Owning slice: ${SLICE_COMPAT}.`,
    ).toBe(TESTED_CEILING);
  });

  it("S004: the packaged plugin carries an integrity digest and is accepted by the marketplace", async () => {
    // S004-O01, first half: the package is BUILT with an integrity digest, minted by
    // the same primitive the host re-verifies with (so publisher and consumer cannot
    // disagree about what the digest means).
    expect(
      publishedDigest,
      `AP-TC-118 step S004 (S004-O01) diverged: expected the packaged plugin to carry a sha256 content digest, got "${publishedDigest}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(
      await computePackageDigest(publishedDir),
      `AP-TC-118 step S004 (S004-O01) diverged: expected the digest to be reproducible over the published artifact. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(publishedDigest);
    expect((await stat(assetTgz)).size).toBeGreaterThan(0);

    // S004-O01, second half: the marketplace ACCEPTS the submission. The catalog
    // serves the entry with that digest and it survives the catalog read (not
    // revoked, not filtered), which is what "accepted" means on this surface.
    setCatalog(releaseEntry(publishedDigest));
    const { listings } = await marketplace.listCatalog();
    const published = listings.find((l) => l.id === PLUGIN_ID);
    expect(
      published,
      `AP-TC-118 step S004 (S004-O01) diverged: expected the published plugin "${PLUGIN_ID}" to be accepted into the catalog, got ${JSON.stringify(listings.map((l) => l.id))}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBeDefined();
    expect(
      published?.integrity,
      `AP-TC-118 step S004 (S004-O01) diverged: expected the accepted entry to carry the artifact's integrity digest ${publishedDigest}, got "${published?.integrity}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(publishedDigest);
    expect(
      published?.source.type,
      `AP-TC-118 step S004 (S004-O01) diverged: expected a published third-party plugin to be served as a release artifact, got source type "${published?.source.type}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe("release");
  });

  it("S005: the newly published plugin appears as an agent-kind listing to a user who has never seen it", async () => {
    setCatalog(releaseEntry(publishedDigest));

    // S005-O01: it lists under the agent kind, which is the filter the Marketplace
    // screen's Agent chip applies, and it lists as installable rather than installed.
    const { listings } = await marketplace.listCatalog({ kind: "agent" });
    const published = listings.find((l) => l.id === PLUGIN_ID);
    expect(
      published,
      `AP-TC-118 step S005 (S005-O01) diverged: expected the newly published plugin to appear under the agent-kind listing, got ${JSON.stringify(listings.map((l) => l.id))}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBeDefined();
    expect(
      published?.kind,
      `AP-TC-118 step S005 (S005-O01) diverged: expected the listing's kind to be "agent", got "${published?.kind}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe("agent");
    // A user who has never seen this plugin: not installed, so the card renders the
    // Install affordance rather than the Installed badge.
    expect(
      published?.installed,
      `AP-TC-118 step S005 (S005-O01) diverged: expected the listing to read not-installed for a user who has never installed it, got installed: ${String(published?.installed)}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(false);
    expect(published?.updateAvailable).toBe(false);
    expect(
      consentState.hasConsent(PLUGIN_ID),
      `AP-TC-118 step S005 diverged: expected a user who has never seen this plugin to hold no consent record for it. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(false);
  });

  it("S005-O02: the newly published, not-yet-installed listing displays its declared compatibility metadata", async () => {
    // The manifest derivation seam on its own: the moment the entry's manifest is
    // readable pre-install, `annotate()` projects exactly the declared floor and
    // ceiling onto the listing. This entry carries no entry-level declaration, so
    // the window here can only have come off the manifest.
    setCatalog(readableManifestEntry(publishedDigest));
    const readable = (await marketplace.listCatalog({ kind: "agent" })).listings.find(
      (l) => l.id === PLUGIN_ID,
    );
    expect(
      readable?.agentCompatibility,
      `AP-TC-118 step S005 (S005-O02) diverged: expected a pre-install agent listing whose manifest is readable to project the declared window {minVersion: ${MIN_VERSION}, testedCeiling: ${TESTED_CEILING}}, got ${JSON.stringify(readable?.agentCompatibility)}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toEqual({ minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING });

    // And THE SHAPE A GENUINELY PUBLISHED PLUGIN ACTUALLY HAS: a release entry with
    // no local manifest to read. The catalog entry now carries the author-declared
    // window itself (issue #722), so `annotate()` falls back to it and the card
    // renders the floor and ceiling before anything is installed, which is what
    // S005-O02 asks for. Until #722 this projected null and the card showed the
    // "compatibility not declared" fallback (AP-TC-121), which that fallback is now
    // reserved for a genuinely undeclared window.
    marketplace.__test.resetSourceClients();
    setCatalog(releaseEntry(publishedDigest));
    const released = (await marketplace.listCatalog({ kind: "agent" })).listings.find(
      (l) => l.id === PLUGIN_ID,
    );
    expect(
      released?.agentCompatibility,
      `AP-TC-118 step S005 (S005-O02) diverged: expected a not-yet-installed, release-sourced agent listing to display the declared window {minVersion: ${MIN_VERSION}, testedCeiling: ${TESTED_CEILING}} carried on its catalog entry, got ${JSON.stringify(released?.agentCompatibility)}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toEqual({ minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING });
  });

  it("S006: installing the published plugin verifies its integrity digest and completes", async () => {
    setCatalog(releaseEntry(publishedDigest));
    fakeDownload(assetTgz);

    // S006-O01, first half: install() downloads the release artifact, unpacks it,
    // recomputes the digest over the UNPACKED bytes and compares it to the catalog's
    // declaration. A preview exists only because that comparison passed; the sibling
    // AP-TC-120 guard feeds the same pipeline a mismatched declaration and gets
    // `integrity-failed` instead, which is the pair that makes this meaningful.
    const preview = await marketplace.install(PLUGIN_ID);
    expect(
      preview.manifest.id,
      `AP-TC-118 step S006 (S006-O01) diverged: expected installing "${PLUGIN_ID}" to stage that plugin, got "${preview.manifest.id}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(PLUGIN_ID);
    expect(
      preview.manifest.kind,
      `AP-TC-118 step S006 (S006-O01) diverged: expected the staged plugin to be agent-kind, got "${preview.manifest.kind}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe("agent");
    expect(
      preview.source,
      `AP-TC-118 step S006 (S006-O01) diverged: expected the staged artifact to have been fetched from the published release URL, got ${JSON.stringify(preview.source)}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toEqual({ type: "release", assetUrl: ASSET_URL });
    expect(
      pluginInstaller.isValidStagingToken(preview.stagingToken),
      `AP-TC-118 step S006 (S006-O01) diverged: expected a verified artifact to yield a committable staging token. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(true);
    // The bytes really were fetched, so the digest was recomputed over the download
    // rather than trusted from the catalog.
    expect(
      String(vi.mocked(fetch).mock.calls[0]?.[0]),
      `AP-TC-118 step S006 (S006-O01) diverged: expected the installer to fetch the published asset ${ASSET_URL}, got "${String(vi.mocked(fetch).mock.calls[0]?.[0])}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(ASSET_URL);
    // The declared window survives the round trip through the published tarball, so
    // what the author declared in S003 is what the host reads back off the artifact.
    expect(
      preview.manifest.agentCompatibility,
      `AP-TC-118 step S006 (S006-O01) diverged: expected the staged manifest to carry the declared window {minVersion: ${MIN_VERSION}, testedCeiling: ${TESTED_CEILING}}, got ${JSON.stringify(preview.manifest.agentCompatibility)}. Owning slice: ${SLICE_COMPAT}.`,
    ).toMatchObject({ minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING });

    // S006-O01, second half: it INSTALLS. Commit moves the verified artifact into
    // the plugins dir and registers it.
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(installedRecord());
    const record = await pluginInstaller.commit(preview.stagingToken);
    // `record` is whatever the mocked `registerInstalled` resolved, so its fields
    // carry no FR-020 attribution: asserting them would only restate this test's
    // own fixture. What commit() itself determines is that the staged entry is
    // consumed, so the artifact can never be committed twice.
    expect(record.id).toBe(PLUGIN_ID);
    expect(
      pluginInstaller.__test.listTokens(),
      `AP-TC-118 step S006 (S006-O01) diverged: expected committing the verified package to consume its staging token, got ${JSON.stringify(
        pluginInstaller.__test.listTokens(),
      )}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).not.toContain(preview.stagingToken);
    const target = path.join(pluginsRoot, PLUGIN_ID);
    expect(
      (await stat(path.join(target, "roubo-plugin.yaml"))).isFile(),
      `AP-TC-118 step S006 (S006-O01) diverged: expected the installed plugin's manifest to land at ${target}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(true);
    expect((await stat(path.join(target, "dist", "index.js"))).isFile()).toBe(true);
    expect(pluginManager.registerInstalled).toHaveBeenCalledWith(target);

    // And the listing re-reads as Installed, which is the journey's terminal state:
    // the plugin a third party published is now on this user's machine, and the
    // window now comes off the INSTALLED MANIFEST rather than the catalog entry
    // (`annotate()` prefers the manifest), so the post-install card cannot disagree
    // with what is actually on disk.
    marketplace.__test.resetSourceClients();
    setCatalog(releaseEntry(publishedDigest));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([installedRecord()]);
    const installed = (await marketplace.listCatalog({ kind: "agent" })).listings.find(
      (l) => l.id === PLUGIN_ID,
    );
    expect(
      installed?.installed,
      `AP-TC-118 step S006 (S006-O01) diverged: expected the listing to read Installed after a successful install, got installed: ${String(installed?.installed)}. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(true);
    expect(installed?.installedVersion).toBe(PLUGIN_VERSION);
    expect(
      installed?.agentCompatibility,
      `AP-TC-118 step S006 diverged: expected the installed agent listing to carry the declared window. Owning slices: ${SLICE_ALL}.`,
    ).toEqual({ minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING });
  });
});
