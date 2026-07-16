import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// In-memory keyring shared across module resets so the OS keychain is never
// touched in tests. Hoisted so the vi.mock factory (also hoisted) can close over
// it, and stable across vi.resetModules() so a simulated restart keeps its
// credentials.
const keyring = vi.hoisted(() => new Map<string, string>());

vi.mock("./credential-store.js", () => ({
  set: vi.fn(async (pluginId: string, slot: string, value: string) => {
    keyring.set(`${pluginId}/${slot}`, value);
  }),
  deleteSlot: vi.fn(async (pluginId: string, slot: string) => {
    keyring.delete(`${pluginId}/${slot}`);
  }),
  get: vi.fn(async (pluginId: string, slot: string) => keyring.get(`${pluginId}/${slot}`) ?? null),
}));

let sandboxRoot: string;
let originalHome: string | undefined;
let originalProduction: string | undefined;
let mod: typeof import("./marketplace-sources-state.js");

async function freshImport(): Promise<typeof import("./marketplace-sources-state.js")> {
  vi.resetModules();
  return await import("./marketplace-sources-state.js");
}

beforeEach(async () => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), "roubo-marketplace-sources-"));
  originalHome = process.env.HOME;
  originalProduction = process.env.ROUBO_PRODUCTION;
  process.env.HOME = sandboxRoot;
  process.env.ROUBO_PRODUCTION = "1";
  keyring.clear();
  vi.clearAllMocks();
  mod = await freshImport();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProduction === undefined) delete process.env.ROUBO_PRODUCTION;
  else process.env.ROUBO_PRODUCTION = originalProduction;
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function statePath(): string {
  return path.join(sandboxRoot, ".roubo", "marketplace-sources.json");
}

const URL_A = "https://marketplace.example.com/catalog.json";
const URL_B = "https://plugins.internal.example.org/catalog.json";

describe("loadSourcesState", () => {
  it("returns null when the file is absent", () => {
    expect(mod.loadSourcesState()).toBeNull();
  });

  it("backs up an invalid-JSON file and recovers to last-known", async () => {
    await mod.addSource({ url: URL_A });
    fs.writeFileSync(statePath(), "{ not json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = mod.loadSourcesState();
    warn.mockRestore();
    expect(loaded?.sources[0].url).toBe(URL_A);
    const broken = fs
      .readdirSync(path.dirname(statePath()))
      .filter((f) => f.startsWith("marketplace-sources.json.broken-"));
    expect(broken.length).toBe(1);
  });
});

describe("listSourceSummaries", () => {
  it("lists the built-in first-party source, which is present by default", () => {
    const summaries = mod.listSourceSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(mod.FIRST_PARTY_SOURCE_ID);
    expect(summaries[0].hasCredential).toBe(false);
  });

  it("appends registered third-party sources after the first-party row", async () => {
    await mod.addSource({ url: URL_A });
    const summaries = mod.listSourceSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].id).toBe(mod.FIRST_PARTY_SOURCE_ID);
    expect(summaries[1].url).toBe(URL_A);
    // The API projection never carries the credential or registration internals.
    expect(Object.keys(summaries[1]).sort()).toEqual(
      ["hasCredential", "id", "registeredAt", "url"].sort(),
    );
  });
});

describe("addSource", () => {
  it("persists a fresh row that survives a restart", async () => {
    const result = await mod.addSource({ url: URL_A });
    expect(result.outcome).toBe("created");

    // Simulate a restart: reset modules (clears the in-process cache) and reload.
    const restarted = await freshImport();
    const loaded = restarted.loadSourcesState();
    expect(loaded?.sources).toHaveLength(1);
    expect(loaded?.sources[0].url).toBe(URL_A);
    expect(loaded?.sources[0].unsigned).toBe(true);
  });

  it("stores an optional credential in the keyring, never in plaintext on disk", async () => {
    const secret = "ghp_supersecrettoken_1234567890";
    const result = await mod.addSource({ url: URL_A, credential: secret });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.source.hasCredential).toBe(true);

    // Stored in the keyring under account `source:<id>/token`.
    const id = result.source.id;
    expect(keyring.get(`source:${id}/token`)).toBe(secret);

    // Not on disk: the row carries only the boolean.
    const onDisk = fs.readFileSync(statePath(), "utf-8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain('"hasCredential": true');
  });

  it("registers without a credential (hasCredential false, keyring untouched)", async () => {
    const credStore = await import("./credential-store.js");
    const result = await mod.addSource({ url: URL_A });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.source.hasCredential).toBe(false);
    expect(credStore.set).not.toHaveBeenCalled();
    expect(keyring.size).toBe(0);
  });

  it("performs a pure write with no network call to the candidate URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await mod.addSource({ url: URL_A, credential: "tok" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a malformed URL, a non-http(s) scheme, and http without allowHttp", async () => {
    expect((await mod.addSource({ url: "not a url" })).outcome).toBe("invalid-url");
    expect((await mod.addSource({ url: "ftp://example.com/catalog.json" })).outcome).toBe(
      "invalid-url",
    );
    expect((await mod.addSource({ url: "http://intranet.local/catalog.json" })).outcome).toBe(
      "invalid-url",
    );
    expect((await mod.addSource({ url: 42 as unknown as string })).outcome).toBe("invalid-url");
    // Nothing was persisted for any rejected candidate.
    expect(mod.listSources()).toHaveLength(0);
  });

  it("allows an http URL when allowHttp is set", async () => {
    const result = await mod.addSource({
      url: "http://intranet.local/catalog.json",
      allowHttp: true,
    });
    expect(result.outcome).toBe("created");
    expect(mod.listSources()[0].allowHttp).toBe(true);
  });

  it("re-registering the same URL replaces the credential without a second entry", async () => {
    const first = await mod.addSource({ url: URL_A, credential: "first-token" });
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    const originalRegisteredAt = first.source.registeredAt;
    const id = first.source.id;

    const again = await mod.addSource({ url: URL_A, credential: "second-token" });
    expect(again.outcome).toBe("replaced");
    if (again.outcome !== "replaced") return;

    // No second entry; same id; original consent timestamp preserved.
    expect(mod.listSources()).toHaveLength(1);
    expect(again.source.id).toBe(id);
    expect(again.source.registeredAt).toBe(originalRegisteredAt);
    // Keyring now holds the replacement credential.
    expect(keyring.get(`source:${id}/token`)).toBe("second-token");
  });

  it("generates a deterministic, keyring-safe slug id from the URL", async () => {
    const r1 = await mod.addSource({ url: URL_A });
    const restarted = await freshImport();
    // Re-deriving the id for the same URL is stable (duplicate detection relies
    // on it). Add a distinct URL and confirm a different id.
    const r2 = await restarted.addSource({ url: URL_B });
    expect(r1.outcome).toBe("created");
    expect(r2.outcome).toBe("created");
    if (r1.outcome !== "created" || r2.outcome !== "created") return;
    expect(r1.source.id).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(r2.source.id).not.toBe(r1.source.id);
    expect(r1.source.id).not.toBe(restarted.FIRST_PARTY_SOURCE_ID);
  });

  it("refuses to register the built-in first-party URL as a third-party source", async () => {
    // A well-formed URL, but reserved: registering it would otherwise surface a
    // removable unsigned duplicate of the non-removable built-in in GET /sources.
    const firstPartyUrl = mod.listSourceSummaries()[0].url;
    const result = await mod.addSource({ url: firstPartyUrl });
    expect(result.outcome).toBe("invalid-url");
    expect(mod.listSources()).toHaveLength(0);
  });
});

// Issue #557: the read counterpart of the private storeCredential. A credentialed
// source is unlistable without its token, so the multi-source listing fan-out
// reads it here and hands it to that source's catalog client.
describe("readSourceCredential", () => {
  it("reads back the credential a registration stored, from the keyring account", async () => {
    const credStore = await import("./credential-store.js");
    const secret = "ghp_multi_source_token";
    const result = await mod.addSource({ url: URL_A, credential: secret });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;

    await expect(mod.readSourceCredential(result.source.id)).resolves.toBe(secret);
    // Read from the namespaced account the row was written under: the `source:`
    // prefix keeps it from colliding with a plugin id's slot.
    expect(credStore.get).toHaveBeenCalledWith(`source:${result.source.id}`, "token");
  });

  it("returns null for a source registered without a credential", async () => {
    const result = await mod.addSource({ url: URL_A });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    await expect(mod.readSourceCredential(result.source.id)).resolves.toBeNull();
  });

  it("reads back the replacement after a credential rotation", async () => {
    await mod.addSource({ url: URL_A, credential: "old-token" });
    const rotated = await mod.addSource({ url: URL_A, credential: "new-token" });
    expect(rotated.outcome).toBe("replaced");
    if (rotated.outcome !== "replaced") return;
    await expect(mod.readSourceCredential(rotated.source.id)).resolves.toBe("new-token");
  });
});

describe("removeSource", () => {
  it("refuses to remove the built-in first-party source", async () => {
    const result = await mod.removeSource(mod.FIRST_PARTY_SOURCE_ID);
    expect(result).toBe("first-party");
    // Still present.
    expect(mod.listSourceSummaries().some((s) => s.id === mod.FIRST_PARTY_SOURCE_ID)).toBe(true);
  });

  it("returns not-found for an unknown id", async () => {
    expect(await mod.removeSource("ghost-00000000")).toBe("not-found");
  });

  it("removes the row, its keyring credential, and its cache directory", async () => {
    const credStore = await import("./credential-store.js");
    const added = await mod.addSource({ url: URL_A, credential: "tok" });
    expect(added.outcome).toBe("created");
    if (added.outcome !== "created") return;
    const id = added.source.id;

    // Seed a cache dir the way a later listing would.
    const cacheDir = mod.__test.sourceCacheDir(id);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "catalog-cache.json"), "{}", "utf-8");

    const result = await mod.removeSource(id);
    expect(result).toBe("removed");
    expect(mod.listSources()).toHaveLength(0);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(credStore.deleteSlot).toHaveBeenCalledWith(`source:${id}`, "token");
    expect(keyring.has(`source:${id}/token`)).toBe(false);
  });

  it("still reports removed when the keyring credential delete fails", async () => {
    const credStore = await import("./credential-store.js");
    const added = await mod.addSource({ url: URL_A, credential: "tok" });
    expect(added.outcome).toBe("created");
    if (added.outcome !== "created") return;
    // A headless-Linux keyring can be unavailable. The row is already persisted as
    // removed before cleanup, so a keyring delete failure is logged, not propagated:
    // the removal must not be reported as failed after it already completed.
    vi.mocked(credStore.deleteSlot).mockRejectedValueOnce(new Error("keyring unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await mod.removeSource(added.source.id);
    expect(result).toBe("removed");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(mod.listSources()).toHaveLength(0);
  });

  it("skips the keyring delete for a credential-less source", async () => {
    const credStore = await import("./credential-store.js");
    const added = await mod.addSource({ url: URL_A });
    expect(added.outcome).toBe("created");
    if (added.outcome !== "created") return;
    const result = await mod.removeSource(added.source.id);
    expect(result).toBe("removed");
    expect(credStore.deleteSlot).not.toHaveBeenCalled();
  });
});

describe("sourceCacheDir", () => {
  it("resolves a valid id under the marketplace sources root", () => {
    const dir = mod.__test.sourceCacheDir("example-com-1a2b3c4d");
    expect(dir.endsWith(path.join("marketplace", "sources", "example-com-1a2b3c4d"))).toBe(true);
  });

  it("refuses to resolve a traversal id outside the sources root", () => {
    // The id reaching fs.rmSync originates from a request path param. A traversal
    // segment must be rejected before it can hand a path outside the cache root to a
    // recursive delete (CWE-22, defense in depth).
    expect(() => mod.__test.sourceCacheDir("../../escape")).toThrow();
    expect(() => mod.__test.sourceCacheDir("a/../../escape")).toThrow();
  });
});
