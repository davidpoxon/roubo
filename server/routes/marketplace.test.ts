import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceListing, MarketplaceSourceStatus } from "@roubo/shared";

vi.mock("../services/marketplace.js", () => {
  // The route narrows with `err instanceof marketplace.AmbiguousSourceError`, so
  // the mock must export a real class: an undefined right-hand side makes
  // `instanceof` throw a TypeError that the catch would report as a 500, masking
  // every mapped status (issue #558).
  class AmbiguousSourceError extends Error {
    readonly code = "ambiguous-source" as const;
    readonly pluginId: string;
    readonly sourceIds: string[];
    constructor(pluginId: string, sourceIds: string[]) {
      super(`Plugin "${pluginId}" is served by ${sourceIds.length} sources.`);
      this.pluginId = pluginId;
      this.sourceIds = sourceIds;
      this.name = "AmbiguousSourceError";
    }
  }
  return {
    AmbiguousSourceError,
    listCatalog: vi.fn(),
    resolveEntry: vi.fn(),
    install: vi.fn(),
    update: vi.fn(),
    invalidateSourceClient: vi.fn(),
  };
});

vi.mock("../services/plugin-installer.js", () => {
  class InstallError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "InstallError";
    }
  }
  return { InstallError };
});

vi.mock("../services/marketplace-sources-state.js", () => ({
  listSourceSummaries: vi.fn(),
  addSource: vi.fn(),
  removeSource: vi.fn(),
}));

import router from "./marketplace.js";
import * as marketplace from "../services/marketplace.js";
import * as pluginInstaller from "../services/plugin-installer.js";
import * as sourcesState from "../services/marketplace-sources-state.js";

const listCatalog = vi.mocked(marketplace.listCatalog);
const resolveEntry = vi.mocked(marketplace.resolveEntry);
const install = vi.mocked(marketplace.install);
const update = vi.mocked(marketplace.update);
const invalidateSourceClient = vi.mocked(marketplace.invalidateSourceClient);
const listSourceSummaries = vi.mocked(sourcesState.listSourceSummaries);
const addSource = vi.mocked(sourcesState.addSource);
const removeSource = vi.mocked(sourcesState.removeSource);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/marketplace", router);
  return app;
}

const ENTRY = {
  id: "redis",
  name: "Redis",
  kind: "component" as const,
  version: "1.3.0",
  summary: "cache",
  source: { type: "git" as const, url: "https://example.com/r.git" },
  provenance: "roubo/plugins@redis",
  integrity: "sha256-redis",
  verified: true,
};

const LISTING: MarketplaceListing = {
  ...ENTRY,
  installed: false,
  installedVersion: null,
  updateAvailable: false,
  declaredPermissions: null,
  lifecycle: null,
  sourceId: FIRST_PARTY_SOURCE_ID,
};

const FETCHED_AT = "2026-06-28T00:00:00.000Z";

// The always-present built-in source's status row (issue #557): the fan-out
// reports it first, and it is never unavailable (its chain has the seed floor).
const FIRST_PARTY_STATUS: MarketplaceSourceStatus = {
  id: FIRST_PARTY_SOURCE_ID,
  url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  label: "Roubo first-party",
  source: "network",
  fetchedAt: FETCHED_AT,
  unavailable: false,
};

// The CatalogResult shape listCatalog now resolves to: the merged listings, the
// first-party catalog's provenance (source / fetchedAt) for the offline /
// staleness banner (issue #372), and the per-source status of every source in the
// fan-out (issue #557). GET /plugins forwards all of it.
function catalogResult(
  listings: MarketplaceListing[],
  source: "network" | "cache" = "network",
  fetchedAt: string | null = FETCHED_AT,
  sources: MarketplaceSourceStatus[] = [FIRST_PARTY_STATUS],
): Awaited<ReturnType<typeof marketplace.listCatalog>> {
  return { listings, source, fetchedAt, sources };
}

const PREVIEW = {
  stagingToken: "11111111-1111-1111-1111-111111111111",
  source: ENTRY.source,
  manifest: { id: "redis", name: "Redis", version: "1.3.0" },
} as unknown as Awaited<ReturnType<typeof marketplace.install>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveEntry.mockResolvedValue(ENTRY);
});

describe("GET /api/marketplace/plugins", () => {
  it("returns the curated catalog with the network source and fetch timestamp", async () => {
    listCatalog.mockResolvedValue(catalogResult([LISTING], "network"));
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      curated: true,
      listings: [LISTING],
      source: "network",
      fetchedAt: FETCHED_AT,
      sources: [FIRST_PARTY_STATUS],
    });
    expect(listCatalog).toHaveBeenCalledWith({
      q: undefined,
      kind: undefined,
      sourceId: undefined,
    });
  });

  // CPHM-TC-043 (issue #372): when the marketplace is unreachable the catalog
  // degrades to the last-known cache; the route forwards source "cache" + the
  // cached fetch timestamp so the client can render the offline banner.
  it("forwards the cache source and fetch timestamp when degraded to the cache", async () => {
    listCatalog.mockResolvedValue(catalogResult([LISTING], "cache"));
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("cache");
    expect(res.body.fetchedAt).toBe(FETCHED_AT);
    expect(res.body.listings).toHaveLength(1);
  });

  // CPHM-FR-009 (issue #372, #621): the empty-listing degrade (no bundled seed
  // floor) reports source "cache" with a null fetchedAt (nothing was fetched).
  it("forwards the cache source and a null fetch timestamp on the empty degrade", async () => {
    listCatalog.mockResolvedValue(catalogResult([], "cache", null));
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("cache");
    expect(res.body.fetchedAt).toBeNull();
  });

  it("passes through q and a valid kind", async () => {
    listCatalog.mockResolvedValue(catalogResult([]));
    await request(makeApp()).get("/api/marketplace/plugins?q=red&kind=component");
    expect(listCatalog).toHaveBeenCalledWith({
      q: "red",
      kind: "component",
      sourceId: undefined,
    });
  });

  it("ignores an invalid kind", async () => {
    listCatalog.mockResolvedValue(catalogResult([]));
    await request(makeApp()).get("/api/marketplace/plugins?kind=bogus");
    expect(listCatalog).toHaveBeenCalledWith({
      q: undefined,
      kind: undefined,
      sourceId: undefined,
    });
  });

  // Issue #557: the source filter chip scopes the merged multi-source list to one
  // source, so the chosen id is threaded through to the service.
  it("passes through sourceId so the list can be scoped to one source", async () => {
    listCatalog.mockResolvedValue(catalogResult([]));
    await request(makeApp()).get("/api/marketplace/plugins?sourceId=acme-example-1a2b3c4d");
    expect(listCatalog).toHaveBeenCalledWith({
      q: undefined,
      kind: undefined,
      sourceId: "acme-example-1a2b3c4d",
    });
  });

  // Issue #557: the per-source status rows ride back on the response so the client
  // can render one filter chip per source and call out only the failed one.
  it("forwards the per-source status of every source in the fan-out", async () => {
    const acme: MarketplaceSourceStatus = {
      id: "marketplace-acme-example-1a2b3c4d",
      url: "https://marketplace.acme.example/catalog.json",
      label: "marketplace.acme.example",
      source: "cache",
      fetchedAt: null,
      unavailable: true,
    };
    listCatalog.mockResolvedValue(
      catalogResult([LISTING], "network", FETCHED_AT, [FIRST_PARTY_STATUS, acme]),
    );
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([FIRST_PARTY_STATUS, acme]);
    // A dead third-party source never flips the first-party offline banner.
    expect(res.body.source).toBe("network");
  });

  it("returns 500 on an unexpected error", async () => {
    listCatalog.mockRejectedValue(new Error("boom"));
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal");
  });
});

describe("POST /api/marketplace/plugins/:id/install", () => {
  it("returns the install preview for a known catalog id", async () => {
    install.mockResolvedValue(PREVIEW);
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(200);
    expect(res.body.stagingToken).toBe(PREVIEW.stagingToken);
    // No body, so no explicit source choice: the id must resolve from exactly one
    // source (issue #558).
    expect(install).toHaveBeenCalledWith("redis", undefined);
  });

  it("rejects an invalid id with 400", async () => {
    const res = await request(makeApp()).post("/api/marketplace/plugins/Bad_Id/install");
    expect(res.status).toBe(400);
    expect(install).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown catalog id", async () => {
    resolveEntry.mockResolvedValue(null);
    const res = await request(makeApp()).post("/api/marketplace/plugins/ghost/install");
    expect(res.status).toBe(404);
    expect(install).not.toHaveBeenCalled();
  });

  it("maps an InstallError code to its status", async () => {
    install.mockRejectedValue(new pluginInstaller.InstallError("clone-failed", "nope"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("clone-failed");
  });

  // CP-TC-107/108: a tampered/unsigned package fails the integrity check; 422.
  it("maps integrity-failed to 422", async () => {
    install.mockRejectedValue(new pluginInstaller.InstallError("integrity-failed", "tampered"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("integrity-failed");
  });

  // CP-TC-109: a revoked entry is rejected; 410 Gone.
  it("maps revoked to 410", async () => {
    install.mockRejectedValue(new pluginInstaller.InstallError("revoked", "withdrawn"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("revoked");
  });

  // Built-artifact install codes (issue #370): download-failed maps to 400,
  // unpack-failed to 422.
  it("maps download-failed to 400", async () => {
    resolveEntry.mockReturnValue(ENTRY);
    install.mockRejectedValue(new pluginInstaller.InstallError("download-failed", "HTTP 404"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("download-failed");
  });

  it("maps unpack-failed to 422", async () => {
    resolveEntry.mockReturnValue(ENTRY);
    install.mockRejectedValue(new pluginInstaller.InstallError("unpack-failed", "zip-slip"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("unpack-failed");
  });

  // CPHMTP-TC-051 (issue #559): a third-party entry with no usable per-artifact
  // digest is uninstallable, and the installer refuses it before fetching the
  // artifact. The route surfaces that refusal as 422 missing-integrity.
  it("maps missing-integrity to 422", async () => {
    resolveEntry.mockReturnValue(ENTRY);
    install.mockRejectedValue(
      new pluginInstaller.InstallError("missing-integrity", "no per-artifact digest"),
    );
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("missing-integrity");
  });

  // CPHM-TC-045/050/051: a new install while the marketplace is unreachable is
  // paused; the route maps marketplace-unreachable to 503.
  it("maps marketplace-unreachable to 503", async () => {
    install.mockRejectedValue(
      new pluginInstaller.InstallError("marketplace-unreachable", "offline"),
    );
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("marketplace-unreachable");
  });
});

describe("POST /api/marketplace/plugins/:id/update", () => {
  it("returns the update preview for a known catalog id", async () => {
    update.mockResolvedValue(PREVIEW);
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith("redis", undefined);
  });

  it("rejects an invalid id with 400", async () => {
    const res = await request(makeApp()).post("/api/marketplace/plugins/Bad_Id/update");
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown catalog id", async () => {
    resolveEntry.mockResolvedValue(null);
    const res = await request(makeApp()).post("/api/marketplace/plugins/ghost/update");
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it("maps update-target-missing to 404", async () => {
    update.mockRejectedValue(new pluginInstaller.InstallError("update-target-missing", "gone"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("update-target-missing");
  });

  // CP-TC-112: a tampered update package fails integrity; 422.
  it("maps integrity-failed to 422 on update", async () => {
    update.mockRejectedValue(new pluginInstaller.InstallError("integrity-failed", "tampered"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("integrity-failed");
  });

  // Issue #559: an unsigned entry with no usable digest is equally un-updatable.
  it("maps missing-integrity to 422 on update", async () => {
    update.mockRejectedValue(
      new pluginInstaller.InstallError("missing-integrity", "no per-artifact digest"),
    );
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("missing-integrity");
  });

  // CP-TC-109: a revoked entry cannot be updated; 410.
  it("maps revoked to 410 on update", async () => {
    update.mockRejectedValue(new pluginInstaller.InstallError("revoked", "withdrawn"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("revoked");
  });

  it("maps marketplace-unreachable to 503 on update", async () => {
    update.mockRejectedValue(
      new pluginInstaller.InstallError("marketplace-unreachable", "offline"),
    );
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("marketplace-unreachable");
  });
});

// Third-party source registry endpoints (issue #553; CPHMTP-FR-001,
// CPHMTP-FR-003, CPHMTP-NFR-002, CPHMTP-NFR-003). Persistence, id generation, and
// credential handling are exercised in marketplace-sources-state.test.ts; here we
// assert only the HTTP status/shape mapping the route owns.
const SUMMARY = {
  id: "example-com-0a1b2c3d",
  url: "https://example.com/catalog.json",
  hasCredential: true,
  registeredAt: "2026-07-16T00:00:00.000Z",
};

describe("GET /api/marketplace/sources", () => {
  it("returns the source summaries (first-party plus registered)", async () => {
    const firstParty = {
      id: "first-party",
      url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
      hasCredential: false,
      registeredAt: "1970-01-01T00:00:00.000Z",
    };
    listSourceSummaries.mockReturnValue([firstParty, SUMMARY]);
    const res = await request(makeApp()).get("/api/marketplace/sources");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sources: [firstParty, SUMMARY] });
  });
});

describe("POST /api/marketplace/sources", () => {
  it("registers a new source with 201 and passes the body through", async () => {
    addSource.mockResolvedValue({ outcome: "created", source: SUMMARY });
    const res = await request(makeApp())
      .post("/api/marketplace/sources")
      .send({ url: SUMMARY.url, credential: "tok", allowHttp: false });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(SUMMARY);
    expect(addSource).toHaveBeenCalledWith({
      url: SUMMARY.url,
      credential: "tok",
      allowHttp: false,
    });
  });

  it("rejects an invalid URL with 400", async () => {
    addSource.mockResolvedValue({ outcome: "invalid-url" });
    const res = await request(makeApp())
      .post("/api/marketplace/sources")
      .send({ url: "not a url" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid-url");
  });

  it("returns 409 for an already-registered URL (credential replaced, no new row)", async () => {
    addSource.mockResolvedValue({ outcome: "replaced", source: SUMMARY });
    const res = await request(makeApp())
      .post("/api/marketplace/sources")
      .send({ url: SUMMARY.url, credential: "rotated" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(SUMMARY);
  });

  // A cached client captured the OLD credential at construction, and a rotation
  // changes neither the id nor the url, so the registry write is the only place
  // that knows the client is stale (issue #557).
  it("drops the source's cached client when a rotation replaces its credential", async () => {
    addSource.mockResolvedValue({ outcome: "replaced", source: SUMMARY });
    await request(makeApp())
      .post("/api/marketplace/sources")
      .send({ url: SUMMARY.url, credential: "rotated" });
    expect(invalidateSourceClient).toHaveBeenCalledWith(SUMMARY.id);
  });

  it("drops any client left over from a same-URL row on a fresh registration", async () => {
    addSource.mockResolvedValue({ outcome: "created", source: SUMMARY });
    await request(makeApp())
      .post("/api/marketplace/sources")
      .send({ url: SUMMARY.url, credential: "tok" });
    expect(invalidateSourceClient).toHaveBeenCalledWith(SUMMARY.id);
  });

  it("returns 500 when the store throws (e.g. keyring unavailable)", async () => {
    addSource.mockRejectedValue(new Error("keyring unavailable"));
    const res = await request(makeApp())
      .post("/api/marketplace/sources")
      .send({ url: SUMMARY.url, credential: "tok" });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal");
    expect(invalidateSourceClient).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/marketplace/sources/:id", () => {
  it("removes a registered source with 204 and drops its cached client", async () => {
    removeSource.mockResolvedValue("removed");
    const res = await request(makeApp()).delete(`/api/marketplace/sources/${SUMMARY.id}`);
    expect(res.status).toBe(204);
    expect(removeSource).toHaveBeenCalledWith(SUMMARY.id);
    // The client would otherwise outlive a same-URL re-registration.
    expect(invalidateSourceClient).toHaveBeenCalledWith(SUMMARY.id);
  });

  it("refuses to remove the first-party source with 403", async () => {
    removeSource.mockResolvedValue("first-party");
    const res = await request(makeApp()).delete("/api/marketplace/sources/first-party");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("returns 404 for an unknown source id", async () => {
    removeSource.mockResolvedValue("not-found");
    const res = await request(makeApp()).delete("/api/marketplace/sources/ghost-00000000");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not-found");
  });
});

// Issue #558 (CPHMTP-FR-005): a cross-source id collision surfaces as a typed 409
// carrying the contributing source ids, at BOTH the install and update paths. It
// is deliberately not an InstallError: that channel flattens to { error, code }
// and would drop the sourceIds the client needs to offer the pick-a-source choices.
describe("ambiguous-source refusal (issue #558)", () => {
  const SOURCE_IDS = [FIRST_PARTY_SOURCE_ID, "marketplace-acme-example-1a2b3c4d"];

  function ambiguous(): Error {
    return new marketplace.AmbiguousSourceError("database", SOURCE_IDS);
  }

  it("maps an ambiguous install to 409 with the source ids", async () => {
    install.mockRejectedValue(ambiguous());
    const res = await request(makeApp()).post("/api/marketplace/plugins/database/install");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous-source");
    // The payload the client renders its install-from choices from; a flattened
    // body would leave it with nothing to offer.
    expect(res.body.sourceIds).toEqual(SOURCE_IDS);
    expect(res.body.error).toContain("database");
  });

  // AC3: enforced at the update path too, not only install.
  it("maps an ambiguous update to 409 with the source ids", async () => {
    update.mockRejectedValue(ambiguous());
    const res = await request(makeApp()).post("/api/marketplace/plugins/database/update");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous-source");
    expect(res.body.sourceIds).toEqual(SOURCE_IDS);
  });

  it("forwards an explicit sourceId from the install body", async () => {
    install.mockResolvedValue(PREVIEW);
    const res = await request(makeApp())
      .post("/api/marketplace/plugins/database/install")
      .send({ sourceId: "marketplace-acme-example-1a2b3c4d" });
    expect(res.status).toBe(200);
    expect(install).toHaveBeenCalledWith("database", "marketplace-acme-example-1a2b3c4d");
  });

  it("forwards an explicit sourceId from the update body", async () => {
    update.mockResolvedValue(PREVIEW);
    const res = await request(makeApp())
      .post("/api/marketplace/plugins/database/update")
      .send({ sourceId: "marketplace-acme-example-1a2b3c4d" });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith("database", "marketplace-acme-example-1a2b3c4d");
  });

  // A malformed sourceId is not a 400: it reads as "no choice", and the service
  // rejects it against the sources that actually serve the id.
  it("treats a non-string sourceId as no choice", async () => {
    install.mockResolvedValue(PREVIEW);
    const res = await request(makeApp())
      .post("/api/marketplace/plugins/database/install")
      .send({ sourceId: 42 });
    expect(res.status).toBe(200);
    expect(install).toHaveBeenCalledWith("database", undefined);
  });
});
