import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import config, { buildOsxNotarize } from "./forge.config.js";

describe("forge.config", () => {
  it("registers AutoUnpackNativesPlugin so node-pty .node binaries are unpacked from asar", () => {
    expect(config.plugins).toBeDefined();
    const names = (config.plugins ?? []).map((p: { name: string }) => p.name);
    expect(names).toContain("auto-unpack-natives");
  });

  it("includes maker-dmg for darwin only", () => {
    type Maker = { name: string; platforms?: string[] };
    const dmg = ((config.makers as Maker[]) ?? []).find(
      (m) => m.name === "@electron-forge/maker-dmg",
    );
    expect(dmg).toBeDefined();
    expect(dmg?.platforms).toEqual(["darwin"]);
  });

  it("includes maker-zip for darwin only", () => {
    type Maker = { name: string; platforms?: string[] };
    const zip = ((config.makers as Maker[]) ?? []).find(
      (m) => m.name === "@electron-forge/maker-zip",
    );
    expect(zip).toBeDefined();
    expect(zip?.platforms).toEqual(["darwin"]);
  });

  it("sets appBundleId to dev.roubo.desktop", () => {
    expect(config.packagerConfig?.appBundleId).toBe("dev.roubo.desktop");
  });

  it("registers the roubo:// protocol scheme for deep linking and OAuth", () => {
    type Protocol = { name: string; schemes: string[] };
    const protocols = (config.packagerConfig as Record<string, unknown>)?.protocols as
      | Protocol[]
      | undefined;
    expect(protocols).toBeDefined();
    expect(protocols?.some((p) => p.schemes.includes("roubo"))).toBe(true);
  });

  it("registers x-scheme-handler/roubo MIME type in the deb maker for Linux protocol support", () => {
    type Maker = { name: string; config?: { options?: { mimeType?: string[] } } };
    const deb = ((config.makers as Maker[]) ?? []).find(
      (m) => m.name === "@electron-forge/maker-deb",
    );
    expect(deb?.config?.options?.mimeType).toContain("x-scheme-handler/roubo");
  });

  it("includes maker-appimage for linux only", () => {
    type Maker = { name: string; platforms?: string[] };
    const appimage = ((config.makers as Maker[]) ?? []).find(
      (m) => m.name === "@reforged/maker-appimage",
    );
    expect(appimage).toBeDefined();
    expect(appimage?.platforms).toEqual(["linux"]);
  });

  it("registers x-scheme-handler/roubo MIME type in the appimage maker for Linux protocol support", () => {
    type Maker = { name: string; config?: { options?: { mimeType?: string[] } } };
    const appimage = ((config.makers as Maker[]) ?? []).find(
      (m) => m.name === "@reforged/maker-appimage",
    );
    expect(appimage?.config?.options?.mimeType).toContain("x-scheme-handler/roubo");
  });
});

describe("forge.config osxSign gating", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("omits osxSign when neither CSC_LINK nor CSC_KEY_PASSWORD is set", async () => {
    vi.stubEnv("CSC_LINK", "");
    vi.stubEnv("CSC_KEY_PASSWORD", "");
    const { default: cfg } = await import("./forge.config.js");
    const pc = cfg.packagerConfig as Record<string, unknown>;
    expect(pc?.osxSign).toBeUndefined();
  });

  it("omits osxSign when CSC_LINK is set but CSC_KEY_PASSWORD is missing", async () => {
    vi.stubEnv("CSC_LINK", "base64cert");
    vi.stubEnv("CSC_KEY_PASSWORD", "");
    const { default: cfg } = await import("./forge.config.js");
    const pc = cfg.packagerConfig as Record<string, unknown>;
    expect(pc?.osxSign).toBeUndefined();
  });

  it("omits osxSign when CSC_KEY_PASSWORD is set but CSC_LINK is missing", async () => {
    vi.stubEnv("CSC_LINK", "");
    vi.stubEnv("CSC_KEY_PASSWORD", "secret");
    const { default: cfg } = await import("./forge.config.js");
    const pc = cfg.packagerConfig as Record<string, unknown>;
    expect(pc?.osxSign).toBeUndefined();
  });

  it("throws when both signing vars are set but APPLE_IDENTITY is missing", async () => {
    vi.stubEnv("CSC_LINK", "base64cert");
    vi.stubEnv("CSC_KEY_PASSWORD", "secret");
    vi.stubEnv("APPLE_IDENTITY", "");
    await expect(import("./forge.config.js")).rejects.toThrow("APPLE_IDENTITY is required");
  });

  it("includes osxSign with hardened runtime and entitlements when both signing vars are set", async () => {
    vi.stubEnv("CSC_LINK", "base64cert");
    vi.stubEnv("CSC_KEY_PASSWORD", "secret");
    vi.stubEnv("APPLE_IDENTITY", "Developer ID Application: Test Corp (ABCDEF1234)");
    const { default: cfg } = await import("./forge.config.js");
    const osxSign = (cfg.packagerConfig as Record<string, unknown>)?.osxSign as Record<
      string,
      unknown
    >;
    expect(osxSign).toBeDefined();
    const perFile = (osxSign.optionsForFile as (f: string) => Record<string, unknown>)(
      "Roubo.app/Contents/MacOS/roubo",
    );
    expect(perFile.hardenedRuntime).toBe(true);
    const expectedEntitlements = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "build/entitlements.mac.plist",
    );
    expect(perFile.entitlements).toBe(expectedEntitlements);
  });

  it("reads signing identity from APPLE_IDENTITY env var", async () => {
    vi.stubEnv("CSC_LINK", "base64cert");
    vi.stubEnv("CSC_KEY_PASSWORD", "secret");
    vi.stubEnv("APPLE_IDENTITY", "Developer ID Application: Test Corp (ABCDEF1234)");
    const { default: cfg } = await import("./forge.config.js");
    const osxSign = (cfg.packagerConfig as Record<string, unknown>)?.osxSign as Record<
      string,
      unknown
    >;
    expect(osxSign.identity).toBe("Developer ID Application: Test Corp (ABCDEF1234)");
  });

  it("includes osxNotarize when signing and all notarization vars are set", async () => {
    vi.stubEnv("CSC_LINK", "base64cert");
    vi.stubEnv("CSC_KEY_PASSWORD", "secret");
    vi.stubEnv("APPLE_IDENTITY", "Developer ID Application: Test Corp (ABCDEF1234)");
    vi.stubEnv("APPLE_ID", "dev@example.com");
    vi.stubEnv("APPLE_APP_SPECIFIC_PASSWORD", "pw");
    vi.stubEnv("APPLE_TEAM_ID", "TEAM123456");
    const { default: cfg } = await import("./forge.config.js");
    const pc = cfg.packagerConfig as Record<string, unknown>;
    expect(pc?.osxNotarize).toEqual({
      appleId: "dev@example.com",
      appleIdPassword: "pw",
      teamId: "TEAM123456",
    });
  });

  it("omits osxNotarize when signing is disabled even if notarization vars are set", async () => {
    vi.stubEnv("CSC_LINK", "");
    vi.stubEnv("CSC_KEY_PASSWORD", "");
    vi.stubEnv("APPLE_ID", "dev@example.com");
    vi.stubEnv("APPLE_APP_SPECIFIC_PASSWORD", "pw");
    vi.stubEnv("APPLE_TEAM_ID", "TEAM123456");
    const { default: cfg } = await import("./forge.config.js");
    const pc = cfg.packagerConfig as Record<string, unknown>;
    expect(pc?.osxNotarize).toBeUndefined();
  });

  it("omits osxNotarize when signing is enabled but notarization vars are absent", async () => {
    vi.stubEnv("CSC_LINK", "base64cert");
    vi.stubEnv("CSC_KEY_PASSWORD", "secret");
    vi.stubEnv("APPLE_IDENTITY", "Developer ID Application: Test Corp (ABCDEF1234)");
    vi.stubEnv("APPLE_ID", "");
    vi.stubEnv("APPLE_APP_SPECIFIC_PASSWORD", "");
    vi.stubEnv("APPLE_TEAM_ID", "");
    const { default: cfg } = await import("./forge.config.js");
    const pc = cfg.packagerConfig as Record<string, unknown>;
    expect(pc?.osxNotarize).toBeUndefined();
  });
});

describe("electron/build/entitlements.mac.plist", () => {
  it("contains the three V8-required entitlement keys", () => {
    const plistPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "build/entitlements.mac.plist",
    );
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("com.apple.security.cs.allow-jit");
    expect(plist).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(plist).toContain("com.apple.security.cs.allow-dyld-environment-variables");
  });
});

describe("buildOsxNotarize", () => {
  it("returns notarize options when all three Apple env vars are set", () => {
    expect(
      buildOsxNotarize({
        APPLE_ID: "a@b.com",
        APPLE_APP_SPECIFIC_PASSWORD: "pw",
        APPLE_TEAM_ID: "TEAM",
      }),
    ).toEqual({ appleId: "a@b.com", appleIdPassword: "pw", teamId: "TEAM" });
  });

  it.each([
    ["APPLE_ID missing", { APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "TEAM" }],
    ["APPLE_APP_SPECIFIC_PASSWORD missing", { APPLE_ID: "a@b.com", APPLE_TEAM_ID: "TEAM" }],
    ["APPLE_TEAM_ID missing", { APPLE_ID: "a@b.com", APPLE_APP_SPECIFIC_PASSWORD: "pw" }],
    ["all missing", {}],
    [
      "APPLE_ID empty string",
      { APPLE_ID: "", APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "TEAM" },
    ],
    [
      "APPLE_APP_SPECIFIC_PASSWORD empty string",
      { APPLE_ID: "a@b.com", APPLE_APP_SPECIFIC_PASSWORD: "", APPLE_TEAM_ID: "TEAM" },
    ],
    [
      "APPLE_TEAM_ID empty string",
      { APPLE_ID: "a@b.com", APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "" },
    ],
  ])("returns undefined when %s", (_label, env) => {
    expect(buildOsxNotarize(env as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
