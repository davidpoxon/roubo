import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { MarketplaceListing } from "@roubo/shared";

vi.mock("../services/marketplace.js", () => ({
  listCatalog: vi.fn(),
  resolveEntry: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
}));

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

vi.mock("../services/catalog-client.js", () => {
  class CatalogUnverifiedError extends Error {
    readonly code = "catalog-unverified" as const;
    constructor(message = "The plugin catalog could not be verified and was rejected.") {
      super(message);
      this.name = "CatalogUnverifiedError";
    }
  }
  return { CatalogUnverifiedError };
});

import router from "./marketplace.js";
import * as marketplace from "../services/marketplace.js";
import * as pluginInstaller from "../services/plugin-installer.js";
import { CatalogUnverifiedError } from "../services/catalog-client.js";

const listCatalog = vi.mocked(marketplace.listCatalog);
const resolveEntry = vi.mocked(marketplace.resolveEntry);
const install = vi.mocked(marketplace.install);
const update = vi.mocked(marketplace.update);

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
};

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
  it("returns the curated catalog", async () => {
    listCatalog.mockResolvedValue([LISTING]);
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ curated: true, listings: [LISTING] });
    expect(listCatalog).toHaveBeenCalledWith({ q: undefined, kind: undefined });
  });

  it("passes through q and a valid kind", async () => {
    listCatalog.mockResolvedValue([]);
    await request(makeApp()).get("/api/marketplace/plugins?q=red&kind=component");
    expect(listCatalog).toHaveBeenCalledWith({ q: "red", kind: "component" });
  });

  it("ignores an invalid kind", async () => {
    listCatalog.mockResolvedValue([]);
    await request(makeApp()).get("/api/marketplace/plugins?kind=bogus");
    expect(listCatalog).toHaveBeenCalledWith({ q: undefined, kind: undefined });
  });

  // CP-TC-118 / CPHM-TC-006: when even the seed fails verification the service
  // throws CatalogUnverifiedError; the route fails closed with a typed 502 and
  // no listings.
  it("returns 502 catalog-unverified with no listings when the catalog is unverified", async () => {
    listCatalog.mockRejectedValue(new CatalogUnverifiedError());
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("catalog-unverified");
    expect(res.body.listings).toBeUndefined();
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
    expect(install).toHaveBeenCalledWith("redis");
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

  // Built-artifact install codes (issue #773): download-failed maps to 400,
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

  it("maps a CatalogUnverifiedError from resolveEntry to 502", async () => {
    resolveEntry.mockRejectedValue(new CatalogUnverifiedError());
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("catalog-unverified");
    expect(install).not.toHaveBeenCalled();
  });
});

describe("POST /api/marketplace/plugins/:id/update", () => {
  it("returns the update preview for a known catalog id", async () => {
    update.mockResolvedValue(PREVIEW);
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith("redis");
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
