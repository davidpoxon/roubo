// Guarded-fetch transport tests (issue #554, CPHMTP-NFR-002 / NFR-005 /
// FR-003). Two layers:
//
//   1. Pure guard-shape vectors lifted from the resolved spike #551 prototype
//      (.specifications/.../spikes/spike-551/url-guard-probe.mjs): encoding
//      variants of loopback / link-local / metadata all block un-consented, HARD
//      is un-overridable even when consented, SOFT is reachable only as the
//      consented origin, and the scheme policy (https always, http opt-in).
//   2. Live redirect chains over loopback node:http servers on distinct ports
//      (distinct origins per the URL spec, mirroring
//      undici-authorization-redirect.test.ts) that exercise the credential rule
//      (hybrid header formation, exact-origin attach, same-origin retention,
//      cross-origin strip + never-re-attach, Authorization-header-only) and the
//      SSRF / redirect guard (per-hop re-validation, later-hop metadata block
//      with zero requests to it, encoded-loopback redirect block, disallowed
//      scheme fail-closed, hop cap, DNS resolve-and-recheck).
//
// No external network: every live case runs against 127.0.0.1 servers, and the
// one DNS-rebinding case injects a fake resolver. Produces zero stdout/stderr.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, type Dispatcher, fetch as npmUndiciFetch } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DNS,
  GuardedFetchError,
  HARD,
  PUBLIC,
  SOFT,
  buildPinnedDispatcher,
  buildPinnedLookup,
  classifyHost,
  formAuthorization,
  guardedFetch,
  isRedirect,
  validateSourceUrl,
  type LookupFn,
} from "./guarded-fetch.js";

// ---------------------------------------------------------------------------
// Layer 1: pure guard-shape vectors (validateSourceUrl / formAuthorization).
// ---------------------------------------------------------------------------

const denyAll = { allowHttp: false, allowedOrigins: new Set<string>() };

describe("validateSourceUrl: encoding vectors block un-consented (spike #551 AC2)", () => {
  it("blocks every spelling of loopback 127.0.0.1 (SOFT), canonicalised to one host", () => {
    for (const url of [
      "https://127.0.0.1/catalog.json",
      "https://2130706433/catalog.json", // decimal
      "https://0177.0.0.1/catalog.json", // octal
      "https://0x7f000001/catalog.json", // hex
      "https://127.1/catalog.json", // short-form
    ]) {
      const v = validateSourceUrl(url, denyAll);
      expect(v.ok).toBe(false);
      expect(v.classification).toBe(SOFT);
      expect(v.host).toBe("127.0.0.1");
      expect(v.reason).toBe("soft-blocked-range-unconsented");
    }
  });

  it("blocks IPv6 loopback and IPv4-mapped IPv6 loopback (SOFT)", () => {
    for (const url of ["https://[::1]/catalog.json", "https://[::ffff:127.0.0.1]/catalog.json"]) {
      const v = validateSourceUrl(url, denyAll);
      expect(v.ok).toBe(false);
      expect(v.classification).toBe(SOFT);
    }
  });

  it("blocks cloud-metadata 169.254.169.254 (HARD), decimal and IPv4-mapped included", () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://2852039166/latest/meta-data/", // decimal 169.254.169.254
      "https://[::ffff:169.254.169.254]/latest/meta-data/",
    ]) {
      const v = validateSourceUrl(url, denyAll);
      expect(v.ok).toBe(false);
      expect(v.classification).toBe(HARD);
    }
    expect(validateSourceUrl("https://2852039166/x", denyAll).host).toBe("169.254.169.254");
  });

  it("blocks IPv4 and IPv6 link-local (HARD)", () => {
    expect(validateSourceUrl("https://169.254.1.1/x", denyAll).classification).toBe(HARD);
    expect(validateSourceUrl("https://[fe80::1]/x", denyAll).classification).toBe(HARD);
  });

  it("blocks IPv6 ULA fd00::/8 (SOFT) and RFC1918 private ranges (SOFT)", () => {
    expect(validateSourceUrl("https://[fd00::1]/x", denyAll).classification).toBe(SOFT);
    expect(validateSourceUrl("https://[fdff:1234:5678::1]/x", denyAll).classification).toBe(SOFT);
    for (const url of ["https://10.0.0.5/x", "https://172.16.4.4/x", "https://192.168.1.1/x"]) {
      const v = validateSourceUrl(url, denyAll);
      expect(v.ok).toBe(false);
      expect(v.classification).toBe(SOFT);
    }
  });
});

describe("validateSourceUrl: consent, HARD override, scheme policy (spike #551 AC1)", () => {
  it("allows a consented https public origin, blocks the same host un-consented", () => {
    const policy = {
      allowHttp: false,
      allowedOrigins: new Set(["https://marketplace.example.com"]),
    };
    const ok = validateSourceUrl("https://marketplace.example.com/catalog.json", policy);
    expect(ok.ok).toBe(true);
    expect(ok.reason).toBe("consented-origin");
    expect(validateSourceUrl("https://other.example.com/catalog.json", policy).ok).toBe(false);
  });

  it("permits a consented private/intranet origin only with the http opt-in (SOFT-consented)", () => {
    const policy = { allowHttp: true, allowedOrigins: new Set(["http://10.0.0.5:8443"]) };
    const v = validateSourceUrl("http://10.0.0.5:8443/catalog.json", policy);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("soft-range-consented-origin");
    // http without the opt-in is rejected even for a consented host.
    const noHttp = { allowHttp: false, allowedOrigins: new Set(["http://10.0.0.5:8443"]) };
    expect(validateSourceUrl("http://10.0.0.5:8443/catalog.json", noHttp).reason).toBe(
      "http-not-permitted",
    );
  });

  it("never lets consent override a HARD range", () => {
    const policy = { allowHttp: true, allowedOrigins: new Set(["http://169.254.169.254"]) };
    const v = validateSourceUrl("http://169.254.169.254/latest/meta-data/", policy);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("hard-blocked-range");
  });

  it("rejects non-http(s) schemes and allows a public/DNS redirect target without consent", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi"]) {
      expect(validateSourceUrl(url, { allowHttp: true, allowedOrigins: new Set() }).reason).toBe(
        "scheme-not-allowed",
      );
    }
    // hop > 0 (a redirect target) permits a public origin with no consent.
    const redirect = validateSourceUrl("https://cdn.example.net/blob", denyAll, { hop: 1 });
    expect(redirect.ok).toBe(true);
    expect(redirect.reason).toBe("public-redirect-target");
    // but the initial hop to the same un-consented origin is blocked.
    expect(validateSourceUrl("https://cdn.example.net/blob", denyAll, { hop: 0 }).ok).toBe(false);
  });

  it("classifies a DNS-name host as DNS and reports unparseable URLs", () => {
    expect(classifyHost(new URL("https://ghe.corp.example/")).kind).toBe(DNS);
    expect(validateSourceUrl("not a url", denyAll).reason).toBe("unparseable-url");
  });

  it("isRedirect recognises the redirect status set only", () => {
    for (const s of [301, 302, 303, 307, 308]) expect(isRedirect(s)).toBe(true);
    for (const s of [200, 201, 204, 304, 400, 404, 500]) expect(isRedirect(s)).toBe(false);
  });
});

describe("formAuthorization: hybrid header rule (CPHMTP-FR-003, TC-015 / TC-026 / TC-069)", () => {
  it("wraps a bare credential as Bearer <value>", () => {
    expect(formAuthorization("ghe_pat_abc")).toBe("Bearer ghe_pat_abc");
  });

  it("passes a recognised scheme prefix verbatim, never double-prefixed", () => {
    expect(formAuthorization("Bearer already")).toBe("Bearer already");
    expect(formAuthorization("Basic dXNlcjpwdw==")).toBe("Basic dXNlcjpwdw==");
    expect(formAuthorization("token ghp_classic")).toBe("token ghp_classic");
  });

  it("treats empty and whitespace-only credentials as no header", () => {
    expect(formAuthorization(undefined)).toBeNull();
    expect(formAuthorization("")).toBeNull();
    expect(formAuthorization("   ")).toBeNull();
  });

  it("only the exact-case prefixes are verbatim; other casings are Bearer-wrapped", () => {
    expect(formAuthorization("bearer x")).toBe("Bearer bearer x");
  });
});

// ---------------------------------------------------------------------------
// Layer 2: live loopback redirect chains (guardedFetch).
// ---------------------------------------------------------------------------

const BARE_CREDENTIAL = "ghe_pat_554";
const EXPECTED_AUTH = `Bearer ${BARE_CREDENTIAL}`;

interface SeenRequest {
  origin: "A" | "B";
  path: string;
  authorization: string | undefined;
  accept: string | undefined;
  cookie: string | undefined;
  referer: string | undefined;
  query: string;
  bodyLength: number;
}

const seen: SeenRequest[] = [];
const origins = { A: "", B: "" };
// A public-looking origin for server B. The SSRF guard blocks a loopback ->
// loopback cross-origin redirect (a SOFT un-consented target), which is correct:
// a real cross-origin hop from a source goes to a PUBLIC CDN. To exercise the
// credential-strip path against a guard-PERMITTED cross-origin hop we present
// server B under a public hostname (allowed as a redirect target) and route it
// back to loopback via routedFetch + publicLookup below.
let publicB = "";
const PUBLIC_B_HOST = "cdn.example.net";
// A discard port used as an un-consented loopback redirect target (decimal-encoded).
const UNCONSENTED_LOOPBACK = "http://2130706433:9/"; // 2130706433 -> 127.0.0.1

let serverA: Server;
let serverB: Server;

function makeHandler(origin: "A" | "B") {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", origins[origin]);
    let bodyLength = 0;
    req.on("data", (chunk: Buffer) => {
      bodyLength += chunk.length;
    });
    req.on("end", () => {
      seen.push({
        origin,
        path: url.pathname,
        authorization: req.headers.authorization,
        accept: req.headers.accept,
        cookie: typeof req.headers.cookie === "string" ? req.headers.cookie : undefined,
        referer: typeof req.headers.referer === "string" ? req.headers.referer : undefined,
        query: url.search,
        bodyLength,
      });

      const redirectTargets: Record<string, string> = {
        "/same-origin-redirect": `${origins.A}/target`,
        "/cross-origin-redirect": `${publicB}/target`,
        "/chain-start": `${publicB}/chain-middle`,
        "/chain-middle": `${origins.A}/chain-final`,
        "/metadata-hop1": `${origins.A}/metadata-hop2`,
        "/metadata-hop2": "http://169.254.169.254/latest/meta-data/iam/",
        "/encoded-loopback": UNCONSENTED_LOOPBACK,
        "/to-dns-redirect": "https://internal.example/x",
        "/to-ftp": "ftp://example.com/payload",
        "/loop-a": `${origins.A}/loop-b`,
        "/loop-b": `${origins.A}/loop-a`,
      };
      const location = redirectTargets[url.pathname];
      if (location) {
        res.writeHead(302, { location });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  serverA = createServer(makeHandler("A"));
  serverB = createServer(makeHandler("B"));
  origins.A = await listen(serverA);
  origins.B = await listen(serverB);
  publicB = origins.B.replace("127.0.0.1", PUBLIC_B_HOST);
});

afterAll(async () => {
  serverA.closeAllConnections();
  serverB.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => serverA.close(resolve)),
    new Promise((resolve) => serverB.close(resolve)),
  ]);
});

beforeEach(() => {
  seen.length = 0;
});

function at(origin: "A" | "B", path: string): SeenRequest {
  const match = seen.find((r) => r.origin === origin && r.path === path);
  if (!match) throw new Error(`no request recorded at origin ${origin} path ${path}`);
  return match;
}

// guardedFetch now defaults to npm undici's fetch (so the issue #590 connect-pin
// dispatcher is honoured); the download path uses npm undici too. The transports
// array still pins both node-global and npm-undici for the redirect parity cases
// (a redirect case per transport; those hops are IP literals, so no pin is
// attached and global fetch stays valid), while the credential-detail cases
// inject no fetchImpl and so run on the npm-undici-fetch default.
const transports: [name: string, doFetch: typeof globalThis.fetch][] = [
  ["node-global-fetch", globalThis.fetch],
  ["npm-undici-fetch", npmUndiciFetch as unknown as typeof globalThis.fetch],
];

async function drain(res: Response): Promise<void> {
  await res.arrayBuffer();
}

// Transport that maps the public hostname for server B back to loopback, so a
// guard-permitted PUBLIC cross-origin hop physically reaches the loopback server.
// Routes through npm undici's fetch (not Node's built-in global fetch) so a
// guarded hop carrying the issue #590 connect-pinning dispatcher, an npm undici
// Agent, dispatches on a protocol-compatible transport. The rewritten loopback
// literal means the pinned lookup is never consulted (an IP literal skips DNS).
const routedFetch: typeof globalThis.fetch = (input, init) => {
  const u = new URL(String(input));
  if (u.hostname === PUBLIC_B_HOST) u.hostname = "127.0.0.1";
  return (npmUndiciFetch as unknown as typeof globalThis.fetch)(u.toString(), init);
};

// Resolver that reports the public hostname as a public IP so the DNS
// resolve-and-recheck permits the cross-origin hop (deterministic, no real DNS).
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34" }];

describe("guardedFetch: credential attach and origin scoping (CPHMTP-NFR-002)", () => {
  it("attaches the hybrid Authorization header only on the exact source origin (TC-053 / TC-015)", async () => {
    const res = await guardedFetch(`${origins.A}/target`, {
      sourceOrigin: origins.A,
      credential: BARE_CREDENTIAL,
      allowHttp: true,
    });
    await drain(res);
    expect(res.status).toBe(200);
    expect(at("A", "/target").authorization).toBe(EXPECTED_AUTH);
  });

  it("retains the credential across a same-origin redirect (TC-064)", async () => {
    const res = await guardedFetch(`${origins.A}/same-origin-redirect`, {
      sourceOrigin: origins.A,
      credential: BARE_CREDENTIAL,
      allowHttp: true,
    });
    await drain(res);
    expect(res.status).toBe(200);
    expect(at("A", "/same-origin-redirect").authorization).toBe(EXPECTED_AUTH);
    expect(at("A", "/target").authorization).toBe(EXPECTED_AUTH);
  });

  it("strips the credential across a guard-permitted cross-origin redirect, never reaching a different origin (TC-052 / TC-053)", async () => {
    const res = await guardedFetch(`${origins.A}/cross-origin-redirect`, {
      sourceOrigin: origins.A,
      credential: BARE_CREDENTIAL,
      allowHttp: true,
      fetchImpl: routedFetch,
      lookup: publicLookup,
    });
    await drain(res);
    expect(res.status).toBe(200);
    // The credential rode the source-origin hop, but the different origin gets none.
    expect(at("A", "/cross-origin-redirect").authorization).toBe(EXPECTED_AUTH);
    expect(at("B", "/target").authorization).toBeUndefined();
  });

  it("never re-attaches the credential after leaving the source origin, even back on A (TC-052)", async () => {
    const res = await guardedFetch(`${origins.A}/chain-start`, {
      sourceOrigin: origins.A,
      credential: BARE_CREDENTIAL,
      allowHttp: true,
      fetchImpl: routedFetch,
      lookup: publicLookup,
    });
    await drain(res);
    expect(res.status).toBe(200);
    expect(at("A", "/chain-start").authorization).toBe(EXPECTED_AUTH);
    expect(at("B", "/chain-middle").authorization).toBeUndefined();
    // Sticky latch: once the chain left A for B, the return hop to A stays bare.
    expect(at("A", "/chain-final").authorization).toBeUndefined();
  });

  it("sends a recognised scheme prefix verbatim over the wire (TC-069 / TC-015)", async () => {
    for (const credential of ["Bearer verb_atim", "Basic dXNlcjpwdw==", "token ghp_x"]) {
      seen.length = 0;
      const res = await guardedFetch(`${origins.A}/target`, {
        sourceOrigin: origins.A,
        credential,
        allowHttp: true,
      });
      await drain(res);
      expect(at("A", "/target").authorization).toBe(credential);
    }
  });

  it("attaches no Authorization header for an empty or whitespace-only credential (TC-026)", async () => {
    for (const credential of ["", "   "]) {
      seen.length = 0;
      const res = await guardedFetch(`${origins.A}/target`, {
        sourceOrigin: origins.A,
        credential,
        allowHttp: true,
      });
      await drain(res);
      expect(at("A", "/target").authorization).toBeUndefined();
    }
  });

  it("places the credential only in Authorization, never in query / cookie / Referer / body (TC-071)", async () => {
    const res = await guardedFetch(`${origins.A}/target`, {
      sourceOrigin: origins.A,
      credential: BARE_CREDENTIAL,
      allowHttp: true,
    });
    await drain(res);
    const req = at("A", "/target");
    expect(req.authorization).toBe(EXPECTED_AUTH);
    expect(req.query).toBe("");
    expect(req.cookie).toBeUndefined();
    expect(req.referer).toBeUndefined();
    expect(req.bodyLength).toBe(0);
    for (const field of [req.query, req.cookie ?? "", req.referer ?? ""]) {
      expect(field.includes(BARE_CREDENTIAL)).toBe(false);
    }
  });
});

// A GHE Release-asset API endpoint negotiates content by Accept (returning JSON
// metadata instead of the asset's bytes unless the request carries the exact
// value `application/octet-stream`), which is why the artifact download needs to
// set it explicitly. Unlike the credential, Accept carries no secret, so it is
// deliberately NOT origin-scoped: it rides every hop, including a cross-origin
// redirect the credential is stripped from.
describe("guardedFetch: Accept header (marketplace GHE Release-asset download)", () => {
  it("sends the given Accept header on hop 0", async () => {
    const res = await guardedFetch(`${origins.A}/target`, {
      sourceOrigin: origins.A,
      allowHttp: true,
      accept: "application/octet-stream",
    });
    await drain(res);
    expect(at("A", "/target").accept).toBe("application/octet-stream");
  });

  it("retains the Accept header across a same-origin redirect", async () => {
    const res = await guardedFetch(`${origins.A}/same-origin-redirect`, {
      sourceOrigin: origins.A,
      allowHttp: true,
      accept: "application/octet-stream",
    });
    await drain(res);
    expect(at("A", "/same-origin-redirect").accept).toBe("application/octet-stream");
    expect(at("A", "/target").accept).toBe("application/octet-stream");
  });

  it("retains the Accept header across a guard-permitted cross-origin redirect (no secret to withhold)", async () => {
    const res = await guardedFetch(`${origins.A}/cross-origin-redirect`, {
      sourceOrigin: origins.A,
      allowHttp: true,
      accept: "application/octet-stream",
      fetchImpl: routedFetch,
      lookup: publicLookup,
    });
    await drain(res);
    expect(at("A", "/cross-origin-redirect").accept).toBe("application/octet-stream");
    expect(at("B", "/target").accept).toBe("application/octet-stream");
  });

  it("sets no Accept header itself when the option is omitted", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    await guardedFetch(`${origins.A}/target`, {
      sourceOrigin: origins.A,
      allowHttp: true,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });
    const init = fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.accept).toBeUndefined();
  });
});

describe("guardedFetch: SSRF / redirect guard (CPHMTP-NFR-005)", () => {
  it.each(transports)(
    "blocks a later redirect hop to cloud-metadata with zero requests to it (%s) (TC-054 / TC-063)",
    async (_name, doFetch) => {
      await expect(
        guardedFetch(`${origins.A}/metadata-hop1`, {
          sourceOrigin: origins.A,
          allowHttp: true,
          fetchImpl: doFetch,
        }),
      ).rejects.toMatchObject({ reason: "hard-blocked-range" });
      // The two same-origin hops ran; the metadata hop was rejected before connect.
      expect(at("A", "/metadata-hop1").path).toBe("/metadata-hop1");
      expect(at("A", "/metadata-hop2").path).toBe("/metadata-hop2");
      expect(seen.some((r) => r.path.includes("meta-data"))).toBe(false);
    },
  );

  it("blocks a decimal-encoded loopback redirect target on an un-consented origin (TC-070)", async () => {
    await expect(
      guardedFetch(`${origins.A}/encoded-loopback`, {
        sourceOrigin: origins.A,
        allowHttp: true,
      }),
    ).rejects.toMatchObject({ reason: "soft-blocked-range-unconsented" });
  });

  it("fails closed on a disallowed-scheme redirect target (TC-068)", async () => {
    await expect(
      guardedFetch(`${origins.A}/to-ftp`, { sourceOrigin: origins.A, allowHttp: true }),
    ).rejects.toMatchObject({ reason: "scheme-not-allowed" });
  });

  it("blocks a direct fetch to a HARD/SOFT literal before connecting (TC-062)", async () => {
    const fetchImpl = vi.fn();
    await expect(
      guardedFetch("http://169.254.169.254/latest/meta-data/", {
        sourceOrigin: "http://169.254.169.254",
        allowHttp: true,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ reason: "hard-blocked-range" });
    await expect(
      guardedFetch("http://127.0.0.1:9/x", {
        sourceOrigin: "https://marketplace.example.com",
        allowHttp: true,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ reason: "soft-blocked-range-unconsented" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects http without the opt-in and permits it with the opt-in (TC-104)", async () => {
    const fetchImpl = vi.fn();
    await expect(
      guardedFetch(`${origins.A}/target`, {
        sourceOrigin: origins.A,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ reason: "http-not-permitted" });
    expect(fetchImpl).not.toHaveBeenCalled();
    // With allowHttp the same consented loopback origin is reachable.
    const res = await guardedFetch(`${origins.A}/target`, {
      sourceOrigin: origins.A,
      allowHttp: true,
    });
    await drain(res);
    expect(res.status).toBe(200);
  });

  it("enforces the redirect hop cap as too-many-redirects", async () => {
    await expect(
      guardedFetch(`${origins.A}/loop-a`, {
        sourceOrigin: origins.A,
        allowHttp: true,
        maxHops: 2,
      }),
    ).rejects.toMatchObject({ reason: "too-many-redirects" });
  });

  it.each(transports)(
    "follows a benign same-origin redirect chain to 200 (%s positive control)",
    async (_name, doFetch) => {
      const res = await guardedFetch(`${origins.A}/same-origin-redirect`, {
        sourceOrigin: origins.A,
        allowHttp: true,
        fetchImpl: doFetch,
      });
      await drain(res);
      expect(res.status).toBe(200);
      expect(at("A", "/target").path).toBe("/target");
    },
  );
});

describe("guardedFetch: DNS resolve-and-recheck (issue #554 decision point)", () => {
  it("blocks a consented DNS origin that resolves to a cloud-metadata address (rebinding)", async () => {
    const fetchImpl = vi.fn();
    // The name is consented (it is the source origin), but it resolves into the
    // HARD metadata range: the recheck rejects before any connect.
    const lookup: LookupFn = async () => [{ address: "169.254.169.254" }];
    await expect(
      guardedFetch("https://ghe.corp.example/catalog.json", {
        sourceOrigin: "https://ghe.corp.example",
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        lookup,
      }),
    ).rejects.toMatchObject({ reason: "hard-blocked-range-resolved" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an un-consented redirect target whose DNS resolves into a private range", async () => {
    // hop 0 is the consented loopback source (IP literal, no lookup); it
    // redirects to a public-looking DNS target (hop > 0, un-consented) that
    // resolves to an RFC1918 address. The recheck blocks the rebind pivot before
    // connecting to the private host.
    const lookup: LookupFn = async (host) =>
      host === "internal.example" ? [{ address: "10.1.2.3" }] : [{ address: "93.184.216.34" }];
    await expect(
      guardedFetch(`${origins.A}/to-dns-redirect`, {
        sourceOrigin: origins.A,
        allowHttp: true,
        lookup,
      }),
    ).rejects.toMatchObject({ reason: "soft-blocked-range-resolved-unconsented" });
  });

  it("proceeds when resolution fails (adds no new failure, only blocks)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const lookup: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    const res = await guardedFetch("https://marketplace.example.com/catalog.json", {
      sourceOrigin: "https://marketplace.example.com",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      lookup,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exposes GuardedFetchError with a machine-readable reason and PUBLIC constant", () => {
    const err = new GuardedFetchError("hard-blocked-range", "blocked", "http://x/");
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe("hard-blocked-range");
    expect(err.url).toBe("http://x/");
    expect(PUBLIC).toBe("public");
  });
});

// ---------------------------------------------------------------------------
// Layer 3: pin the validated IP to the socket connect (issue #590). Closes the
// residual TOCTOU DNS-rebinding window by forcing the connect to the exact
// address that passed the range check. Deterministic and socket-free: the pin
// helper is exercised directly, and the wiring is asserted through the injected
// fetchImpl seam (no real DNS, no live connection).
// ---------------------------------------------------------------------------

// Resolve a pinned lookup's callback into a value, handling both node forms.
function lookupAll(
  lookup: ReturnType<typeof buildPinnedLookup>,
): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) =>
    lookup("pinned.example", { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses as { address: string; family: number }[]),
    ),
  );
}
function lookupSingle(
  lookup: ReturnType<typeof buildPinnedLookup>,
): Promise<[string, number | undefined]> {
  return new Promise((resolve, reject) =>
    lookup("pinned.example", {}, (err, address, family) =>
      err ? reject(err) : resolve([address as string, family]),
    ),
  );
}

describe("guardedFetch: pin the validated IP to the socket connect (issue #590)", () => {
  it("buildPinnedLookup answers only with the validated pinned addresses, correct family, both node forms", async () => {
    const lookup = buildPinnedLookup([
      { address: "93.184.216.34" },
      { address: "2606:2800:220:1:248:1893:25c8:1946" },
    ]);
    // The all:true form (node's autoSelectFamily path) returns the pinned array.
    expect(await lookupAll(lookup)).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    // The single-address form returns the first pinned address and its family.
    expect(await lookupSingle(lookup)).toEqual(["93.184.216.34", 4]);
  });

  it("buildPinnedDispatcher returns a fresh undici Agent (no live socket)", async () => {
    const dispatcher = buildPinnedDispatcher([{ address: "93.184.216.34" }]);
    expect(dispatcher).toBeInstanceOf(Agent);
    await dispatcher.close();
  });

  it("pins a validated DNS hop to its resolution via an init.dispatcher, no real DNS", async () => {
    let seenDispatcher: unknown = "unset";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenDispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher;
      return new Response("ok", { status: 200 });
    });
    const lookup: LookupFn = async () => [{ address: "93.184.216.34" }];
    const res = await guardedFetch("https://ghe.corp.example/catalog.json", {
      sourceOrigin: "https://ghe.corp.example",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      lookup,
    });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A pinned dispatcher rode the request, resolving the host to the validated IP.
    expect(seenDispatcher).toBeInstanceOf(Agent);
    expect(await lookupSingle(buildPinnedLookup([{ address: "93.184.216.34" }]))).toEqual([
      "93.184.216.34",
      4,
    ]);
    await (seenDispatcher as Dispatcher).close();
  });

  it("does not pin an IP-literal hop (no DNS step, no rebind window)", async () => {
    let seenDispatcher: unknown = "unset";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenDispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher;
      return new Response("ok", { status: 200 });
    });
    const res = await guardedFetch("http://127.0.0.1:9/x", {
      sourceOrigin: "http://127.0.0.1:9",
      allowHttp: true,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(seenDispatcher).toBeUndefined();
  });

  it("attaches no dispatcher when resolution fails (transport keeps its own connect, adds no failure)", async () => {
    let seenDispatcher: unknown = "unset";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenDispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher;
      return new Response("ok", { status: 200 });
    });
    const lookup: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    const res = await guardedFetch("https://marketplace.example.com/catalog.json", {
      sourceOrigin: "https://marketplace.example.com",
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      lookup,
    });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(seenDispatcher).toBeUndefined();
  });
});
