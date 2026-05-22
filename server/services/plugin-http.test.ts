import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Agent, EnvHttpProxyAgent } from "undici";
import type { PluginManifest } from "@roubo/shared";
import {
  createPluginFetcher,
  PluginPermissionDeniedError,
  PluginUnsupportedResponseError,
  type PluginHttpLogLine,
} from "./plugin-http.js";

// Self-signed cert for localhost, generated at planning time. Used only by the
// TLS opt-in test. Embedded to keep the test hermetic (no openssl shellout).
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

function manifest(hosts: string[]): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test plugin",
    version: "0.0.1",
    description: "Test plugin",
    kind: "integration",
    roubo: "1.0.0",
    entry: "index.js",
    permissions: {
      network: { hosts },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
  };
}

interface RunningServer<T extends http.Server | https.Server> {
  server: T;
  port: number;
  url: (path: string, hostname?: string) => string;
}

async function startHttpServer(handler: http.RequestListener): Promise<RunningServer<http.Server>> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: (path, hostname = "127.0.0.1") => `http://${hostname}:${port}${path}`,
  };
}

async function startHttpsServer(
  handler: http.RequestListener,
): Promise<RunningServer<https.Server>> {
  const server = https.createServer({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: (path, hostname = "127.0.0.1") => `https://${hostname}:${port}${path}`,
  };
}

function closeServer(s: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

describe("createPluginFetcher: allowlist enforcement", () => {
  it("rejects URLs whose host is not in network.hosts", async () => {
    const logger = vi.fn<(line: PluginHttpLogLine) => void>();
    const fetchImpl = vi.fn(async () => new Response());
    const fetcher = createPluginFetcher(manifest(["api.github.com"]), {
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(fetcher("https://example.com/secret")).rejects.toBeInstanceOf(
      PluginPermissionDeniedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledTimes(1);
    const call = logger.mock.calls[0];
    if (!call) throw new Error("logger not called");
    const line = call[0];
    expect(line.level).toBe("warn");
    expect(line.kind).toBe("denied");
    expect(line.detail).toMatchObject({
      category: "network",
      host: "example.com",
      url: "https://example.com/secret",
    });
  });

  it("rejects invalid URL strings without attempting fetch", async () => {
    const fetchImpl = vi.fn();
    const fetcher = createPluginFetcher(manifest(["*"]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(fetcher("not a url")).rejects.toBeInstanceOf(PluginPermissionDeniedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("matches single-label glob (*.atlassian.net)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const fetcher = createPluginFetcher(manifest(["*.atlassian.net"]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(fetcher("https://acme.atlassian.net/rest/api")).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(fetcher("https://atlassian.net/rest/api")).rejects.toBeInstanceOf(
      PluginPermissionDeniedError,
    );
    await expect(fetcher("https://evil.com/")).rejects.toBeInstanceOf(PluginPermissionDeniedError);
    // Single-label glob does not match deeper subdomains.
    await expect(fetcher("https://a.b.atlassian.net/")).rejects.toBeInstanceOf(
      PluginPermissionDeniedError,
    );
  });

  it("matches multi-label glob (**.atlassian.net)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const fetcher = createPluginFetcher(manifest(["**.atlassian.net"]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(fetcher("https://a.b.atlassian.net/x")).resolves.toBeDefined();
  });

  it("matches host comparisons case-insensitively", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const fetcher = createPluginFetcher(manifest(["API.GitHub.com"]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(fetcher("https://api.github.com/")).resolves.toBeDefined();
  });
});

describe("createPluginFetcher: dispatcher selection", () => {
  it("uses EnvHttpProxyAgent by default", async () => {
    let captured: unknown = undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      captured = (init as { dispatcher?: unknown }).dispatcher;
      return new Response("ok", { status: 200 });
    });
    const fetcher = createPluginFetcher(manifest(["api.github.com"]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fetcher("https://api.github.com/x");
    expect(captured).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("uses a self-signed-tolerant Agent when allowSelfSignedTls is true", async () => {
    let captured: unknown = undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      captured = (init as { dispatcher?: unknown }).dispatcher;
      return new Response("ok", { status: 200 });
    });
    const fetcher = createPluginFetcher(manifest(["api.github.com"]), {
      allowSelfSignedTls: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fetcher("https://api.github.com/x");
    expect(captured).toBeInstanceOf(Agent);
    expect(captured).not.toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("builds independent dispatchers per fetcher instance", async () => {
    const captures: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      captures.push((init as { dispatcher?: unknown }).dispatcher);
      return new Response("ok", { status: 200 });
    });
    const a = createPluginFetcher(manifest(["api.github.com"]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const b = createPluginFetcher(manifest(["api.github.com"]), {
      allowSelfSignedTls: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await a("https://api.github.com/x");
    await b("https://api.github.com/y");
    expect(captures[0]).not.toBe(captures[1]);
    expect(captures[0]).toBeInstanceOf(EnvHttpProxyAgent);
    expect(captures[1]).toBeInstanceOf(Agent);
  });
});

describe("createPluginFetcher: response surfacing", () => {
  let serverInfo: RunningServer<http.Server>;
  beforeAll(async () => {
    serverInfo = await startHttpServer((req, res) => {
      if (req.url === "/cache-headers") {
        res.setHeader("ETag", '"abc123"');
        res.setHeader("Retry-After", "42");
        res.setHeader("X-RateLimit-Remaining", "4999");
        res.setHeader("X-RateLimit-Reset", "1700000000");
        res.setHeader("X-GitHub-Request-Id", "deadbeef");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/multi-cookie") {
        res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
        res.setHeader("Content-Type", "text/plain");
        res.end("ok");
        return;
      }
      if (req.url === "/png") {
        res.setHeader("Content-Type", "image/png");
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        return;
      }
      if (req.url === "/empty-text") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("hello");
        return;
      }
      if (req.url === "/echo-method") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ method: req.method ?? null }));
        return;
      }
      if (req.url === "/hal-json") {
        res.setHeader("Content-Type", "application/hal+json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  afterAll(async () => {
    await closeServer(serverInfo.server);
  });

  it("surfaces ETag, Retry-After and X-RateLimit-* verbatim with lowercased keys", async () => {
    const fetcher = createPluginFetcher(manifest(["127.0.0.1"]));
    const result = await fetcher(serverInfo.url("/cache-headers"));

    expect(result.status).toBe(200);
    expect(result.headers["etag"]).toBe('"abc123"');
    expect(result.headers["retry-after"]).toBe("42");
    expect(result.headers["x-ratelimit-remaining"]).toBe("4999");
    expect(result.headers["x-ratelimit-reset"]).toBe("1700000000");
    expect(result.headers["x-github-request-id"]).toBe("deadbeef");
    // No upper-cased duplicates leaked through.
    expect(result.headers["ETag"]).toBeUndefined();
  });

  it("preserves multiple Set-Cookie headers as an array", async () => {
    const fetcher = createPluginFetcher(manifest(["127.0.0.1"]));
    const result = await fetcher(serverInfo.url("/multi-cookie"));
    expect(Array.isArray(result.headers["set-cookie"])).toBe(true);
    expect(result.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("returns a string body for JSON responses", async () => {
    const fetcher = createPluginFetcher(manifest(["127.0.0.1"]));
    const result = await fetcher(serverInfo.url("/cache-headers"));
    expect(typeof result.body).toBe("string");
    expect(JSON.parse(result.body as string)).toEqual({ ok: true });
  });

  it("returns a string body for application/*+json", async () => {
    const fetcher = createPluginFetcher(manifest(["127.0.0.1"]));
    const result = await fetcher(serverInfo.url("/hal-json"));
    expect(typeof result.body).toBe("string");
  });

  it("rejects non-textual responses with an unsupported-response error", async () => {
    const logger = vi.fn<(line: PluginHttpLogLine) => void>();
    const fetcher = createPluginFetcher(manifest(["127.0.0.1"]), { logger });
    await expect(fetcher(serverInfo.url("/png"))).rejects.toBeInstanceOf(
      PluginUnsupportedResponseError,
    );
    try {
      await fetcher(serverInfo.url("/png"));
    } catch (err) {
      const e = err as PluginUnsupportedResponseError;
      expect(e.code).toBe("unsupported-response");
      expect(e.contentType).toBe("image/png");
      expect(e.host).toBe("127.0.0.1");
    }
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", kind: "unsupported-response" }),
    );
  });

  it("forwards method and headers from init", async () => {
    const fetcher = createPluginFetcher(manifest(["127.0.0.1"]));
    const result = await fetcher(serverInfo.url("/echo-method"), { method: "POST" });
    expect(JSON.parse(result.body as string)).toEqual({ method: "POST" });
  });

  it("does not invoke the denial logger on successful requests", async () => {
    const logger = vi.fn<(line: PluginHttpLogLine) => void>();
    const fetcher = createPluginFetcher(manifest(["127.0.0.1"]), { logger });
    await fetcher(serverInfo.url("/empty-text"));
    expect(logger).not.toHaveBeenCalled();
  });
});

describe("createPluginFetcher: self-signed TLS opt-in (TC-010)", () => {
  let tls: RunningServer<https.Server>;
  beforeAll(async () => {
    tls = await startHttpsServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  afterAll(async () => {
    await closeServer(tls.server);
  });

  it("rejects self-signed certs by default", async () => {
    const fetcher = createPluginFetcher(manifest(["localhost"]));
    await expect(fetcher(tls.url("/x", "localhost"))).rejects.toBeDefined();
  });

  it("accepts self-signed certs when allowSelfSignedTls is true", async () => {
    const fetcher = createPluginFetcher(manifest(["localhost"]), {
      allowSelfSignedTls: true,
    });
    const result = await fetcher(tls.url("/x", "localhost"));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ ok: true, path: "/x" });
  });

  it("toggling self-signed TLS on one fetcher does not affect another", async () => {
    const strict = createPluginFetcher(manifest(["localhost"]));
    const lax = createPluginFetcher(manifest(["localhost"]), { allowSelfSignedTls: true });
    await expect(strict(tls.url("/strict", "localhost"))).rejects.toBeDefined();
    const ok = await lax(tls.url("/lax", "localhost"));
    expect(ok.status).toBe(200);
  });
});

describe("PluginPermissionDeniedError", () => {
  it("carries a structured shape suitable for the RPC envelope", () => {
    const err = new PluginPermissionDeniedError({
      category: "network",
      host: "evil.com",
      url: "https://evil.com/",
      reason: "not in allowlist",
    });
    expect(err.code).toBe("permission-denied");
    expect(err.category).toBe("network");
    expect(err.host).toBe("evil.com");
    expect(err.url).toBe("https://evil.com/");
    expect(err.reason).toBe("not in allowlist");
    expect(err.name).toBe("PluginPermissionDeniedError");
  });
});
