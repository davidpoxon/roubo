import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetch as undiciFetch } from "undici";
import type { MarketplaceSource } from "@roubo/shared";

// Regression test for the root cause of "a third-party marketplace source never loads":
// guardedFetch attaches a DNS-pinned-connect dispatcher built from npm undici (issue
// #590) as `init.dispatcher`. Only npm undici's fetch honours a foreign dispatcher;
// Node's built-in global fetch bundles a DIFFERENT undici major that rejects it with
// `UND_ERR_INVALID_ARG`. createThirdPartyCatalogClient's default transport must
// therefore be npm undici's fetch (mirroring createCatalogClient's first-party
// default), never `globalThis.fetch`, or every DNS-hostname source (i.e. every real
// one) silently fails and degrades to an empty "unavailable" listing.
//
// Deliberately a SEPARATE file from third-party-catalog-client.test.ts: every test
// there injects its own `fetchImpl` fake, so none of them exercise (or would catch a
// regression in) the PRODUCTION default. Mocking guarded-fetch.js here to capture the
// transport it actually receives isolates that one check, network-free and
// keychain-free, without disturbing the real-guardedFetch behavioural coverage in the
// sibling suite (which mocking guardedFetch file-wide would otherwise break).
const guardedFetchMock = vi.hoisted(() => vi.fn());
vi.mock("./guarded-fetch.js", () => ({ guardedFetch: guardedFetchMock }));

const stateMock = vi.hoisted(() => ({ rouboDir: "" }));
vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return { ...actual, getRouboDir: () => stateMock.rouboDir };
});

import { createThirdPartyCatalogClient } from "./catalog-client.js";

function makeSource(overrides: Partial<MarketplaceSource> = {}): MarketplaceSource {
  return {
    id: "acme",
    url: "https://example.invalid/acme/catalog.json",
    unsigned: true,
    hasCredential: false,
    allowHttp: false,
    registeredAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

let rouboBase: string;

beforeEach(async () => {
  rouboBase = await mkdtemp(path.join(tmpdir(), "roubo-3p-transport-"));
  stateMock.rouboDir = rouboBase;
  guardedFetchMock.mockReset();
  guardedFetchMock.mockResolvedValue(
    new Response(JSON.stringify({ entries: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

afterEach(async () => {
  await rm(rouboBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("createThirdPartyCatalogClient default transport", () => {
  it("defaults to npm undici's fetch, never globalThis.fetch, when no fetchImpl is injected", async () => {
    const client = createThirdPartyCatalogClient(makeSource(), { log: vi.fn() });
    await client.getCatalog({ forceRefresh: true });

    expect(guardedFetchMock).toHaveBeenCalledTimes(1);
    const [, options] = guardedFetchMock.mock.calls[0] as [string, { fetchImpl?: typeof fetch }];
    // Strict reference equality: must be the SAME undici fetch export catalog-client.ts
    // imports, not Node's built-in global fetch (a different, incompatible undici major).
    expect(options.fetchImpl).toBe(undiciFetch);
    expect(options.fetchImpl).not.toBe(globalThis.fetch);
  });

  it("still prefers an injected fetchImpl over the default", async () => {
    const injected = vi.fn() as unknown as typeof fetch;
    const client = createThirdPartyCatalogClient(makeSource(), {
      log: vi.fn(),
      fetchImpl: injected,
    });
    await client.getCatalog({ forceRefresh: true });

    const [, options] = guardedFetchMock.mock.calls[0] as [string, { fetchImpl?: typeof fetch }];
    expect(options.fetchImpl).toBe(injected);
  });
});
