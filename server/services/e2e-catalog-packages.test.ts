import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { MarketplaceCatalogEntry } from "@roubo/shared";

vi.mock("undici", () => ({
  fetch: vi.fn(async () => new Response("from the network", { status: 200 })),
}));

import { fetch as undiciFetch } from "undici";
import {
  E2E_PACKAGE_ORIGIN,
  catalogPackageEntry,
  catalogPackageFetch,
  catalogPackageUrl,
  isCatalogPackageRef,
} from "./e2e-catalog-packages.js";
import { computePackageDigest } from "./marketplace-integrity.js";

const BASE: MarketplaceCatalogEntry = {
  id: "database",
  name: "Database",
  kind: "component",
  version: "0.1.1",
  summary: "Docker-backed databases via compose.",
  source: { type: "git", url: "https://example.com/plugins.git", directory: "database" },
  provenance: "roubo/plugins@database",
  integrity: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
  verified: true,
};

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
  vi.mocked(undiciFetch).mockClear();
});

/** Unpack a served tarball into a fresh directory, as the installer would. */
async function unpack(res: Response): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roubo-e2e-package-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "..", `${path.basename(dir)}.tgz`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  tmpDirs.push(file);
  await tar.x({ file, cwd: dir });
  return dir;
}

describe("catalogPackageEntry", () => {
  it("HR-TC-012 serves a fixture version as a release-sourced entry with the package's real digest", async () => {
    const entry = await catalogPackageEntry(BASE, "1.1.0");

    expect(entry).toMatchObject({
      id: "database",
      name: "Database",
      version: "1.1.0",
      source: { type: "release", assetUrl: `${E2E_PACKAGE_ORIGIN}/database/1.1.0.tgz` },
    });
    expect(entry?.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(entry?.integrity).not.toBe(BASE.integrity);
  });

  it("gives each fixture version its own digest", async () => {
    const older = await catalogPackageEntry(BASE, "1.0.0");
    const newer = await catalogPackageEntry(BASE, "1.1.0");

    expect(older?.integrity).not.toBe(newer?.integrity);
  });

  it("returns null for a version no fixture package has", async () => {
    expect(await catalogPackageEntry(BASE, "9.9.9")).toBeNull();
    expect(await catalogPackageEntry({ ...BASE, id: "no-such-plugin" }, "1.0.0")).toBeNull();
  });
});

describe("catalogPackageFetch", () => {
  it("HR-TC-012 answers a package URL with a tarball that unpacks to the digest the entry carries", async () => {
    const entry = await catalogPackageEntry(BASE, "1.1.0");
    const res = await catalogPackageFetch(catalogPackageUrl("database", "1.1.0"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const dir = await unpack(res);
    expect(await computePackageDigest(dir)).toBe(entry?.integrity);
    expect(await readFile(path.join(dir, "roubo-plugin.yaml"), "utf8")).toMatch(
      /^version: 1\.1\.0$/m,
    );
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("answers 404 for a package path with no fixture package", async () => {
    const missing = await catalogPackageFetch(`${E2E_PACKAGE_ORIGIN}/database/9.9.9.tgz`);
    const malformed = await catalogPackageFetch(`${E2E_PACKAGE_ORIGIN}/database/../../etc.tgz`);

    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("sends a URL on any other origin to the network", async () => {
    const res = await catalogPackageFetch("https://example.com/echo.tgz", { method: "GET" });

    expect(await res.text()).toBe("from the network");
    expect(undiciFetch).toHaveBeenCalledWith("https://example.com/echo.tgz", { method: "GET" });
  });
});

describe("isCatalogPackageRef", () => {
  it("accepts a plugin id and a MAJOR.MINOR.PATCH version only", () => {
    expect(isCatalogPackageRef("database", "1.0.0")).toBe(true);
    expect(isCatalogPackageRef("Database", "1.0.0")).toBe(false);
    expect(isCatalogPackageRef("database", "1.0")).toBe(false);
    expect(isCatalogPackageRef("database", "../1.0.0")).toBe(false);
    expect(isCatalogPackageRef(undefined, "1.0.0")).toBe(false);
  });
});
