import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression coverage for the plugin-log secret leak: bearer tokens that reach a log line must
// be scrubbed before they hit disk / the logs API. Drives the real writeLog -> formatLogLine
// (redactSecrets) -> readLogs path rather than testing redactSecrets in isolation (that is
// covered by log-redaction.test.ts).
//
// plugin-manager keeps module-level singletons, so each test reloads it via
// vi.resetModules + dynamic import, mirroring plugin-manager.test.ts.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_FIXTURES = path.join(HERE, "__fixtures__", "plugins");

type PluginManagerModule = typeof import("./plugin-manager.js");

let mgr: PluginManagerModule | undefined;
let sandboxRoot: string | undefined;

async function loadManagerWithEcho(): Promise<PluginManagerModule> {
  const root = await mkdtemp(path.join(tmpdir(), "roubo-plugin-redaction-"));
  sandboxRoot = root;
  const pluginsDir = path.join(root, "plugins");
  const userPluginsDir = path.join(root, "user-plugins");
  await mkdir(pluginsDir, { recursive: true });
  await mkdir(userPluginsDir, { recursive: true });
  await cp(path.join(BUNDLED_FIXTURES, "echo"), path.join(pluginsDir, "echo"), { recursive: true });

  vi.resetModules();
  process.env.ROUBO_BUNDLED_PLUGINS_DIR = pluginsDir;
  process.env.ROUBO_USER_PLUGINS_DIR = userPluginsDir;
  const mod = await import("./plugin-manager.js");
  await mod.initialize();
  mgr = mod;
  return mod;
}

afterEach(async () => {
  if (mgr) await mgr.__test.flushLogs();
  mgr = undefined;
  // Static deletes (not a dynamic loop) keep the @typescript-eslint/no-dynamic-delete rule happy
  // and match the cleanup convention in plugin-manager.test.ts.
  delete process.env.ROUBO_BUNDLED_PLUGINS_DIR;
  delete process.env.ROUBO_USER_PLUGINS_DIR;
  if (sandboxRoot) {
    await rm(sandboxRoot, { recursive: true, force: true });
    sandboxRoot = undefined;
  }
});

describe("plugin log redaction", () => {
  it("redacts a bearer token from a logged host.fetch frame", async () => {
    const manager = await loadManagerWithEcho();
    const frame =
      '{"jsonrpc":"2.0","id":191,"method":"host.fetch","params":{"url":"https://api.github.com/user","init":{"method":"GET","headers":{"Accept":"application/vnd.github+json","Authorization":"Bearer gho_0123456789abcdefghijABCDEFGHIJ"}}}}';
    await manager.__test.appendLog("echo", "stderr", frame);

    const logs = await manager.readLogs("echo", "current", 100);
    const joined = logs.map((l) => l.text).join("\n");
    expect(joined).not.toContain("gho_0123456789abcdefghijABCDEFGHIJ");
    expect(joined).not.toContain("Bearer gho_");
    expect(joined).toContain('"Authorization":"[REDACTED]"');
    // The non-secret remainder of the frame still round-trips, so the log stays useful.
    expect(joined).toContain('"url":"https://api.github.com/user"');
  });

  it("still captures non-secret stderr lines verbatim", async () => {
    const manager = await loadManagerWithEcho();
    await manager.__test.appendLog("echo", "stderr", "fetched 12 issues in 240ms");

    const logs = await manager.readLogs("echo", "current", 100);
    expect(logs.some((l) => l.source === "stderr" && l.text === "fetched 12 issues in 240ms")).toBe(
      true,
    );
  });
});
