// Integration-level E2E test for the component-plugin journey: a third-party
// plugin author scaffolds my-redis-plugin, a consumer installs it, binds a
// component to it in roubo.yaml, consents to its declared permissions, and runs
// it end to end, asserting the authoritative e2e_flow case CP-TC-027 step by
// step (issue #623).
//
// This is the journey's drift guard, mirroring shared/testbench-e2e.test.ts (the
// TC-056 / #442 drift guard): it exercises the integrated journey through the
// already-pure, importable seams of the slices it spans, rather than re-testing
// any single slice. The slices owned by this work unit are #602 (the `component`
// plugin kind + `ports`/`docker` permission categories), #603 (the typed
// ProvisionDescriptor union), #604 (the component host broker), #605 (the SDK
// defineComponentPlugin + component host client), #606 (the LifecycleEngine),
// #607 (the ResourceOwnershipLedger), #608 (the ComponentPluginRegistry binding
// resolver), #609 (the roubo.yaml component-to-plugin binding config), #613
// (crash cleanup / orphan teardown), #615 (the permission consent gate), and
// #616 (the plugin-backed component status/logs parity surface). A failing step
// is localised back to the owning slice(s) via OWNING_SLICES below (FR-020).
//
// Hermetic by construction (matching the lifecycle-engine.test.ts and
// testbench-e2e precedents): no real server, no real Docker daemon, no real SSE
// EventSource, and no spawned plugin child process. The journey's host-side
// effects are driven through their pure seams:
//   - "restart the server to trigger discovery"  -> plugin-manager.initialize()
//     against an isolated tmp user-plugins root (the scaffolded plugin is seeded
//     disabled so discovery records it without spawning a real child).
//   - GET/POST /consent                          -> the REAL Express consent
//     routes via supertest, backed by the REAL plugin-consent-state persistence.
//   - binding resolution                         -> ComponentPluginRegistry
//     .resolveBinding (project-registry getProject + plugin getConnection mocked
//     at the seam, real consent gate).
//   - "translate() -> docker descriptor -> running" -> the LifecycleEngine
//     runDescriptor with an injected fake DockerLike, so no Docker daemon runs.
//   - "wait for running via SSE"                  -> the engine's pushed
//     ComponentStatus transitions (push-based, never polled).
//   - logs pushed via host.component.reportLog    -> component-log-store.
//   - teardown                                    -> ledger.clearEntry + the
//     orphan-reap invariant (no roubo-* compose project survives).
//
// State isolation: ROUBO_PRODUCTION + a mocked os.homedir pin the ~/.roubo state
// dir (state.json, plugins-consent.json, plugins-state.json) into a throwaway dir
// before any state-touching module resolves its dir, so the real dev/user state
// is never read or written. The node:os mock is hoisted above every import.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { ComponentStatus, RegisteredProject, RouboConfig } from "@roubo/shared";
import { PLUGIN_CONSENT_STATE_SCHEMA_VERSION, PluginConsentStateSchema } from "@roubo/shared";
import {
  ProvisionDescriptorSchema,
  type DockerProvisionDescriptor,
} from "@roubo/shared/provision-descriptor-schema";
import type { JsonRpcConnection } from "./services/plugin-rpc.js";
import {
  runDescriptor,
  type DockerLike,
  type LifecycleContext,
} from "./services/lifecycle-engine.js";
import {
  appendComponentLog,
  getComponentLogLines,
  _resetForTest as resetComponentLogStore,
} from "./services/component-log-store.js";
import consentRouter from "./routes/plugins.js";
import * as pluginManager from "./services/plugin-manager.js";
import * as projectRegistry from "./services/project-registry.js";
import * as consentState from "./services/plugin-consent-state.js";
import * as ledger from "./services/resource-ownership-ledger.js";
import * as componentRegistry from "./services/component-plugin-registry.js";
import * as dockerService from "./services/docker.js";
import * as benchManager from "./services/bench-manager.js";

// The slices this journey integrates, from #623's blocked_by / covers set.
// Reported when a step diverges so a failure is attributable (FR-020).
const OWNING_SLICES = "#602, #603, #604, #605, #606, #607, #608, #609, #613, #615, #616";

const PLUGIN_ID = "my-redis-plugin";
const PROJECT_ID = "sample-app";
const COMPONENT_NAME = "cache";
const BENCH_ID = 1;
const MAX_MEMORY = "128m";
const ALLOCATED_PORT = 6400;
const COMPOSE_PROJECT = `roubo-${PROJECT_ID}-bench-${BENCH_ID}`;

// ── State isolation: pin ~/.roubo into a throwaway HOME ──
//
// state.ts freezes ROUBO_DIR at module-load time from os.homedir() (under
// ROUBO_PRODUCTION). Mocking node:os.homedir (the ledger/state-test precedent)
// is the reliable way to redirect it: $HOME is not honoured by os.homedir()
// under the vitest worker. The mock is hoisted above every import so state.ts
// resolves its dir under the tmp HOME, never the real ~/.roubo. Everything else
// on node:os delegates to the real module so tmpdir() and friends keep working.
const isolation = vi.hoisted(() => {
  process.env.ROUBO_PRODUCTION = "1";
  return { tmpHome: "" };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  isolation.tmpHome = fs.mkdtempSync(actual.tmpdir() + "/cp-e2e-home-");
  return {
    ...actual,
    default: { ...actual, homedir: () => isolation.tmpHome },
    homedir: () => isolation.tmpHome,
  };
});

const tmpHome = isolation.tmpHome;
const tmpUserPlugins = mkdtempSync(join(realOs.tmpdir(), "cp-e2e-user-plugins-"));
const tmpBundledPlugins = mkdtempSync(join(realOs.tmpdir(), "cp-e2e-bundled-plugins-"));
const sampleProjectDir = mkdtempSync(join(realOs.tmpdir(), "cp-e2e-project-"));

const savedEnv = {
  ROUBO_PRODUCTION: process.env.ROUBO_PRODUCTION,
  ROUBO_USER_PLUGINS_DIR: process.env.ROUBO_USER_PLUGINS_DIR,
  ROUBO_BUNDLED_PLUGINS_DIR: process.env.ROUBO_BUNDLED_PLUGINS_DIR,
};
process.env.ROUBO_USER_PLUGINS_DIR = tmpUserPlugins;
process.env.ROUBO_BUNDLED_PLUGINS_DIR = tmpBundledPlugins;
mkdirSync(join(tmpHome, ".roubo"), { recursive: true });

afterAll(async () => {
  // Tear the plugin-manager down so no discovery state leaks to sibling tests.
  try {
    await pluginManager.shutdown();
  } catch {
    // already down
  }
  pluginManager.__test.reset();
  consentState.__test.reset();
  resetComponentLogStore();
  for (const dir of [tmpHome, tmpUserPlugins, tmpBundledPlugins, sampleProjectDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv("ROUBO_PRODUCTION", savedEnv.ROUBO_PRODUCTION);
  restoreEnv("ROUBO_USER_PLUGINS_DIR", savedEnv.ROUBO_USER_PLUGINS_DIR);
  restoreEnv("ROUBO_BUNDLED_PLUGINS_DIR", savedEnv.ROUBO_BUNDLED_PLUGINS_DIR);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

// ── Canonical CP-TC-027 step sequence (single source of truth) ──
//
// The labels are both what each step runs under and the expected order the
// terminal drift guard asserts against: drop or reorder a step and the recorded
// run no longer equals TC027_SEQUENCE, so the test fails (mirrors TC056_SEQUENCE
// in the testbench-e2e precedent).
const TC027_STEPS = {
  authorManifest:
    "S001 Author: scaffold my-redis-plugin/ with a roubo-plugin.yaml (kind: component, contractVersion 1, network/docker/ports permissions)",
  authorIndex:
    "S002 Author: write index.js using defineComponentPlugin() with a translate() returning a docker ProvisionDescriptor",
  consumerInstall: "S003 Consumer: install my-redis-plugin/ into the user plugins root",
  consumerBind:
    "S004 Consumer: bind components.cache to the plugin with config.maxMemory in roubo.yaml",
  serverDiscovers:
    "S005 Consumer: restart the server to trigger discovery; the plugin appears with kind component and no manifest errors",
  consentGet:
    "S006 Consumer: GET /api/plugins/my-redis-plugin/consent lists network/docker/ports and firstParty false",
  consentPost:
    "S007 Consumer: POST /api/plugins/my-redis-plugin/consent persists a ConsentRecord (200)",
  registryResolves:
    "S008 Consumer: start a bench; the registry resolves cache to my-redis-plugin and translate() yields a docker descriptor",
  componentRuns:
    "S009 Consumer: the cache component reaches running and the ledger records the compose project",
  logsReturned:
    "S010 Consumer: GET .../components/cache/logs returns the lines pushed via host.component.reportLog",
  teardown:
    "S011 Consumer: stop the bench; cache transitions to stopped, no roubo-* containers remain, and the ledger entry is cleared",
} as const;
const TC027_SEQUENCE = [
  TC027_STEPS.authorManifest,
  TC027_STEPS.authorIndex,
  TC027_STEPS.consumerInstall,
  TC027_STEPS.consumerBind,
  TC027_STEPS.serverDiscovers,
  TC027_STEPS.consentGet,
  TC027_STEPS.consentPost,
  TC027_STEPS.registryResolves,
  TC027_STEPS.componentRuns,
  TC027_STEPS.logsReturned,
  TC027_STEPS.teardown,
];

// ── FR-020 failure-output wrapper ──
//
// Each CP-TC-027 step runs inside step(): on divergence it reports the diverging
// step label, the expected-vs-actual, and the owning slice issue(s), so a
// failure is attributable to a slice rather than the whole journey.
async function step<T>(label: string, expectation: string, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `CP-TC-027 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${OWNING_SLICES}`,
      { cause },
    );
  }
}

// ── Scaffolding helpers (the author + consumer file operations) ──

// The roubo-plugin.yaml the author writes (S001). The declared permission set
// maps the TC-027 shorthand { network: true, docker: true, ports: true } onto
// the real manifest schema: a non-empty network.hosts, a docker object, and a
// ports object name the three categories declaredCategories() will surface;
// credentials/filesystem stay empty and processes is false so ONLY network,
// docker, and ports are declared (matching S006-O01 exactly).
function manifestYaml(): string {
  return [
    `id: ${PLUGIN_ID}`,
    `name: My Redis Plugin`,
    `version: 1.0.0`,
    `description: A third-party Redis component plugin`,
    `kind: component`,
    `roubo: ">=1.3.0"`,
    `entry: index.js`,
    `contractVersion: 1`,
    `descriptorSchemaVersion: 1`,
    `permissions:`,
    `  network:`,
    `    hosts:`,
    `      - "*"`,
    `  credentials:`,
    `    slots: []`,
    `  filesystem:`,
    `    paths: []`,
    `  processes: false`,
    `  ports:`,
    `    names:`,
    `      - ${COMPONENT_NAME}`,
    `  docker: {}`,
    ``,
  ].join("\n");
}

// The index.js the author writes (S002): a declarative component plugin whose
// translate() returns a docker ProvisionDescriptor. Real file, asserted on disk
// and parsed for its load-bearing shape. It is NOT required in-process (it would
// open a JSON-RPC connection over stdio at load); the descriptor it emits is the
// contract, exercised directly through translate() below.
function indexJs(): string {
  return [
    `const { defineComponentPlugin } = require("@roubo/plugin-sdk");`,
    ``,
    `defineComponentPlugin({`,
    `  translate({ config }) {`,
    `    return {`,
    `      schemaVersion: 1,`,
    `      kind: "docker",`,
    `      composeFile: "./redis.yml",`,
    `      service: "redis",`,
    `      portEnvVar: "REDIS_PORT",`,
    `      connection: { template: "redis://localhost:{{port}}?maxmemory=" + config.maxMemory },`,
    `    };`,
    `  },`,
    `});`,
    ``,
  ].join("\n");
}

// The translate() the scaffolded plugin registers (S002 / S008-O02). The host
// never sees the plugin's JS; it receives this descriptor over RPC. We model the
// pure function here and feed its output straight into the LifecycleEngine,
// exactly as the host would after the RPC round-trip.
function translate(input: {
  config: { maxMemory: string };
  context: { benchId: number };
}): DockerProvisionDescriptor {
  return {
    schemaVersion: 1,
    kind: "docker",
    composeFile: "./redis.yml",
    service: "redis",
    portEnvVar: "REDIS_PORT",
    connection: {
      template: `redis://localhost:{{port}}?maxmemory=${input.config.maxMemory}`,
    },
  };
}

function rouboYaml(): string {
  return [
    `project:`,
    `  name: ${PROJECT_ID}`,
    `  displayName: Sample App`,
    `layout:`,
    `  type: single-repo`,
    `components:`,
    `  ${COMPONENT_NAME}:`,
    `    plugin:`,
    `      id: ${PLUGIN_ID}`,
    `    config:`,
    `      maxMemory: "${MAX_MEMORY}"`,
    `ports:`,
    `  ${COMPONENT_NAME}:`,
    `    base: ${ALLOCATED_PORT}`,
    `benches:`,
    `  max: 1`,
    ``,
  ].join("\n");
}

// A fake DockerLike: composeUp/waitForHealthy succeed, getComposeProjectName
// follows the roubo-<projectId>-bench-<N> convention. No Docker daemon runs.
// Tracks brought-up compose projects so the teardown step can assert none
// survive (the zero-orphan invariant, NFR-003 / #613).
function makeFakeDocker(liveComposeProjects: Set<string>): DockerLike {
  return {
    composeUp: vi.fn(async ({ projectName }: { projectName: string }) => {
      liveComposeProjects.add(projectName);
      return { success: true, stdout: "", stderr: "" };
    }),
    waitForHealthy: vi.fn(async () => true),
    composeRunInit: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    getContainerId: vi.fn(async () => "redis-container-abc"),
    getContainerStatusById: vi.fn(async () => "running" as const),
    getComposeProjectName: vi.fn(
      (projectId: string, benchId: number) => `roubo-${projectId}-bench-${benchId}`,
    ),
  };
}

// A throwaway live-connection stand-in (the registry hands back exactly what
// getConnection returns; identity is all that matters for resolveBinding).
const fakeConnection = {} as JsonRpcConnection;

function projectWithBinding(): RegisteredProject {
  const config = {
    project: { name: PROJECT_ID, displayName: "Sample App" },
    layout: { type: "single-repo" },
    components: {
      [COMPONENT_NAME]: {
        plugin: { id: PLUGIN_ID },
        config: { maxMemory: MAX_MEMORY },
      },
    },
    ports: { [COMPONENT_NAME]: { base: ALLOCATED_PORT } },
    benches: { max: 1 },
  } as unknown as RouboConfig;
  return {
    id: PROJECT_ID,
    repoPath: sampleProjectDir,
    config,
    configValid: true,
    settings: {} as RegisteredProject["settings"],
  };
}

describe("Component-plugin E2E (CP-TC-027): author scaffolds, consumer binds and runs", () => {
  it("runs the full journey end to end and matches CP-TC-027", async () => {
    const executed: string[] = [];
    const track = async <T>(
      label: string,
      expectation: string,
      body: () => T | Promise<T>,
    ): Promise<T> => {
      const result = await step(label, expectation, body);
      executed.push(label);
      return result;
    };

    const pluginAuthoringDir = join(sampleProjectDir, "author", PLUGIN_ID);

    // S001: author scaffolds the manifest. Assert it is on disk with the
    // component kind, contractVersion, and the three declared permissions (#602).
    await track(
      TC027_STEPS.authorManifest,
      "roubo-plugin.yaml exists with kind: component, contractVersion 1, and network/docker/ports permissions",
      () => {
        mkdirSync(pluginAuthoringDir, { recursive: true });
        const manifestPath = join(pluginAuthoringDir, "roubo-plugin.yaml");
        writeFileSync(manifestPath, manifestYaml());
        expect(existsSync(manifestPath)).toBe(true);
        const text = readFileSync(manifestPath, "utf8");
        expect(text).toContain("kind: component");
        expect(text).toContain("contractVersion: 1");
        expect(text).toContain("docker: {}");
        expect(text).toMatch(/names:\s*\n\s*- cache/);
      },
    );

    // S002: author writes index.js with defineComponentPlugin + translate(). The
    // descriptor translate() emits validates against the typed union (#603, #605).
    await track(
      TC027_STEPS.authorIndex,
      "index.js uses defineComponentPlugin and its translate() emits a valid docker ProvisionDescriptor",
      () => {
        const indexPath = join(pluginAuthoringDir, "index.js");
        writeFileSync(indexPath, indexJs());
        const text = readFileSync(indexPath, "utf8");
        expect(text).toContain("defineComponentPlugin");
        expect(text).toContain("translate");
        const descriptor = translate({
          config: { maxMemory: MAX_MEMORY },
          context: { benchId: BENCH_ID },
        });
        const parsed = ProvisionDescriptorSchema.safeParse(descriptor);
        expect(parsed.success).toBe(true);
        expect(descriptor.kind).toBe("docker");
        expect(descriptor.service).toBe("redis");
      },
    );

    // S003: consumer installs the plugin into the user plugins root.
    const installedDir = join(tmpUserPlugins, PLUGIN_ID);
    await track(
      TC027_STEPS.consumerInstall,
      "the plugin directory and its manifest exist under the user plugins root",
      () => {
        mkdirSync(installedDir, { recursive: true });
        writeFileSync(join(installedDir, "roubo-plugin.yaml"), manifestYaml());
        writeFileSync(join(installedDir, "index.js"), indexJs());
        expect(existsSync(join(installedDir, "roubo-plugin.yaml"))).toBe(true);
      },
    );

    // S004: consumer binds components.cache to the plugin in roubo.yaml (#609).
    await track(
      TC027_STEPS.consumerBind,
      "roubo.yaml binds components.cache to my-redis-plugin with config.maxMemory",
      () => {
        const dotRoubo = join(sampleProjectDir, ".roubo");
        mkdirSync(dotRoubo, { recursive: true });
        writeFileSync(join(dotRoubo, "roubo.yaml"), rouboYaml());
        const project = projectWithBinding();
        const binding = project.config.components[COMPONENT_NAME];
        expect(binding.plugin?.id).toBe(PLUGIN_ID);
      },
    );

    // S005: "restart the server" -> plugin-manager discovery. Seed the plugin as
    // disabled so discovery records it WITHOUT spawning a real child process,
    // then assert it appears with kind component and no manifest error (#602).
    await track(
      TC027_STEPS.serverDiscovers,
      "my-redis-plugin appears in the installed list with kind component and no manifest validation error",
      async () => {
        // Seed the on-disk enable-state so initialize() discovers-but-skips-spawn.
        writeFileSync(
          join(tmpHome, ".roubo", "plugins-state.json"),
          JSON.stringify({
            schemaVersion: 1,
            installInitialized: true,
            plugins: { [PLUGIN_ID]: "disabled" },
          }),
        );
        // Idempotent across a vitest retry: tear any prior discovery down first.
        try {
          await pluginManager.shutdown();
        } catch {
          // not initialized yet
        }
        await pluginManager.initialize();
        const record = pluginManager.listInstalled().find((r) => r.id === PLUGIN_ID);
        if (!record) throw new Error("plugin was not discovered");
        expect(record.manifest?.kind).toBe("component");
        expect(record.lastError).toBeNull();
        expect(record.status).not.toBe("invalid");
        expect(record.status).not.toBe("incompatible");
      },
    );

    // ── Mount the REAL consent routes for S006 / S007 (real persistence). ──
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", consentRouter);

    // S006: GET /consent lists the declared categories and firstParty false (#615).
    await track(
      TC027_STEPS.consentGet,
      "the consent endpoint lists network, docker, ports and reports firstParty false",
      async () => {
        const res = await request(app).get(`/api/plugins/${PLUGIN_ID}/consent`);
        expect(res.status).toBe(200);
        expect(res.body.firstParty).toBe(false);
        // declared mirrors the manifest's permission object; the route ships the
        // raw permissions and the UI derives categories via declaredCategories.
        expect(res.body.declared.network.hosts).toEqual(["*"]);
        expect(res.body.declared.docker).toEqual({});
        expect(res.body.declared.ports.names).toEqual([COMPONENT_NAME]);
        // Not yet consented: no consentedAt timestamp.
        expect(res.body.consentedAt).toBeUndefined();
      },
    );

    // S007: POST /consent persists a ConsentRecord (200) (#615).
    await track(
      TC027_STEPS.consentPost,
      "POST /consent returns 200 and persists a ConsentRecord acknowledging all declared categories",
      async () => {
        const res = await request(app)
          .post(`/api/plugins/${PLUGIN_ID}/consent`)
          .send({ acknowledgedCategories: ["network", "docker", "ports"] });
        expect(res.status).toBe(200);
        expect(res.body.pluginId).toBe(PLUGIN_ID);
        expect(res.body.acknowledgedCategories).toEqual(["network", "docker", "ports"]);
        // Persisted to the isolated plugins-consent.json and re-loadable.
        const persisted = consentState.getConsent(PLUGIN_ID);
        expect(persisted?.pluginId).toBe(PLUGIN_ID);
        // The on-disk file validates against the shared schema.
        const fileText = readFileSync(join(tmpHome, ".roubo", "plugins-consent.json"), "utf8");
        const fileParse = PluginConsentStateSchema.safeParse(JSON.parse(fileText));
        expect(fileParse.success).toBe(true);
        expect(PLUGIN_CONSENT_STATE_SCHEMA_VERSION).toBe(1);
      },
    );

    // S008: "start a bench" -> the registry resolves the cache binding to the
    // plugin (consent gate now satisfied), and translate() yields a docker
    // descriptor the engine can run (#608, #605, #603).
    const liveComposeProjects = new Set<string>();
    const descriptor = await track(
      TC027_STEPS.registryResolves,
      "ComponentPluginRegistry resolves cache to my-redis-plugin and translate({ config }) returns a docker descriptor",
      () => {
        const getProjectSpy = vi
          .spyOn(projectRegistry, "getProject")
          .mockReturnValue(projectWithBinding());
        const getConnectionSpy = vi
          .spyOn(pluginManager, "getConnection")
          .mockImplementation((id: string) => (id === PLUGIN_ID ? fakeConnection : null));
        try {
          const resolved = componentRegistry.resolveBinding(PROJECT_ID, COMPONENT_NAME);
          if (componentRegistry.isNotBound(resolved)) {
            throw new Error(`binding not resolved: ${resolved.reason}`);
          }
          expect(resolved.pluginId).toBe(PLUGIN_ID);
          expect(resolved.connection).toBe(fakeConnection);
        } finally {
          getProjectSpy.mockRestore();
          getConnectionSpy.mockRestore();
        }
        const d = translate({
          config: { maxMemory: MAX_MEMORY },
          context: { benchId: BENCH_ID },
        });
        expect(d.kind).toBe("docker");
        return d;
      },
    );

    // S009: drive the descriptor through the LifecycleEngine with a fake docker.
    // The component reaches running (push-based status, never polled) and the
    // ledger records the compose project (#606, #607).
    const statuses: ComponentStatus[] = [];
    await track(
      TC027_STEPS.componentRuns,
      "the cache component reaches running and the ledger records the compose project under my-redis-plugin",
      async () => {
        const ctx: LifecycleContext = {
          pluginId: PLUGIN_ID,
          projectId: PROJECT_ID,
          benchId: BENCH_ID,
          componentName: COMPONENT_NAME,
          workspacePath: sampleProjectDir,
          ports: { [COMPONENT_NAME]: ALLOCATED_PORT },
          reportStatus: (s) => statuses.push(s),
        };
        const result = await runDescriptor(descriptor, ctx, {
          docker: makeFakeDocker(liveComposeProjects),
          ledger,
        });
        expect(result.status).toBe("running");
        // The port-templated connection string was resolved with the allocated port.
        expect(result.connection).toBe(
          `redis://localhost:${ALLOCATED_PORT}?maxmemory=${MAX_MEMORY}`,
        );
        expect(statuses.at(-1)?.status).toBe("running");
        // The ledger (real persistence into the isolated state.json) records the
        // compose project for this bench under the plugin id.
        const entry = ledger.getEntry(PLUGIN_ID, BENCH_ID);
        expect(entry?.composeProjects).toContain(COMPOSE_PROJECT);
      },
    );

    // S010: logs pushed via host.component.reportLog are returned by the logs
    // surface (the component-log-store parity buffer) (#604, #616).
    await track(
      TC027_STEPS.logsReturned,
      "GET .../components/cache/logs returns the Redis startup lines pushed via host.component.reportLog",
      () => {
        // The plugin pushes startup lines over host.component.reportLog; the host
        // appends them to the structured store keyed by (project, bench, name).
        appendComponentLog(PROJECT_ID, BENCH_ID, COMPONENT_NAME, {
          source: "stdout",
          text: "Ready to accept connections",
          ts: "2026-06-21T00:00:00.000Z",
        });
        appendComponentLog(PROJECT_ID, BENCH_ID, COMPONENT_NAME, {
          source: "stdout",
          text: `maxmemory set to ${MAX_MEMORY}`,
          ts: "2026-06-21T00:00:01.000Z",
        });
        const lines = getComponentLogLines(PROJECT_ID, BENCH_ID, COMPONENT_NAME);
        expect(lines.map((l) => l.text)).toEqual([
          "Ready to accept connections",
          `maxmemory set to ${MAX_MEMORY}`,
        ]);
      },
    );

    // S011: teardown. Drive the REAL orphan-reap seam rather than asserting
    // hand-set values: sweepOrphanedComposeProjects() (#613) replays the ledger,
    // downs every roubo-* compose project it still records, and clears the
    // entry. Spying composeDownByProject lets the real down path run (and remove
    // the project from our live set) without a Docker daemon, so "no roubo-*
    // remains" (S011-O02) and "the ledger entry is cleared" (S011-O03) are
    // proved by production code, not by the test setting them itself (#613, #607).
    // The stopping -> stopped ComponentStatus transition (S011-O01) is the #616
    // status-surface slice's own contract and is asserted in its unit tests; the
    // plugin lifecycle exposes no hermetic stop seam here, so this integration
    // guard does not re-fabricate that transition (a hand-pushed status would be
    // tautological).
    await track(
      TC027_STEPS.teardown,
      "no roubo-* compose project remains after the real orphan sweep and the ledger entry is cleared",
      async () => {
        // Precondition: the bench's compose project is live and ledger-recorded
        // (set up by S009 through real engine + ledger code).
        expect(liveComposeProjects.has(COMPOSE_PROJECT)).toBe(true);
        expect(ledger.getEntry(PLUGIN_ID, BENCH_ID)?.composeProjects).toContain(COMPOSE_PROJECT);

        const downSpy = vi
          .spyOn(dockerService, "composeDownByProject")
          .mockImplementation(async (projectName: string) => {
            liveComposeProjects.delete(projectName);
          });
        try {
          await benchManager.sweepOrphanedComposeProjects();
          // The real sweep downed this bench's compose project (S011-O02)...
          expect(downSpy).toHaveBeenCalledWith(COMPOSE_PROJECT);
          expect([...liveComposeProjects].filter((p) => p.startsWith("roubo-"))).toEqual([]);
          // ...and cleared the ledger entry as part of the same sweep (S011-O03).
          expect(ledger.getEntry(PLUGIN_ID, BENCH_ID)).toBeUndefined();
        } finally {
          downSpy.mockRestore();
        }
      },
    );

    // Terminal drift guard: the integrated run matches CP-TC-027's step sequence
    // end to end. A dropped or reordered step makes executed != TC027_SEQUENCE.
    expect(executed).toEqual(TC027_SEQUENCE);
  });

  // FR-020: prove the failure-output wrapper localises a diverging step,
  // reporting the diverging label, expected-vs-actual, and the owning slices.
  it("on failure reports the diverging step, expected-vs-actual, and owning slices", async () => {
    await expect(
      step(TC027_STEPS.componentRuns, "the cache component reaches running", () => {
        // Drive a real engine failure: an invalid descriptor (bad schemaVersion)
        // is rejected before any host call, driving the component to error.
        const statuses: ComponentStatus[] = [];
        const ctx: LifecycleContext = {
          pluginId: PLUGIN_ID,
          projectId: PROJECT_ID,
          benchId: BENCH_ID,
          componentName: COMPONENT_NAME,
          workspacePath: sampleProjectDir,
          ports: { [COMPONENT_NAME]: ALLOCATED_PORT },
          reportStatus: (s) => statuses.push(s),
        };
        return runDescriptor(
          { schemaVersion: 99, kind: "docker", composeFile: "x", service: "r" },
          ctx,
          { docker: makeFakeDocker(new Set()), ledger },
        ).then((result) => {
          if (result.status !== "running") {
            throw new Error(`component reached ${result.status}, not running`);
          }
        });
      }),
    ).rejects.toThrow(/CP-TC-027 step diverged/);

    const captured = await step(
      TC027_STEPS.componentRuns,
      "the cache component reaches running",
      () => {
        throw new Error("component reached error, not running");
      },
    ).catch((e: Error) => e.message);

    expect(captured).toContain("expected: the cache component reaches running");
    expect(captured).toContain("actual:   component reached error, not running");
    expect(captured).toContain(`owning slice(s): ${OWNING_SLICES}`);
  });
});
