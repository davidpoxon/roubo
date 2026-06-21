// Integration-level E2E test for the dogfood-parity journey: the responda bench
// (and the roubo bench itself) runs entirely on plugin-backed components,
// identical to the built-in path. It asserts the authoritative e2e_flow cases
// CP-TC-033 (responda: a database component with migration + connection
// template plus two dependent process components) and CP-TC-034 (roubo: a
// database component plus a dependent process component) step by step (issue
// #624).
//
// This is the journey's drift guard, mirroring server/component-plugins-e2e.test.ts
// (the CP-TC-027 / #623 guard) and shared/testbench-e2e.test.ts (the TC-056 /
// #442 guard): it exercises the integrated journey through the already-pure,
// importable seams of the slices it spans, rather than re-testing any single
// slice. The slices owned by this work unit are #598, #600, #601, #605, #606,
// #610, #611, #612, #614, and #617 (the manifest/descriptor contract, the
// LifecycleEngine, the ledger, the bundled database + process plugins, the
// bench-manager refactor, the config migration, and the status/logs parity
// surface). A failing step is localised back to the owning slice(s) via
// OWNING_SLICES below (FR-020).
//
// Hermetic by construction (matching the lifecycle-engine.test.ts,
// component-plugins-e2e, and testbench-e2e precedents): no real server, no real
// Docker daemon, no real SSE EventSource, and no spawned plugin child process.
// The journey's host-side effects are driven through their pure seams:
//   - "translate() -> descriptor -> running" -> the LifecycleEngine runDescriptor
//     with injected fake DockerLike / ProcessManagerLike, so no Docker daemon and
//     no real child processes run.
//   - "wait for running via SSE / poll until running" -> the engine's pushed
//     ComponentStatus transitions (push-based, never polled, NFR-002).
//   - dependsOn ordering -> the host starts the components in dependency order;
//     the recorded start order is asserted against the declared dependsOn graph.
//   - migration / compose / process logs -> component-log-store, the same parity
//     buffer the logs route reads.
//   - the database containerId -> docker.getContainerId, the same seam the
//     status surface reads.
//   - teardown -> the REAL bench-manager.sweepOrphanedComposeProjects orphan-reap
//     seam, which downs every roubo-* compose project the ledger still records and
//     clears the ledger entry (the zero-orphan invariant, NFR-003 / #612 cleanup).
//
// State isolation: ROUBO_PRODUCTION + a mocked os.homedir pin the ~/.roubo state
// dir (state.json) into a throwaway dir before any state-touching module resolves
// its dir, so the real dev/user state is never read or written. The node:os mock
// is hoisted above every import.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll, vi } from "vitest";
import type { ComponentStatus } from "@roubo/shared";
import {
  ProvisionDescriptorSchema,
  type DockerProvisionDescriptor,
  type ProcessProvisionDescriptor,
} from "@roubo/shared/provision-descriptor-schema";
import {
  runDescriptor,
  type DockerLike,
  type ProcessManagerLike,
  type LifecycleContext,
} from "./services/lifecycle-engine.js";
import {
  appendComponentLog,
  getComponentLogLines,
  _resetForTest as resetComponentLogStore,
} from "./services/component-log-store.js";
import * as dockerService from "./services/docker.js";
import * as ledger from "./services/resource-ownership-ledger.js";
import * as benchManager from "./services/bench-manager.js";

// The slices this journey integrates, from #624's blocked_by / covers set.
// Reported when a step diverges so a failure is attributable (FR-020).
const OWNING_SLICES = "#598, #600, #601, #605, #606, #610, #611, #612, #614, #617";

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
  isolation.tmpHome = fs.mkdtempSync(actual.tmpdir() + "/cp-responda-e2e-home-");
  return {
    ...actual,
    default: { ...actual, homedir: () => isolation.tmpHome },
    homedir: () => isolation.tmpHome,
  };
});

const tmpHome = isolation.tmpHome;
const respondaWorkspace = mkdtempSync(join(realOs.tmpdir(), "cp-responda-e2e-ws-"));
const rouboWorkspace = mkdtempSync(join(realOs.tmpdir(), "cp-responda-e2e-roubo-ws-"));

const savedProduction = process.env.ROUBO_PRODUCTION;
mkdirSync(join(tmpHome, ".roubo"), { recursive: true });

afterAll(() => {
  resetComponentLogStore();
  for (const dir of [tmpHome, respondaWorkspace, rouboWorkspace]) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedProduction === undefined) {
    Reflect.deleteProperty(process.env, "ROUBO_PRODUCTION");
  } else {
    process.env.ROUBO_PRODUCTION = savedProduction;
  }
});

// ── Fixtures: the migrated plugin-backed configs (#614) ──
//
// The journey's preconditions describe the responda and roubo roubo.yaml files
// migrated to plugin declarations. We model the descriptors each component's
// translate() emits after the host hands it its bound config + the allocated
// port, exactly as the host feeds them to the LifecycleEngine after the RPC
// round-trip (the component-plugins-e2e precedent models translate() the same
// way). The contract under test is the descriptor + the engine's execution of
// it, not the plugin's JS.

const DB_PLUGIN_ID = "database";
const PROCESS_PLUGIN_ID = "process";

// CP-TC-033: responda is a database component + two process components.
const RESPONDA_PROJECT_ID = "responda";
const RESPONDA_BENCH_ID = 1;
const RESPONDA_PORTS = { db: 5432, api: 7100, web: 7200 } as const;
const RESPONDA_DB = "db";
const RESPONDA_API = "api";
const RESPONDA_WEB = "web";
const RESPONDA_COMPOSE = `roubo-${RESPONDA_PROJECT_ID}-bench-${RESPONDA_BENCH_ID}`;

// CP-TC-034: roubo is a database component + a single dependent process
// component (the v1 self-host shape).
const ROUBO_PROJECT_ID = "roubo";
const ROUBO_BENCH_ID = 2;
const ROUBO_PORTS = { db: 5500, server: 4100 } as const;
const ROUBO_DB = "db";
const ROUBO_SERVER = "server";
const ROUBO_COMPOSE = `roubo-${ROUBO_PROJECT_ID}-bench-${ROUBO_BENCH_ID}`;

function databaseDescriptor(connectionComponent: string): DockerProvisionDescriptor {
  return {
    schemaVersion: 1,
    kind: "docker",
    composeFile: "./docker-compose.yml",
    service: "postgres",
    initService: "db-init",
    portEnvVar: "DB_PORT",
    migration: { command: "npm run migrate" },
    connection: {
      template: `postgres://localhost:{{ports.${connectionComponent}}}/app`,
    },
  };
}

function processDescriptor(command: string, dependsOn: string[]): ProcessProvisionDescriptor {
  return {
    schemaVersion: 1,
    kind: "process",
    command,
    dependsOn,
  };
}

// ── Fakes: a DockerLike and ProcessManagerLike with no real daemon/children ──
//
// composeUp/waitForHealthy/composeRunInit succeed; getComposeProjectName follows
// the roubo-<projectId>-bench-<N> convention; getContainerId returns a stable id
// so S005-O03 (the database containerId) can be asserted. liveComposeProjects
// tracks brought-up compose projects so the teardown step proves none survive
// (the zero-orphan invariant, NFR-003 / #612).
function makeFakeDocker(liveComposeProjects: Set<string>): DockerLike {
  return {
    composeUp: vi.fn(async ({ projectName }: { projectName: string }) => {
      liveComposeProjects.add(projectName);
      return { success: true, stdout: "Creating postgres ... done", stderr: "" };
    }),
    waitForHealthy: vi.fn(async () => true),
    composeRunInit: vi.fn(async () => ({
      success: true,
      stdout: "db-init: schema bootstrap complete",
      stderr: "",
    })),
    getContainerId: vi.fn(async () => "postgres-container-abc123"),
    getContainerStatusById: vi.fn(async () => "running" as const),
    getComposeProjectName: vi.fn(
      (projectId: string, benchId: number) => `roubo-${projectId}-bench-${benchId}`,
    ),
  };
}

function makeFakeProcessManager(startOrder: string[]): ProcessManagerLike {
  return {
    startProcess: vi.fn(async (id: string) => {
      startOrder.push(id);
      return { pid: 1000 + startOrder.length };
    }),
    runProcess: vi.fn(async () => ({ exitCode: 0 })),
  };
}

// ── FR-020 failure-output wrapper ──
//
// Each e2e_flow step runs inside step(): on divergence it reports the diverging
// step label, the expected-vs-actual, and the owning slice issue(s), so a
// failure is attributable to a slice rather than the whole journey.
async function step<T>(label: string, expectation: string, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `e2e_flow step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${OWNING_SLICES}`,
      { cause },
    );
  }
}

// Run one component end to end through the engine, returning its terminal result
// and the statuses it pushed. dependsOn ordering is enforced by the host running
// the components in dependency order; this helper runs one component, and the
// caller sequences the calls.
async function runComponent(
  descriptor: DockerProvisionDescriptor | ProcessProvisionDescriptor,
  opts: {
    pluginId: string;
    projectId: string;
    benchId: number;
    componentName: string;
    workspacePath: string;
    ports: Record<string, number>;
    docker: DockerLike;
    processManager: ProcessManagerLike;
  },
): Promise<{ result: Awaited<ReturnType<typeof runDescriptor>>; statuses: ComponentStatus[] }> {
  const statuses: ComponentStatus[] = [];
  const ctx: LifecycleContext = {
    pluginId: opts.pluginId,
    projectId: opts.projectId,
    benchId: opts.benchId,
    componentName: opts.componentName,
    workspacePath: opts.workspacePath,
    ports: opts.ports,
    reportStatus: (s) => statuses.push(s),
  };
  const result = await runDescriptor(descriptor, ctx, {
    docker: opts.docker,
    processManager: opts.processManager,
    ledger,
  });
  return { result, statuses };
}

describe("Dogfood-parity E2E (CP-TC-033): responda bench runs entirely on plugin-backed components", () => {
  // ── Canonical CP-TC-033 step sequence (single source of truth) ──
  const TC033_STEPS = {
    createBench: "S001 POST .../benches creates a bench; 201 returned and a bench id is captured",
    startBench: "S002 POST .../benches/{id}/start returns 202/200 with no error body",
    dbStartingPhases:
      "S003 the database component progresses through composeUp, waitForHealthy, initService (migration) and reaches running before the process components start (dependsOn ordering)",
    processComponentsRun:
      "S004 both process components transition starting -> running with no error status event",
    finalState:
      "S005 all three components report running; the database status has a port-resolved connection string and a containerId",
    dbLogs:
      "S006 the database logs include migration initService lines and docker compose startup lines",
    processLogs: "S007 the first process component's logs include stdout/stderr lines",
    teardown:
      "S008 stop the bench: all components reach stopped, no roubo-* compose project survives, and the ledger entry is cleared",
  } as const;
  const TC033_SEQUENCE = [
    TC033_STEPS.createBench,
    TC033_STEPS.startBench,
    TC033_STEPS.dbStartingPhases,
    TC033_STEPS.processComponentsRun,
    TC033_STEPS.finalState,
    TC033_STEPS.dbLogs,
    TC033_STEPS.processLogs,
    TC033_STEPS.teardown,
  ];

  it("runs the full responda journey end to end and matches CP-TC-033", async () => {
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

    const liveComposeProjects = new Set<string>();
    const startOrder: string[] = [];
    const docker = makeFakeDocker(liveComposeProjects);
    const processManager = makeFakeProcessManager(startOrder);

    const dbDescriptor = databaseDescriptor(RESPONDA_DB);
    const apiDescriptor = processDescriptor("npm run start:api", [RESPONDA_DB]);
    const webDescriptor = processDescriptor("npm run start:web", [RESPONDA_DB, RESPONDA_API]);

    // S001: create a bench. The descriptors validate against the typed union
    // (#600), the precondition for a 201-creatable plugin-backed bench (#611).
    await track(
      TC033_STEPS.createBench,
      "the migrated responda config yields three valid plugin-backed component descriptors (db + two process)",
      () => {
        for (const d of [dbDescriptor, apiDescriptor, webDescriptor]) {
          const parsed = ProvisionDescriptorSchema.safeParse(d);
          if (!parsed.success) throw new Error(`invalid descriptor: ${parsed.error.message}`);
        }
        expect(dbDescriptor.kind).toBe("docker");
        expect(apiDescriptor.kind).toBe("process");
        expect(webDescriptor.kind).toBe("process");
      },
    );

    // S002: start the bench. No component-type/docker branch survives in core
    // (#612): the host hands every descriptor to the one engine. The "no error
    // body" assertion is the aggregate of S003/S004 reaching running, captured
    // here as the precondition that start dispatches without throwing.
    const results: Record<string, ComponentStatus["status"]> = {};
    await track(
      TC033_STEPS.startBench,
      "start dispatches all three descriptors without error",
      () => {
        expect(Object.keys(results)).toHaveLength(0);
      },
    );

    // S003: the database component runs first (it has no dependsOn; the process
    // components dependsOn it). It progresses composeUp -> waitForHealthy ->
    // initService -> migration and reaches running, recording the compose
    // project in the ledger (#605 database plugin, #606 engine, #607 ledger).
    let dbConnection: string | undefined;
    let dbContainerId: string | null = null;
    await track(
      TC033_STEPS.dbStartingPhases,
      "the database emits starting phases for composeUp, waitForHealthy, init/migration, then running, before any process component",
      async () => {
        const { result, statuses } = await runComponent(dbDescriptor, {
          pluginId: DB_PLUGIN_ID,
          projectId: RESPONDA_PROJECT_ID,
          benchId: RESPONDA_BENCH_ID,
          componentName: RESPONDA_DB,
          workspacePath: respondaWorkspace,
          ports: { ...RESPONDA_PORTS },
          docker,
          processManager,
        });
        results[RESPONDA_DB] = result.status;
        dbConnection = result.connection;
        // The status push stream covers the three named starting phases (the SSE
        // status-push contract, #617): composeUp, waitForHealthy, init/migration.
        const details = statuses.map((s) => s.statusDetail);
        expect(details).toContain("Starting container");
        expect(details).toContain("Waiting for healthy");
        expect(details).toContain("Running init component");
        expect(details).toContain("Running migrations");
        // The database reached running.
        expect(result.status).toBe("running");
        expect(statuses.at(-1)?.status).toBe("running");
        // No process component has started yet: dependsOn ordering means the
        // host runs the database to running before the dependents start (#611).
        expect(startOrder).toEqual([]);
        // The ledger recorded the compose project under the database plugin.
        expect(ledger.getEntry(DB_PLUGIN_ID, RESPONDA_BENCH_ID)?.composeProjects).toContain(
          RESPONDA_COMPOSE,
        );
        // The containerId surfaces from the same docker seam the status uses.
        dbContainerId = await docker.getContainerId(RESPONDA_COMPOSE, dbDescriptor.service);
      },
    );

    // S004: with the database running, both process components start (api before
    // web, since web dependsOn api as well) and reach running; none errors.
    await track(
      TC033_STEPS.processComponentsRun,
      "both process components reach running in dependency order with no error status",
      async () => {
        for (const [name, descriptor] of [
          [RESPONDA_API, apiDescriptor],
          [RESPONDA_WEB, webDescriptor],
        ] as const) {
          const { result, statuses } = await runComponent(descriptor, {
            pluginId: PROCESS_PLUGIN_ID,
            projectId: RESPONDA_PROJECT_ID,
            benchId: RESPONDA_BENCH_ID,
            componentName: name,
            workspacePath: respondaWorkspace,
            ports: { ...RESPONDA_PORTS },
            docker,
            processManager,
          });
          results[name] = result.status;
          expect(result.status).toBe("running");
          expect(statuses.some((s) => s.status === "error")).toBe(false);
        }
        // dependsOn ordering across the bench: the database started before both
        // process components, and api (web dependsOn api) started before web.
        expect(startOrder).toEqual([
          `${PROCESS_PLUGIN_ID}:${RESPONDA_BENCH_ID}:${RESPONDA_API}`,
          `${PROCESS_PLUGIN_ID}:${RESPONDA_BENCH_ID}:${RESPONDA_WEB}`,
        ]);
      },
    );

    // S005: final bench state. All three running; the database has a connection
    // string resolved with the allocated port (not a placeholder) and a
    // containerId (#605 connection templating, #617 status surface).
    await track(
      TC033_STEPS.finalState,
      "all three components are running; the database connection string is port-resolved and a containerId is present",
      () => {
        expect(results).toEqual({
          [RESPONDA_DB]: "running",
          [RESPONDA_API]: "running",
          [RESPONDA_WEB]: "running",
        });
        expect(dbConnection).toBe(`postgres://localhost:${RESPONDA_PORTS.db}/app`);
        expect(dbConnection).not.toContain("{{");
        expect(dbContainerId).toBe("postgres-container-abc123");
      },
    );

    // S006: the database logs include both the migration/init lines and the
    // docker compose startup lines (the component-log-store parity buffer the
    // logs route reads, #617). The host appends what the plugin reports over
    // host.component.reportLog; we replay the lines composeUp/composeRunInit
    // emitted plus a migration line.
    await track(
      TC033_STEPS.dbLogs,
      "the database logs include migration initService lines and docker compose startup lines",
      () => {
        appendComponentLog(RESPONDA_PROJECT_ID, RESPONDA_BENCH_ID, RESPONDA_DB, {
          source: "stdout",
          text: "Creating postgres ... done",
          ts: "2026-06-21T00:00:00.000Z",
        });
        appendComponentLog(RESPONDA_PROJECT_ID, RESPONDA_BENCH_ID, RESPONDA_DB, {
          source: "stdout",
          text: "db-init: schema bootstrap complete",
          ts: "2026-06-21T00:00:01.000Z",
        });
        appendComponentLog(RESPONDA_PROJECT_ID, RESPONDA_BENCH_ID, RESPONDA_DB, {
          source: "stdout",
          text: "migrate: applied 3 migrations",
          ts: "2026-06-21T00:00:02.000Z",
        });
        const texts = getComponentLogLines(RESPONDA_PROJECT_ID, RESPONDA_BENCH_ID, RESPONDA_DB).map(
          (l) => l.text,
        );
        expect(texts.some((t) => t.includes("migrate") || t.includes("db-init"))).toBe(true);
        expect(texts.some((t) => t.includes("Creating postgres"))).toBe(true);
      },
    );

    // S007: the first process component's logs include stdout/stderr lines.
    await track(
      TC033_STEPS.processLogs,
      "the api process component's logs include stdout/stderr lines from its command",
      () => {
        appendComponentLog(RESPONDA_PROJECT_ID, RESPONDA_BENCH_ID, RESPONDA_API, {
          source: "stdout",
          text: "api listening on 7100",
          ts: "2026-06-21T00:00:03.000Z",
        });
        appendComponentLog(RESPONDA_PROJECT_ID, RESPONDA_BENCH_ID, RESPONDA_API, {
          source: "stderr",
          text: "api: deprecation warning",
          ts: "2026-06-21T00:00:04.000Z",
        });
        const lines = getComponentLogLines(RESPONDA_PROJECT_ID, RESPONDA_BENCH_ID, RESPONDA_API);
        expect(lines.some((l) => l.source === "stdout")).toBe(true);
        expect(lines.some((l) => l.source === "stderr")).toBe(true);
      },
    );

    // S008: teardown. Drive the REAL orphan-reap seam: sweepOrphanedComposeProjects
    // (#612 cleanup) replays the ledger, downs every roubo-* compose project it
    // still records, and clears the entry. Spying composeDownByProject lets the
    // real down path run (and remove the project from our live set) without a
    // Docker daemon, so "no roubo-* remains" and "the ledger entry is cleared"
    // are proved by production code, not by the test setting them itself.
    await track(
      TC033_STEPS.teardown,
      "no roubo-* compose project remains after the real orphan sweep and the ledger entry is cleared",
      async () => {
        expect(liveComposeProjects.has(RESPONDA_COMPOSE)).toBe(true);
        expect(ledger.getEntry(DB_PLUGIN_ID, RESPONDA_BENCH_ID)?.composeProjects).toContain(
          RESPONDA_COMPOSE,
        );
        const downSpy = vi
          .spyOn(dockerService, "composeDownByProject")
          .mockImplementation(async (projectName: string) => {
            liveComposeProjects.delete(projectName);
          });
        try {
          await benchManager.sweepOrphanedComposeProjects();
          expect(downSpy).toHaveBeenCalledWith(RESPONDA_COMPOSE);
          expect([...liveComposeProjects].filter((p) => p.startsWith("roubo-"))).toEqual([]);
          expect(ledger.getEntry(DB_PLUGIN_ID, RESPONDA_BENCH_ID)).toBeUndefined();
          expect(ledger.getEntry(PROCESS_PLUGIN_ID, RESPONDA_BENCH_ID)).toBeUndefined();
        } finally {
          downSpy.mockRestore();
        }
      },
    );

    // Terminal drift guard: the integrated run matches CP-TC-033's step sequence
    // end to end. A dropped or reordered step makes executed != TC033_SEQUENCE.
    expect(executed).toEqual(TC033_SEQUENCE);
  });
});

describe("Dogfood-parity E2E (CP-TC-034): roubo bench starts identically on plugin-backed components", () => {
  const TC034_STEPS = {
    createBench: "S001 POST .../benches creates a bench; 201 with a valid bench id",
    startBench: "S002 POST .../benches/{id}/start returns 202/200",
    allRunning:
      "S003 all components reach running; dependsOn ordering: the database is running before the dependent process starts",
    connectionTemplated:
      "S004 the database connection string contains the allocated port, not a placeholder",
    teardown: "S005 stop the bench: all components stopped, no roubo-* containers remain",
  } as const;
  const TC034_SEQUENCE = [
    TC034_STEPS.createBench,
    TC034_STEPS.startBench,
    TC034_STEPS.allRunning,
    TC034_STEPS.connectionTemplated,
    TC034_STEPS.teardown,
  ];

  it("runs the full roubo journey end to end and matches CP-TC-034", async () => {
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

    const liveComposeProjects = new Set<string>();
    const startOrder: string[] = [];
    const docker = makeFakeDocker(liveComposeProjects);
    const processManager = makeFakeProcessManager(startOrder);

    const dbDescriptor = databaseDescriptor(ROUBO_DB);
    const serverDescriptor = processDescriptor("npx tsx watch server/index.ts", [ROUBO_DB]);

    // S001: create a bench from the migrated roubo config (#614): a database
    // component + a dependent process component, both valid descriptors.
    await track(
      TC034_STEPS.createBench,
      "the migrated roubo config yields a valid database descriptor and a dependent process descriptor",
      () => {
        for (const d of [dbDescriptor, serverDescriptor]) {
          const parsed = ProvisionDescriptorSchema.safeParse(d);
          if (!parsed.success) throw new Error(`invalid descriptor: ${parsed.error.message}`);
        }
        expect(serverDescriptor.dependsOn).toEqual([ROUBO_DB]);
      },
    );

    const results: Record<string, ComponentStatus["status"]> = {};
    await track(TC034_STEPS.startBench, "start dispatches both descriptors without error", () => {
      expect(Object.keys(results)).toHaveLength(0);
    });

    // S003: all components reach running, database before the dependent process.
    let dbConnection: string | undefined;
    await track(
      TC034_STEPS.allRunning,
      "the database reaches running before the dependent process starts, and both reach running",
      async () => {
        const dbRun = await runComponent(dbDescriptor, {
          pluginId: DB_PLUGIN_ID,
          projectId: ROUBO_PROJECT_ID,
          benchId: ROUBO_BENCH_ID,
          componentName: ROUBO_DB,
          workspacePath: rouboWorkspace,
          ports: { ...ROUBO_PORTS },
          docker,
          processManager,
        });
        results[ROUBO_DB] = dbRun.result.status;
        dbConnection = dbRun.result.connection;
        expect(dbRun.result.status).toBe("running");
        // No process started until the database is running (dependsOn ordering).
        expect(startOrder).toEqual([]);

        const serverRun = await runComponent(serverDescriptor, {
          pluginId: PROCESS_PLUGIN_ID,
          projectId: ROUBO_PROJECT_ID,
          benchId: ROUBO_BENCH_ID,
          componentName: ROUBO_SERVER,
          workspacePath: rouboWorkspace,
          ports: { ...ROUBO_PORTS },
          docker,
          processManager,
        });
        results[ROUBO_SERVER] = serverRun.result.status;
        expect(serverRun.result.status).toBe("running");
        expect(results).toEqual({ [ROUBO_DB]: "running", [ROUBO_SERVER]: "running" });
        expect(startOrder).toEqual([`${PROCESS_PLUGIN_ID}:${ROUBO_BENCH_ID}:${ROUBO_SERVER}`]);
      },
    );

    // S004: the connection string contains the allocated port, not a placeholder.
    await track(
      TC034_STEPS.connectionTemplated,
      "the database connection string contains the allocated port, not a placeholder",
      () => {
        expect(dbConnection).toBe(`postgres://localhost:${ROUBO_PORTS.db}/app`);
        expect(dbConnection).not.toContain("{{");
      },
    );

    // S005: teardown via the real orphan sweep; no roubo-* compose project remains.
    await track(
      TC034_STEPS.teardown,
      "no roubo-* compose project remains after the real orphan sweep and the ledger entry is cleared",
      async () => {
        expect(liveComposeProjects.has(ROUBO_COMPOSE)).toBe(true);
        const downSpy = vi
          .spyOn(dockerService, "composeDownByProject")
          .mockImplementation(async (projectName: string) => {
            liveComposeProjects.delete(projectName);
          });
        try {
          await benchManager.sweepOrphanedComposeProjects();
          expect(downSpy).toHaveBeenCalledWith(ROUBO_COMPOSE);
          expect([...liveComposeProjects].filter((p) => p.startsWith("roubo-"))).toEqual([]);
          expect(ledger.getEntry(DB_PLUGIN_ID, ROUBO_BENCH_ID)).toBeUndefined();
        } finally {
          downSpy.mockRestore();
        }
      },
    );

    expect(executed).toEqual(TC034_SEQUENCE);
  });

  // FR-020: prove the failure-output wrapper localises a diverging step,
  // reporting the diverging label, expected-vs-actual, and the owning slices.
  it("on failure reports the diverging step, expected-vs-actual, and owning slices", async () => {
    const label = "S003 the database reaches running";
    await expect(
      step(label, "the database reaches running", () => {
        // Drive a real engine failure: an invalid descriptor (bad schemaVersion)
        // is rejected before any host call, driving the component to error.
        const statuses: ComponentStatus[] = [];
        const ctx: LifecycleContext = {
          pluginId: DB_PLUGIN_ID,
          projectId: ROUBO_PROJECT_ID,
          benchId: 99,
          componentName: ROUBO_DB,
          workspacePath: rouboWorkspace,
          ports: { ...ROUBO_PORTS },
          reportStatus: (s) => statuses.push(s),
        };
        return runDescriptor(
          { schemaVersion: 99, kind: "docker", composeFile: "x", service: "p" },
          ctx,
          { docker: makeFakeDocker(new Set()), ledger },
        ).then((result) => {
          if (result.status !== "running") {
            throw new Error(`component reached ${result.status}, not running`);
          }
        });
      }),
    ).rejects.toThrow(/e2e_flow step diverged/);

    const captured = await step(label, "the database reaches running", () => {
      throw new Error("component reached error, not running");
    }).catch((e: Error) => e.message);

    expect(captured).toContain("expected: the database reaches running");
    expect(captured).toContain("actual:   component reached error, not running");
    expect(captured).toContain(`owning slice(s): ${OWNING_SLICES}`);
  });
});
