// #312 (e2e_flow): install a plugin from the marketplace listing to a running
// plugin, for a `release`-type (built-artifact) catalog entry. This is the
// end-to-end verification that #370 (route marketplace install()/update() to the
// release preview) makes pass: before the fix, install() unconditionally called
// the git-clone preview, so a release entry (which has no `source.url`) failed
// with "Git URL is required" downstream of the network gate. After the fix, a
// release entry routes to previewFromRelease and installs end to end.
//
// The "running system" here is the REAL, already-merged host install pipeline
// composed in process under vitest, not a mock of it:
//   - the REAL marketplace service (server/services/marketplace.ts install()),
//     which resolves the verified catalog entry, runs the network gate
//     (assertInstallable), and routes on source.type;
//   - the REAL plugin installer (server/services/plugin-installer.ts
//     previewFromRelease -> commit), which validates the asset URL, streams the
//     tarball under the download cap, unpacks it under zip-slip + size limits,
//     re-verifies the unpacked artifact's digest via the REAL marketplace-integrity
//     primitives (node:crypto sha256), and atomically moves it into the plugins dir.
// Only three seams are stood in for: the catalog fetch (catalog-client is mocked to
// return a verified network catalog), the network download (undici.fetch is mocked
// to stream a REAL gzipped tarball built on disk), and the plugin registry/runtime
// (plugin-manager.registerInstalled returns an enabled record, mirroring the
// plugin-installer unit tests). The journey is deterministic, network-free, and
// runs under `npm test`.
//
// Coverage closes davidpoxon/roubo-development#312 (the e2e side of the gap whose
// implementation is #370): a release-type listing installs to a committed, runnable
// plugin, and a tampered artifact is rejected before commit (no plugin installed).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { MarketplaceCatalogEntry, PluginRecord } from "@roubo/shared";
import type { CatalogSource, VerifiedCatalog } from "./catalog-client.js";

vi.mock("./catalog-client.js", () => ({
  getVerifiedCatalog: vi.fn(),
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

// This journey drives the REAL install() and commit(), and commit now records the
// chosen marketplace source to ~/.roubo/plugins-provenance.json (issue #558). Mock
// that persistence boundary so the journey cannot write the developer's own state
// dir; the ledger's file IO is covered by plugin-provenance-state.test.ts.
vi.mock("./plugin-provenance-state.js", () => ({
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  getProvenance: vi.fn(() => null),
}));

import * as marketplace from "./marketplace.js";
import * as pluginInstaller from "./plugin-installer.js";
import * as catalogClient from "./catalog-client.js";
import * as pluginManager from "./plugin-manager.js";
import { computePackageDigest } from "./marketplace-integrity.js";
import { fetch } from "undici";
import { resolveWithin } from "../lib/safe-path.js";

const PLUGIN_ID = "image-optimizer";
const ASSET_URL = "https://releases.example.invalid/image-optimizer-1.2.0.tgz";

// A complete, valid plugin manifest (the host parses and host-compat checks it).
const MANIFEST = `id: ${PLUGIN_ID}
name: Image Optimizer
version: 1.2.0
description: An image-optimizing component published as a built artifact.
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
let assetTgz: string; // path to the REAL gzipped tarball CI would publish
let dirDigest: string; // computePackageDigest of the unpacked artifact = catalog `integrity`
const tmpDirs: string[] = [];

async function trackTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Build the published built artifact on disk (roubo-plugin.yaml + a runnable
// dist/index.js + package.json + README), then pack it into a REAL gzipped tarball.
// The unpacked-directory digest is the catalog entry's `integrity`, the value the
// host re-verifies before commit.
async function buildReleaseArtifact(): Promise<void> {
  const src = await trackTmp("roubo-312-src-");
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "roubo-plugin.yaml"), MANIFEST, "utf8");
  await writeFile(
    path.join(src, "dist", "index.js"),
    "module.exports = { plugin: { id: 'image-optimizer' } };\n",
    "utf8",
  );
  await writeFile(
    path.join(src, "package.json"),
    `${JSON.stringify({ name: PLUGIN_ID, version: "1.2.0", type: "commonjs", main: "dist/index.js" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(src, "README.md"), "# Image Optimizer\n", "utf8");

  dirDigest = await computePackageDigest(src);

  const out = await trackTmp("roubo-312-tgz-");
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

// A verified catalog carrying one release-type entry. `integrity` is the value the
// host re-verifies; `source.sha256` is the publish-gate asset digest (unused by the
// host install path, recorded for fidelity).
function releaseEntry(integrity: string): MarketplaceCatalogEntry {
  return {
    id: PLUGIN_ID,
    name: "Image Optimizer",
    kind: "component",
    version: "1.2.0",
    summary: "An image-optimizing component published as a built artifact.",
    source: { type: "release", assetUrl: ASSET_URL, sha256: "sha256-asset" },
    provenance: "github.com/davidpoxon/roubo-plugins",
    integrity,
    verified: true,
  };
}

function setCatalog(integrity: string, source: CatalogSource = "network") {
  const catalog: VerifiedCatalog = {
    entries: [releaseEntry(integrity)],
    source,
    fetchedAt: "2026-06-28T00:00:00.000Z",
  };
  vi.mocked(catalogClient.getVerifiedCatalog).mockResolvedValue(catalog);
}

async function listStaging(): Promise<string[]> {
  try {
    return await readdir(resolveWithin(pluginInstaller.__test.stagingRoot()));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  await buildReleaseArtifact();
});

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

beforeEach(async () => {
  pluginInstaller.__test.reset();
  pluginsRoot = await trackTmp("roubo-312-plugins-");
  vi.mocked(pluginManager.getUserPluginsRoot).mockReturnValue(pluginsRoot);
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(pluginManager.registerInstalled).mockReset();
  vi.mocked(fetch).mockReset();
});

afterEach(async () => {
  await rm(pluginsRoot, { recursive: true, force: true });
});

describe("#312: install a release-type marketplace listing to a running plugin (#370)", () => {
  it("installs end to end: resolve -> install() -> previewFromRelease -> commit -> runnable plugin", async () => {
    // The catalog's recorded integrity is the unpacked artifact's true digest, so
    // the host's verify-before-commit passes.
    setCatalog(dirDigest);
    fakeDownload(assetTgz);

    // The release entry resolves from the verified catalog (the listing the user clicks).
    const resolved = await marketplace.resolveEntry(PLUGIN_ID);
    expect(resolved?.source.type).toBe("release");

    // install() routes a release entry to the download/unpack preview. Before #370
    // this threw "Git URL is required"; now it stages the built artifact.
    const preview = await marketplace.install(PLUGIN_ID);
    expect(preview.manifest.id).toBe(PLUGIN_ID);
    expect(preview.source).toEqual({ type: "release", assetUrl: ASSET_URL });
    expect(pluginInstaller.isValidStagingToken(preview.stagingToken)).toBe(true);

    // Commit atomically moves the unpacked artifact into the plugins dir and the
    // host registers it as a runnable plugin.
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
    expect(record.id).toBe(PLUGIN_ID);
    expect(record.status).toBe("enabled");

    // The plugin is installed on disk with its runnable dist/, and the host's
    // registerInstalled was called against that target.
    const target = path.join(pluginsRoot, PLUGIN_ID);
    expect((await stat(path.join(target, "dist", "index.js"))).isFile()).toBe(true);
    expect((await stat(path.join(target, "roubo-plugin.yaml"))).isFile()).toBe(true);
    expect(pluginManager.registerInstalled).toHaveBeenCalledWith(target);
    expect(await listStaging()).not.toContain(preview.stagingToken);
  });

  it("rejects a tampered artifact before commit: nothing is installed (integrity verify is load-bearing)", async () => {
    // The catalog records a digest that does NOT match the downloaded artifact (a
    // substituted / tampered asset), so the host must reject at preview, before any
    // plugin is committed.
    setCatalog(`sha256-${"0".repeat(64)}`);
    fakeDownload(assetTgz);

    await expect(marketplace.install(PLUGIN_ID)).rejects.toMatchObject({
      code: "integrity-failed",
    });

    // No staged token to commit, and no plugin directory was created.
    expect(await listStaging()).toEqual([]);
    await expect(stat(path.join(pluginsRoot, PLUGIN_ID))).rejects.toMatchObject({ code: "ENOENT" });
    expect(pluginManager.registerInstalled).not.toHaveBeenCalled();
  });
});
