import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type {
  MarketplaceCatalogEntry,
  MarketplaceSource,
  PluginLifecycle,
  PluginPermissions,
  PluginRecord,
} from "@roubo/shared";
import type { CatalogSource, ThirdPartyCatalogResult, VerifiedCatalog } from "./catalog-client.js";

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
  createThirdPartyCatalogClient: vi.fn(),
}));

const FIRST_PARTY_URL = "https://davidpoxon.github.io/roubo-plugins/catalog.json";

// What install/update record for a first-party install (issue #558): the built-in
// source, and verified, since the first-party signed chain is the only thing that
// can assert verification.
const FIRST_PARTY_PROVENANCE = {
  sourceId: FIRST_PARTY_SOURCE_ID,
  sourceUrl: FIRST_PARTY_URL,
  unverified: false,
};

vi.mock("./marketplace-sources-state.js", () => ({
  FIRST_PARTY_URL: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  listSources: vi.fn(),
  readSourceCredential: vi.fn(),
}));

import * as marketplace from "./marketplace.js";
import * as pluginManager from "./plugin-manager.js";
import * as pluginInstaller from "./plugin-installer.js";
import * as catalogClient from "./catalog-client.js";
import * as sourcesState from "./marketplace-sources-state.js";

const listInstalled = vi.mocked(pluginManager.listInstalled);
const previewFromGitUrl = vi.mocked(pluginInstaller.previewFromGitUrl);
const previewUpdateFromGitUrl = vi.mocked(pluginInstaller.previewUpdateFromGitUrl);
const previewFromRelease = vi.mocked(pluginInstaller.previewFromRelease);
const previewUpdateFromRelease = vi.mocked(pluginInstaller.previewUpdateFromRelease);
const getVerifiedCatalog = vi.mocked(catalogClient.getVerifiedCatalog);
const createThirdPartyCatalogClient = vi.mocked(catalogClient.createThirdPartyCatalogClient);
const listSources = vi.mocked(sourcesState.listSources);
const readSourceCredential = vi.mocked(sourcesState.readSourceCredential);

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
  // Default: no third-party source registered, so the fan-out is first-party only
  // and every pre-existing expectation below holds unchanged.
  listSources.mockReturnValue([]);
  readSourceCredential.mockResolvedValue(null);
  marketplace.__test.resetSourceClients();
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

// Issue #557 (CPHMTP-FR-004 / NFR-006 / NFR-007): listCatalog fans out over the
// first-party catalog AND every registered source concurrently, merges the
// results with per-entry provenance, and reports each source's health on its own
// row so one dead source cannot take the others down with it.
describe("multi-source listing (issue #557)", () => {
  const ACME_URL = "https://marketplace.acme.example/catalog.json";
  const OTHER_URL = "https://plugins.other.example/catalog.json";

  function sourceRow(over: Partial<MarketplaceSource> = {}): MarketplaceSource {
    return {
      id: "marketplace-acme-example-1a2b3c4d",
      url: ACME_URL,
      unsigned: true,
      hasCredential: false,
      allowHttp: false,
      registeredAt: "2026-07-01T00:00:00.000Z",
      ...over,
    };
  }

  function thirdPartyEntry(over: Partial<MarketplaceCatalogEntry> = {}): MarketplaceCatalogEntry {
    return {
      id: "ghe",
      name: "GitHub Enterprise",
      kind: "integration",
      version: "1.0.0",
      summary: "Connect a self-hosted GitHub Enterprise instance",
      source: { type: "release", assetUrl: "https://marketplace.acme.example/ghe-1.0.0.tgz" },
      provenance: "acme/marketplace@ghe",
      integrity: "sha256-ghe",
      verified: false,
      ...over,
    };
  }

  interface FakeSource {
    row: MarketplaceSource;
    /** What this source's client resolves to; the client itself never throws. */
    result: ThirdPartyCatalogResult;
    /** Simulated fetch duration, so concurrency is observable. */
    delayMs?: number;
  }

  /** The per-source fetch windows a fan-out produced, in wall-clock ms. */
  const windows: { id: string; start: number; end: number }[] = [];
  let concurrentPeak = 0;

  /**
   * Wire `createThirdPartyCatalogClient` to serve these fakes, keyed by source id,
   * and register their rows. Each fake records when its fetch started and ended so
   * a test can prove the windows overlap (parallel) rather than abut (serial).
   */
  function registerSources(fakes: FakeSource[]) {
    listSources.mockReturnValue(fakes.map((f) => f.row));
    let inFlight = 0;
    createThirdPartyCatalogClient.mockImplementation((source) => {
      const fake = fakes.find((f) => f.row.id === source.id);
      if (!fake) throw new Error(`unexpected source ${source.id}`);
      return {
        async getCatalog() {
          const start = Date.now();
          inFlight += 1;
          concurrentPeak = Math.max(concurrentPeak, inFlight);
          if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
          inFlight -= 1;
          windows.push({ id: fake.row.id, start, end: Date.now() });
          return fake.result;
        },
      };
    });
  }

  function served(
    entries: MarketplaceCatalogEntry[],
    over: Partial<ThirdPartyCatalogResult> = {},
  ): ThirdPartyCatalogResult {
    return { entries, source: "network", fetchedAt: "2026-07-02T00:00:00.000Z", ...over };
  }

  /**
   * What a third-party client resolves to when it can serve nothing at all:
   * unreachable with no usable cache. There is no third-party seed floor, so the
   * chain bottoms out at an empty result with a null fetchedAt.
   */
  function unreachable(): ThirdPartyCatalogResult {
    return { entries: [], source: "cache", fetchedAt: null };
  }

  beforeEach(() => {
    windows.length = 0;
    concurrentPeak = 0;
  });

  // AC1 / CPHMTP-TC-028 S001: the list contains entries from the first-party
  // catalog AND every registered source, merged into one list.
  it("merges first-party entries with every registered source's entries", async () => {
    registerSources([
      { row: sourceRow(), result: served([thirdPartyEntry()]) },
      {
        row: sourceRow({ id: "plugins-other-example-99887766", url: OTHER_URL }),
        result: served([thirdPartyEntry({ id: "jira-self-hosted", name: "Jira (self-hosted)" })]),
      },
    ]);
    const { listings } = await marketplace.listCatalog();
    const ids = listings.map((l) => l.id);
    // First-party entries survive the merge, and each source contributed its own.
    expect(ids).toContain("database");
    expect(ids).toContain("github-com");
    expect(ids).toContain("ghe");
    expect(ids).toContain("jira-self-hosted");
  });

  // AC1 / CPHMTP-TC-028 S002-O01: every entry carries exactly one source
  // provenance naming where it came from.
  it("stamps every entry with exactly one sourceId naming its originating source", async () => {
    const acme = sourceRow();
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);
    const { listings } = await marketplace.listCatalog();
    for (const listing of listings) {
      expect(typeof listing.sourceId).toBe("string");
      expect(listing.sourceId.length).toBeGreaterThan(0);
    }
    expect(listings.find((l) => l.id === "database")?.sourceId).toBe(FIRST_PARTY_SOURCE_ID);
    expect(listings.find((l) => l.id === "ghe")?.sourceId).toBe(acme.id);
  });

  // The `verified` flag lives on the (unsigned, unverifiable) third-party payload,
  // so a hostile source could claim it and borrow the first-party treatment. Only
  // the signed chain can assert it: force it false for third-party entries.
  it("forces verified false on a third-party entry even when the source claims true", async () => {
    registerSources([{ row: sourceRow(), result: served([thirdPartyEntry({ verified: true })]) }]);
    const { listings } = await marketplace.listCatalog();
    expect(listings.find((l) => l.id === "ghe")?.verified).toBe(false);
    // The first-party entries keep their signed curation flag.
    expect(listings.find((l) => l.id === "database")?.verified).toBe(true);
  });

  it("reports the first-party source first, then each registered source with a host-derived label", async () => {
    const acme = sourceRow();
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);
    const { sources } = await marketplace.listCatalog();
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      id: FIRST_PARTY_SOURCE_ID,
      url: FIRST_PARTY_URL,
      label: "Roubo first-party",
      source: "network",
      unavailable: false,
    });
    // A registered row carries no display name, so the label is derived from the
    // URL host rather than the generated slug.
    expect(sources[1]).toMatchObject({
      id: acme.id,
      url: ACME_URL,
      label: "marketplace.acme.example",
      unavailable: false,
    });
  });

  // AC2 / CPHMTP-TC-029: the source filter scopes the merged list to a single
  // source, and back to all when unset.
  it("scopes the merged list to one source and back to all", async () => {
    const acme = sourceRow();
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);

    const firstPartyOnly = await marketplace.listCatalog({ sourceId: FIRST_PARTY_SOURCE_ID });
    expect(firstPartyOnly.listings.length).toBeGreaterThan(0);
    expect(firstPartyOnly.listings.every((l) => l.sourceId === FIRST_PARTY_SOURCE_ID)).toBe(true);
    expect(firstPartyOnly.listings.some((l) => l.id === "ghe")).toBe(false);

    const acmeOnly = await marketplace.listCatalog({ sourceId: acme.id });
    expect(acmeOnly.listings.map((l) => l.id)).toEqual(["ghe"]);

    const all = await marketplace.listCatalog();
    expect(all.listings.some((l) => l.sourceId === FIRST_PARTY_SOURCE_ID)).toBe(true);
    expect(all.listings.some((l) => l.sourceId === acme.id)).toBe(true);
  });

  it("keeps reporting every source while the listings are scoped to one", async () => {
    const acme = sourceRow();
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);
    // The chip row must stay complete while filtered, or there is no way back.
    const { sources } = await marketplace.listCatalog({ sourceId: FIRST_PARTY_SOURCE_ID });
    expect(sources.map((s) => s.id)).toEqual([FIRST_PARTY_SOURCE_ID, acme.id]);
  });

  it("applies the kind and query filters across the merged list, not per source", async () => {
    registerSources([
      {
        row: sourceRow(),
        result: served([
          thirdPartyEntry(),
          thirdPartyEntry({ id: "acme-cache", name: "ACME Cache", kind: "component" }),
        ]),
      },
    ]);
    const { listings: integrations } = await marketplace.listCatalog({ kind: "integration" });
    // github-com (first-party) and ghe (third-party) both survive a kind filter.
    expect(integrations.every((l) => l.kind === "integration")).toBe(true);
    expect(integrations.map((l) => l.id)).toEqual(expect.arrayContaining(["github-com", "ghe"]));

    const { listings: byQuery } = await marketplace.listCatalog({ q: "acme" });
    expect(byQuery.map((l) => l.id)).toEqual(["acme-cache"]);
  });

  it("filters a revoked third-party entry out of the merged list (CP-TC-109)", async () => {
    registerSources([
      {
        row: sourceRow(),
        result: served([thirdPartyEntry(), thirdPartyEntry({ id: "dead-plugin", revoked: true })]),
      },
    ]);
    const { listings } = await marketplace.listCatalog();
    expect(listings.some((l) => l.id === "dead-plugin")).toBe(false);
  });

  it("annotates a third-party entry's installed state the same way as a first-party one", async () => {
    listInstalled.mockReturnValue([installedRecord("ghe", "0.9.0")]);
    registerSources([{ row: sourceRow(), result: served([thirdPartyEntry()]) }]);
    const { listings } = await marketplace.listCatalog();
    const ghe = listings.find((l) => l.id === "ghe");
    expect(ghe?.installed).toBe(true);
    expect(ghe?.installedVersion).toBe("0.9.0");
    expect(ghe?.updateAvailable).toBe(true);
  });

  // AC3 / CPHMTP-TC-045 / CPHMTP-TC-032 S002: sources are fetched concurrently,
  // not serially, so the list costs the slowest single source rather than the sum.
  it("fetches every source concurrently rather than serially (CPHMTP-TC-045)", async () => {
    const fakes: FakeSource[] = [0, 1, 2, 3, 4].map((i) => ({
      row: sourceRow({ id: `src-${i}`, url: `https://s${i}.example/catalog.json` }),
      result: served([thirdPartyEntry({ id: `plugin-${i}` })]),
      delayMs: 50,
    }));
    registerSources(fakes);

    const startedAt = Date.now();
    const { listings } = await marketplace.listCatalog();
    const elapsed = Date.now() - startedAt;

    // S001-O01: all five sources were in flight at once, so the windows overlap.
    expect(concurrentPeak).toBe(5);
    const lastStart = Math.max(...windows.map((w) => w.start));
    const firstEnd = Math.min(...windows.map((w) => w.end));
    expect(lastStart).toBeLessThanOrEqual(firstEnd);
    // S001-O02: total approximates the slowest single source (~50ms), not the sum
    // of all five (~250ms). The bound is deliberately loose: it only has to
    // separate "parallel" from "serial", not measure the runtime precisely.
    expect(elapsed).toBeLessThan(200);
    // Five healthy sources plus first-party all contributed.
    expect(listings.filter((l) => l.id.startsWith("plugin-"))).toHaveLength(5);
  });

  // AC4 / CPHMTP-TC-039: a dead source is bounded by its own timeout and never
  // blocks a healthy source or the first-party section. The 5s per-fetch timeout
  // itself lives in the client (third-party-catalog-client.test.ts); what matters
  // here is that the fan-out neither serialises behind it nor drops the healthy
  // sources' entries.
  it("lets a dead source cost only its own timeout, never blocking healthy sources (CPHMTP-TC-039)", async () => {
    registerSources([
      // Stands in for a source that hangs until its own 5s timeout fires, then
      // degrades to the empty result.
      { row: sourceRow({ id: "dead" }), result: unreachable(), delayMs: 80 },
      ...[0, 1, 2, 3].map((i) => ({
        row: sourceRow({ id: `healthy-${i}`, url: `https://h${i}.example/catalog.json` }),
        result: served([thirdPartyEntry({ id: `healthy-plugin-${i}` })]),
        delayMs: 10,
      })),
    ]);

    const startedAt = Date.now();
    const { listings, sources } = await marketplace.listCatalog();
    const elapsed = Date.now() - startedAt;

    // S002-O01: the dead source contributes at most its own wait; no healthy
    // source is delayed beyond its own fetch time (they all finish inside the
    // dead source's window rather than queueing after it).
    expect(elapsed).toBeLessThan(160);
    const dead = windows.find((w) => w.id === "dead");
    if (!dead) throw new Error("expected the dead source to have been fetched");
    for (const healthy of windows.filter((w) => w.id !== "dead")) {
      expect(healthy.end).toBeLessThanOrEqual(dead.end);
    }
    // S001-O01: 100% of the healthy sources' entries are listed regardless.
    expect(listings.filter((l) => l.id.startsWith("healthy-plugin-"))).toHaveLength(4);
    expect(listings.some((l) => l.id === "database")).toBe(true);
    expect(sources.find((s) => s.id === "dead")?.unavailable).toBe(true);
  });

  // AC5 / CPHMTP-TC-046 / CPHMTP-TC-036: a cold source with no cache and no
  // network shows unavailable while every other source lists normally.
  it("marks only the cold, unreachable source unavailable while the rest list normally (CPHMTP-TC-046)", async () => {
    registerSources([
      { row: sourceRow({ id: "cold" }), result: unreachable() },
      {
        row: sourceRow({ id: "healthy", url: OTHER_URL }),
        result: served([thirdPartyEntry({ id: "healthy-plugin" })]),
      },
    ]);
    const { listings, sources, source } = await marketplace.listCatalog();

    // S001-O01: the cold source contributed nothing and is flagged unavailable.
    expect(sources.find((s) => s.id === "cold")).toMatchObject({
      unavailable: true,
      fetchedAt: null,
    });
    // S001-O02: first-party and every other healthy source are unaffected.
    expect(sources.find((s) => s.id === "healthy")?.unavailable).toBe(false);
    expect(sources.find((s) => s.id === FIRST_PARTY_SOURCE_ID)?.unavailable).toBe(false);
    expect(listings.some((l) => l.id === "healthy-plugin")).toBe(true);
    expect(listings.some((l) => l.id === "database")).toBe(true);
    // A dead third-party source must NOT flip the first-party offline banner.
    expect(source).toBe("network");
  });

  // CPHMTP-TC-036 S002-O01: a source serving from its own cache is degraded but
  // still populated, so it is not "unavailable"; only a source that can serve
  // nothing is.
  it("does not mark a cache-degraded source unavailable while it still serves entries", async () => {
    registerSources([
      {
        row: sourceRow({ id: "cached" }),
        result: served([thirdPartyEntry()], { source: "cache" }),
      },
    ]);
    const { sources, listings } = await marketplace.listCatalog();
    expect(sources.find((s) => s.id === "cached")).toMatchObject({
      source: "cache",
      unavailable: false,
    });
    expect(listings.some((l) => l.id === "ghe")).toBe(true);
  });

  // A cache the app did not write (corrupted, hand-edited, or from a future
  // schema) can hold entries alongside a non-string fetchedAt, which the client's
  // shape guard null-coalesces. The source is still serving, so it must not be
  // flagged unavailable above its own listed plugins.
  it("does not mark a source unavailable when it serves entries with a null fetchedAt", async () => {
    registerSources([
      {
        row: sourceRow({ id: "stale-stamp" }),
        result: served([thirdPartyEntry()], { source: "cache", fetchedAt: null }),
      },
    ]);
    const { sources, listings } = await marketplace.listCatalog();
    expect(sources.find((s) => s.id === "stale-stamp")).toMatchObject({
      source: "cache",
      fetchedAt: null,
      unavailable: false,
    });
    expect(listings.some((l) => l.id === "ghe")).toBe(true);
  });

  it("keeps the first-party offline banner scoped to the first-party chain", async () => {
    setCatalog("cache");
    registerSources([{ row: sourceRow(), result: served([thirdPartyEntry()]) }]);
    const { source, sources } = await marketplace.listCatalog();
    // The first-party chain degraded, so the banner fires; the healthy
    // third-party source is untouched by it.
    expect(source).toBe("cache");
    expect(sources[0]).toMatchObject({ id: FIRST_PARTY_SOURCE_ID, source: "cache" });
    expect(sources[1].source).toBe("network");
  });

  it("reads a credentialed source's keyring token and passes it to its client", async () => {
    const acme = sourceRow({ hasCredential: true });
    readSourceCredential.mockResolvedValue("ghp_secret");
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);
    await marketplace.listCatalog();
    expect(readSourceCredential).toHaveBeenCalledWith(acme.id);
    expect(createThirdPartyCatalogClient).toHaveBeenCalledWith(
      acme,
      expect.objectContaining({ credential: "ghp_secret" }),
    );
  });

  it("never reads the keyring for a source that has no credential", async () => {
    registerSources([{ row: sourceRow({ hasCredential: false }), result: served([]) }]);
    await marketplace.listCatalog();
    expect(readSourceCredential).not.toHaveBeenCalled();
  });

  // The keyring read is the one step outside the client's never-throws contract
  // (an unavailable headless keyring throws), so it must not take the fan-out
  // down with it.
  it("isolates a keyring failure to its own source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readSourceCredential.mockRejectedValue(new Error("keyring unavailable"));
    registerSources([
      { row: sourceRow({ id: "credentialed", hasCredential: true }), result: served([]) },
      {
        row: sourceRow({ id: "healthy", url: OTHER_URL }),
        result: served([thirdPartyEntry({ id: "healthy-plugin" })]),
      },
    ]);
    const { listings, sources } = await marketplace.listCatalog();
    expect(sources.find((s) => s.id === "credentialed")?.unavailable).toBe(true);
    expect(listings.some((l) => l.id === "healthy-plugin")).toBe(true);
    expect(listings.some((l) => l.id === "database")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("source credentialed could not be listed"),
    );
  });

  // Constructing a fresh client per call would hand each one an empty memo, so
  // every keystroke in the search field would re-fetch every source.
  it("reuses one client per source across calls so search-as-you-type does not refetch", async () => {
    registerSources([{ row: sourceRow(), result: served([thirdPartyEntry()]) }]);
    await marketplace.listCatalog();
    await marketplace.listCatalog({ q: "gh" });
    await marketplace.listCatalog({ q: "ghe" });
    expect(createThirdPartyCatalogClient).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a source's client when its registered URL changes", async () => {
    registerSources([{ row: sourceRow(), result: served([thirdPartyEntry()]) }]);
    await marketplace.listCatalog();
    // Same id, re-registered at a new URL: the cached client points at the old
    // origin, so it must not be reused.
    registerSources([{ row: sourceRow({ url: OTHER_URL }), result: served([thirdPartyEntry()]) }]);
    await marketplace.listCatalog();
    expect(createThirdPartyCatalogClient).toHaveBeenCalledTimes(2);
  });

  // A client captures its credential once at construction, and a re-registration
  // keeps the same id AND url (the id is a deterministic slug of the href), so
  // nothing about the row itself reveals a rotation. The registry routes drop the
  // client instead, and the rebuild must pick the new token up from the keyring.
  it("rebuilds a source's client with the new credential after invalidation", async () => {
    const acme = sourceRow({ hasCredential: true });
    readSourceCredential.mockResolvedValue("ghp_old");
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);
    await marketplace.listCatalog();

    readSourceCredential.mockResolvedValue("ghp_rotated");
    marketplace.invalidateSourceClient(acme.id);
    await marketplace.listCatalog();

    expect(createThirdPartyCatalogClient).toHaveBeenCalledTimes(2);
    expect(createThirdPartyCatalogClient).toHaveBeenLastCalledWith(
      acme,
      expect.objectContaining({ credential: "ghp_rotated" }),
    );
  });

  it("leaves other sources' clients alone when one is invalidated", async () => {
    const acme = sourceRow();
    const other = sourceRow({ id: "other", url: OTHER_URL });
    registerSources([
      { row: acme, result: served([thirdPartyEntry()]) },
      { row: other, result: served([thirdPartyEntry({ id: "other-plugin" })]) },
    ]);
    await marketplace.listCatalog();
    marketplace.invalidateSourceClient(acme.id);
    await marketplace.listCatalog();
    // Two on the cold start, plus one rebuild of the invalidated source only.
    expect(createThirdPartyCatalogClient).toHaveBeenCalledTimes(3);
  });

  // The keyring read spawns an OS process, so keeping it on the cold path is what
  // stops a keystroke from spawning one per credentialed source.
  it("never re-reads the keyring while a source's client is still cached", async () => {
    readSourceCredential.mockResolvedValue("ghp_secret");
    registerSources([{ row: sourceRow({ hasCredential: true }), result: served([]) }]);
    await marketplace.listCatalog();
    await marketplace.listCatalog({ q: "gh" });
    await marketplace.listCatalog({ q: "ghe" });
    expect(createThirdPartyCatalogClient).toHaveBeenCalledTimes(1);
    expect(readSourceCredential).toHaveBeenCalledTimes(1);
  });

  // Issue #595: the cache entry used to be `set` only AFTER the keyring read
  // resolved, so a rotation landing inside that window found no entry, deleted
  // nothing, and the resuming build then cached a pre-rotation client that every
  // later call reused (the exact failure the invalidation exists to prevent).
  it("drops a client whose credential was invalidated during its keyring read", async () => {
    const acme = sourceRow({ hasCredential: true });
    let releaseKeyring!: (token: string) => void;
    readSourceCredential.mockReturnValue(
      new Promise<string>((resolve) => {
        releaseKeyring = resolve;
      }),
    );
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);

    // A cold listCatalog, suspended on the keyring read with no client built yet.
    const inFlight = marketplace.listCatalog();
    // The credential rotates while that read is still outstanding.
    marketplace.invalidateSourceClient(acme.id);
    releaseKeyring("ghp_old");
    await inFlight;

    readSourceCredential.mockResolvedValue("ghp_rotated");
    await marketplace.listCatalog();

    // The pre-rotation client must not have survived the invalidation.
    expect(createThirdPartyCatalogClient).toHaveBeenLastCalledWith(
      acme,
      expect.objectContaining({ credential: "ghp_rotated" }),
    );
  });

  // Caching the build PROMISE means a rejected build would otherwise be cached and
  // rethrown by every later call, pinning the source unavailable until a process
  // restart after one transient keyring hiccup. The build self-evicts on rejection.
  it("rebuilds a source's client after a transient keyring failure instead of pinning it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acme = sourceRow({ hasCredential: true });
    readSourceCredential.mockRejectedValueOnce(new Error("keyring unavailable"));
    readSourceCredential.mockResolvedValue("ghp_secret");
    registerSources([{ row: acme, result: served([thirdPartyEntry()]) }]);

    const first = await marketplace.listCatalog();
    expect(first.sources.find((s) => s.id === acme.id)?.unavailable).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`source ${acme.id} could not be listed`),
    );

    // Keyring healthy again: the failed build must not have been cached.
    const second = await marketplace.listCatalog();
    expect(second.sources.find((s) => s.id === acme.id)?.unavailable).toBe(false);
    expect(second.listings.some((l) => l.id === "ghe")).toBe(true);
  });

  // The same set-after-await window let two concurrent cold calls each build their
  // own client and spawn their own keyring read for one source. Caching the promise
  // collapses that: the second caller awaits the first caller's build.
  it("builds one client for two concurrent cold calls for the same source", async () => {
    readSourceCredential.mockResolvedValue("ghp_secret");
    registerSources([{ row: sourceRow({ hasCredential: true }), result: served([]) }]);

    await Promise.all([marketplace.listCatalog(), marketplace.listCatalog()]);

    expect(createThirdPartyCatalogClient).toHaveBeenCalledTimes(1);
    expect(readSourceCredential).toHaveBeenCalledTimes(1);
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
      // A first-party install passes NO ThirdPartyInstallContext (the seam that
      // makes the digest mandatory applies to unsigned sources only), and records
      // first-party, verified provenance (issue #558).
      undefined,
      FIRST_PARTY_PROVENANCE,
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
      undefined,
      FIRST_PARTY_PROVENANCE,
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
      undefined,
      FIRST_PARTY_PROVENANCE,
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
      undefined,
      FIRST_PARTY_PROVENANCE,
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

// Issue #558 (CPHMTP-FR-005 / CPHMTP-US-005): a plugin id served by more than one
// source is a collision. The listing marks it and names the sources; install and
// update refuse it with an ambiguity error until a source is named. There is no
// precedence and no shadowing anywhere in this block: that is the point of the FR.
describe("cross-source id collisions (issue #558)", () => {
  const ACME_URL = "https://marketplace.acme.example/catalog.json";
  const OTHER_URL = "https://plugins.other.example/catalog.json";
  const ACME_ID = "marketplace-acme-example-1a2b3c4d";
  const OTHER_ID = "plugins-other-example-5e6f7a8b";

  function row(id: string, url: string, over: Partial<MarketplaceSource> = {}): MarketplaceSource {
    return {
      id,
      url,
      unsigned: true,
      hasCredential: false,
      allowHttp: false,
      registeredAt: "2026-07-01T00:00:00.000Z",
      ...over,
    };
  }

  /** A third-party entry for `id`, distinguishable from the first-party one. */
  function entry(id: string, over: Partial<MarketplaceCatalogEntry> = {}): MarketplaceCatalogEntry {
    return {
      id,
      name: `${id} (third-party)`,
      kind: "component",
      version: "9.9.9",
      summary: `A third-party ${id}`,
      source: { type: "release", assetUrl: `https://marketplace.acme.example/${id}.tgz` },
      provenance: `acme/marketplace@${id}`,
      integrity: "sha256-acme",
      verified: false,
      ...over,
    };
  }

  /** Wire the given third-party sources, each serving `entries`. */
  function wire(fakes: { row: MarketplaceSource; entries: MarketplaceCatalogEntry[] }[]) {
    listSources.mockReturnValue(fakes.map((f) => f.row));
    createThirdPartyCatalogClient.mockImplementation((source) => {
      const fake = fakes.find((f) => f.row.id === source.id);
      if (!fake) throw new Error(`unexpected source ${source.id}`);
      return {
        async getCatalog() {
          return {
            entries: fake.entries,
            source: "network",
            fetchedAt: "2026-07-02T00:00:00.000Z",
          };
        },
      };
    });
  }

  /** The first-party catalog serves `database`; ACME serves `database` too. */
  function wireCollision() {
    wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("database")] }]);
  }

  describe("listing marks the collision (AC1)", () => {
    // CPHMTP-TC-033 S001: the colliding id is marked and both sources are named.
    it("marks both listings of a colliding id and names every serving source", async () => {
      wireCollision();
      const { listings } = await marketplace.listCatalog();
      const colliding = listings.filter((l) => l.id === "database");
      // No shadowing: BOTH sources' entries survive into the list, so the consumer
      // sees one card per source rather than a silently chosen winner.
      expect(colliding).toHaveLength(2);
      for (const listing of colliding) {
        expect(listing.collision).toEqual({ sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID] });
      }
    });

    it("names all three sources when three serve the same id", async () => {
      wire([
        { row: row(ACME_ID, ACME_URL), entries: [entry("database")] },
        { row: row(OTHER_ID, OTHER_URL), entries: [entry("database")] },
      ]);
      const { listings } = await marketplace.listCatalog();
      expect(listings.find((l) => l.id === "database")?.collision).toEqual({
        sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID, OTHER_ID],
      });
    });

    it("leaves a single-source id unmarked", async () => {
      wireCollision();
      const { listings } = await marketplace.listCatalog();
      // `github-com` is first-party only, so it is not a collision and carries no
      // key at all (rather than an empty one).
      expect(listings.find((l) => l.id === "github-com")).not.toHaveProperty("collision");
    });

    // A source listing an id twice is one source, not a collision.
    it("does not mark an id one source happens to serve twice", async () => {
      wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("acme-only"), entry("acme-only")] }]);
      const { listings } = await marketplace.listCatalog();
      for (const listing of listings.filter((l) => l.id === "acme-only")) {
        expect(listing.collision).toBeUndefined();
      }
    });

    // A revoked entry is served to nobody, so it cannot make an id ambiguous.
    it("does not mark a collision against a revoked entry", async () => {
      wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("database", { revoked: true })] }]);
      const { listings } = await marketplace.listCatalog();
      const colliding = listings.filter((l) => l.id === "database");
      expect(colliding).toHaveLength(1);
      expect(colliding[0].collision).toBeUndefined();
    });
  });

  // CPHMTP-TC-044 S001: the mark is a property of the merged catalog, not of the
  // current view, so every filter that leaves the id visible still shows it marked.
  describe("the mark survives filter views (AC5, CPHMTP-TC-044)", () => {
    it("keeps the mark when scoped to the first-party source alone", async () => {
      wireCollision();
      const { listings } = await marketplace.listCatalog({ sourceId: FIRST_PARTY_SOURCE_ID });
      const listing = listings.find((l) => l.id === "database");
      // Only the first-party listing survives the filter, but it must NOT read as
      // unambiguous: that would be the view silently resolving the collision.
      expect(listing?.sourceId).toBe(FIRST_PARTY_SOURCE_ID);
      expect(listing?.collision).toEqual({ sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID] });
    });

    it("keeps the mark when scoped to the third-party source alone", async () => {
      wireCollision();
      const { listings } = await marketplace.listCatalog({ sourceId: ACME_ID });
      const listing = listings.find((l) => l.id === "database");
      expect(listing?.sourceId).toBe(ACME_ID);
      expect(listing?.collision).toEqual({ sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID] });
    });

    it("keeps the mark under a kind filter", async () => {
      wireCollision();
      const { listings } = await marketplace.listCatalog({ kind: "component" });
      expect(listings.find((l) => l.id === "database")?.collision).toEqual({
        sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID],
      });
    });

    // The query matches only the third-party entry's name, so the first-party one
    // is filtered out; the survivor must still be marked.
    it("keeps the mark under a query that matches only one of the colliding entries", async () => {
      wireCollision();
      const { listings } = await marketplace.listCatalog({ q: "third-party" });
      const listing = listings.find((l) => l.id === "database");
      expect(listing?.sourceId).toBe(ACME_ID);
      expect(listing?.collision).toEqual({ sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID] });
    });

    // CPHMTP-TC-044 S002: re-derived per call, so a refresh cannot lose it.
    it("re-derives the mark on a refetch", async () => {
      wireCollision();
      await marketplace.listCatalog();
      const { listings } = await marketplace.listCatalog();
      expect(listings.find((l) => l.id === "database")?.collision).toEqual({
        sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID],
      });
    });
  });

  // CPHMTP-TC-034 / TC-035: enforcement at the install AND update paths, not just
  // the listing. Nothing is fetched, so no artifact touches the machine.
  describe("install/update refuse an ambiguous id (AC2, AC3)", () => {
    it("refuses an install of a colliding id and names both sources", async () => {
      wireCollision();
      await expect(marketplace.install("database")).rejects.toMatchObject({
        code: "ambiguous-source",
        sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID],
      });
      // CPHMTP-TC-034 S002: refused BEFORE any artifact was fetched or staged.
      expect(previewFromGitUrl).not.toHaveBeenCalled();
      expect(previewFromRelease).not.toHaveBeenCalled();
    });

    it("refuses an update of a colliding id at the update path", async () => {
      wireCollision();
      await expect(marketplace.update("database")).rejects.toMatchObject({
        code: "ambiguous-source",
        sourceIds: [FIRST_PARTY_SOURCE_ID, ACME_ID],
      });
      // CPHMTP-TC-035 S002: the installed copy is left untouched.
      expect(previewUpdateFromGitUrl).not.toHaveBeenCalled();
      expect(previewUpdateFromRelease).not.toHaveBeenCalled();
    });

    it("still installs a single-source id with no source named", async () => {
      wireCollision();
      previewFromGitUrl.mockResolvedValue({ stagingToken: "t" } as Awaited<
        ReturnType<typeof pluginInstaller.previewFromGitUrl>
      >);
      // `github-com` is served by first-party alone, so it is unambiguous and the
      // collision guard must not block it.
      await expect(marketplace.install("github-com")).resolves.toBeDefined();
      expect(previewFromGitUrl).toHaveBeenCalled();
    });

    // The listing counterpart ("does not mark an id one source happens to serve
    // twice") de-dupes by source id, so this gate must count DISTINCT sources too.
    // Counting entries would refuse an install the listing shows as unambiguous.
    it("still installs when one source lists the same id twice", async () => {
      wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("acme-only"), entry("acme-only")] }]);
      previewFromRelease.mockResolvedValue({ stagingToken: "t" } as Awaited<
        ReturnType<typeof pluginInstaller.previewFromRelease>
      >);
      await expect(marketplace.install("acme-only")).resolves.toBeDefined();
      expect(previewFromRelease).toHaveBeenCalled();
    });
  });

  // CPHMTP-TC-042: an explicit choice resolves the ambiguity, and the trust
  // treatment follows the CHOSEN source.
  describe("an explicit source choice resolves it (AC4, CPHMTP-TC-042)", () => {
    it("installs from the named third-party source and records that choice as unverified", async () => {
      wireCollision();
      previewFromRelease.mockResolvedValue({ stagingToken: "t" } as Awaited<
        ReturnType<typeof pluginInstaller.previewFromRelease>
      >);
      await marketplace.install("database", ACME_ID);
      expect(previewFromRelease).toHaveBeenCalledWith(
        "https://marketplace.acme.example/database.tgz",
        "sha256-acme",
        // The unsigned source's trust treatment: the ThirdPartyInstallContext is
        // what makes the per-artifact digest mandatory and scopes the download to
        // the consented origin (CPHMTP-NFR-004 / NFR-002).
        {
          sourceOrigin: "https://marketplace.acme.example",
          credential: undefined,
          allowHttp: false,
        },
        // AC4: the record captures the chosen source, marked unverified because
        // that source is unsigned.
        { sourceId: ACME_ID, sourceUrl: ACME_URL, unverified: true },
      );
      // The first-party entry of the same id was NOT installed.
      expect(previewFromGitUrl).not.toHaveBeenCalled();
    });

    it("installs from the named first-party source and records it as verified", async () => {
      wireCollision();
      previewFromGitUrl.mockResolvedValue({ stagingToken: "t" } as Awaited<
        ReturnType<typeof pluginInstaller.previewFromGitUrl>
      >);
      await marketplace.install("database", FIRST_PARTY_SOURCE_ID);
      // CPHMTP-TC-042 S002: the first-party choice keeps the verified treatment,
      // and passes no third-party context.
      expect(previewFromGitUrl).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.anything(),
        undefined,
        FIRST_PARTY_PROVENANCE,
      );
      expect(previewFromRelease).not.toHaveBeenCalled();
    });

    it("passes the source's keyring credential and allowHttp opt-in to the installer", async () => {
      wire([
        {
          row: row(ACME_ID, ACME_URL, { hasCredential: true, allowHttp: true }),
          entries: [entry("database")],
        },
      ]);
      readSourceCredential.mockResolvedValue("tok-123");
      previewFromRelease.mockResolvedValue({ stagingToken: "t" } as Awaited<
        ReturnType<typeof pluginInstaller.previewFromRelease>
      >);
      await marketplace.install("database", ACME_ID);
      expect(previewFromRelease).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        {
          sourceOrigin: "https://marketplace.acme.example",
          credential: "tok-123",
          allowHttp: true,
        },
        expect.anything(),
      );
    });

    it("updates from the named source", async () => {
      wireCollision();
      previewUpdateFromRelease.mockResolvedValue({ stagingToken: "t" } as Awaited<
        ReturnType<typeof pluginInstaller.previewUpdateFromRelease>
      >);
      await marketplace.update("database", ACME_ID);
      expect(previewUpdateFromRelease).toHaveBeenCalledWith(
        "https://marketplace.acme.example/database.tgz",
        "database",
        "sha256-acme",
        expect.objectContaining({ sourceOrigin: "https://marketplace.acme.example" }),
        { sourceId: ACME_ID, sourceUrl: ACME_URL, unverified: true },
      );
    });

    // A stale choice must not fall back to another source: that would install code
    // from somewhere the consumer did not pick.
    it("refuses a choice naming a source that does not serve the id", async () => {
      wireCollision();
      await expect(marketplace.install("database", OTHER_ID)).rejects.toMatchObject({
        code: "invalid-input",
      });
      expect(previewFromRelease).not.toHaveBeenCalled();
      expect(previewFromGitUrl).not.toHaveBeenCalled();
    });

    it("refuses an explicit choice of a revoked entry as revoked, not ambiguous", async () => {
      wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("database", { revoked: true })] }]);
      await expect(marketplace.install("database", ACME_ID)).rejects.toMatchObject({
        code: "revoked",
      });
    });
  });

  // A third-party-only id must reach install rather than 404 at the route's
  // resolveEntry pre-check, which used to read the first-party catalog alone.
  describe("resolveEntry spans every source", () => {
    it("resolves an id only a third-party source serves", async () => {
      wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("acme-only")] }]);
      await expect(marketplace.resolveEntry("acme-only")).resolves.toMatchObject({
        id: "acme-only",
      });
    });

    it("resolves a colliding id rather than reporting it unknown", async () => {
      wireCollision();
      await expect(marketplace.resolveEntry("database")).resolves.not.toBeNull();
    });

    it("returns null for an id no source serves", async () => {
      wireCollision();
      await expect(marketplace.resolveEntry("nope")).resolves.toBeNull();
    });
  });

  // Issue #566 (CPHMTP-FR-008): the missing-plugin surface needs to know WHICH
  // sources serve an id, which resolveEntry explicitly refuses to answer. These
  // must stay in lockstep with the collision index and the install gate above: the
  // three read the same merged fan-out, so they cannot disagree about ambiguity.
  describe("resolveServingSources (issue #566)", () => {
    it("names the one source serving a third-party-only id", async () => {
      wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("acme-only")] }]);
      const serving = await marketplace.resolveServingSources("acme-only");
      expect(serving).toHaveLength(1);
      expect(serving[0]).toMatchObject({ id: ACME_ID, label: "marketplace.acme.example" });
    });

    it("names every source serving a colliding id, in fan-out order", async () => {
      wireCollision();
      const serving = await marketplace.resolveServingSources("database");
      // First-party first, then registered sources in registration order: the same
      // order buildCollisionIndex reports, so the pick-a-source list matches the
      // listing's collision mark.
      expect(serving.map((s) => s.id)).toEqual([FIRST_PARTY_SOURCE_ID, ACME_ID]);
    });

    it("returns nothing for an id no source serves", async () => {
      wireCollision();
      await expect(marketplace.resolveServingSources("nope")).resolves.toEqual([]);
    });

    // A revoked entry is served to no one, so counting it would invent an ambiguity
    // for an id only one source honestly serves (parity with buildCollisionIndex).
    it("excludes a source whose only matching entry is revoked", async () => {
      wire([{ row: row(ACME_ID, ACME_URL), entries: [entry("database", { revoked: true })] }]);
      const serving = await marketplace.resolveServingSources("database");
      expect(serving.map((s) => s.id)).toEqual([FIRST_PARTY_SOURCE_ID]);
    });

    // One source listing an id twice is its own duplicate, not a cross-source
    // collision, so it must not read as ambiguous.
    it("de-duplicates a source that lists the same id twice", async () => {
      wire([
        {
          row: row(ACME_ID, ACME_URL),
          entries: [entry("acme-only"), entry("acme-only", { version: "1.0.0" })],
        },
      ]);
      const serving = await marketplace.resolveServingSources("acme-only");
      expect(serving.map((s) => s.id)).toEqual([ACME_ID]);
    });
  });
});
