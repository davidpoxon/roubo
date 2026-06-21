/**
 * CP-TC-029 drift guard (issue #630): the component kind coexists with
 * integration plugins (no regression).
 *
 * This is the integration-level drift guard for the journey that spans slices
 * #600 and #609. It asserts the *integrated* journey against the authoritative
 * e2e_flow case CP-TC-029 in .specifications/component-plugins/test-cases.json,
 * not whatever any single slice implemented. It does NOT re-test slice
 * internals (out of scope per the issue).
 *
 * Steps are keyed to CP-TC-029's S001-S004:
 *   S001  github-com manifest discovers + validates against HOST_API_VERSION
 *         1.3.0 and its spawn path is invoked.
 *   S002  POST /api/projects/:projectId/issues/:externalId/assign drives the
 *         integration plugin's standard RPC flow with no component-kind error.
 *   S003  POST /api/plugins/github-com/oauth/{authorize,exchange} respond
 *         correctly with no component-kind-introduced errors.
 *   S004  no component-kind broker surface is injected into the integration
 *         plugin's RPC namespace, asserted against the real wiring: the host
 *         calls component.translate / component.start on the plugin (its true
 *         served registry) and the plugin probes host.docker.* / host.process.*
 *         back to the host (the real broker injection path); both yield
 *         MethodNotFound, with positive controls proving the probe is live.
 *
 * FR-020 failure-output contract: every assertion runs through `expectStep`,
 * which on failure surfaces (1) the diverged e2e_flow step id, (2) the
 * expected-vs-actual at that step, and (3) the owning slice issue(s) from this
 * unit's blocked-by set, so integration drift is localized to an attributable
 * slice.
 *
 * NOTE on S002 contract: CP-TC-029 S002-O01's prose says the assign endpoint
 * "returns a 200 response with the expected assignment payload". The shipped
 * route contract (server/routes/issues.ts) is 204 No Content with no body (see
 * server/routes/issues.test.ts "returns 204 (TC-040)"). This drift guard
 * asserts the *actual integrated contract* (204 + the assignIssue RPC invoked
 * with the expected payload), because asserting a 200-with-body the system never
 * returns would make the guard fail against a correct system. The "expected
 * assignment payload" is verified on the RPC the route forwards to the plugin.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import semver from "semver";
import { parseManifest } from "@roubo/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(here, "__fixtures__", "plugins");
const REPO_ROOT = path.resolve(here, "..", "..");
const BUNDLED_GITHUB_MANIFEST = path.join(REPO_ROOT, "plugins", "github-com", "roubo-plugin.yaml");

// --- FR-020 failure-output helper ------------------------------------------
//
// The journey spans slices #600 and #609 (the issue's blocked-by set). On a
// step assertion failure we surface the diverged e2e_flow step id, the
// expected-vs-actual, and the owning slice issue(s) so the drift is
// attributable to a slice rather than to "the e2e test".
const BLOCKED_BY = ["#600", "#609"];

const STEP_OWNERS: Record<string, string[]> = {
  // Manifest discovery / validation / spawn parity rides the plugin-kind
  // contract slice work that introduced the component kind and the
  // HOST_API_VERSION bump.
  S001: ["#600", "#609"],
  // The integration RPC route (assign) is exercised against the unchanged
  // integration surface; a regression here implicates the kind-coexistence
  // slice that touched plugin-manager dispatch.
  S002: ["#600", "#609"],
  // OAuth flow is integration-plugin-only; a component-kind-introduced break
  // implicates the same coexistence slice set.
  S003: ["#600", "#609"],
  // Broker-namespace isolation is the component-broker wiring slice.
  S004: ["#600", "#609"],
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
      `CP-TC-029 drift at e2e_flow step ${stepId}: ${what}`,
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
  const root = await mkdtemp(path.join(tmpdir(), "roubo-cp-tc-029-"));
  const bundledDir = path.join(root, "bundled");
  const userDir = path.join(root, "user");
  await mkdir(bundledDir, { recursive: true });
  await mkdir(userDir, { recursive: true });
  // Symlink (not copy) so the fixture's `require("vscode-jsonrpc/node")`
  // resolves via the project's node_modules through the realpath walk, exactly
  // as plugin-manager.test.ts does.
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

describe("CP-TC-029: the component kind coexists with integration plugins (issue #630)", () => {
  let sandbox: Sandbox | null = null;

  afterEach(async () => {
    if (sandbox) {
      await sandbox.cleanup();
      sandbox = null;
    }
    // Clear any per-test `vi.doMock` registrations so a mocked module from one
    // step (e.g. S002/S003 mock ./plugin-manager.js) never leaks into a later
    // step that imports the real module (S001/S004). resetModules alone clears
    // the module cache but not the mock registry.
    vi.doUnmock("./plugin-manager.js");
    vi.doUnmock("./active-plugin.js");
    vi.doUnmock("./plugin-activation.js");
    vi.doUnmock("./integration-migrations.js");
    vi.doUnmock("./issue-snapshot-cache.js");
    vi.doUnmock("./cut-list-query-service.js");
    vi.doUnmock("./plugin-sort-fields.js");
    vi.doUnmock("./issue-assignment.js");
    vi.doUnmock("./github-oauth.js");
    vi.doUnmock("./github.js");
    vi.doUnmock("./credential-store.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // --- S001 ----------------------------------------------------------------
  it("S001: github-com manifest discovers + validates against HOST_API_VERSION 1.3.0 and its spawn path is invoked", async () => {
    // The plugin-manager module reads ROUBO_*_PLUGINS_DIR at discovery time, so
    // mount the sandbox before importing it.
    sandbox = await makeSandbox(["github-com-e2e"]);
    const pluginManager = await import("./plugin-manager.js");
    pluginManager.__test.reset();

    // (a) Validate the *real bundled* github-com manifest against the live
    // HOST_API_VERSION. This is the regression heart of the step: the 1.3.0
    // bump (component kind + ports/docker categories + version fields) must
    // remain backward-compatible with the unchanged integration manifest.
    const manifestText = await readFile(BUNDLED_GITHUB_MANIFEST, "utf8");
    const parsed = parseManifest(manifestText, BUNDLED_GITHUB_MANIFEST);

    expectStep(
      "S001",
      "the bundled github-com manifest parses + validates",
      () => {
        expect(parsed.ok).toBe(true);
      },
      { expected: { ok: true }, actual: parsed.ok ? { ok: true } : parsed.error },
    );
    if (!parsed.ok) return; // unreachable once the assertion above holds

    expectStep(
      "S001",
      "the github-com manifest declares kind: integration",
      () => {
        expect(parsed.manifest.kind).toBe("integration");
      },
      { expected: "integration", actual: parsed.manifest.kind },
    );

    expectStep(
      "S001",
      "the github-com manifest's roubo range is satisfied by HOST_API_VERSION 1.3.0",
      () => {
        expect(pluginManager.HOST_API_VERSION).toBe("1.3.0");
        expect(
          semver.satisfies(pluginManager.HOST_API_VERSION, parsed.manifest.roubo, {
            includePrerelease: false,
          }),
        ).toBe(true);
      },
      {
        expected: `${"1.3.0"} satisfies ${parsed.manifest.roubo}`,
        actual: `${pluginManager.HOST_API_VERSION} vs ${parsed.manifest.roubo}`,
      },
    );

    // (b) Prove the integration spawn path is invoked: a spawnable
    // integration fixture mounted under the bundled id "github-com" is
    // discovered, validated, and spawned by the real plugin-manager (the
    // kind-agnostic discover -> validate -> spawn machinery), reaching
    // `enabled` with a live pid. We do not boot the real (unbuilt) bundled
    // plugin; the fixture exercises the same spawn path.
    await pluginManager.initialize();
    try {
      const record = pluginManager.getRecord("github-com");

      expectStep(
        "S001",
        "github-com is discovered with a validated integration manifest",
        () => {
          expect(record).toBeDefined();
          expect(record?.manifest?.kind).toBe("integration");
        },
        { expected: "discovered integration record", actual: record?.manifest?.kind },
      );

      expectStep(
        "S001",
        "github-com's spawn path was invoked: status enabled with a live pid",
        () => {
          expect(record?.status).toBe("enabled");
          expect(typeof record?.pid).toBe("number");
        },
        {
          expected: { status: "enabled", pid: "number" },
          actual: { status: record?.status, pid: record?.pid },
        },
      );

      const pid = record?.pid;
      expectStep(
        "S001",
        "the spawned github-com process is alive",
        () => {
          expect(typeof pid).toBe("number");
          expect(() => process.kill(pid as number, 0)).not.toThrow();
        },
        { expected: "process alive", actual: { pid } },
      );
    } finally {
      await pluginManager.shutdown();
    }
  });

  // --- S002 ----------------------------------------------------------------
  it("S002: POST /:projectId/issues/:externalId/assign drives the integration RPC flow with no component-kind error", async () => {
    // Reuse the issues route's supertest + mock harness shape (see
    // server/routes/issues.test.ts). We mock the same module boundary so the
    // route runs against a stubbed integration plugin, not a live process.
    vi.doMock("./plugin-manager.js", () => ({ invoke: vi.fn(), getRecord: vi.fn() }));
    vi.doMock("./active-plugin.js", () => ({ resolveActivePlugin: vi.fn() }));
    vi.doMock("./plugin-activation.js", () => ({
      ensurePluginActivated: vi.fn().mockResolvedValue(undefined),
      forgetProjectActivation: vi.fn(),
      forgetPluginActivation: vi.fn(),
      resolveSources: vi.fn().mockReturnValue([{ kind: "repo", externalId: "foo/bar" }]),
      resolveExclusion: vi
        .fn()
        .mockReturnValue({ excludedStatusCategories: [], excludedStatuses: [] }),
      resolveInstanceEndpoint: vi.fn().mockReturnValue(null),
    }));
    vi.doMock("./integration-migrations.js", () => ({
      awaitPendingIntegrationSetup: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("./issue-snapshot-cache.js", () => ({
      getSnapshot: vi.fn(),
      recordSnapshot: vi.fn(),
    }));
    vi.doMock("./cut-list-query-service.js", () => ({
      cutListQueryService: {
        queryFirstOrPage: vi.fn(),
        buildListParams: vi.fn(),
        resolvePersistedSort: vi.fn(),
      },
    }));
    vi.doMock("./plugin-sort-fields.js", () => ({ getPluginSortFields: vi.fn() }));
    vi.doMock("./issue-assignment.js", () => ({ assignIssue: vi.fn(), unassignIssue: vi.fn() }));

    const pluginManager = await import("./plugin-manager.js");
    const activePlugin = await import("./active-plugin.js");
    const { default: issuesRouter } = await import("../routes/issues.js");

    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });
    // The integration plugin handles assignIssue (resolves with no value).
    vi.mocked(pluginManager.invoke).mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.use("/", issuesRouter);

    const res = await request(app)
      .post("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "jane.doe@acme.com" });

    // CP-TC-029 S002-O01: the integration plugin handles the request and
    // returns the expected assignment outcome. The shipped contract is 204 No
    // Content (see the route + issues.test.ts); the "expected assignment
    // payload" is the assignIssue RPC the route forwards to the plugin.
    expectStep(
      "S002",
      "the assign endpoint returns its success status with no component-kind error",
      () => {
        expect(res.status).toBe(204);
        expect(res.text).toBe("");
      },
      { expected: { status: 204, body: "" }, actual: { status: res.status, body: res.text } },
    );

    expectStep(
      "S002",
      "the route forwarded the expected assignment payload to the integration plugin via assignIssue",
      () => {
        expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "assignIssue", {
          externalId: "ROUBO-42",
          assigneeExternalId: "jane.doe@acme.com",
        });
      },
      {
        expected: {
          plugin: "github-com",
          method: "assignIssue",
          params: { externalId: "ROUBO-42", assigneeExternalId: "jane.doe@acme.com" },
        },
        actual: vi.mocked(pluginManager.invoke).mock.calls,
      },
    );
  });

  // --- S003 ----------------------------------------------------------------
  it("S003: POST /authorize and /exchange respond correctly with no component-kind-introduced errors", async () => {
    // Reuse the github-oauth route's mock harness shape (see
    // server/routes/plugins-github-oauth.test.ts).
    const githubOauthMocks = {
      buildAuthorizationUrl: vi.fn(),
      exchangeCodeForToken: vi.fn(),
      fetchGitHubUsername: vi.fn(),
      saveToken: vi.fn(),
      validateState: vi.fn(),
      GITHUB_PLUGIN_ID: "github-com",
      GITHUB_TOKEN_SLOT: "github-token",
      REQUIRED_SCOPES: ["repo", "read:org", "read:project", "security_events"],
    };
    const githubMocks = { refreshAuth: vi.fn() };
    const pluginManagerMocks = { invalidateConnectionStatus: vi.fn(), invoke: vi.fn() };
    const credentialStoreMocks = { deleteSlot: vi.fn(), set: vi.fn(), get: vi.fn() };

    vi.doMock("./github-oauth.js", () => githubOauthMocks);
    vi.doMock("./github.js", () => githubMocks);
    vi.doMock("./plugin-manager.js", () => pluginManagerMocks);
    vi.doMock("./credential-store.js", () => credentialStoreMocks);

    const { default: oauthRouter } = await import("../routes/plugins-github-oauth.js");

    // Silence the route's structured oauth-authorize / oauth-exchange info
    // lines so they don't leak into test stdout (repo testing rule).
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    const app = express();
    app.use(express.json());
    app.use("/", oauthRouter);

    // authorize
    githubOauthMocks.buildAuthorizationUrl.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?state=abc",
    });
    const authorizeRes = await request(app).post("/authorize");

    expectStep(
      "S003",
      "POST /authorize returns the authorization URL with no component-kind error",
      () => {
        expect(authorizeRes.status).toBe(200);
        expect(authorizeRes.body).toEqual({
          url: "https://github.com/login/oauth/authorize?state=abc",
        });
      },
      {
        expected: { status: 200, hasUrl: true },
        actual: { status: authorizeRes.status, body: authorizeRes.body },
      },
    );

    // exchange
    githubOauthMocks.validateState.mockReturnValue(true);
    githubOauthMocks.exchangeCodeForToken.mockResolvedValue({
      token: "ghp_secret",
      scopes: ["repo", "read:org", "read:project"],
    });
    githubOauthMocks.fetchGitHubUsername.mockResolvedValue("octocat");
    githubOauthMocks.saveToken.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);
    pluginManagerMocks.invoke.mockResolvedValue(undefined);

    const exchangeRes = await request(app).post("/exchange").send({ code: "abc", state: "good" });

    expectStep(
      "S003",
      "POST /exchange completes the OAuth flow with no component-kind error",
      () => {
        expect(exchangeRes.status).toBe(200);
        expect(exchangeRes.body).toEqual({ ok: true, username: "octocat" });
      },
      {
        expected: { status: 200, body: { ok: true, username: "octocat" } },
        actual: { status: exchangeRes.status, body: exchangeRes.body },
      },
    );

    consoleInfo.mockRestore();
  });

  // --- S004 ----------------------------------------------------------------
  it("S004: no component-kind broker methods are injected into the integration plugin's RPC namespace", async () => {
    sandbox = await makeSandbox(["github-com-e2e"]);
    const pluginManager = await import("./plugin-manager.js");
    pluginManager.__test.reset();
    await pluginManager.initialize();

    // JSON-RPC "method not found" (the response when no handler is registered
    // for a method on a connection). invoke() maps the numeric -32601 to the
    // string "MethodNotFound" for host->plugin calls; the __probeHost helper
    // reports the raw numeric code for plugin->host calls.
    const METHOD_NOT_FOUND_CODE = -32601;
    const METHOD_NOT_FOUND_STR = "MethodNotFound";

    try {
      await waitFor(() => {
        const r = pluginManager.getRecord("github-com");
        return !!r && r.status === "enabled" && r.pid !== null;
      });

      // The S004 concern (AC-4) is that no component-kind broker surface leaks
      // into an integration plugin's RPC namespace. That surface has two halves,
      // each asserted against the REAL wiring (not a self-reported method list,
      // which the plugin author controls and so cannot detect a host-side leak):
      //
      //   1. component.* are PLUGIN-served methods (a component plugin implements
      //      component.translate / component.start for the host to call). An
      //      integration plugin must not serve them, so the host actually calls
      //      each over the live connection and asserts MethodNotFound: this hits
      //      the plugin process's true onRequest registry.
      //   2. host.docker.* / host.process.* are HOST-served broker methods (the
      //      host registers them so the PLUGIN can call them). They are wired by
      //      bench-manager onto component-kind connections only. The plugin's own
      //      method list could never contain them, so we probe the real injection
      //      path: the plugin calls each broker method back to the host via
      //      __probeHost and asserts the host did NOT register it (MethodNotFound).

      // (1) Component-kind plugin-served methods are not served by this plugin.
      const FORBIDDEN_PLUGIN_METHODS = ["component.translate", "component.start"];
      for (const method of FORBIDDEN_PLUGIN_METHODS) {
        let code: string | null = null;
        try {
          await pluginManager.invoke("github-com", method, undefined);
        } catch (err) {
          code = (err as { code?: string }).code ?? null;
        }
        expectStep(
          "S004",
          `the integration plugin does not serve the component-kind method ${method}`,
          () => {
            expect(code).toBe(METHOD_NOT_FOUND_STR);
          },
          { expected: METHOD_NOT_FOUND_STR, actual: code },
        );
      }

      // (2) Host-served broker methods are not registered on this integration
      // connection. The plugin probes each back to the host; MethodNotFound
      // proves the broker was not wired here.
      const FORBIDDEN_BROKER_METHODS = [
        "host.docker.composeUp",
        "host.docker.waitForHealthy",
        "host.docker.composeDown",
        "host.process.start",
      ];
      for (const method of FORBIDDEN_BROKER_METHODS) {
        const probe = await pluginManager.invoke<{ code: number | null }>(
          "github-com",
          "__probeHost",
          method,
        );
        expectStep(
          "S004",
          `the host did not inject the broker method ${method} onto the integration connection`,
          () => {
            expect(probe.code).toBe(METHOD_NOT_FOUND_CODE);
          },
          { expected: { code: METHOD_NOT_FOUND_CODE }, actual: probe },
        );
      }

      // Positive control A: the probe genuinely reaches the host, so the
      // broker-absence above is meaningful and not just a dead connection. A
      // host method that registerHostHandlers DOES register on every plugin
      // connection (host.credentials.get) is reachable: probing it returns a
      // real error (missing-slot / permission), NOT MethodNotFound.
      const liveProbe = await pluginManager.invoke<{ code: number | null }>(
        "github-com",
        "__probeHost",
        "host.credentials.get",
      );
      expectStep(
        "S004",
        "an integration host method (host.credentials.get) IS reachable, so the probe is live",
        () => {
          expect(liveProbe.code).not.toBe(METHOD_NOT_FOUND_CODE);
        },
        { expected: `code !== ${METHOD_NOT_FOUND_CODE}`, actual: liveProbe },
      );

      // Positive control B: the integration plugin's own RPC surface is intact.
      const integrationRpc = await pluginManager.invoke<string>("github-com", "ping", undefined);
      expectStep(
        "S004",
        "the integration plugin's own RPC surface is intact (ping -> pong)",
        () => {
          expect(integrationRpc).toBe("pong");
        },
        { expected: "pong", actual: integrationRpc },
      );
    } finally {
      await pluginManager.shutdown();
    }
  });
});
