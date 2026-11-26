/**
 * HR-TC-054 (HR-NFR-005): a published plugin built against the current SDK
 * loads unchanged, and hot reload did not move the SDK's major version.
 *
 * Two parts. The default run checks the SDK's major version against the one
 * before the feature, and that the snapshot of the published github-com
 * manifest (e2e/fixtures/first-party-manifests/) still parses and is in range
 * of this host. The live part, run with ROUBO_LIVE_REGISTRY=1 (the nightly
 * perf workflow), takes the github-com entry of the live signed catalog at a
 * pinned version and stages it through the real install path: download,
 * unpack, digest check, manifest parse and host range check, the same steps a
 * marketplace install runs before it registers the plugin. The pin is
 * GITHUB_COM_PINNED_VERSION, overridable with ROUBO_LIVE_GITHUB_COM_VERSION;
 * a new release of the plugin fails the live part until the pin is moved, so
 * a version bump is a deliberate step.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { parseManifest } from "@roubo/shared";
import { HOST_API_VERSION } from "./plugin-manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** The @roubo/plugin-sdk major version before hot reload: 0.8.0 was released before it. */
const SDK_MAJOR_BEFORE_HOT_RELOAD = 0;

/** The github-com version the live part installs. */
const GITHUB_COM_PINNED_VERSION = process.env.ROUBO_LIVE_GITHUB_COM_VERSION || "0.2.0";

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
    "HR-TC-054: the pinned github-com release from the live registry stages through the install path",
    async () => {
      const { createCatalogClient } = await import("./catalog-client.js");
      const installer = await import("./plugin-installer.js");
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-live-catalog-"));
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
        try {
          expect(preview.manifest.id).toBe("github-com");
          expect(preview.manifest.version).toBe(GITHUB_COM_PINNED_VERSION);
          expect(semver.satisfies(HOST_API_VERSION, preview.manifest.roubo)).toBe(true);
        } finally {
          await installer.cancel(preview.stagingToken);
        }
      } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
