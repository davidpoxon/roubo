import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import {
  registerHostHandlers,
  type CredentialStoreLike,
  type FsLike,
  type SpawnLike,
} from "./plugin-host-api.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";

function need<T>(value: T | undefined | null, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

interface ManifestOverrides {
  filesystemPaths?: string[];
  processes?: PluginManifest["permissions"]["processes"];
}

function makeManifest(
  slots: Array<{ slot: string; scope: "read" | "read-write" }>,
  networkOrOverrides: string[] | ManifestOverrides = [],
  overridesArg: ManifestOverrides = {},
): PluginManifest {
  const networkHosts: string[] = Array.isArray(networkOrOverrides) ? networkOrOverrides : [];
  const overrides: ManifestOverrides = Array.isArray(networkOrOverrides)
    ? overridesArg
    : networkOrOverrides;
  return {
    id: "jira-plugin",
    name: "Jira",
    version: "1.0.0",
    description: "Jira integration",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "dist/index.js",
    permissions: {
      network: { hosts: networkHosts },
      credentials: {
        slots: slots.map((s) => ({ ...s, description: `slot ${s.slot}` })),
      },
      filesystem: { paths: overrides.filesystemPaths ?? [] },
      processes: overrides.processes ?? false,
    },
  };
}

function makeRecord(manifest: PluginManifest, pluginDir = "/fake"): PluginRecord {
  return {
    id: manifest.id,
    manifest,
    manifestPath: path.join(pluginDir, "roubo-plugin.yaml"),
    pluginDir,
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 1234,
  };
}

function makeConnection(): JsonRpcConnection & {
  handlers: Map<string, (params: unknown) => unknown>;
  notifications: Map<string, (params: unknown) => void>;
} {
  const handlers = new Map<string, (params: unknown) => unknown>();
  const notifications = new Map<string, (params: unknown) => void>();
  return {
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
    onRequest: vi.fn((method: string, handler: (params: unknown) => unknown) => {
      handlers.set(method, handler);
    }),
    onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
      notifications.set(method, handler);
    }),
    onError: vi.fn(),
    onClose: vi.fn(),
    dispose: vi.fn(),
    handlers,
    notifications,
  } as unknown as JsonRpcConnection & {
    handlers: Map<string, (params: unknown) => unknown>;
    notifications: Map<string, (params: unknown) => void>;
  };
}

function makeStoreSpy(): CredentialStoreLike & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  deleteSlot: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(),
    set: vi.fn(),
    deleteSlot: vi.fn(),
  };
}

describe("plugin-host-api", () => {
  let logCalls: Array<["info" | "warn" | "error", string]>;

  beforeEach(() => {
    logCalls = [];
  });

  const log = (level: "info" | "warn" | "error", text: string) => {
    logCalls.push([level, text]);
  };

  describe("host.credentials.get (TC-070: slot-scope enforcement)", () => {
    it("denies a get for a slot not declared in the manifest, never reaching the store", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.get"), "host.credentials.get");
      await expect(handler({ slot: "github-token" })).rejects.toBeInstanceOf(ResponseError);

      try {
        await handler({ slot: "github-token" });
      } catch (err) {
        const ResponseErrorTyped = err as ResponseError<{
          code: string;
          category: string;
          slot: string;
          reason: string;
        }>;
        expect(ResponseErrorTyped.data).toEqual({
          code: "permission-denied",
          category: "credentials",
          slot: "github-token",
          reason: "slot-not-declared",
        });
      }

      expect(store.get).not.toHaveBeenCalled();
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            text.includes("jira-plugin.host.credentials.get") &&
            text.includes("github-token") &&
            text.includes("slot-not-declared"),
        ),
      ).toBe(true);
    });

    it("passes through to the store when the slot is declared", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      store.get.mockResolvedValue("secret-value");
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.get"), "host.credentials.get");
      const result = await handler({ slot: "jira-token" });
      expect(result).toBe("secret-value");
      expect(store.get).toHaveBeenCalledWith("jira-plugin", "jira-token");
    });

    it("rejects requests with a missing or empty slot parameter", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.get"), "host.credentials.get");
      await expect(handler({})).rejects.toBeInstanceOf(ResponseError);
      await expect(handler({ slot: "" })).rejects.toBeInstanceOf(ResponseError);
      expect(store.get).not.toHaveBeenCalled();
    });

    it("wraps credential-store errors as internal errors with the original code", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const storeErr = new Error("keyring went sideways");
      (storeErr as Error & { code: string }).code = "keyring-unavailable";
      store.get.mockRejectedValue(storeErr);
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.get"), "host.credentials.get");
      try {
        await handler({ slot: "jira-token" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ code: string }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.message).toBe("keyring went sideways");
        expect(responseErr.data).toEqual({ code: "keyring-unavailable" });
      }
    });
  });

  describe("host.credentials.set", () => {
    it("denies set when slot is not declared", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.set"), "host.credentials.set");
      try {
        await handler({ slot: "github-token", value: "x" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("slot-not-declared");
      }
      expect(store.set).not.toHaveBeenCalled();
    });

    it("denies set when scope is read-only", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.set"), "host.credentials.set");
      try {
        await handler({ slot: "jira-token", value: "x" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("scope-read-only");
      }
      expect(store.set).not.toHaveBeenCalled();
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            text.includes("jira-plugin.host.credentials.set") &&
            text.includes("scope-read-only"),
        ),
      ).toBe(true);
    });

    it("allows set when slot is declared with read-write scope", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      store.set.mockResolvedValue(undefined);
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.set"), "host.credentials.set");
      await expect(handler({ slot: "jira-token", value: "secret" })).resolves.toBeNull();
      expect(store.set).toHaveBeenCalledWith("jira-plugin", "jira-token", "secret");
    });
  });

  describe("host.credentials.delete", () => {
    it("denies delete when slot is not declared", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(
        connection.handlers.get("host.credentials.delete"),
        "host.credentials.delete",
      );
      try {
        await handler({ slot: "github-token" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("slot-not-declared");
      }
      expect(store.deleteSlot).not.toHaveBeenCalled();
    });

    it("denies delete when scope is read-only", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(
        connection.handlers.get("host.credentials.delete"),
        "host.credentials.delete",
      );
      try {
        await handler({ slot: "jira-token" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("scope-read-only");
      }
      expect(store.deleteSlot).not.toHaveBeenCalled();
    });

    it("calls store.deleteSlot when permitted", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      store.deleteSlot.mockResolvedValue(undefined);
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(
        connection.handlers.get("host.credentials.delete"),
        "host.credentials.delete",
      );
      await expect(handler({ slot: "jira-token" })).resolves.toBeNull();
      expect(store.deleteSlot).toHaveBeenCalledWith("jira-plugin", "jira-token");
    });
  });

  describe("host.fetch", () => {
    it("dispatches to the supplied fetcher and returns its result verbatim", async () => {
      const manifest = makeManifest([], ["api.example.com"]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fetcher = vi.fn().mockResolvedValue({
        status: 200,
        headers: { "content-type": "application/json", etag: "abc" },
        body: '{"ok":true}',
      });
      await registerHostHandlers(connection, makeRecord(manifest), log, { store, fetcher });

      const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
      const result = await handler({
        url: "https://api.example.com/me",
        init: { method: "GET", headers: { authorization: "Bearer t" } },
      });
      expect(result).toEqual({
        status: 200,
        headers: { "content-type": "application/json", etag: "abc" },
        body: '{"ok":true}',
      });
      expect(fetcher).toHaveBeenCalledWith("https://api.example.com/me", {
        method: "GET",
        headers: { authorization: "Bearer t" },
      });
    });

    it("rejects out-of-allowlist URLs with a structured network-denied error", async () => {
      const manifest = makeManifest([], ["api.example.com"]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      // Use the real fetcher so it enforces the allowlist; inject a stub fetch
      // that should never be called.
      const stubFetch = vi.fn();
      await registerHostHandlers(connection, makeRecord(manifest), log, {
        store,
        fetcher: (await import("./plugin-http.js")).createPluginFetcher(manifest, {
          fetchImpl: stubFetch as unknown as typeof globalThis.fetch,
        }),
      });

      const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
      try {
        await handler({ url: "https://blocked.example.com/anything", init: {} });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ code: string; host: string; reason: string }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.data?.code).toBe("network-denied");
        expect(responseErr.data?.host).toBe("blocked.example.com");
      }
      expect(stubFetch).not.toHaveBeenCalled();
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            text.includes("jira-plugin.host.fetch") &&
            text.includes("blocked.example.com"),
        ),
      ).toBe(true);
    });

    it("rejects invalid params with -32602 invalid-params", async () => {
      const manifest = makeManifest([], ["api.example.com"]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fetcher = vi.fn();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store, fetcher });

      const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
      await expect(handler({})).rejects.toBeInstanceOf(ResponseError);
      await expect(
        handler({ url: "https://api.example.com/", init: { method: 5 } }),
      ).rejects.toBeInstanceOf(ResponseError);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("wraps unexpected fetcher errors as internal errors", async () => {
      const manifest = makeManifest([], ["api.example.com"]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fetcher = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("dns failure"), { code: "ENOTFOUND" }));
      await registerHostHandlers(connection, makeRecord(manifest), log, { store, fetcher });

      const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
      try {
        await handler({ url: "https://api.example.com/", init: {} });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ code: string }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.message).toBe("dns failure");
        expect(responseErr.data?.code).toBe("ENOTFOUND");
      }
    });
  });

  describe("host.logger", () => {
    it("writes one log line per level for string payloads", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const info = need(connection.notifications.get("host.logger.info"), "host.logger.info");
      const warn = need(connection.notifications.get("host.logger.warn"), "host.logger.warn");
      const error = need(connection.notifications.get("host.logger.error"), "host.logger.error");

      info("started");
      warn("flaky");
      error("boom");

      expect(logCalls).toEqual([
        ["info", "started"],
        ["warn", "flaky"],
        ["error", "boom"],
      ]);
    });

    it("formats {message, data} payloads with the data JSON-encoded", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const info = need(connection.notifications.get("host.logger.info"), "host.logger.info");
      info({ message: "hit", data: { url: "https://example.com" } });

      expect(logCalls).toEqual([["info", 'hit {"url":"https://example.com"}']]);
    });
  });

  it("does not register handlers when the record has no manifest", async () => {
    const connection = makeConnection();
    const store = makeStoreSpy();
    await registerHostHandlers(
      connection,
      {
        id: "broken",
        manifest: null,
        manifestPath: "/x",
        pluginDir: "/x",
        source: "user",
        status: "invalid",
        lastError: { code: "invalid-manifest", message: "x" },
        restartHistory: [],
        pid: null,
      },
      log,
      { store },
    );
    expect(connection.handlers.size).toBe(0);
  });

  describe("host.fs.* (TC-080: filesystem confinement)", () => {
    let tmpDir: string;
    let outsideFile: string;

    function makeFsSpy(): FsLike & {
      readFile: ReturnType<typeof vi.fn>;
      writeFile: ReturnType<typeof vi.fn>;
      readdir: ReturnType<typeof vi.fn>;
      stat: ReturnType<typeof vi.fn>;
      mkdir: ReturnType<typeof vi.fn>;
    } {
      return {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        readdir: vi.fn(),
        stat: vi.fn(),
        mkdir: vi.fn(),
      };
    }

    beforeEach(async () => {
      tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "host-api-fs-")));
      outsideFile = path.join(os.tmpdir(), "exfiltrate-" + Date.now() + ".txt");
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outsideFile, { force: true });
    });

    it("denies host.fs.writeFile to a path outside the plugin directory (TC-080)", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy = makeFsSpy();
      await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
        store,
        fs: fsSpy,
      });

      const handler = need(connection.handlers.get("host.fs.writeFile"), "host.fs.writeFile");
      try {
        await handler({ path: outsideFile, data: "secret" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{
          code: string;
          category: string;
          path: string;
          reason: string;
        }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.data?.code).toBe("permission-denied");
        expect(responseErr.data?.category).toBe("filesystem");
        expect(responseErr.data?.reason).toBe("path-not-in-allowlist");
      }
      expect(fsSpy.writeFile).not.toHaveBeenCalled();
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            text.includes("jira-plugin.host.fs.writeFile") &&
            text.includes("path-not-in-allowlist"),
        ),
      ).toBe(true);
    });

    it("allows host.fs.writeFile to a path inside the plugin directory", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy = makeFsSpy();
      fsSpy.writeFile.mockResolvedValue(undefined);
      await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
        store,
        fs: fsSpy,
      });

      const handler = need(connection.handlers.get("host.fs.writeFile"), "host.fs.writeFile");
      const target = path.join(tmpDir, "ok.txt");
      await expect(handler({ path: target, data: "hello" })).resolves.toBeNull();
      expect(fsSpy.writeFile).toHaveBeenCalledWith(target, "hello", "utf8");
    });

    it("allows host.fs.readFile to a path inside a declared extra root", async () => {
      const extra = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "host-api-fs-extra-")),
      );
      try {
        const manifest = makeManifest([], { filesystemPaths: [extra] });
        const connection = makeConnection();
        const store = makeStoreSpy();
        const fsSpy = makeFsSpy();
        fsSpy.readFile.mockResolvedValue("payload");
        await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
          store,
          fs: fsSpy,
        });
        const handler = need(connection.handlers.get("host.fs.readFile"), "host.fs.readFile");
        const inside = path.join(extra, "data.json");
        await fs.writeFile(inside, "payload");
        await expect(handler({ path: inside })).resolves.toBe("payload");
        expect(fsSpy.readFile).toHaveBeenCalledWith(inside, "utf8");
      } finally {
        await fs.rm(extra, { recursive: true, force: true });
      }
    });

    it("denies host.fs.writeFile when data parameter is missing", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy = makeFsSpy();
      await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
        store,
        fs: fsSpy,
      });
      const handler = need(connection.handlers.get("host.fs.writeFile"), "host.fs.writeFile");
      await expect(
        handler({ path: path.join(tmpDir, "ok.txt") } as unknown as {
          path: string;
          data: string;
        }),
      ).rejects.toBeInstanceOf(ResponseError);
      expect(fsSpy.writeFile).not.toHaveBeenCalled();
    });

    it("denies host.fs.readdir on an out-of-scope path", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy = makeFsSpy();
      await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
        store,
        fs: fsSpy,
      });
      const handler = need(connection.handlers.get("host.fs.readdir"), "host.fs.readdir");
      await expect(handler({ path: "/etc" })).rejects.toBeInstanceOf(ResponseError);
      expect(fsSpy.readdir).not.toHaveBeenCalled();
    });

    it("denies host.fs.stat on an out-of-scope path", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy = makeFsSpy();
      await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
        store,
        fs: fsSpy,
      });
      const handler = need(connection.handlers.get("host.fs.stat"), "host.fs.stat");
      await expect(handler({ path: "/etc/passwd" })).rejects.toBeInstanceOf(ResponseError);
      expect(fsSpy.stat).not.toHaveBeenCalled();
    });

    it("denies host.fs.mkdir on an out-of-scope path", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy = makeFsSpy();
      await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
        store,
        fs: fsSpy,
      });
      const handler = need(connection.handlers.get("host.fs.mkdir"), "host.fs.mkdir");
      await expect(handler({ path: "/var/lib/jira-evil" })).rejects.toBeInstanceOf(ResponseError);
      expect(fsSpy.mkdir).not.toHaveBeenCalled();
    });

    it("returns a normalised stat shape for an allowed path", async () => {
      const manifest = makeManifest([]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy = makeFsSpy();
      fsSpy.stat.mockResolvedValue({
        size: 42,
        mtimeMs: 1700000000000,
        isFile: () => true,
        isDirectory: () => false,
      });
      await registerHostHandlers(connection, makeRecord(manifest, tmpDir), log, {
        store,
        fs: fsSpy,
      });
      const handler = need(connection.handlers.get("host.fs.stat"), "host.fs.stat");
      const target = path.join(tmpDir, "thing.txt");
      await fs.writeFile(target, "x");
      const result = await handler({ path: target });
      expect(result).toEqual({
        size: 42,
        isFile: true,
        isDirectory: false,
        mtimeMs: 1700000000000,
      });
    });
  });

  describe("host.process.spawn (processes enforcement)", () => {
    function makeFakeChild(): {
      child: import("node:child_process").ChildProcess;
      finish: (opts: {
        code: number;
        signal?: NodeJS.Signals | null;
        stdout?: string;
        stderr?: string;
      }) => void;
    } {
      const emitter = new EventEmitter() as unknown as import("node:child_process").ChildProcess & {
        stdout: EventEmitter & { setEncoding: (e: string) => void };
        stderr: EventEmitter & { setEncoding: (e: string) => void };
        stdin: { end: (data?: string) => void };
        kill: (signal?: NodeJS.Signals) => boolean;
        pid?: number;
      };
      const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
      stdout.setEncoding = () => {};
      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
      stderr.setEncoding = () => {};
      emitter.stdout = stdout;
      emitter.stderr = stderr;
      emitter.stdin = { end: () => {} };
      emitter.pid = 4321;
      emitter.kill = () => true;
      const finish = (opts: {
        code: number;
        signal?: NodeJS.Signals | null;
        stdout?: string;
        stderr?: string;
      }) => {
        if (opts.stdout) stdout.emit("data", opts.stdout);
        if (opts.stderr) stderr.emit("data", opts.stderr);
        emitter.emit("close", opts.code, opts.signal ?? null);
      };
      return { child: emitter, finish };
    }

    it("denies spawn when processes is false (manifest declared no executables)", async () => {
      const manifest = makeManifest([], { processes: false });
      const connection = makeConnection();
      const spawn: SpawnLike = vi.fn();
      await registerHostHandlers(connection, makeRecord(manifest), log, { spawn });
      const handler = need(connection.handlers.get("host.process.spawn"), "host.process.spawn");
      try {
        await handler({ executable: "rm", args: ["-rf", "/"] });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ category: string; reason: string }>;
        expect(responseErr.data?.category).toBe("processes");
        expect(responseErr.data?.reason).toBe("all-spawning-denied");
      }
      expect(spawn).not.toHaveBeenCalled();
    });

    it("denies spawn for an executable not in the declared list", async () => {
      const manifest = makeManifest([], { processes: { executables: ["git"] } });
      const connection = makeConnection();
      const spawn: SpawnLike = vi.fn();
      await registerHostHandlers(connection, makeRecord(manifest), log, { spawn });
      const handler = need(connection.handlers.get("host.process.spawn"), "host.process.spawn");
      await expect(handler({ executable: "curl" })).rejects.toBeInstanceOf(ResponseError);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("invokes the spawn implementation for a declared executable", async () => {
      const manifest = makeManifest([], { processes: { executables: ["git"] } });
      const connection = makeConnection();
      const { child, finish } = makeFakeChild();
      const spawn = vi.fn(() => child) as unknown as SpawnLike;
      await registerHostHandlers(connection, makeRecord(manifest), log, { spawn });
      const handler = need(connection.handlers.get("host.process.spawn"), "host.process.spawn");
      const promise = handler({ executable: "git", args: ["status"] });
      finish({ code: 0, stdout: "clean\n" });
      const result = await promise;
      expect(spawn).toHaveBeenCalledWith(
        "git",
        ["status"],
        expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
      );
      expect(result).toEqual(
        expect.objectContaining({ exitCode: 0, stdout: "clean\n", stderr: "", truncated: false }),
      );
    });
  });

  describe("cross-category enforcement (TC-070 re-check + WU-008 categories)", () => {
    it("denies undeclared credentials, fs, and processes calls in a single registration", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }], {
        filesystemPaths: [],
        processes: { executables: ["git"] },
      });
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fsSpy: FsLike = {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        readdir: vi.fn(),
        stat: vi.fn(),
        mkdir: vi.fn(),
      };
      const spawn: SpawnLike = vi.fn();
      await registerHostHandlers(connection, makeRecord(manifest, "/opt/plugins/jira"), log, {
        store,
        fs: fsSpy,
        spawn,
      });

      // (a) TC-070: credentials slot scoping still works
      const credGet = need(connection.handlers.get("host.credentials.get"), "host.credentials.get");
      try {
        await credGet({ slot: "github-token" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("slot-not-declared");
      }
      expect(store.get).not.toHaveBeenCalled();

      // (b) Filesystem path-not-in-allowlist
      const fsWrite = need(connection.handlers.get("host.fs.writeFile"), "host.fs.writeFile");
      try {
        await fsWrite({ path: "/tmp/leak.txt", data: "x" });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string; category: string }>;
        expect(responseErr.data?.category).toBe("filesystem");
        expect(responseErr.data?.reason).toBe("path-not-in-allowlist");
      }
      expect(fsSpy.writeFile as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

      // (c) Processes executable-not-declared
      const spawnHandler = need(
        connection.handlers.get("host.process.spawn"),
        "host.process.spawn",
      );
      try {
        await spawnHandler({ executable: "rm", args: ["-rf", "/"] });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string; category: string }>;
        expect(responseErr.data?.category).toBe("processes");
        expect(responseErr.data?.reason).toBe("executable-not-declared");
      }
      expect(spawn).not.toHaveBeenCalled();

      // All three denials logged with their respective method identifiers
      expect(logCalls.filter(([level]) => level === "warn").length).toBeGreaterThanOrEqual(3);
    });
  });
});
