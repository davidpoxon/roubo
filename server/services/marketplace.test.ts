import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MarketplaceCatalogEntry,
  PluginLifecycle,
  PluginPermissions,
  PluginRecord,
} from "@roubo/shared";
import type { CatalogSource, VerifiedCatalog } from "./catalog-client.js";

vi.mock("./plugin-manager.js", () => ({
  listInstalled: vi.fn(() => [] as PluginRecord[]),
}));

vi.mock("./plugin-installer.js", () => {
  class InstallError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "InstallError";
    }
  }
  return {
    InstallError,
    previewFromGitUrl: vi.fn(),
    previewUpdateFromGitUrl: vi.fn(),
    previewFromRelease: vi.fn(),
    previewUpdateFromRelease: vi.fn(),
  };
});

vi.mock("./catalog-client.js", () => ({
  getVerifiedCatalog: vi.fn(),
}));

import * as marketplace from "./marketplace.js";
import * as pluginManager from "./plugin-manager.js";
import * as pluginInstaller from "./plugin-installer.js";
import * as catalogClient from "./catalog-client.js";

const listInstalled = vi.mocked(pluginManager.listInstalled);
const previewFromGitUrl = vi.mocked(pluginInstaller.previewFromGitUrl);
const previewUpdateFromGitUrl = vi.mocked(pluginInstaller.previewUpdateFromGitUrl);
const previewFromRelease = vi.mocked(pluginInstaller.previewFromRelease);
const previewUpdateFromRelease = vi.mocked(pluginInstaller.previewUpdateFromRelease);
const getVerifiedCatalog = vi.mocked(catalogClient.getVerifiedCatalog);

const ENTRIES: MarketplaceCatalogEntry[] = [
  {
    id: "database",
    name: "Database",
    kind: "component",
    version: "0.1.0",
    summary: "Docker-backed databases",
    source: { type: "git", url: "https://example.invalid/r.git", directory: "plugins/database" },
    provenance: "roubo/plugins@database",
    integrity: "sha256-db",
    verified: true,
  },
  {
    id: "github-com",
    name: "GitHub.com",
    kind: "integration",
    version: "0.2.0",
    summary: "Connect GitHub issues",
    source: { type: "git", url: "https://example.invalid/r.git", directory: "plugins/github-com" },
    provenance: "roubo/plugins@github-com",
    integrity: "sha256-gh",
    verified: true,
  },
  {
    id: "worker-queue",
    name: "Worker Queue",
    kind: "component",
    version: "1.0.0",
    summary: "A background worker-queue component",
    source: { type: "git", url: "https://example.invalid/r.git" },
    provenance: "roubo/plugins@worker-queue",
    integrity: "sha256-wq",
    revoked: true,
    verified: true,
  },
];

// A `release`-type (built-artifact) entry: the hosted catalog serves these, and
// install/update must route to the download/unpack preview, not the git clone
// (issue #370). The asset digest lives on source.sha256; the host's expected
// package digest is the entry's `integrity`.
const RELEASE_ENTRY: MarketplaceCatalogEntry = {
  id: "image-optimizer",
  name: "Image Optimizer",
  kind: "component",
  version: "1.2.0",
  summary: "An image-optimizing component published as a built artifact",
  source: {
    type: "release",
    assetUrl: "https://releases.example.invalid/image-optimizer-1.2.0.tgz",
    sha256: "sha256-io-asset",
  },
  provenance: "roubo/plugins@image-optimizer",
  integrity: "sha256-io",
  verified: true,
};

function setCatalog(
  source: CatalogSource = "network",
  entries: MarketplaceCatalogEntry[] = ENTRIES,
) {
  const catalog: VerifiedCatalog = {
    entries,
    source,
    fetchedAt: source === "seed" ? null : "2026-06-28T00:00:00.000Z",
  };
  getVerifiedCatalog.mockResolvedValue(catalog);
}

function installedRecord(
  id: string,
  version: string,
  source: PluginRecord["source"] = "user",
): PluginRecord {
  return {
    id,
    manifest: {
      id,
      name: id,
      version,
      description: "x",
      kind: "component",
      roubo: "*",
      entry: "./index.js",
      permissions: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
      },
    } as PluginRecord["manifest"],
    manifestPath: `/p/${id}/roubo-plugin.yaml`,
    pluginDir: `/p/${id}`,
    source,
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
  };
}

function installedComponentRecord(
  id: string,
  opts: { permissions?: PluginPermissions; lifecycle?: PluginLifecycle } = {},
): PluginRecord {
  const base = installedRecord(id, "1.0.0");
  return {
    ...base,
    manifest: {
      ...base.manifest,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
    },
  } as PluginRecord;
}

async function annotatedById(id: string) {
  const found = (await marketplace.listCatalog()).listings.find((l) => l.id === id);
  if (!found) throw new Error(`expected listing ${id}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  listInstalled.mockReturnValue([]);
  setCatalog("network");
});

describe("isNewerVersion", () => {
  it("returns true when the catalog version is a higher semver", () => {
    expect(marketplace.isNewerVersion("1.3.0", "1.0.0")).toBe(true);
    expect(marketplace.isNewerVersion("0.2.0", "0.1.0")).toBe(true);
  });

  it("returns false when versions are equal or older", () => {
    expect(marketplace.isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(marketplace.isNewerVersion("1.0.0", "2.0.0")).toBe(false);
  });

  it("falls back to string inequality for non-semver versions", () => {
    expect(marketplace.isNewerVersion("nightly", "stable")).toBe(true);
    expect(marketplace.isNewerVersion("same", "same")).toBe(false);
  });
});

describe("listCatalog", () => {
  it("serves the memoized catalog without forcing a per-call network refresh", async () => {
    await marketplace.listCatalog();
    // listCatalog must NOT force a refresh on every call: with no debounce on the
    // client search field, that would issue a fresh fetch + signature verify per
    // keystroke. The catalog-client refreshes on its own short memo TTL instead
    // (fetch-on-marketplace-open), so filtering runs in memory.
    expect(getVerifiedCatalog).toHaveBeenCalled();
    expect(getVerifiedCatalog).not.toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("returns both component and integration entries with verified + version", async () => {
    const { listings } = await marketplace.listCatalog();
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.some((l) => l.kind === "component")).toBe(true);
    expect(listings.some((l) => l.kind === "integration")).toBe(true);
    for (const l of listings) {
      expect(typeof l.verified).toBe("boolean");
      expect(l.version.length).toBeGreaterThan(0);
    }
  });

  it("filters by kind", async () => {
    const { listings: components } = await marketplace.listCatalog({ kind: "component" });
    expect(components.length).toBeGreaterThan(0);
    expect(components.every((l) => l.kind === "component")).toBe(true);

    const { listings: integrations } = await marketplace.listCatalog({ kind: "integration" });
    expect(integrations.every((l) => l.kind === "integration")).toBe(true);
  });

  it("filters by free-text query over name, id, and summary (case-insensitive)", async () => {
    const { listings: byName } = await marketplace.listCatalog({ q: "DATABASE" });
    expect(byName.some((l) => l.id === "database")).toBe(true);

    const { listings: none } = await marketplace.listCatalog({ q: "zzz-not-a-real-plugin-zzz" });
    expect(none).toHaveLength(0);
  });

  it("annotates an installed plugin at the same version as installed without update", async () => {
    listInstalled.mockReturnValue([installedRecord("database", "0.1.0")]);
    const annotated = await annotatedById("database");
    expect(annotated.installed).toBe(true);
    expect(annotated.installedVersion).toBe("0.1.0");
    expect(annotated.updateAvailable).toBe(false);
  });

  it("flags updateAvailable when the installed version is older than the catalog", async () => {
    listInstalled.mockReturnValue([installedRecord("database", "0.0.1")]);
    const annotated = await annotatedById("database");
    expect(annotated.installed).toBe(true);
    expect(annotated.updateAvailable).toBe(true);
  });

  it("never flags updateAvailable for a bundled installed plugin (issue #752)", async () => {
    listInstalled.mockReturnValue([installedRecord("database", "0.0.1", "bundled")]);
    const annotated = await annotatedById("database");
    expect(annotated.installed).toBe(true);
    expect(annotated.updateAvailable).toBe(false);
  });

  it("still flags updateAvailable for a user-installed plugin behind the catalog (issue #752)", async () => {
    listInstalled.mockReturnValue([installedRecord("database", "0.0.1", "user")]);
    const annotated = await annotatedById("database");
    expect(annotated.installed).toBe(true);
    expect(annotated.updateAvailable).toBe(true);
  });

  it("leaves a non-installed entry uninstalled with no update", async () => {
    listInstalled.mockReturnValue([]);
    const annotated = await annotatedById("database");
    expect(annotated.installed).toBe(false);
    expect(annotated.installedVersion).toBeNull();
    expect(annotated.updateAvailable).toBe(false);
  });

  // CP-TC-109: a revoked entry is removed from the catalog grid.
  it("filters out revoked entries (CP-TC-109)", async () => {
    const { listings } = await marketplace.listCatalog();
    expect(listings.some((l) => l.id === "worker-queue")).toBe(false);
  });

  // CPHM-FR-009: even on the seed-degraded path the list is non-zero.
  it("still lists entries when the catalog is served from the seed (never zero)", async () => {
    setCatalog("seed");
    const { listings } = await marketplace.listCatalog();
    expect(listings.length).toBeGreaterThan(0);
  });

  // CPHM-FR-009 / CPHM-NFR-003 (issue #372): the served catalog's provenance is
  // threaded through so the route can forward it and the client can render the
  // offline / staleness banner. A live network fetch reports source "network"
  // with a fetch timestamp.
  it("threads through the network source and fetch timestamp (issue #372)", async () => {
    setCatalog("network");
    const result = await marketplace.listCatalog();
    expect(result.source).toBe("network");
    expect(result.fetchedAt).toBe("2026-06-28T00:00:00.000Z");
  });

  // CPHM-TC-043: degraded to the last-known cache (marketplace unreachable):
  // source "cache" with the cached fetch timestamp, entries still rendered.
  it("threads through the cache source and the cached fetch timestamp (CPHM-TC-043)", async () => {
    setCatalog("cache");
    const result = await marketplace.listCatalog();
    expect(result.source).toBe("cache");
    expect(result.fetchedAt).toBe("2026-06-28T00:00:00.000Z");
    expect(result.listings.length).toBeGreaterThan(0);
  });

  // CPHM-FR-009: degraded to the bundled seed: source "seed" with a null
  // fetchedAt (the seed was never fetched), entries still rendered.
  it("threads through the seed source with a null fetch timestamp (CPHM-FR-009)", async () => {
    setCatalog("seed");
    const result = await marketplace.listCatalog();
    expect(result.source).toBe("seed");
    expect(result.fetchedAt).toBeNull();
    expect(result.listings.length).toBeGreaterThan(0);
  });
});

// Issue #401: annotate() enriches each listing with PRE-INSTALL provenance the
// detail drawer renders: the plugin's declared permissions and, for components,
// its lifecycle. These are derived (not part of the signed catalog payload):
// preferred from the installed record's manifest, else read from the bundled
// plugins/<id> source manifest the git+directory entry points at.
describe("annotate enrichment: declared permissions + lifecycle (issue #401)", () => {
  const richPermissions: PluginPermissions = {
    network: { hosts: ["api.example.com"] },
    credentials: { slots: [] },
    filesystem: { paths: [] },
    processes: false,
    ports: false,
    docker: {},
  };

  it("surfaces the installed manifest's lifecycle and declared permissions", async () => {
    listInstalled.mockReturnValue([
      installedComponentRecord("database", { permissions: richPermissions, lifecycle: "one-shot" }),
    ]);
    const annotated = await annotatedById("database");
    expect(annotated.lifecycle).toBe("one-shot");
    expect(annotated.declaredPermissions).toEqual(richPermissions);
  });

  it("defaults an installed component with no manifest lifecycle to long-running", async () => {
    listInstalled.mockReturnValue([
      installedComponentRecord("database", { permissions: richPermissions }),
    ]);
    const annotated = await annotatedById("database");
    expect(annotated.lifecycle).toBe("long-running");
  });

  it("enriches a NOT-installed bundled component from its plugins/<id> source manifest", async () => {
    listInstalled.mockReturnValue([]);
    const annotated = await annotatedById("database");
    // Read pre-install from the real plugins/database manifest (declares docker).
    expect(annotated.declaredPermissions).not.toBeNull();
    expect(annotated.declaredPermissions?.docker).toBeDefined();
    // The bundled manifest declares no lifecycle field, so it defaults to long-running.
    expect(annotated.lifecycle).toBe("long-running");
  });

  it("gives an integration plugin no lifecycle but still surfaces its declared permissions", async () => {
    listInstalled.mockReturnValue([]);
    const annotated = await annotatedById("github-com");
    expect(annotated.lifecycle).toBeNull();
    expect(annotated.declaredPermissions).not.toBeNull();
  });

  it("derives one-shot lifecycle for a NOT-installed component from a real one-shot manifest (CP-TC-097)", async () => {
    // CP-TC-097: a one-shot component listing must derive `lifecycle: one-shot`
    // from its manifest so the detail drawer's Lifecycle row reads "one-shot
    // (start runs to completion, then completed)". This is the first test to
    // derive one-shot from a REAL on-disk manifest (a git+directory entry
    // pointing at the __fixtures__ one-shot component fixture), complementing the
    // client render test in client/src/components/marketplace/Marketplace.test.tsx.
    // The fixture lives under server/services/__fixtures__ (a test-only path),
    // never the shipped seed catalog, so nothing user-visible is introduced.
    listInstalled.mockReturnValue([]);
    setCatalog("network", [
      ...ENTRIES,
      {
        id: "oneshot-deploy",
        name: "One-shot Deploy",
        kind: "component",
        version: "0.1.0",
        summary: "A one-shot deploy component",
        source: {
          type: "git",
          url: "https://example.invalid/r.git",
          directory: "server/services/__fixtures__/plugins/component-oneshot",
        },
        provenance: "roubo/plugins@oneshot-deploy",
        integrity: "sha256-oneshot",
        verified: true,
      },
    ]);
    const annotated = await annotatedById("oneshot-deploy");
    expect(annotated.lifecycle).toBe("one-shot");
  });
});

describe("resolveEntry", () => {
  it("resolves a known catalog id", async () => {
    expect((await marketplace.resolveEntry("database"))?.id).toBe("database");
  });

  it("returns null for an unknown id", async () => {
    expect(await marketplace.resolveEntry("definitely-not-in-catalog")).toBeNull();
  });
});

describe("install", () => {
  it("delegates a git-type entry to previewFromGitUrl with the entry's source", async () => {
    const entry = ENTRIES[0];
    previewFromGitUrl.mockResolvedValue({
      stagingToken: "t",
      source: entry.source,
    } as Awaited<ReturnType<typeof pluginInstaller.previewFromGitUrl>>);
    await marketplace.install(entry.id);
    expect(previewFromGitUrl).toHaveBeenCalledWith(
      // Narrow for the test: ENTRIES[0] is a git-type source.
      (entry.source as { type: "git"; url: string; directory?: string }).url,
      entry.integrity,
      (entry.source as { type: "git"; url: string; directory?: string }).directory,
    );
    // A git entry never touches the release preview.
    expect(previewFromRelease).not.toHaveBeenCalled();
  });

  // Issue #370: a `release`-type catalog entry must route to the download/unpack
  // preview (with assetUrl + the entry integrity), never the git clone path that
  // throws "Git URL is required" for a source with no `url`.
  it("routes a release-type entry to previewFromRelease with the asset URL and integrity (issue #370)", async () => {
    setCatalog("network", [...ENTRIES, RELEASE_ENTRY]);
    previewFromRelease.mockResolvedValue({
      stagingToken: "t",
      source: RELEASE_ENTRY.source,
    } as Awaited<ReturnType<typeof pluginInstaller.previewFromRelease>>);
    await marketplace.install(RELEASE_ENTRY.id);
    expect(previewFromRelease).toHaveBeenCalledWith(
      (RELEASE_ENTRY.source as { type: "release"; assetUrl: string }).assetUrl,
      RELEASE_ENTRY.integrity,
    );
    // The git clone path is not taken, so "Git URL is required" never throws.
    expect(previewFromGitUrl).not.toHaveBeenCalled();
  });

  it("throws invalid-input for an unknown id", async () => {
    await expect(marketplace.install("nope")).rejects.toMatchObject({ code: "invalid-input" });
    expect(previewFromGitUrl).not.toHaveBeenCalled();
    expect(previewFromRelease).not.toHaveBeenCalled();
  });

  // CP-TC-109: a revoked id is rejected with a specific `revoked` error.
  it("rejects a revoked id with a revoked error (CP-TC-109)", async () => {
    await expect(marketplace.install("worker-queue")).rejects.toMatchObject({ code: "revoked" });
    expect(previewFromGitUrl).not.toHaveBeenCalled();
  });

  // CPHM-TC-045/050/051: a new install while the marketplace is unreachable
  // (catalog served from cache/seed) is paused with a clear error, no clone.
  it("rejects a new install with marketplace-unreachable when degraded to cache", async () => {
    setCatalog("cache");
    await expect(marketplace.install("database")).rejects.toMatchObject({
      code: "marketplace-unreachable",
    });
    expect(previewFromGitUrl).not.toHaveBeenCalled();
  });

  it("rejects a new install with marketplace-unreachable when degraded to seed", async () => {
    setCatalog("seed");
    await expect(marketplace.install("database")).rejects.toMatchObject({
      code: "marketplace-unreachable",
    });
    expect(previewFromGitUrl).not.toHaveBeenCalled();
  });
});

describe("update", () => {
  it("delegates a git-type entry to previewUpdateFromGitUrl with the entry's source and id", async () => {
    const entry = ENTRIES[0];
    previewUpdateFromGitUrl.mockResolvedValue({
      stagingToken: "t",
      source: entry.source,
    } as Awaited<ReturnType<typeof pluginInstaller.previewUpdateFromGitUrl>>);
    await marketplace.update(entry.id);
    expect(previewUpdateFromGitUrl).toHaveBeenCalledWith(
      (entry.source as { type: "git"; url: string; directory?: string }).url,
      entry.id,
      entry.integrity,
      (entry.source as { type: "git"; url: string; directory?: string }).directory,
    );
    expect(previewUpdateFromRelease).not.toHaveBeenCalled();
  });

  // Issue #370: a `release`-type entry's update routes to previewUpdateFromRelease
  // (asset URL + the entry id + integrity), never the git update path.
  it("routes a release-type entry to previewUpdateFromRelease with the asset URL, id, and integrity (issue #370)", async () => {
    setCatalog("network", [...ENTRIES, RELEASE_ENTRY]);
    previewUpdateFromRelease.mockResolvedValue({
      stagingToken: "t",
      source: RELEASE_ENTRY.source,
    } as Awaited<ReturnType<typeof pluginInstaller.previewUpdateFromRelease>>);
    await marketplace.update(RELEASE_ENTRY.id);
    expect(previewUpdateFromRelease).toHaveBeenCalledWith(
      (RELEASE_ENTRY.source as { type: "release"; assetUrl: string }).assetUrl,
      RELEASE_ENTRY.id,
      RELEASE_ENTRY.integrity,
    );
    expect(previewUpdateFromGitUrl).not.toHaveBeenCalled();
  });

  it("throws invalid-input for an unknown id", async () => {
    await expect(marketplace.update("nope")).rejects.toMatchObject({ code: "invalid-input" });
    expect(previewUpdateFromGitUrl).not.toHaveBeenCalled();
    expect(previewUpdateFromRelease).not.toHaveBeenCalled();
  });

  it("rejects a revoked id with a revoked error (CP-TC-109)", async () => {
    await expect(marketplace.update("worker-queue")).rejects.toMatchObject({ code: "revoked" });
    expect(previewUpdateFromGitUrl).not.toHaveBeenCalled();
  });

  it("rejects an update with marketplace-unreachable when degraded (offline)", async () => {
    setCatalog("cache");
    await expect(marketplace.update("database")).rejects.toMatchObject({
      code: "marketplace-unreachable",
    });
    expect(previewUpdateFromGitUrl).not.toHaveBeenCalled();
  });
});
