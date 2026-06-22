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

import router from "./marketplace.js";
import * as marketplace from "../services/marketplace.js";
import * as pluginInstaller from "../services/plugin-installer.js";

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
});

describe("GET /api/marketplace/plugins", () => {
  it("returns the curated catalog", async () => {
    listCatalog.mockReturnValue([LISTING]);
    const res = await request(makeApp()).get("/api/marketplace/plugins");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ curated: true, listings: [LISTING] });
    expect(listCatalog).toHaveBeenCalledWith({ q: undefined, kind: undefined });
  });

  it("passes through q and a valid kind", async () => {
    listCatalog.mockReturnValue([]);
    await request(makeApp()).get("/api/marketplace/plugins?q=red&kind=component");
    expect(listCatalog).toHaveBeenCalledWith({ q: "red", kind: "component" });
  });

  it("ignores an invalid kind", async () => {
    listCatalog.mockReturnValue([]);
    await request(makeApp()).get("/api/marketplace/plugins?kind=bogus");
    expect(listCatalog).toHaveBeenCalledWith({ q: undefined, kind: undefined });
  });
});

describe("POST /api/marketplace/plugins/:id/install", () => {
  it("returns the install preview for a known catalog id", async () => {
    resolveEntry.mockReturnValue(ENTRY);
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
    resolveEntry.mockReturnValue(null);
    const res = await request(makeApp()).post("/api/marketplace/plugins/ghost/install");
    expect(res.status).toBe(404);
    expect(install).not.toHaveBeenCalled();
  });

  it("maps an InstallError code to its status", async () => {
    resolveEntry.mockReturnValue(ENTRY);
    install.mockRejectedValue(new pluginInstaller.InstallError("clone-failed", "nope"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/install");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("clone-failed");
  });
});

describe("POST /api/marketplace/plugins/:id/update", () => {
  it("returns the update preview for a known catalog id", async () => {
    resolveEntry.mockReturnValue(ENTRY);
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
    resolveEntry.mockReturnValue(null);
    const res = await request(makeApp()).post("/api/marketplace/plugins/ghost/update");
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it("maps update-target-missing to 404", async () => {
    resolveEntry.mockReturnValue(ENTRY);
    update.mockRejectedValue(new pluginInstaller.InstallError("update-target-missing", "gone"));
    const res = await request(makeApp()).post("/api/marketplace/plugins/redis/update");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("update-target-missing");
  });
});
