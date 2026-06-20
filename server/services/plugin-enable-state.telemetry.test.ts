import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express, Router } from "express";
import type { PluginRecord } from "@roubo/shared";

// TC-149 (security invariant from .specifications/integration-plugins/test-cases.json).
// NFR-019 / FR-060 pin that ~/.roubo/plugins-state.json is never serialised by
// routes or telemetry. This test captures every outbound channel during
// enable/disable and asserts no leak; it also inventories the plugins router
// for state-snapshot endpoints. See parent WU-063 (#154) and issue #217.

const MARKER_ID = "tc149-secret-marker";

vi.mock("../services/plugin-installer.js", () => {
  class InstallError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return {
    InstallError,
    isValidStagingToken: (t: string) => TOKEN_RE.test(t),
    previewFromGitUrl: vi.fn(),
    previewFromLocalPath: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
});

vi.mock("../services/integration-overrides.js", async () => {
  const actual = await vi.importActual<typeof import("../services/integration-overrides.js")>(
    "../services/integration-overrides.js",
  );
  return {
    ...actual,
    loadGlobalOverride: vi.fn().mockReturnValue(null),
    saveGlobalOverride: vi.fn(),
  };
});

vi.mock("../services/integration-test.js", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  persistSecretFields: vi.fn(),
  runIntegrationTest: vi.fn(),
}));

vi.mock("../services/plugin-activation.js", () => ({
  ensurePluginActivated: vi.fn().mockResolvedValue(undefined),
  forgetProjectActivation: vi.fn(),
  forgetPluginActivation: vi.fn(),
}));

// plugin-manager is partially mocked: enable/disable delegate to the REAL
// plugin-enable-state so the persistence path (and any future emissions on
// that path) are exercised end-to-end. Everything else is stubbed so the
// router can mount without a real plugin process.
vi.mock("../services/plugin-manager.js", async () => {
  const realEnableState = await import("./plugin-enable-state.js");
  const record: PluginRecord = {
    id: MARKER_ID,
    manifest: null,
    manifestPath: `/p/${MARKER_ID}/roubo-plugin.yaml`,
    pluginDir: `/p/${MARKER_ID}`,
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 4242,
  };
  return {
    HOST_API_VERSION: "1.2.0",
    listInstalled: vi.fn(() => [record]),
    enable: vi.fn(async (id: string) => {
      realEnableState.setPluginEnabled(id, true);
    }),
    disable: vi.fn(async (id: string) => {
      realEnableState.setPluginEnabled(id, false);
    }),
    restart: vi.fn(),
    readLogs: vi.fn().mockResolvedValue([]),
    uninstall: vi.fn(),
    invoke: vi.fn(),
    getConnectionStatus: vi.fn().mockResolvedValue({ state: "checking" }),
    invalidateConnectionStatus: vi.fn(),
  };
});

let sandboxRoot: string;
let originalHome: string | undefined;
let originalProduction: string | undefined;
let enableState: typeof import("./plugin-enable-state.js");
let router: Router;

// state.ts captures ROUBO_DIR at module load time from process.env.HOME, so
// each test re-imports against a fresh sandbox HOME. Mocks above stay hot
// across resetModules (that is exactly what vitest's hoisted vi.mock provides).
async function freshImports(): Promise<void> {
  vi.resetModules();
  enableState = await import("./plugin-enable-state.js");
  const routerMod = await import("../routes/plugins.js");
  router = routerMod.default;
}

function mountApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
}

function statePath(): string {
  return path.join(sandboxRoot, ".roubo", "plugins-state.json");
}

function readPersisted(): string {
  return readFileSync(statePath(), "utf-8");
}

interface Captured {
  console: string[];
  stdout: string[];
  stderr: string[];
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a == null) return String(a);
      if (typeof a === "string") return a;
      if (a instanceof Buffer) return a.toString("utf-8");
      if (a instanceof Uint8Array) return Buffer.from(a).toString("utf-8");
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

// Spies are scoped to the action so the vitest reporter's own writes between
// tests are not captured (and not suppressed). Forwarding stdout/stderr to
// the original keeps the reporter functional during the action too.
async function withCapture(action: () => Promise<void> | void): Promise<Captured> {
  const captured: Captured = { console: [], stdout: [], stderr: [] };

  const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      captured.console.push(stringifyArgs(args));
    }),
  );

  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    captured.stdout.push(stringifyArgs([chunk]));
    return stdoutOrig(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write);

  const stderrOrig = process.stderr.write.bind(process.stderr);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    captured.stderr.push(stringifyArgs([chunk]));
    return stderrOrig(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write);

  try {
    await action();
  } finally {
    for (const s of consoleSpies) s.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return captured;
}

function allEmissions(c: Captured): string[] {
  return [...c.console, ...c.stdout, ...c.stderr];
}

// Matches the only on-disk shape that would constitute a true leak of a
// plugins-state.json value: a `"<pluginId>": "enabled"|"disabled"` mapping.
// References to the pluginId alone are permitted (and expected) in logs.
const ENABLE_STATE_PAIR_RE = new RegExp(`"${MARKER_ID}"\\s*:\\s*"(?:enabled|disabled)"`);

beforeEach(async () => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), "roubo-tc149-"));
  originalHome = process.env.HOME;
  originalProduction = process.env.ROUBO_PRODUCTION;
  process.env.HOME = sandboxRoot;
  process.env.ROUBO_PRODUCTION = "1";
  await freshImports();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProduction === undefined) delete process.env.ROUBO_PRODUCTION;
  else process.env.ROUBO_PRODUCTION = originalProduction;
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("TC-149: plugin enable state never appears in telemetry payloads", () => {
  it("HTTP enable/disable: response is 204 + empty body, no enable-state values leak to any channel", async () => {
    const app = mountApp();
    let enableRes!: Awaited<ReturnType<ReturnType<typeof request>["post"]>>;
    let disableRes!: Awaited<ReturnType<ReturnType<typeof request>["post"]>>;

    const captured = await withCapture(async () => {
      enableRes = await request(app).post(`/${MARKER_ID}/enable`);
      disableRes = await request(app).post(`/${MARKER_ID}/disable`);
    });

    expect(enableRes.status).toBe(204);
    expect(enableRes.text).toBe("");
    expect(disableRes.status).toBe(204);
    expect(disableRes.text).toBe("");

    // Sanity: the routes wrote through to the real plugin-enable-state.
    const persisted = readPersisted();
    expect(persisted).toContain(MARKER_ID);

    for (const line of allEmissions(captured)) {
      expect(line).not.toContain(persisted);
      expect(line).not.toContain('"schemaVersion"');
      expect(line).not.toContain('"installInitialized"');
      expect(line).not.toMatch(ENABLE_STATE_PAIR_RE);
    }
  });

  it("direct setPluginEnabled call: persistence path emits nothing that includes plugins-state.json values", async () => {
    const captured = await withCapture(async () => {
      enableState.setPluginEnabled(MARKER_ID, true);
      enableState.setPluginEnabled(MARKER_ID, false);
    });

    const persisted = readPersisted();
    expect(persisted).toContain(MARKER_ID);

    for (const line of allEmissions(captured)) {
      expect(line).not.toContain(persisted);
      expect(line).not.toContain('"schemaVersion"');
      expect(line).not.toContain('"installInitialized"');
      expect(line).not.toMatch(ENABLE_STATE_PAIR_RE);
    }
  });

  it("any emission that references the plugin uses pluginId only, never an enable-state pair", async () => {
    const app = mountApp();
    const captured = await withCapture(async () => {
      await request(app).post(`/${MARKER_ID}/enable`);
      await request(app).post(`/${MARKER_ID}/disable`);
    });

    for (const line of allEmissions(captured)) {
      if (!line.includes(MARKER_ID)) continue;
      expect(line).not.toMatch(ENABLE_STATE_PAIR_RE);
    }
  });

  it("plugins router exposes no state-snapshot endpoint that surfaces plugins-state.json", async () => {
    interface RouterRoute {
      path: string;
      methods: Record<string, boolean>;
    }
    interface RouterLayer {
      route?: RouterRoute;
    }
    const stack = (router as unknown as { stack: RouterLayer[] }).stack;
    const routes: RouterRoute[] = stack.flatMap((l) => (l.route ? [l.route] : []));
    const allPaths = routes.map((r) => r.path);

    // Structural inventory. `connection-status` is permitted: derived health,
    // not a dump.
    const FORBIDDEN = [/\bsnapshot\b/i, /\bdump\b/i, /-export\b/i, /\bexport-/i];
    for (const p of allPaths) {
      for (const pat of FORBIDDEN) {
        expect(p).not.toMatch(pat);
      }
    }

    // Active inventory: seed the file, then hit every registered GET path.
    // No response body may contain the persisted JSON or an enable-state pair.
    enableState.setPluginEnabled(MARKER_ID, true);
    const persisted = readPersisted();

    const app = mountApp();
    const getPaths = routes.filter((r) => r.methods.get).map((r) => r.path);
    expect(getPaths.length).toBeGreaterThan(0);

    for (const p of getPaths) {
      const concrete = p.replace(/:id/g, MARKER_ID).replace(/:[A-Za-z][A-Za-z0-9_]*/g, "x");
      const res = await request(app).get(concrete);
      const body = res.text ?? "";
      expect(body).not.toContain(persisted);
      expect(body).not.toMatch(ENABLE_STATE_PAIR_RE);
    }
  });
});
