import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
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

// Self-signed cert for localhost, duplicated from plugin-http.test.ts (the
// canonical source). Embedded so the host.fetch TLS test stays hermetic.
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUPosJdCuLfd6fl3LABFNVrtdH/qEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUyMjAxMTIxNVoXDTQ2MDUx
NzAxMTIxNVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAuPA7SGGww1kmT5Sj+T3Wt8SO7TJykshg9Q2Ee+ZO1PI7
Ydl5bzSLeEFRDv7WF3V+F+GRnHnAZGS/G9i/kzErM6iG8Z2tS+7Qlr5N7/UnqvBa
J8duzY6lr39dbAhuWwmmLMg/Rhjpg5GhqpkvXMSPqhuptXhR1Ynue69rR9/BXrx2
0VFpuQ4qDjRURJp1emkTyXdVnB6/b27ks9zAD3QAnbwNW0YkOSm0RDp+7j4I0Qq/
YCzjCjp7Nr8nrrZV8CTyGSQSZXLBakaoDaWnxf6ddQXGHjAera5PyuudCUea55kB
tdTYOFRN2mtjr/rU604eSTuv+Q1bpy7gvtkXp3L9NwIDAQABo28wbTAdBgNVHQ4E
FgQUThsww/7O1n8SwzXr1B/6SDoECggwHwYDVR0jBBgwFoAUThsww/7O1n8SwzXr
1B/6SDoECggwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBALOBwa7WlV4fkJ2hQM8vSMFBcL2LLCyF
RmJib6qjtzgSIVcPxwo1oFLjB9vwcv20AgX+yyuds07W/nMR+okGNCMGPe3xkMKH
j/gMwP+iimIFIf/TrwkHzjAFwAEkdiX2BcBwnrXWdH7lAFEBf7F+MQL9NdZhufLd
s6ZgtjZpPmktkx46LahIoslfESPoaGxcu7s4HcRY7aaxCepiCBjh1jtPNXD7VD/o
2J1Cn9Os5G4j9CXAYUyYk+x+SD7F7QCsD7Skf27RqOcDhSRKGvh0MAUUmDiuPghD
Ptzk5Uu2BpPTQ+28UybneEjyjMe6g0INDs9pVy0MnoXkq/D9WqY9N4M=
-----END CERTIFICATE-----
`;

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC48DtIYbDDWSZP
lKP5Pda3xI7tMnKSyGD1DYR75k7U8jth2XlvNIt4QVEO/tYXdX4X4ZGcecBkZL8b
2L+TMSszqIbxna1L7tCWvk3v9Seq8Fonx27NjqWvf11sCG5bCaYsyD9GGOmDkaGq
mS9cxI+qG6m1eFHVie57r2tH38FevHbRUWm5DioONFREmnV6aRPJd1WcHr9vbuSz
3MAPdACdvA1bRiQ5KbREOn7uPgjRCr9gLOMKOns2vyeutlXwJPIZJBJlcsFqRqgN
pafF/p11BcYeMB6trk/K650JR5rnmQG11Ng4VE3aa2Ov+tTrTh5JO6/5DVunLuC+
2Rencv03AgMBAAECggEAU2pH0wX9LJ9xYEOzEiCKUKkfrm0qsHohAWbvctMWi4YW
srPcygPxRHRxk0nuVvZvwWXEv8dKt/2ZFX5WKpXq3ooNE74DBFTbUKLVlH4HPlra
z0Zs+9pzcQ0JnkjPPdDEWz6XC48BBI8TVFdzvWwLQLbpfSigAKkOIEunH+wU1B15
PU5T+6TqxNGsvsQj/L69dEEPCGtbL5pBBP0Bt1ISEfO+kzGLVKr7eeWcDQ6jBBrB
vlLDGvWE2xCpoHkk7wwV+cLaKzGyetsBi997dTPtBYEiqjt7+d76FfFG4anc/SLV
pxw6KUONbluk3EZd1ZS2V2CA8UEcsFpBUZVo45ygAQKBgQDfy2PM8RG1HjmJyQzF
/R3uVpXdhyN7HaxldIzqWnwdmNSfN06MVANOx0h4hp51MG23/9bczhDGdY+COpOc
fBbn7Xshyu2RfaXNotdTURvrYw4LIFbnyDigYI0d77tIgTwLY8vF99anG1spQcYw
9V2i8Cev3F9vw9ONY7ej9zu/NwKBgQDTjWE7+dyrcq2G7ZXWR7bcrQWbMg9CJV8j
3q3unHqKyYwuIeM8qkYyLTEFV6o+3ur9mRviOklwb8zgrj1rt2OPfUSVlTimW8ed
Ctcido28T8ivmZy+/Z0kZD48+oDDaKanqui0iLQMts82jSWoONgy6Xk4SQCptdja
Ai67mFWyAQKBgQCJyHIocl9BkFtCboqztvPfkmVwX0xD92/1gr1jZ9Q0cKyvXeC5
Wtwye1UuB0u1wNw8RYJmrWP8m9KADkplNKzxm++MTaDYS3ByW4iQnkY/NNwnk4CN
8WKTsv4O6VL3/8EVDhseRklc1uXYT8uSxu4gbBUzG82SRRGRYkxk4cliHwKBgEgZ
p0oJnmvQadPSpX6icnBDh+Wc6hZhJkvTWPQ54InspxoR8qB6Z/Ix9MMdXaiP0Qcd
Z6NyuhTYBbuNpuFPX19IElfow6XvIdkkGK5mOWg0yPEQKZvuU+BTSeL+fWQcBrCe
TzE4ZiTvKTAuaucqeIThja7hMpikoYOrusG06YABAoGALimUYUxOCmpU/4iTIK7a
lqjpW2C/97KzUYMrd4HSCYP2iktXFeM7pvTVdNVnnB2BjO/6NESp1Qqgaa7sVYZx
+skTS06/6uSTIHZ6SHmMDIMwQt8O83GqEsgusTR7jG1yhhw6d2oaM/HFNgyR/PEG
vcGapDyrafTKZgHDtXrKbLU=
-----END PRIVATE KEY-----
`;

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
      // Match the structured log line rather than substring-scanning for the
      // hostname; the regex anchors the host token between the literal `Host "`
      // prefix and `"` suffix our plugin-http allowlist message uses, which
      // avoids tripping the CodeQL "incomplete URL substring sanitization" rule
      // that fires on `.includes()` checks against URL-like strings.
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            /jira-plugin\.host\.fetch/.test(text) &&
            /Host "blocked\.example\.com"/.test(text),
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

    it("surfaces PluginUnsupportedResponseError as a structured unsupported-response error", async () => {
      const manifest = makeManifest([], ["api.example.com"]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const { PluginUnsupportedResponseError } = await import("./plugin-http.js");
      const fetcher = vi.fn().mockRejectedValue(
        new PluginUnsupportedResponseError({
          category: "network",
          host: "api.example.com",
          url: "https://api.example.com/avatar.png",
          contentType: "image/png",
          reason: 'host.fetch only supports textual content types; got "image/png"',
        }),
      );
      await registerHostHandlers(connection, makeRecord(manifest), log, { store, fetcher });

      const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
      try {
        await handler({ url: "https://api.example.com/avatar.png", init: {} });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{
          code: string;
          host: string;
          contentType: string | null;
          reason: string;
        }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.data?.code).toBe("unsupported-response");
        expect(responseErr.data?.host).toBe("api.example.com");
        expect(responseErr.data?.contentType).toBe("image/png");
      }
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            text.includes("jira-plugin.host.fetch unsupported-response") &&
            text.includes("image/png"),
        ),
      ).toBe(true);
    });

    it("rejects non-string body params with invalid-params", async () => {
      const manifest = makeManifest([], ["api.example.com"]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fetcher = vi.fn();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store, fetcher });

      const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
      try {
        await handler({
          url: "https://api.example.com/",
          init: { body: new Uint8Array([1, 2, 3]) },
        });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ code: string }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.data?.code).toBe("invalid-params");
      }
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("rejects non-boolean allowSelfSignedTls with invalid-params", async () => {
      const manifest = makeManifest([], ["api.example.com"]);
      const connection = makeConnection();
      const store = makeStoreSpy();
      const fetcher = vi.fn();
      await registerHostHandlers(connection, makeRecord(manifest), log, { store, fetcher });

      const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
      try {
        await handler({
          url: "https://api.example.com/",
          init: { allowSelfSignedTls: "yes" },
        });
        throw new Error("expected throw");
      } catch (err) {
        const responseErr = err as ResponseError<{ code: string }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.data?.code).toBe("invalid-params");
      }
      expect(fetcher).not.toHaveBeenCalled();
    });

    describe("self-signed TLS opt-in (issue #70)", () => {
      let server: https.Server;
      let port: number;
      beforeAll(async () => {
        server = https.createServer(
          { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
          (req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, path: req.url }));
          },
        );
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
      });
      afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      it("rejects self-signed TLS by default and accepts when init.allowSelfSignedTls is true", async () => {
        const manifest = makeManifest([], ["localhost"]);
        const connection = makeConnection();
        const store = makeStoreSpy();
        // No fetcher injected: registerHostHandlers builds the real strict +
        // lax pair so we exercise per-call dispatcher selection end-to-end.
        await registerHostHandlers(connection, makeRecord(manifest), log, { store });

        const handler = need(connection.handlers.get("host.fetch"), "host.fetch");
        const url = `https://localhost:${port}/x`;

        await expect(handler({ url, init: {} })).rejects.toBeDefined();

        const ok = (await handler({ url, init: { allowSelfSignedTls: true } })) as {
          status: number;
          body: string;
        };
        expect(ok.status).toBe(200);
        expect(JSON.parse(ok.body)).toEqual({ ok: true, path: "/x" });

        // Going back to default (no flag) still rejects: the strict fetcher is
        // not contaminated by the lax call.
        await expect(handler({ url, init: {} })).rejects.toBeDefined();
      });
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
