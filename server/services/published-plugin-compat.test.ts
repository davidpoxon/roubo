/**
 * HR-TC-054 (HR-NFR-005): a published plugin built against the current SDK
 * loads unchanged, and hot reload did not move the SDK's major version.
 *
 * Two parts. The default run checks the SDK's major version against the one
 * before the feature, and that the snapshot of the published github-com
 * manifest (e2e/fixtures/first-party-manifests/) still parses and is in range
 * of this host. The live part, run with ROUBO_LIVE_REGISTRY=1 (the nightly
 * perf workflow), takes the github-com entry of the live signed catalog at a
 * pinned version and runs the real install path: download, unpack, digest
 * check, manifest parse and host range check, then the commit that registers
 * and starts the plugin, a consent record for it, and a check that it reaches
 * the running state with a live connection. The install runs against a
 * throwaway home and plugins root, never the developer's own. The pin is
 * GITHUB_COM_PINNED_VERSION, overridable with ROUBO_LIVE_GITHUB_COM_VERSION;
 * a new release of the plugin fails the live part until the pin is moved, so
 * a version bump is a deliberate step.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { declaredCategories, parseManifest } from "@roubo/shared";
import { HOST_API_VERSION } from "./plugin-manager.js";

// The live part installs and starts a plugin through the real state files, so
// the home dir is a throwaway one. The mock is hoisted above every import so
// state.ts resolves its dir under it, never the real ~/.roubo.
const isolation = vi.hoisted(() => {
  process.env.ROUBO_PRODUCTION = "1";
  return { tmpHome: "" };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  isolation.tmpHome = realFs.mkdtempSync(actual.tmpdir() + "/roubo-live-home-");
  return {
    ...actual,
    default: { ...actual, homedir: () => isolation.tmpHome },
    homedir: () => isolation.tmpHome,
  };
});

const savedEnv = {
  ROUBO_PRODUCTION: process.env.ROUBO_PRODUCTION,
  ROUBO_USER_PLUGINS_DIR: process.env.ROUBO_USER_PLUGINS_DIR,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** The @roubo/plugin-sdk major version before hot reload: 0.8.0 was released before it. */
const SDK_MAJOR_BEFORE_HOT_RELOAD = 0;
/**
 * Before 1.0 a breaking change of the SDK bumps the minor, so the major alone
 * cannot fail: the default run pins the 0.8 minor that was released before hot
 * reload, and a breaking SDK release must move this on purpose.
 */
const SDK_RANGE_BEFORE_HOT_RELOAD = "~0.8.0";

/** The github-com version the live part installs. */
const GITHUB_COM_PINNED_VERSION = process.env.ROUBO_LIVE_GITHUB_COM_VERSION || "0.2.1";

const LIVE = process.env.ROUBO_LIVE_REGISTRY === "1";

function readSdkVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "plugin-sdk", "package.json"), "utf-8"),
  ) as { version: string };
  return pkg.version;
}

describe("HR-TC-054: a published plugin built against the current SDK loads unchanged", () => {
  it("HR-TC-054: the @roubo/plugin-sdk major version equals the version before hot reload", () => {
    const version = readSdkVersion();
    expect(semver.valid(version), `plugin-sdk/package.json version ${version}`).not.toBeNull();
    expect(semver.major(version)).toBe(SDK_MAJOR_BEFORE_HOT_RELOAD);
    expect(
      semver.satisfies(version, SDK_RANGE_BEFORE_HOT_RELOAD),
      `plugin-sdk ${version} stays within ${SDK_RANGE_BEFORE_HOT_RELOAD}, the 0.x minor before hot reload`,
    ).toBe(true);
  });

  it("HR-TC-054: the published github-com manifest parses and is in range of this host", () => {
    const file = path.join(
      repoRoot,
      "e2e",
      "fixtures",
      "first-party-manifests",
      "github-com",
      "roubo-plugin.yaml",
    );
    const parsed = parseManifest(fs.readFileSync(file, "utf-8"), file);
    expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.id).toBe("github-com");
    expect(
      semver.satisfies(HOST_API_VERSION, parsed.manifest.roubo),
      `host ${HOST_API_VERSION} satisfies ${parsed.manifest.roubo}`,
    ).toBe(true);
  });

  it.skipIf(!LIVE)(
    "HR-TC-054: the pinned github-com release from the live registry installs, consents and connects",
    async () => {
      const { createCatalogClient } = await import("./catalog-client.js");
      const installer = await import("./plugin-installer.js");
      const pluginManager = await import("./plugin-manager.js");
      const consentState = await import("./plugin-consent-state.js");
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-live-catalog-"));
      const userPlugins = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-live-plugins-"));
      process.env.ROUBO_USER_PLUGINS_DIR = userPlugins;
      fs.mkdirSync(path.join(isolation.tmpHome, ".roubo"), { recursive: true });
      try {
        const catalog = await createCatalogClient({ cacheDir }).getVerifiedCatalog({
          forceRefresh: true,
        });
        expect(catalog.source, "the live catalog verified over the network").toBe("network");
        const entry = catalog.entries.find((e) => e.id === "github-com");
        expect(entry, "the live catalog lists github-com").toBeDefined();
        if (!entry) return;
        expect(entry.version, "the live github-com version is the pinned one").toBe(
          GITHUB_COM_PINNED_VERSION,
        );
        expect(entry.source.type).toBe("release");
        if (entry.source.type !== "release") return;

        const preview = await installer.previewFromRelease(entry.source.assetUrl, entry.integrity);
        expect(preview.manifest.id).toBe("github-com");
        expect(preview.manifest.version).toBe(GITHUB_COM_PINNED_VERSION);
        expect(semver.satisfies(HOST_API_VERSION, preview.manifest.roubo)).toBe(true);

        // It registers: the commit moves the release into the plugins root and starts it.
        const record = await installer.commit(preview.stagingToken);
        try {
          expect(record.id).toBe("github-com");
          expect(pluginManager.listInstalled().map((r) => r.id)).toContain("github-com");

          // It consents: a record that names the categories the manifest declares.
          const consent = consentState.upsertConsent(
            "github-com",
            declaredCategories(preview.manifest.permissions),
          );
          expect(consentState.hasConsent("github-com")).toBe(true);
          expect(consent.pluginId).toBe("github-com");

          // It connects: the plugin reaches the enabled state with a live connection.
          const running = pluginManager.getRecord("github-com");
          expect(running?.status, `github-com status (${running?.lastError?.message ?? ""})`).toBe(
            "enabled",
          );
          expect(pluginManager.getConnection("github-com"), "a live connection").not.toBeNull();
        } finally {
          await pluginManager.uninstall("github-com");
        }
      } finally {
        await pluginManager.shutdown().catch(() => undefined);
        fs.rmSync(cacheDir, { recursive: true, force: true });
        fs.rmSync(userPlugins, { recursive: true, force: true });
      }
    },
    120_000,
  );

  afterAll(() => {
    fs.rmSync(isolation.tmpHome, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });
});
