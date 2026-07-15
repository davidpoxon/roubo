// undici Authorization cross-origin redirect pinning suite (spike #552,
// CPHMTP-NFR-002).
//
// Pins, on the pinned Node version (.nvmrc) and the pinned npm undici
// (package.json), the redirect-time credential behaviour the guarded-fetch
// transport (#554) builds on. Findings live in the meta-repo at
// .specifications/component-plugins-hosted-marketplace-third-party/spikes/
// spike-552-undici-authorization-cross-origin.md.
//
// Assertions were authored failing-first from the WHATWG fetch expectation
// before any run was observed: if either transport forwarded Authorization
// across origins, the cross-origin cases here would fail and flip the spike
// decision to "manual stripping required".
//
// The suite drives real redirect chains through both fetch transports in the
// tree: Node's global fetch (the Node-bundled undici) and the npm undici fetch
// that plugin-installer.ts already uses. Two 127.0.0.1 loopback servers on
// distinct ports are distinct origins per the URL spec (scheme, host, port),
// so no external network is touched.
//
// What the suite demonstrates, per boundary:
//   - redirect-time: undici strips Authorization on a cross-origin redirect
//     and never re-attaches it, even when a later hop returns to the original
//     origin (the A -> B -> A chain).
//   - attach-time: undici sends whatever Authorization the caller sets, to any
//     origin. Attach-only-on-origin-equality is caller logic; guarded-fetch
//     must enforce it (CPHMTP-NFR-002).
//   - non-Authorization credentials: a custom header and a query-string token
//     both survive the cross-origin redirect, which is why the per-source
//     credential must travel as an Authorization header only.
//
// Run: npx vitest run server/services/undici-authorization-redirect.test.ts

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as npmUndiciFetch } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const AUTH = "Bearer spike-552-secret";
const API_KEY = "spike-552-api-key";

interface SeenRequest {
  origin: "A" | "B";
  path: string;
  authorization: string | undefined;
  xApiKey: string | undefined;
  query: string;
}

const seen: SeenRequest[] = [];
const origins = { A: "", B: "" };

let serverA: Server;
let serverB: Server;

/**
 * Both servers share one handler. Terminal paths record and return 200;
 * redirect paths record, then 302 to the next hop. The redirecting origin
 * controls the Location header, so a redirect can carry the incoming query
 * string onward (exactly what a hostile or compromised source would do to a
 * query-embedded token).
 */
function makeHandler(origin: "A" | "B") {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", origins[origin]);
    seen.push({
      origin,
      path: url.pathname,
      authorization: req.headers.authorization,
      xApiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
      query: url.search,
    });

    const redirectTargets: Record<string, string> = {
      // Same-origin hop: A -> A.
      "/same-origin-redirect": `${origins.A}/target`,
      // Cross-origin hop: A -> B, echoing the incoming query onward.
      "/cross-origin-redirect": `${origins.B}/target${url.search}`,
      // Chain A -> B -> A: the first hop leaves origin A ...
      "/chain-start": `${origins.B}/chain-middle`,
      // ... and the middle hop (on B) bounces back to A.
      "/chain-middle": `${origins.A}/chain-final`,
    };

    const location = redirectTargets[url.pathname];
    if (location) {
      res.writeHead(302, { location });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
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
  if (!match) {
    throw new Error(`no request recorded at origin ${origin} path ${path}`);
  }
  return match;
}

// Both undici transports present in the tree. plugin-installer.ts imports the
// npm undici fetch; Node's global fetch is the Node-bundled undici. The spike
// pins both so #554 may standardise on either without re-running the research.
const transports: [name: string, doFetch: typeof globalThis.fetch][] = [
  ["node-global-fetch (Node-bundled undici)", globalThis.fetch],
  [
    "npm-undici-fetch (plugin-installer transport)",
    npmUndiciFetch as unknown as typeof globalThis.fetch,
  ],
];

describe.each(transports)("%s", (_name, doFetch) => {
  it("preserves Authorization across a same-origin redirect", async () => {
    const res = await doFetch(`${origins.A}/same-origin-redirect`, {
      headers: { authorization: AUTH },
    });
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(at("A", "/same-origin-redirect").authorization).toBe(AUTH);
    expect(at("A", "/target").authorization).toBe(AUTH);
  });

  it("strips Authorization on a cross-origin redirect", async () => {
    const res = await doFetch(`${origins.A}/cross-origin-redirect`, {
      headers: { authorization: AUTH },
    });
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    // Sanity: the credential was attached on the pre-redirect hop ...
    expect(at("A", "/cross-origin-redirect").authorization).toBe(AUTH);
    // ... and the post-redirect cross-origin request carries none.
    expect(at("B", "/target").authorization).toBeUndefined();
  });

  it("never re-attaches Authorization after a cross-origin hop, even back on the original origin (A -> B -> A)", async () => {
    const res = await doFetch(`${origins.A}/chain-start`, {
      headers: { authorization: AUTH },
    });
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(at("A", "/chain-start").authorization).toBe(AUTH);
    expect(at("B", "/chain-middle").authorization).toBeUndefined();
    // Back on origin A: once stripped, the header stays gone. Re-attaching on
    // origin re-entry would hand the credential to whatever B redirects to.
    expect(at("A", "/chain-final").authorization).toBeUndefined();
  });

  it("attaches whatever Authorization the caller sets, to any origin (attach-time origin equality is caller logic)", async () => {
    // Origin B stands in for a non-source origin. undici performs no
    // attach-time origin check: the header the caller sets is the header sent.
    // The attach-only-on-origin-equality rule of CPHMTP-NFR-002 therefore
    // cannot be delegated to undici; guarded-fetch (#554) must enforce it.
    const res = await doFetch(`${origins.B}/target`, {
      headers: { authorization: AUTH },
    });
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(at("B", "/target").authorization).toBe(AUTH);
  });

  it("forwards a custom credential header and a query token across a cross-origin redirect", async () => {
    // undici's protection covers the Authorization header only. A credential
    // in a custom header follows the redirect to the foreign origin, and a
    // query-embedded token is visible to the redirecting origin, which can
    // propagate it onward in the Location it controls. Both leak; hence the
    // Authorization-header-only credential rule.
    const res = await doFetch(`${origins.A}/cross-origin-redirect?token=query-secret`, {
      headers: { authorization: AUTH, "x-api-key": API_KEY },
    });
    await res.arrayBuffer();

    expect(res.status).toBe(200);
    const crossOrigin = at("B", "/target");
    expect(crossOrigin.authorization).toBeUndefined();
    expect(crossOrigin.xApiKey).toBe(API_KEY);
    expect(crossOrigin.query).toBe("?token=query-secret");
  });
});
