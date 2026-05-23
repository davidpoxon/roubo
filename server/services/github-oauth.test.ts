import { describe, it, expect, vi, beforeEach } from "vitest";

const credentialMocks = {
  set: vi.fn<(p: string, s: string, v: string) => Promise<void>>(),
};
vi.mock("./credential-store.js", () => credentialMocks);

let mod: typeof import("./github-oauth.js");

beforeEach(async () => {
  credentialMocks.set.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  mod = await import("./github-oauth.js");
  mod.__test.reset();
});

describe("buildAuthorizationUrl", () => {
  it("returns a URL with client_id, redirect_uri, scopes, and a unique state", () => {
    const a = mod.buildAuthorizationUrl();
    const b = mod.buildAuthorizationUrl();
    const ua = new URL(a.url);
    const ub = new URL(b.url);

    expect(ua.origin + ua.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(ua.searchParams.get("client_id")).toBeTruthy();
    expect(ua.searchParams.get("redirect_uri")).toBe("roubo://oauth/github/callback");
    expect(ua.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["repo", "read:org", "read:project"]),
    );
    expect(ua.searchParams.get("state")).toBeTruthy();
    expect(ua.searchParams.get("state")).not.toEqual(ub.searchParams.get("state"));
  });
});

describe("validateState", () => {
  it("accepts a freshly issued state once and rejects replays", () => {
    const { url } = mod.buildAuthorizationUrl();
    const state = new URL(url).searchParams.get("state");
    if (!state) throw new Error("state missing from authorize URL");
    expect(mod.validateState(state)).toBe(true);
    expect(mod.validateState(state)).toBe(false);
  });

  it("rejects an unknown state", () => {
    expect(mod.validateState("not-real")).toBe(false);
  });

  it("rejects an expired state", () => {
    mod.__test.seedState("expired", Date.now() - mod.STATE_TTL_MS - 1);
    expect(mod.validateState("expired")).toBe(false);
  });
});

describe("exchangeCodeForToken", () => {
  it("returns token and parsed scopes on a successful exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: "ghp_secret",
          scope: "repo,read:org,read:project",
          token_type: "bearer",
        }),
      })),
    );

    const result = await mod.exchangeCodeForToken("the-code");

    expect(result.token).toBe("ghp_secret");
    expect(result.scopes).toEqual(["repo", "read:org", "read:project"]);
  });

  it("throws when GitHub returns no access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: "", scope: "" }),
      })),
    );
    await expect(mod.exchangeCodeForToken("c")).rejects.toThrow(/no access_token/);
  });

  it("throws when GitHub returns a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
    );
    await expect(mod.exchangeCodeForToken("c")).rejects.toThrow(/502/);
  });
});

describe("saveToken", () => {
  it("writes to the github-com plugin keychain slot only", async () => {
    credentialMocks.set.mockResolvedValue();
    await mod.saveToken("ghp_x");
    expect(credentialMocks.set).toHaveBeenCalledWith("github-com", "github-token", "ghp_x");
  });
});
