/**
 * CP-TC-099 drift guard (issue #628): a plugin's undeclared actions are blocked
 * and audited while the bench keeps running (enforced sandboxing, v2).
 *
 * This is the integration-level drift guard for the journey that spans slices
 * #599, #615, #618, #619, #620. It asserts the *integrated* journey against the
 * authoritative e2e_flow case CP-TC-099 in
 * .specifications/component-plugins/test-cases.json, not whatever any single
 * slice implemented. It does NOT re-test slice internals nor write production
 * feature code (out of scope per the issue): it drives the already-shipped
 * broker + PermissionEnforcer + AuditLog + PluginIsolationSandbox surfaces
 * in-process, mirroring the established e2e pattern in
 * component-kind-coexistence.e2e.test.ts (which drives plugin-manager / the
 * broker directly rather than over HTTP). This honours the issue's out-of-scope
 * guard: it asserts the integrated path, it does not add production wiring.
 *
 * Steps are keyed to CP-TC-099's S001-S006:
 *   S001  The bench starts; both the ports-only component and the sibling 'api'
 *         component begin their lifecycle (spawned + enabled with a live pid via
 *         the real plugin-manager).
 *   S002  The plugin's declared host.ports.get is allowed at the broker and
 *         returns the allocated port; an 'allowed' AuditEntry is recorded.
 *   S003  The plugin's undeclared host.docker.composeUp is denied by the
 *         PermissionEnforcer (permission-denied to the plugin), no docker compose
 *         runs on the host, and a 'denied' AuditEntry is recorded.
 *   S004  The plugin's direct outbound TCP attempt (its own process code,
 *         bypassing the broker) is blocked by the OS-level PluginIsolationSandbox
 *         (deny-all egress), does not succeed, and does not crash the host or
 *         take down the sibling 'api'. The OS-tier denial is recorded.
 *   S005  The sibling 'api' component remains 'running' throughout (graceful
 *         degradation despite the offending plugin).
 *   S006  The audit log is queryable per plugin and per bench: both the allowed
 *         (host.ports.get) and denied (host.docker.composeUp) broker entries are
 *         returned, each carrying ts, pluginId, benchId, method, and outcome.
 *
 * FR-020 failure-output contract: every assertion runs through `expectStep`,
 * which on failure surfaces (1) the diverged e2e_flow step id, (2) the
 * expected-vs-actual at that step, and (3) the owning slice issue(s) from this
 * unit's blocked-by / covers set, so integration drift is localized to an
 * attributable slice.
 *
 * NOTE on the two audit tiers. There are two audit layers in the shipped system,
 * and CP-TC-099 exercises both:
 *   - The broker-layer AuditLog (audit-log.ts) records the allowed/denied
 *     *broker* calls (S002 host.ports.get allowed, S003 host.docker.composeUp
 *     denied). S006's per-plugin / per-bench query asserts these.
 *   - The sandbox-layer audit (plugin-manager.querySandboxAudit) records an
 *     OS-attributed denial (source: "sandbox"), because there is no host.network.*
 *     broker method, so the broker AuditLog never sees the direct egress attempt.
 *
 * What S004 verifies, and what it deliberately does NOT. CP-TC-099's S004-O01 is
 * "the OS-level PluginIsolationSandbox blocks the connection." Exercising that
 * end to end would require running the offending plugin under a real
 * network-isolated spawn (`docker run --network none ...`), which is not viable
 * in a unit-test run (it needs a Docker runtime and would break the symlinked
 * fixture's module resolution) and whose production wiring is out of scope for
 * this drift guard. So the live-spawn test below runs the offender at the
 * broker-only tier (it injects no OS-isolation probe), i.e. NOT network-isolated:
 * there, S004-O01's "does not succeed" is enforced by the non-routable
 * TEST-NET-1 target, and the meaningful integrated assertion is the
 * process-survival half (S004-O02 / S005). The OS-block MECHANISM is then
 * verified at the unit level in the dedicated S004 test: deriveEgressPolicy maps
 * the ports-only manifest to deny-all egress, and buildSandboxedSpawn maps the
 * docker tier to a `--network none` spawn, plus the sandbox audit tier's
 * record/query contract. This is an honest split (mechanism-level, not a live
 * network-isolated connection), not a silent degrade to a broker-only assertion.
 *
 * NOTE on the plugin identity. CP-TC-099 names the plugin 'test/ports-only'
 * (and the audit endpoint GET /api/plugins/test%2Fports-only/audit). A *manifest*
 * id must match ^[a-z][a-z0-9-]*$ (no slash), so the spawnable fixture's manifest
 * id is the schema-valid 'ports-only'; the broker / audit identity (a plain
 * string the AuditLog stores and queries on) carries the CP-TC-099
 * 'test/ports-only' string in-process for S002/S003/S006.
 *
 * NOTE on the route shape. There is no GET .../components/:name route; a
 * component's status is embedded in the bench / plugin record (see CLAUDE.md API
 * surface). S005 therefore polls the sibling's plugin record status rather than
 * an HTTP endpoint, consistent with how the system actually exposes component
 * status.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResponseError } from "vscode-jsonrpc/node";
import { parseManifest } from "@roubo/shared";
import type {
  AuditEntry,
  BrokerContext,
  BrokerPermissionCategory,
  BrokerPermissionDeniedData,
} from "@roubo/shared";
import { AuditLog } from "./audit-log.js";
import {
  registerBrokerHandlers,
  type DockerLike,
  type ProcessManagerLike,
} from "./component-broker.js";
import { buildSandboxedSpawn, deriveEgressPolicy, selectTier } from "./plugin-isolation-sandbox.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(here, "__fixtures__", "plugins");

// CP-TC-099's plugin identity. The manifest id (a schema-valid slug) and the
// broker/audit identity (the CP-TC-099 string, which may contain a slash)
// deliberately differ; see the file header.
const PLUGIN_MANIFEST_ID = "ports-only";
const PLUGIN_AUDIT_ID = "test/ports-only";
const SIBLING_ID = "api";
const BENCH_ID = 7;
const PERMISSION_DENIED_CODE = -32001;

// --- FR-020 failure-output helper ------------------------------------------
//
// The journey spans slices #599, #615, #618, #619, #620 (the issue's blocked-by
// set). On a step assertion failure we surface the diverged e2e_flow step id,
// the expected-vs-actual, and the owning slice issue(s) so the drift is
// attributable to a slice rather than to "the e2e test".
const BLOCKED_BY = ["#599", "#615", "#618", "#619", "#620"];

const STEP_OWNERS: Record<string, string[]> = {
  // Bench start / both components spawning rides the component-kind + supervisor
  // slices.
  S001: ["#615", "#619"],
  // host.ports.get allowed at the broker + 'allowed' audit: the broker
  // choke-point (#618) and the AuditLog (#619).
  S002: ["#618", "#619"],
  // host.docker.composeUp denied by the PermissionEnforcer + 'denied' audit:
  // the broker choke-point (#618) and the AuditLog (#619).
  S003: ["#618", "#619"],
  // Direct outbound TCP blocked at the OS layer: the PluginIsolationSandbox
  // (#620), grounded by the isolation spike (#599).
  S004: ["#599", "#620"],
  // Sibling 'api' stays running (graceful degradation): the component
  // supervisor (#615) and the sandbox isolation that contains the offender
  // (#620).
  S005: ["#615", "#620"],
  // Audit queryable per plugin and per bench: the AuditLog (#619).
  S006: ["#619"],
};

function expectStep(
  stepId: string,
  what: string,
  assertion: () => void,
  context?: { expected?: unknown; actual?: unknown },
): void {
  try {
    assertion();
  } catch (err) {
    const owners = STEP_OWNERS[stepId] ?? BLOCKED_BY;
    const lines = [
      `CP-TC-099 drift at e2e_flow step ${stepId}: ${what}`,
      context && "expected" in context ? `  expected: ${JSON.stringify(context.expected)}` : null,
      context && "actual" in context ? `  actual:   ${JSON.stringify(context.actual)}` : null,
      `  owning slice issue(s): ${owners.join(", ")}`,
      `  underlying assertion: ${err instanceof Error ? err.message : String(err)}`,
    ].filter((l): l is string => l !== null);
    throw new Error(lines.join("\n"), { cause: err });
  }
}

// --- test sandbox: symlink fixtures into bundled/user plugin roots ----------

interface Sandbox {
  cleanup: () => Promise<void>;
}

async function makeSandbox(bundled: string[]): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), "roubo-cp-tc-099-"));
  const bundledDir = path.join(root, "bundled");
  const userDir = path.join(root, "user");
  await mkdir(bundledDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  // Symlink (not copy) so the fixture's `require("vscode-jsonrpc/node")`
  // resolves via the project's node_modules through the realpath walk, exactly
  // as plugin-manager.test.ts and component-kind-coexistence.e2e.test.ts do.
  for (const id of bundled) {
    await symlink(path.join(FIXTURES_ROOT, id), path.join(bundledDir, id), "dir");
  }
  process.env.ROUBO_BUNDLED_PLUGINS_DIR = bundledDir;
  process.env.ROUBO_USER_PLUGINS_DIR = userDir;
  return {
    cleanup: async () => {
      delete process.env.ROUBO_BUNDLED_PLUGINS_DIR;
      delete process.env.ROUBO_USER_PLUGINS_DIR;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// --- in-process broker harness ----------------------------------------------
//
// The v2 broker (registerBrokerHandlers + the AuditLog) is the privileged
// choke-point; the host registers each handler on a component plugin's JSON-RPC
// connection. We drive that surface directly (the e2e pattern this repo uses)
// with a ports-only ConsentRecord: hasPermission('ports') is true, every other
// category is false. A real AuditLog instance is the recordAudit sink, so S006
// queries the same store THIS harness's broker wrote.
//
// Scope note for S006. CP-TC-099 phrases the audit query as an HTTP endpoint
// (GET /api/plugins/test%2Fports-only/audit, plus a bench-scoped endpoint). That
// endpoint, and the runtime wiring of the broker AuditLog into the live spawn
// path, do not exist yet and are out of scope for this drift guard (writing the
// spanned slices' production code). plugin-manager documents that the v2 broker
// is "not yet runtime-wired into spawnPlugin". So S006 verifies the broker +
// AuditLog record/query CONTRACT (allowed + denied entries, queryable per plugin
// and per bench with all required fields) against this in-process broker, not
// the integrated HTTP endpoint path. It is contract-level coverage of the audit
// query the integrated journey relies on, not the live endpoint itself.

function makeConnection(): JsonRpcConnection & {
  handlers: Map<string, (params: unknown) => unknown>;
} {
  const handlers = new Map<string, (params: unknown) => unknown>();
  return {
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
    onRequest: vi.fn((method: string, handler: (params: unknown) => unknown) => {
      handlers.set(method, handler);
    }),
    onNotification: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    dispose: vi.fn(),
    handlers,
  } as unknown as JsonRpcConnection & { handlers: Map<string, (params: unknown) => unknown> };
}

function makeDocker(): DockerLike & { composeUp: ReturnType<typeof vi.fn> } {
  return {
    composeUp: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    waitForHealthy: vi.fn(async () => true),
    composeRunInit: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    composeStop: vi.fn(async () => undefined),
    composeDown: vi.fn(async () => undefined),
    getContainerId: vi.fn(async () => "container-abc123"),
  } as DockerLike & { composeUp: ReturnType<typeof vi.fn> };
}

function makeProcessManager(): ProcessManagerLike {
  return {
    startProcess: vi.fn(async () => ({ pid: 4242 })),
    runProcess: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
    stopProcess: vi.fn(async () => undefined),
    getProcessStatus: vi.fn(() => ({ alive: true, exitCode: null })),
    getProcessLogs: vi.fn(() => ["line"]),
  };
}

interface BrokerHarness {
  call: (method: string, params?: unknown) => Promise<unknown>;
  docker: DockerLike & { composeUp: ReturnType<typeof vi.fn> };
  audit: AuditLog;
  allocatedPort: number;
}

// Build a broker wired to a ports-only consent (ports declared; everything else
// denied) for the CP-TC-099 plugin identity, scoped to the bench.
function makePortsOnlyBroker(): BrokerHarness {
  const connection = makeConnection();
  const docker = makeDocker();
  const pm = makeProcessManager();
  const audit = new AuditLog();
  const allocatedPort = 31337;
  const ctx: BrokerContext = {
    pluginId: PLUGIN_AUDIT_ID,
    benchId: BENCH_ID,
    ports: { http: allocatedPort },
    reportStatus: vi.fn(),
    reportLog: vi.fn(),
    // ports-only consent: only the 'ports' category is acknowledged.
    hasPermission: (category: BrokerPermissionCategory) => category === "ports",
    recordAudit: (entry: AuditEntry) => audit.record(entry),
  };
  registerBrokerHandlers(connection, ctx, { processManager: pm, docker, log: () => {} });
  const call = async (method: string, params?: unknown) => {
    const handler = connection.handlers.get(method);
    if (!handler) throw new Error(`broker did not register ${method}`);
    // Every broker call carries the benchId it acts for in its params (#685);
    // the production SDK stamps it from the in-flight lifecycle call. Stamp the
    // ctx's bench here for object params so these contract-level calls route.
    const withBenchId =
      params && typeof params === "object" && !Array.isArray(params) && !("benchId" in params)
        ? { benchId: BENCH_ID, ...params }
        : params;
    return handler(withBenchId);
  };
  return { call, docker, audit, allocatedPort };
}

describe("CP-TC-099: a plugin's undeclared actions are blocked and audited while the bench keeps running (issue #628)", () => {
  let sandbox: Sandbox | null = null;

  afterEach(async () => {
    if (sandbox) {
      await sandbox.cleanup();
      sandbox = null;
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // --- S001 + S004(no-crash) + S005 ----------------------------------------
  //
  // The bench start, the offending plugin staying alive after its blocked
  // outbound attempt, and the sibling 'api' staying running are all properties
  // of the same live spawn, so they are asserted in one run against the real
  // plugin-manager.
  it("S001/S004/S005: the bench starts both components; the offender's blocked TCP does not crash the host or the sibling 'api'", async () => {
    // plugin-manager reads ROUBO_*_PLUGINS_DIR at discovery time, so mount the
    // sandbox before importing it.
    sandbox = await makeSandbox([PLUGIN_MANIFEST_ID, SIBLING_ID]);
    const pluginManager = await import("./plugin-manager.js");
    pluginManager.__test.reset();
    await pluginManager.initialize();

    try {
      // S001-O01: the bench starts; both components begin their lifecycle
      // (spawned + enabled with a live pid).
      await waitFor(() => {
        const offender = pluginManager.getRecord(PLUGIN_MANIFEST_ID);
        const sibling = pluginManager.getRecord(SIBLING_ID);
        return (
          offender?.status === "enabled" &&
          offender?.pid !== null &&
          sibling?.status === "enabled" &&
          sibling?.pid !== null
        );
      });

      const offender = pluginManager.getRecord(PLUGIN_MANIFEST_ID);
      const sibling = pluginManager.getRecord(SIBLING_ID);

      expectStep(
        "S001",
        "the bench starts: both components spawn + reach 'enabled' with a live pid",
        () => {
          expect(offender?.status).toBe("enabled");
          expect(typeof offender?.pid).toBe("number");
          expect(sibling?.status).toBe("enabled");
          expect(typeof sibling?.pid).toBe("number");
        },
        {
          expected: { offender: "enabled+pid", sibling: "enabled+pid" },
          actual: {
            offender: { status: offender?.status, pid: offender?.pid },
            sibling: { status: sibling?.status, pid: sibling?.pid },
          },
        },
      );

      // Drive the offender's instrumented start hook over the live connection.
      // Its three attempts run against the host's real (v1) connection surface.
      // This live spawn is NOT network-isolated: the offender runs at the
      // broker-only tier (no OS-isolation probe is injected here; see the file
      // header), so the load-bearing integrated assertion is the *process-level*
      // one (S004-O02 / S005-O01): the failed direct TCP does not crash the
      // plugin or take down the sibling. The broker allow/deny semantics
      // (S002/S003) and the OS-block mechanism (S004-O01) are asserted against
      // the broker / sandbox surfaces directly in the dedicated tests below.
      const hookResult = (await pluginManager.invoke(PLUGIN_MANIFEST_ID, "start", {
        componentName: "http",
      })) as { directTcp: { connected: boolean; error?: string } };

      // S004-O01 (process-observable half only): the direct outbound TCP did not
      // succeed. Because this spawn is not network-isolated, the non-routable
      // TEST-NET-1 target is what guarantees it cannot connect; the OS-level
      // deny-all-egress block itself is verified at the mechanism level in the
      // dedicated S004 test, not by this live spawn.
      expectStep(
        "S004",
        "the plugin's direct outbound TCP connection attempt does not succeed",
        () => {
          expect(hookResult.directTcp.connected).toBe(false);
        },
        { expected: { connected: false }, actual: hookResult.directTcp },
      );

      // S004-O02: the plugin process did not crash; it still answers a ping over
      // the live connection after the blocked outbound attempt.
      const pong = await pluginManager.invoke(PLUGIN_MANIFEST_ID, "ping", undefined);
      expectStep(
        "S004",
        "the offending plugin process did not crash the host (still answers ping)",
        () => {
          expect(pong).toBe("pong");
        },
        { expected: "pong", actual: pong },
      );

      // S005-O01: the sibling 'api' component remains 'running' throughout. The
      // system embeds component status in the plugin record (no
      // .../components/:name route), so we poll the sibling's record + its live
      // connection.
      const siblingAfter = pluginManager.getRecord(SIBLING_ID);
      const siblingPong = await pluginManager.invoke(SIBLING_ID, "ping", undefined);
      expectStep(
        "S005",
        "the sibling 'api' component remains 'running' (enabled + live) throughout",
        () => {
          expect(siblingAfter?.status).toBe("enabled");
          expect(typeof siblingAfter?.pid).toBe("number");
          expect(siblingPong).toBe("pong");
        },
        {
          expected: { status: "enabled", ping: "pong" },
          actual: { status: siblingAfter?.status, pid: siblingAfter?.pid, ping: siblingPong },
        },
      );
    } finally {
      await pluginManager.shutdown();
    }
  });

  // --- S002 ----------------------------------------------------------------
  it("S002: the declared host.ports.get is allowed and returns the allocated port; an 'allowed' AuditEntry is recorded", async () => {
    const broker = makePortsOnlyBroker();

    const port = await broker.call("host.ports.get", { componentName: "http" });

    // S002-O01: the call is allowed and returns the allocated port.
    expectStep(
      "S002",
      "host.ports.get is allowed and returns the allocated port",
      () => {
        expect(port).toBe(broker.allocatedPort);
      },
      { expected: broker.allocatedPort, actual: port },
    );

    // S002-O02: an AuditEntry with outcome 'allowed' is recorded for
    // host.ports.get.
    const allowed = broker.audit
      .query({ pluginId: PLUGIN_AUDIT_ID })
      .filter((e) => e.method === "host.ports.get");
    expectStep(
      "S002",
      "an 'allowed' AuditEntry is recorded for host.ports.get",
      () => {
        expect(allowed).toHaveLength(1);
        expect(allowed[0]?.outcome).toBe("allowed");
        expect(allowed[0]?.pluginId).toBe(PLUGIN_AUDIT_ID);
        expect(allowed[0]?.benchId).toBe(BENCH_ID);
      },
      {
        expected: { method: "host.ports.get", outcome: "allowed" },
        actual: allowed,
      },
    );
  });

  // --- S003 ----------------------------------------------------------------
  it("S003: the undeclared host.docker.composeUp is denied; no docker compose runs; a 'denied' AuditEntry is recorded", async () => {
    const broker = makePortsOnlyBroker();

    // S003-O01: the PermissionEnforcer denies the call and returns a
    // permission-denied error to the plugin.
    let denied: ResponseError<BrokerPermissionDeniedData> | null = null;
    try {
      await broker.call("host.docker.composeUp", {
        projectName: "ports-only",
        composeFile: "docker-compose.yml",
        cwd: ".",
        service: "http",
      });
    } catch (err) {
      denied = err as ResponseError<BrokerPermissionDeniedData>;
    }
    expectStep(
      "S003",
      "host.docker.composeUp is denied with a permission-denied error",
      () => {
        expect(denied).toBeInstanceOf(ResponseError);
        expect(denied?.code).toBe(PERMISSION_DENIED_CODE);
        expect(denied?.data?.code).toBe("permission-denied");
        expect(denied?.data?.category).toBe("docker");
      },
      {
        expected: { code: PERMISSION_DENIED_CODE, dataCode: "permission-denied" },
        actual: denied ? { code: denied.code, data: denied.data } : null,
      },
    );

    // S003-O02: no docker compose operation executes on the host (the gate
    // throws before the docker delegate is reached).
    expectStep(
      "S003",
      "no docker compose operation executes on the host",
      () => {
        expect(broker.docker.composeUp).not.toHaveBeenCalled();
      },
      { expected: { composeUpCalls: 0 }, actual: broker.docker.composeUp.mock.calls.length },
    );

    // S003-O03: an AuditEntry with outcome 'denied' is recorded for
    // host.docker.composeUp.
    const deniedEntries = broker.audit
      .query({ pluginId: PLUGIN_AUDIT_ID })
      .filter((e) => e.method === "host.docker.composeUp");
    expectStep(
      "S003",
      "a 'denied' AuditEntry is recorded for host.docker.composeUp",
      () => {
        expect(deniedEntries).toHaveLength(1);
        expect(deniedEntries[0]?.outcome).toBe("denied");
        expect(deniedEntries[0]?.pluginId).toBe(PLUGIN_AUDIT_ID);
        expect(deniedEntries[0]?.benchId).toBe(BENCH_ID);
      },
      {
        expected: { method: "host.docker.composeUp", outcome: "denied" },
        actual: deniedEntries,
      },
    );
  });

  // --- S004 (OS-tier egress block + sandbox audit) -------------------------
  //
  // The S001/S004/S005 live-spawn test above asserts the process-observable
  // halves (the TCP does not succeed; nothing crashes). This test asserts the
  // OS-block MECHANISM at the unit level, since a live network-isolated spawn is
  // out of scope / not viable in a unit run (see the file header): the ports-only
  // manifest derives a deny-all egress policy (deriveEgressPolicy), and the docker
  // tier maps to a spawn that drops the plugin's network (buildSandboxedSpawn ->
  // `docker run --network none`). It then asserts the sandbox audit tier's
  // record/query contract (the broker AuditLog never sees a direct egress attempt:
  // there is no host.network.* broker method). This is mechanism-level coverage,
  // not a live OS-blocked connection; it does not pretend otherwise.
  it("S004: the sandbox maps the ports-only manifest to a deny-all `--network none` spawn, and the sandbox audit tier records the OS-attributed denial", async () => {
    sandbox = await makeSandbox([PLUGIN_MANIFEST_ID]);
    const pluginManager = await import("./plugin-manager.js");
    pluginManager.__test.reset();
    await pluginManager.initialize();

    try {
      const record = pluginManager.getRecord(PLUGIN_MANIFEST_ID);
      const manifestParsed = record?.manifest
        ? { ok: true as const, manifest: record.manifest }
        : parseManifest("", "");
      const manifest = record?.manifest;

      // The ports-only manifest declares no network hosts, so the sandbox denies
      // all egress. This is the only place an undeclared outbound connection can
      // be stopped (the broker has no host.network.* method).
      const egress = manifest ? deriveEgressPolicy(manifest) : null;
      expectStep(
        "S004",
        "the ports-only manifest derives a deny-all egress policy",
        () => {
          expect(manifestParsed.ok).toBe(true);
          expect(egress?.mode).toBe("deny-all");
          expect(egress?.allowedHosts).toEqual([]);
        },
        { expected: { mode: "deny-all", allowedHosts: [] }, actual: egress },
      );

      // With an OS-isolation runtime present (here: docker), the sandbox wraps
      // the plugin spawn so its network is dropped (`docker run --network none`).
      // This is the spawn shape that, when used, drops the plugin's network at
      // the OS layer; here we assert the mapping, not a live blocked connection.
      const dockerTier = selectTier({ vzVm: false, appleContainer: false, docker: true });
      const spawn = manifest
        ? buildSandboxedSpawn(manifest, dockerTier, {
            pluginDir: "/plugin",
            entryPath: "/plugin/index.cjs",
          })
        : null;
      expectStep(
        "S004",
        "the sandbox spawns the plugin with its network dropped (--network none)",
        () => {
          expect(dockerTier).toBe("docker");
          expect(spawn?.command).toBe("docker");
          expect(spawn?.args).toContain("--network");
          expect(spawn?.args).toContain("none");
          expect(spawn?.egress.mode).toBe("deny-all");
        },
        {
          expected: { command: "docker", networkNone: true, egress: "deny-all" },
          actual: spawn,
        },
      );

      // The sandbox audit tier's record/query contract: an OS-attributed denial
      // (source: "sandbox"), once recorded, is queryable per plugin and per bench,
      // even though the broker AuditLog never sees a direct egress attempt. NOTE:
      // the denial is INJECTED here via recordSandboxDenial rather than produced
      // by observing a real blocked connection: no production path yet feeds a
      // live OS egress-block into recordSandboxDenial (that wiring is out of scope
      // for this drift guard), so this asserts the record/query contract the
      // integrated journey relies on, not the act of observing a block.
      pluginManager.recordSandboxDenial({
        pluginId: PLUGIN_AUDIT_ID,
        benchId: BENCH_ID,
        method: "host.network.connect",
        params: { host: "192.0.2.1", port: 9 },
      });
      const sandboxAudit = pluginManager.querySandboxAudit({
        pluginId: PLUGIN_AUDIT_ID,
        benchId: BENCH_ID,
      });
      expectStep(
        "S004",
        "the sandbox audit tier records and returns an OS-attributed denial, queryable per plugin and per bench (record/query contract; denial injected, see above)",
        () => {
          expect(sandboxAudit).toHaveLength(1);
          expect(sandboxAudit[0]?.outcome).toBe("denied");
          expect(sandboxAudit[0]?.source).toBe("sandbox");
          expect(sandboxAudit[0]?.pluginId).toBe(PLUGIN_AUDIT_ID);
          expect(sandboxAudit[0]?.benchId).toBe(BENCH_ID);
        },
        { expected: { outcome: "denied", source: "sandbox" }, actual: sandboxAudit },
      );
    } finally {
      await pluginManager.shutdown();
    }
  });

  // --- S006 ----------------------------------------------------------------
  it("S006: the broker audit log is queryable per plugin and per bench; both the allowed and denied entries are returned with all fields", async () => {
    const broker = makePortsOnlyBroker();

    // Exercise both the allowed (host.ports.get) and denied (host.docker.composeUp)
    // broker calls so both AuditEntries exist.
    await broker.call("host.ports.get", { componentName: "http" });
    await broker
      .call("host.docker.composeUp", {
        projectName: "ports-only",
        composeFile: "docker-compose.yml",
        cwd: ".",
        service: "http",
      })
      .catch(() => {
        /* denied; the audit entry is what S006 asserts */
      });

    const byPlugin = broker.audit.query({ pluginId: PLUGIN_AUDIT_ID });
    const byBench = broker.audit.query({ benchId: BENCH_ID });

    // S006-O01: the per-plugin query returns both entries, each with ts,
    // pluginId, benchId, method, and outcome.
    const hasShape = (e: AuditEntry | undefined): boolean =>
      !!e &&
      typeof e.ts === "string" &&
      e.pluginId === PLUGIN_AUDIT_ID &&
      e.benchId === BENCH_ID &&
      typeof e.method === "string" &&
      (e.outcome === "allowed" || e.outcome === "denied");

    expectStep(
      "S006",
      "the per-plugin audit query returns the allowed (host.ports.get) and denied (host.docker.composeUp) entries with all fields",
      () => {
        const allowed = byPlugin.find(
          (e) => e.method === "host.ports.get" && e.outcome === "allowed",
        );
        const denied = byPlugin.find(
          (e) => e.method === "host.docker.composeUp" && e.outcome === "denied",
        );
        expect(allowed).toBeDefined();
        expect(denied).toBeDefined();
        expect(hasShape(allowed)).toBe(true);
        expect(hasShape(denied)).toBe(true);
      },
      {
        expected: {
          allowed: { method: "host.ports.get", outcome: "allowed" },
          denied: { method: "host.docker.composeUp", outcome: "denied" },
        },
        actual: byPlugin,
      },
    );

    // S006-O02: the same entries are retrievable filtered by bench, confirming
    // the audit log is queryable per plugin and per bench.
    expectStep(
      "S006",
      "the same allowed + denied entries are retrievable filtered by bench",
      () => {
        const allowed = byBench.find(
          (e) => e.method === "host.ports.get" && e.outcome === "allowed",
        );
        const denied = byBench.find(
          (e) => e.method === "host.docker.composeUp" && e.outcome === "denied",
        );
        expect(allowed).toBeDefined();
        expect(denied).toBeDefined();
        expect(hasShape(allowed)).toBe(true);
        expect(hasShape(denied)).toBe(true);
        // The per-plugin and per-bench queries surface the same two broker
        // entries for this single-plugin bench.
        expect(byBench).toHaveLength(byPlugin.length);
      },
      {
        expected: { allowedAndDeniedByBench: true },
        actual: byBench,
      },
    );
  });
});
