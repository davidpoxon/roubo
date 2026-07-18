// Marketplace install-from-source consent journey (CPHMTP-TC-077 S003, issue #617).
//
// The bug: POST /api/plugins/install/:token/confirm committed the plugin but never
// recorded a ConsentRecord, so the resumed bench start dead-ended at the
// component-plugin registry's consent gate (`if (!hasConsent(pluginId)) return
// not-consented`). This integration journey drives the REAL confirm route against
// the REAL plugin-consent-state persistence and asserts the exact gate input the
// resumed start reads (`hasConsent`) flips false -> true across the install, with no
// manual POST /consent.
//
// The installer and plugin-manager are stubbed at their module boundary: this
// journey is about the confirm -> consent -> gate seam, not the git/local staging
// mechanics (those are covered by plugin-installer.test.ts). Everything the fix
// touches (the confirm route, declaredCategories, upsertConsent, the on-disk
// plugins-consent.json, GET /consent) runs for real.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PluginRecord } from "@roubo/shared";

const TOKEN = "11111111-1111-1111-1111-111111111111";
const PLUGIN_ID = "google-clasp";

// Isolate ~/.roubo into a throwaway HOME so the REAL consent persistence writes to a
// temp dir, never the developer's home. state.ts freezes its dir from os.homedir()
// at module load under ROUBO_PRODUCTION, so the homedir mock must be hoisted above
// every import (the component-plugins-e2e precedent).
const isolation = vi.hoisted(() => {
  process.env.ROUBO_PRODUCTION = "1";
  return { tmpHome: "" };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  isolation.tmpHome = fs.mkdtempSync(actual.tmpdir() + "/tc077-home-");
  return {
    ...actual,
    default: { ...actual, homedir: () => isolation.tmpHome },
    homedir: () => isolation.tmpHome,
  };
});

vi.mock("./services/plugin-installer.js", () => {
  class InstallError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    InstallError,
    isValidStagingToken: (t: string) => t === TOKEN,
    previewFromGitUrl: vi.fn(),
    previewFromLocalPath: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
});

vi.mock("./services/plugin-manager.js", () => ({
  HOST_API_VERSION: "1.3.0",
  listInstalled: vi.fn(() => [] as PluginRecord[]),
  enable: vi.fn(),
  disable: vi.fn(),
  restart: vi.fn(),
  reinstallIntoUserRoot: vi.fn(),
  readLogs: vi.fn(),
  uninstall: vi.fn(),
  invoke: vi.fn(),
  getConnectionStatus: vi.fn(),
  invalidateConnectionStatus: vi.fn(),
}));

import consentRouter from "./routes/plugins.js";
import * as pluginInstaller from "./services/plugin-installer.js";
import * as pluginManager from "./services/plugin-manager.js";
// The REAL persistence module the confirm route writes and the consent gate reads.
import * as consentState from "./services/plugin-consent-state.js";

function installedRecord(): PluginRecord {
  return {
    id: PLUGIN_ID,
    manifest: {
      id: PLUGIN_ID,
      name: "Google Clasp",
      version: "1.2.3",
      description: "Apps Script deploys",
      kind: "component",
      roubo: "^1.0.0",
      entry: "./index.js",
      permissions: {
        network: { hosts: ["script.google.com"] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: true,
      },
    },
    manifestPath: "/p/google-clasp/roubo-plugin.yaml",
    pluginDir: "/p/google-clasp",
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 4242,
    // A digest-pinned marketplace install: unverified, third-party (the CPHMTP-TC-077
    // repro's real loopback source).
    sourceId: "marketplace-acme-1a2b3c4d",
    sourceUrl: "https://marketplace.acme.example/catalog.json",
    unverified: true,
  } as PluginRecord;
}

const app = express();
app.use(express.json());
app.use("/api/plugins", consentRouter);

beforeAll(() => {
  mkdirSync(join(isolation.tmpHome, ".roubo"), { recursive: true });
});

afterAll(() => {
  consentState.__test.reset();
  rmSync(isolation.tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // A clean consent ledger each run: drop the file and the in-process cache so a
  // prior run's record never masks the pre-install "not consented" assertion.
  consentState.__test.reset();
  rmSync(join(isolation.tmpHome, ".roubo", "plugins-consent.json"), { force: true });
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
});

describe("Marketplace install-from-source consent journey (CPHMTP-TC-077, issue #617)", () => {
  it("records consent on confirm so the resumed start's consent gate passes for the just-installed plugin", async () => {
    // Pre-install: the plugin is not installed and no consent exists, so the consent
    // gate (which reads exactly this) would dead-end the resumed start with
    // `not-consented`.
    expect(consentState.hasConsent(PLUGIN_ID)).toBe(false);

    // "Install from <source>": the REAL confirm route commits the plugin and, with
    // this fix, records its consent from the declared permissions the install
    // PermissionsScreen displayed and the user acknowledged by confirming.
    const record = installedRecord();
    vi.mocked(pluginInstaller.commit).mockResolvedValue(record);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record]);

    const confirm = await request(app).post(`/api/plugins/install/${TOKEN}/confirm`);
    expect(confirm.status).toBe(201);
    expect(confirm.body.plugin.id).toBe(PLUGIN_ID);

    // The install acknowledged the full declared set (network + processes), persisted
    // to the isolated plugins-consent.json, so the consent gate now passes with no
    // manual consent surgery: the resumed bench start no longer dead-ends.
    expect(consentState.hasConsent(PLUGIN_ID)).toBe(true);
    const persisted = consentState.getConsent(PLUGIN_ID);
    expect(persisted?.pluginId).toBe(PLUGIN_ID);
    expect(persisted?.acknowledgedCategories).toEqual(["network", "processes"]);
    expect(persisted?.consentedAt).toBeTruthy();

    // GET /consent surfaces the consentedAt timestamp the install just minted.
    const consent = await request(app).get(`/api/plugins/${PLUGIN_ID}/consent`);
    expect(consent.status).toBe(200);
    expect(consent.body.consentedAt).toBe(persisted?.consentedAt);
  });
});
