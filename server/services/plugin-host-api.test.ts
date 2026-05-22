import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import { registerHostHandlers, type CredentialStoreLike } from "./plugin-host-api.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";

function need<T>(value: T | undefined | null, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

function makeManifest(
  slots: Array<{ slot: string; scope: "read" | "read-write" }>,
): PluginManifest {
  return {
    id: "jira-plugin",
    name: "Jira",
    version: "1.0.0",
    description: "Jira integration",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "dist/index.js",
    permissions: {
      network: { hosts: [] },
      credentials: {
        slots: slots.map((s) => ({ ...s, description: `slot ${s.slot}` })),
      },
      filesystem: { paths: [] },
      processes: false,
    },
  };
}

function makeRecord(manifest: PluginManifest): PluginRecord {
  return {
    id: manifest.id,
    manifest,
    manifestPath: "/fake/roubo-plugin.yaml",
    pluginDir: "/fake",
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 1234,
  };
}

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
    onError: vi.fn(),
    onClose: vi.fn(),
    dispose: vi.fn(),
    handlers,
  } as unknown as JsonRpcConnection & {
    handlers: Map<string, (params: unknown) => unknown>;
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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(connection.handlers.get("host.credentials.get"), "host.credentials.get");
      const result = await handler({ slot: "jira-token" });
      expect(result).toBe("secret-value");
      expect(store.get).toHaveBeenCalledWith("jira-plugin", "jira-token");
    });

    it("rejects requests with a missing or empty slot parameter", async () => {
      const manifest = makeManifest([{ slot: "jira-token", scope: "read-write" }]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

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
      registerHostHandlers(connection, makeRecord(manifest), log, { store });

      const handler = need(
        connection.handlers.get("host.credentials.delete"),
        "host.credentials.delete",
      );
      await expect(handler({ slot: "jira-token" })).resolves.toBeNull();
      expect(store.deleteSlot).toHaveBeenCalledWith("jira-plugin", "jira-token");
    });
  });

  it("does not register handlers when the record has no manifest", () => {
    const connection = makeConnection();
    const store = makeStoreSpy();
    registerHostHandlers(
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
});
