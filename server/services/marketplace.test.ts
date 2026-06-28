import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketplaceCatalogEntry, PluginRecord } from "@roubo/shared";
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

async function annotatedById(id: string) {
  const found = (await marketplace.listCatalog()).find((l) => l.id === id);
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
    const listings = await marketplace.listCatalog();
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.some((l) => l.kind === "component")).toBe(true);
    expect(listings.some((l) => l.kind === "integration")).toBe(true);
    for (const l of listings) {
      expect(typeof l.verified).toBe("boolean");
      expect(l.version.length).toBeGreaterThan(0);
    }
  });

  it("filters by kind", async () => {
    const components = await marketplace.listCatalog({ kind: "component" });
    expect(components.length).toBeGreaterThan(0);
    expect(components.every((l) => l.kind === "component")).toBe(true);

    const integrations = await marketplace.listCatalog({ kind: "integration" });
    expect(integrations.every((l) => l.kind === "integration")).toBe(true);
  });

  it("filters by free-text query over name, id, and summary (case-insensitive)", async () => {
    const byName = await marketplace.listCatalog({ q: "DATABASE" });
    expect(byName.some((l) => l.id === "database")).toBe(true);

    const none = await marketplace.listCatalog({ q: "zzz-not-a-real-plugin-zzz" });
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
    const listings = await marketplace.listCatalog();
    expect(listings.some((l) => l.id === "worker-queue")).toBe(false);
  });

  // CPHM-FR-009: even on the seed-degraded path the list is non-zero.
  it("still lists entries when the catalog is served from the seed (never zero)", async () => {
    setCatalog("seed");
    const listings = await marketplace.listCatalog();
    expect(listings.length).toBeGreaterThan(0);
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
  it("delegates to previewFromGitUrl with the entry's source", async () => {
    const entry = ENTRIES[0];
    previewFromGitUrl.mockResolvedValue({
      stagingToken: "t",
      source: entry.source,
    } as Awaited<ReturnType<typeof pluginInstaller.previewFromGitUrl>>);
    await marketplace.install(entry.id);
    expect(previewFromGitUrl).toHaveBeenCalledWith(
      entry.source.url,
      entry.integrity,
      entry.source.directory,
    );
  });

  it("throws invalid-input for an unknown id", async () => {
    await expect(marketplace.install("nope")).rejects.toMatchObject({ code: "invalid-input" });
    expect(previewFromGitUrl).not.toHaveBeenCalled();
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
  it("delegates to previewUpdateFromGitUrl with the entry's source and id", async () => {
    const entry = ENTRIES[0];
    previewUpdateFromGitUrl.mockResolvedValue({
      stagingToken: "t",
      source: entry.source,
    } as Awaited<ReturnType<typeof pluginInstaller.previewUpdateFromGitUrl>>);
    await marketplace.update(entry.id);
    expect(previewUpdateFromGitUrl).toHaveBeenCalledWith(
      entry.source.url,
      entry.id,
      entry.integrity,
      entry.source.directory,
    );
  });

  it("throws invalid-input for an unknown id", async () => {
    await expect(marketplace.update("nope")).rejects.toMatchObject({ code: "invalid-input" });
    expect(previewUpdateFromGitUrl).not.toHaveBeenCalled();
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
