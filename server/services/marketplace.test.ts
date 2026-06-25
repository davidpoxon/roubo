import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@roubo/shared";

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

import * as marketplace from "./marketplace.js";
import * as pluginManager from "./plugin-manager.js";
import * as pluginInstaller from "./plugin-installer.js";

const listInstalled = vi.mocked(pluginManager.listInstalled);
const previewFromGitUrl = vi.mocked(pluginInstaller.previewFromGitUrl);
const previewUpdateFromGitUrl = vi.mocked(pluginInstaller.previewUpdateFromGitUrl);

function installedRecord(id: string, version: string): PluginRecord {
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
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
  };
}

function annotatedById(id: string) {
  const found = marketplace.listCatalog().find((l) => l.id === id);
  if (!found) throw new Error(`expected listing ${id}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  listInstalled.mockReturnValue([]);
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
  it("returns both component and integration entries with verified + version", () => {
    const listings = marketplace.listCatalog();
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.some((l) => l.kind === "component")).toBe(true);
    expect(listings.some((l) => l.kind === "integration")).toBe(true);
    for (const l of listings) {
      expect(typeof l.verified).toBe("boolean");
      expect(typeof l.version).toBe("string");
      expect(l.version.length).toBeGreaterThan(0);
    }
  });

  it("filters by kind", () => {
    const components = marketplace.listCatalog({ kind: "component" });
    expect(components.length).toBeGreaterThan(0);
    expect(components.every((l) => l.kind === "component")).toBe(true);

    const integrations = marketplace.listCatalog({ kind: "integration" });
    expect(integrations.every((l) => l.kind === "integration")).toBe(true);
  });

  it("filters by free-text query over name, id, and summary (case-insensitive)", () => {
    const all = marketplace.listCatalog();
    const first = all[0];
    const byName = marketplace.listCatalog({ q: first.name.toUpperCase() });
    expect(byName.some((l) => l.id === first.id)).toBe(true);

    const none = marketplace.listCatalog({ q: "zzz-not-a-real-plugin-zzz" });
    expect(none).toHaveLength(0);
  });

  it("annotates an installed plugin at the same version as installed without update", () => {
    const entry = marketplace.listCatalog()[0];
    listInstalled.mockReturnValue([installedRecord(entry.id, entry.version)]);
    const annotated = annotatedById(entry.id);
    expect(annotated.installed).toBe(true);
    expect(annotated.installedVersion).toBe(entry.version);
    expect(annotated.updateAvailable).toBe(false);
  });

  it("flags updateAvailable when the installed version is older than the catalog", () => {
    const entry = marketplace.listCatalog()[0];
    listInstalled.mockReturnValue([installedRecord(entry.id, "0.0.1")]);
    const annotated = annotatedById(entry.id);
    expect(annotated.installed).toBe(true);
    expect(annotated.updateAvailable).toBe(true);
  });

  it("leaves a non-installed entry uninstalled with no update", () => {
    const entry = marketplace.listCatalog()[0];
    listInstalled.mockReturnValue([]);
    const annotated = annotatedById(entry.id);
    expect(annotated.installed).toBe(false);
    expect(annotated.installedVersion).toBeNull();
    expect(annotated.updateAvailable).toBe(false);
  });

  // CP-TC-109: a revoked entry is removed from the catalog grid. The checked-in
  // catalog includes a revoked `worker-queue` fixture.
  it("filters out revoked entries (CP-TC-109)", () => {
    expect(marketplace.listCatalog().some((l) => l.id === "worker-queue")).toBe(false);
  });
});

describe("CATALOG_VERIFIED", () => {
  it("verifies the checked-in signed catalog at load (AC-3)", () => {
    // The catalog ships a valid first-party signature; the service must not be
    // failing closed against the committed manifest.
    expect(marketplace.CATALOG_VERIFIED).toBe(true);
    expect(marketplace.listCatalog().length).toBeGreaterThan(0);
  });
});

describe("resolveEntry", () => {
  it("resolves a known catalog id", () => {
    const entry = marketplace.listCatalog()[0];
    expect(marketplace.resolveEntry(entry.id)?.id).toBe(entry.id);
  });

  it("returns null for an unknown id", () => {
    expect(marketplace.resolveEntry("definitely-not-in-catalog")).toBeNull();
  });
});

describe("install", () => {
  it("delegates to previewFromGitUrl with the entry's source", async () => {
    const entry = marketplace.listCatalog()[0];
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

  // CP-TC-109: a revoked id is rejected with a specific `revoked` error and the
  // installer is never invoked (no clone of a withdrawn plugin).
  it("rejects a revoked id with a revoked error (CP-TC-109)", async () => {
    await expect(marketplace.install("worker-queue")).rejects.toMatchObject({ code: "revoked" });
    expect(previewFromGitUrl).not.toHaveBeenCalled();
  });
});

describe("update", () => {
  it("delegates to previewUpdateFromGitUrl with the entry's source and id", async () => {
    const entry = marketplace.listCatalog()[0];
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

  // CP-TC-109: a revoked id cannot be updated either.
  it("rejects a revoked id with a revoked error (CP-TC-109)", async () => {
    await expect(marketplace.update("worker-queue")).rejects.toMatchObject({ code: "revoked" });
    expect(previewUpdateFromGitUrl).not.toHaveBeenCalled();
  });
});
