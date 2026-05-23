import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");
const mockAtomicWrite = vi.fn();
const mockEnsureDirs = vi.fn();
vi.mock("./state.js", () => ({
  getRouboDir: () => "/mock/.roubo",
  atomicWrite: mockAtomicWrite,
  ensureDirs: mockEnsureDirs,
}));

const mockCredentialSet = vi.fn().mockResolvedValue(undefined);
const mockCredentialDeleteSlot = vi.fn().mockResolvedValue(undefined);
vi.mock("./credential-store.js", () => ({
  set: mockCredentialSet,
  deleteSlot: mockCredentialDeleteSlot,
  get: vi.fn().mockResolvedValue(null),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function loadModule() {
  vi.resetModules();
  return await import("./github-auth.js");
}

describe("buildAuthorizationUrl", () => {
  it("returns a URL pointing to GitHub OAuth authorize endpoint", async () => {
    const { buildAuthorizationUrl } = await loadModule();
    const { url } = buildAuthorizationUrl();
    expect(url).toContain("https://github.com/login/oauth/authorize");
  });

  it("includes the correct client_id", async () => {
    const { buildAuthorizationUrl } = await loadModule();
    const { url } = buildAuthorizationUrl();
    expect(url).toContain("client_id=Ov23li8FytWzZPHmc7fm");
  });

  it("includes the redirect_uri", async () => {
    const { buildAuthorizationUrl } = await loadModule();
    const { url } = buildAuthorizationUrl();
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("roubo%3A%2F%2Foauth%2Fgithub%2Fcallback");
  });

  it("includes repo, read:org, and read:project scopes", async () => {
    const { buildAuthorizationUrl } = await loadModule();
    const { url } = buildAuthorizationUrl();
    expect(url).toContain("scope=");
    expect(url).toContain("repo");
    expect(url).toContain("read%3Aorg");
    expect(url).toContain("read%3Aproject");
  });

  it("includes a state parameter", async () => {
    const { buildAuthorizationUrl } = await loadModule();
    const { url } = buildAuthorizationUrl();
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBeTruthy();
  });

  it("generates a unique state on each call", async () => {
    const { buildAuthorizationUrl } = await loadModule();
    const url1 = new URL(buildAuthorizationUrl().url);
    const url2 = new URL(buildAuthorizationUrl().url);
    expect(url1.searchParams.get("state")).not.toBe(url2.searchParams.get("state"));
  });
});

describe("validateState", () => {
  function extractState(url: string): string {
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();
    return state as string;
  }

  it("returns true for a recently generated state", async () => {
    const { buildAuthorizationUrl, validateState } = await loadModule();
    const state = extractState(buildAuthorizationUrl().url);
    expect(validateState(state)).toBe(true);
  });

  it("returns false for an unknown state", async () => {
    const { validateState } = await loadModule();
    expect(validateState("unknown-state")).toBe(false);
  });

  it("removes the state after validation (one-time use)", async () => {
    const { buildAuthorizationUrl, validateState } = await loadModule();
    const state = extractState(buildAuthorizationUrl().url);
    validateState(state);
    expect(validateState(state)).toBe(false);
  });

  it("returns true just before the TTL expires (boundary)", async () => {
    vi.useFakeTimers();
    const { buildAuthorizationUrl, validateState, STATE_TTL_MS } = await loadModule();
    const state = extractState(buildAuthorizationUrl().url);

    vi.advanceTimersByTime(STATE_TTL_MS - 1);

    expect(validateState(state)).toBe(true);
  });

  it("returns false for an expired state", async () => {
    vi.useFakeTimers();
    const { buildAuthorizationUrl, validateState, STATE_TTL_MS } = await loadModule();
    const state = extractState(buildAuthorizationUrl().url);

    vi.advanceTimersByTime(STATE_TTL_MS + 1);

    expect(validateState(state)).toBe(false);
  });
});

describe("exchangeCodeForToken", () => {
  it("returns a token and scopes on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "gho_test",
          scope: "repo,read:org,read:project",
          token_type: "bearer",
        }),
      }),
    );
    const { exchangeCodeForToken } = await loadModule();
    const result = await exchangeCodeForToken("code123");
    expect(result.token).toBe("gho_test");
    expect(result.scopes).toEqual(["repo", "read:org", "read:project"]);
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const { exchangeCodeForToken } = await loadModule();
    await expect(exchangeCodeForToken("bad-code")).rejects.toThrow(
      "GitHub token exchange failed: 401",
    );
  });

  it("throws when access_token is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: "bad_verification_code" }),
      }),
    );
    const { exchangeCodeForToken } = await loadModule();
    await expect(exchangeCodeForToken("bad-code")).rejects.toThrow("no access_token");
  });
});

describe("fetchGitHubUsername", () => {
  it("returns the login for a valid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "octocat", id: 1 }),
      }),
    );
    const { fetchGitHubUsername } = await loadModule();
    const username = await fetchGitHubUsername("gho_test");
    expect(username).toBe("octocat");
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const { fetchGitHubUsername } = await loadModule();
    await expect(fetchGitHubUsername("bad-token")).rejects.toThrow("GitHub user fetch failed: 401");
  });
});

describe("saveCredentials", () => {
  it("writes auth.json via atomicWrite with mode 0o600", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"));
    const { saveCredentials } = await loadModule();
    await saveCredentials("gho_test", "octocat", ["repo"]);
    expect(mockEnsureDirs).toHaveBeenCalled();
    expect(mockAtomicWrite).toHaveBeenCalledWith(
      "/mock/.roubo/auth.json",
      JSON.stringify(
        {
          githubToken: "gho_test",
          username: "octocat",
          scopes: ["repo"],
          authorizedAt: "2026-04-06T12:00:00.000Z",
        },
        null,
        2,
      ),
      0o600,
    );
  });

  it("includes an ISO 8601 authorizedAt timestamp", async () => {
    const { saveCredentials } = await loadModule();
    await saveCredentials("gho_test", "octocat", ["repo"]);
    const written = mockAtomicWrite.mock.calls[0][1] as string;
    const parsed = JSON.parse(written) as { authorizedAt: string };
    expect(new Date(parsed.authorizedAt).toISOString()).toBe(parsed.authorizedAt);
  });

  it("mirrors the token into the github-com plugin's keychain slot", async () => {
    const { saveCredentials } = await loadModule();
    await saveCredentials("gho_test", "octocat", ["repo"]);
    expect(mockCredentialSet).toHaveBeenCalledWith("github-com", "github-token", "gho_test");
  });

  it("still writes auth.json when the keychain mirror fails", async () => {
    mockCredentialSet.mockRejectedValueOnce(new Error("keyring-unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { saveCredentials } = await loadModule();
    await saveCredentials("gho_test", "octocat", ["repo"]);
    expect(mockAtomicWrite).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to mirror token to keychain"),
      expect.stringContaining("keyring-unavailable"),
    );
  });
});

describe("getConnectionStatus", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it("returns connected: false when auth.json does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { getConnectionStatus } = await loadModule();
    expect(await getConnectionStatus()).toEqual({ connected: false });
  });

  it("validates token via GitHub API and returns username from API response", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        githubToken: "gho_test123",
        username: "storeduser",
        scopes: ["repo", "read:org", "read:project"],
        authorizedAt: "2026-04-06T12:00:00.000Z",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ login: "apiuser", id: 1 }),
      }),
    );
    const { getConnectionStatus } = await loadModule();
    const status = await getConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.username).toBe("apiuser");
    expect(status.scopes).toEqual(["repo", "read:org", "read:project"]);
    expect(status.scopesOutdated).toBe(false);
    expect(status.authorizedAt).toBe("2026-04-06T12:00:00.000Z");
  });

  it("sets scopesOutdated: true when stored scopes are missing read:project", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        githubToken: "gho_old",
        username: "storeduser",
        scopes: ["repo", "read:org"],
        authorizedAt: "2026-04-06T12:00:00.000Z",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ login: "storeduser", id: 1 }),
      }),
    );
    const { getConnectionStatus } = await loadModule();
    const status = await getConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.scopesOutdated).toBe(true);
  });

  it("returns connected: false when GitHub API returns 401 (token revoked)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ githubToken: "gho_revoked", username: "testuser", scopes: ["repo"] }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const { getConnectionStatus } = await loadModule();
    expect(await getConnectionStatus()).toEqual({ connected: false });
  });

  it("falls back to stored data on non-401 GitHub API error", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        githubToken: "gho_test",
        username: "storeduser",
        scopes: ["repo"],
        authorizedAt: "2026-04-06T12:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { getConnectionStatus } = await loadModule();
    const status = await getConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.username).toBe("storeduser");
  });

  it("falls back to stored data on network failure", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ githubToken: "gho_test", username: "storeduser", scopes: ["repo"] }),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const { getConnectionStatus } = await loadModule();
    const status = await getConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.username).toBe("storeduser");
  });

  it("returns cached result without hitting GitHub API again within TTL", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ githubToken: "gho_test", username: "storeduser", scopes: ["repo"] }),
    );
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ login: "apiuser", id: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { getConnectionStatus } = await loadModule();
    await getConnectionStatus();
    await getConnectionStatus();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-validates after clearStatusCache is called", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ githubToken: "gho_test", username: "storeduser", scopes: ["repo"] }),
    );
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ login: "apiuser", id: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { getConnectionStatus, clearStatusCache } = await loadModule();
    await getConnectionStatus();
    clearStatusCache();
    await getConnectionStatus();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns connected: false when auth.json exists but has no githubToken", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ someOtherKey: "value" }));
    const { getConnectionStatus } = await loadModule();
    expect(await getConnectionStatus()).toEqual({ connected: false });
  });

  it("returns connected: false when auth.json is malformed JSON", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not valid json {{{");
    const { getConnectionStatus } = await loadModule();
    expect(await getConnectionStatus()).toEqual({ connected: false });
  });
});

describe("deleteCredentials", () => {
  it("removes auth.json via fs.unlinkSync", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    const { deleteCredentials } = await loadModule();
    await deleteCredentials();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/mock/.roubo/auth.json");
  });

  it("clears the keychain slot for github-com", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    const { deleteCredentials } = await loadModule();
    await deleteCredentials();
    expect(mockCredentialDeleteSlot).toHaveBeenCalledWith("github-com", "github-token");
  });

  it("clears the status cache", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ githubToken: "gho_test", username: "user", scopes: ["repo"] }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ login: "apiuser", id: 1 }),
      }),
    );
    const { getConnectionStatus, deleteCredentials } = await loadModule();
    await getConnectionStatus();
    await deleteCredentials();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const status = await getConnectionStatus();
    expect(status).toEqual({ connected: false });
  });

  it("does not throw when auth.json does not exist (ENOENT)", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const { deleteCredentials } = await loadModule();
    await expect(deleteCredentials()).resolves.toBeUndefined();
  });

  it("rethrows non-ENOENT errors", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    const { deleteCredentials } = await loadModule();
    await expect(deleteCredentials()).rejects.toThrow("EPERM");
  });

  it("swallows keychain failures while still removing auth.json", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    mockCredentialDeleteSlot.mockRejectedValueOnce(new Error("keyring-unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deleteCredentials } = await loadModule();
    await deleteCredentials();
    expect(fs.unlinkSync).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to clear keychain slot during disconnect"),
      expect.stringContaining("keyring-unavailable"),
    );
  });
});
