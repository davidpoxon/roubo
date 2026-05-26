import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const { githubOauthMocks, githubMocks, pluginManagerMocks } = vi.hoisted(() => ({
  githubOauthMocks: {
    buildAuthorizationUrl: vi.fn(),
    exchangeCodeForToken: vi.fn(),
    fetchGitHubUsername: vi.fn(),
    saveToken: vi.fn(),
    validateState: vi.fn(),
    GITHUB_PLUGIN_ID: "github-com",
    GITHUB_TOKEN_SLOT: "github-token",
    // WU-036: REQUIRED_SCOPES is consumed by the route to log `scopesRequested`.
    REQUIRED_SCOPES: ["repo", "read:org", "read:project", "security_events"],
  },
  githubMocks: { refreshAuth: vi.fn() },
  pluginManagerMocks: { invalidateConnectionStatus: vi.fn() },
}));
vi.mock("../services/github-oauth.js", () => githubOauthMocks);
vi.mock("../services/github.js", () => githubMocks);
vi.mock("../services/plugin-manager.js", () => pluginManagerMocks);

import router from "./plugins-github-oauth.js";

const app = express();
app.use(express.json());
app.use("/", router);

let consoleInfo: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const fn of Object.values(githubOauthMocks)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  githubMocks.refreshAuth.mockReset();
  pluginManagerMocks.invalidateConnectionStatus.mockReset();
  // WU-036: silence the structured oauth-authorize / oauth-exchange lines
  // emitted by the route. Tests that need to inspect them assert on the spy.
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  consoleInfo.mockRestore();
});

function infoPayloads(): Array<Record<string, unknown>> {
  return consoleInfo.mock.calls.flatMap(([arg]) => {
    if (typeof arg !== "string") return [];
    try {
      const parsed = JSON.parse(arg);
      return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

describe("POST /authorize", () => {
  it("returns the authorization URL produced by the service", async () => {
    githubOauthMocks.buildAuthorizationUrl.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?state=abc",
    });

    const res = await request(app).post("/authorize");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://github.com/login/oauth/authorize?state=abc",
    });
  });

  it("emits a structured oauth-authorize log with the required scopes and no URL", async () => {
    githubOauthMocks.buildAuthorizationUrl.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?state=abc&scope=secret",
    });

    await request(app).post("/authorize");

    const payloads = infoPayloads().filter((p) => p.kind === "oauth-authorize");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      kind: "oauth-authorize",
      scopesRequested: ["repo", "read:org", "read:project", "security_events"],
    });
    // The authorize URL embeds a single-use state nonce and must never appear
    // in any log line (github-oauth.ts:34–36).
    for (const call of consoleInfo.mock.calls) {
      const arg = String(call[0] ?? "");
      expect(arg).not.toContain("github.com/login/oauth/authorize");
    }
  });

  it("returns 500 when buildAuthorizationUrl throws", async () => {
    githubOauthMocks.buildAuthorizationUrl.mockImplementation(() => {
      throw new Error("crypto broken");
    });

    const res = await request(app).post("/authorize");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "crypto broken" });
  });
});

describe("POST /exchange", () => {
  it("rejects missing parameters with 400", async () => {
    const res = await request(app).post("/exchange").send({ code: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
  });

  it("rejects an invalid state with 400", async () => {
    githubOauthMocks.validateState.mockReturnValue(false);
    const res = await request(app).post("/exchange").send({ code: "abc", state: "stale" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("exchanges the code, persists the token to the keychain, and refreshes legacy auth", async () => {
    githubOauthMocks.validateState.mockReturnValue(true);
    githubOauthMocks.exchangeCodeForToken.mockResolvedValue({
      token: "ghp_secret",
      scopes: ["repo", "read:org", "read:project"],
    });
    githubOauthMocks.fetchGitHubUsername.mockResolvedValue("octocat");
    githubOauthMocks.saveToken.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);

    const res = await request(app).post("/exchange").send({ code: "abc", state: "good" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, username: "octocat" });
    expect(githubOauthMocks.saveToken).toHaveBeenCalledWith("ghp_secret");
    expect(githubMocks.refreshAuth).toHaveBeenCalled();
    // WU-031: invalidate the cached connection-status so the next UI poll
    // re-probes under the freshly-saved token (incl. any newly granted scopes).
    expect(pluginManagerMocks.invalidateConnectionStatus).toHaveBeenCalledWith("github-com");
  });

  it("emits an oauth-exchange log with empty reconsentForCategories when security_events not granted", async () => {
    githubOauthMocks.validateState.mockReturnValue(true);
    githubOauthMocks.exchangeCodeForToken.mockResolvedValue({
      token: "ghp_secret",
      scopes: ["repo", "read:org", "read:project"],
    });
    githubOauthMocks.fetchGitHubUsername.mockResolvedValue("octocat");
    githubOauthMocks.saveToken.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);

    await request(app).post("/exchange").send({ code: "abc", state: "good" });

    const payloads = infoPayloads().filter((p) => p.kind === "oauth-exchange");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      kind: "oauth-exchange",
      scopesGranted: ["repo", "read:org", "read:project"],
      reconsentForCategories: [],
    });
  });

  it("emits oauth-exchange with all three categories when security_events is granted", async () => {
    githubOauthMocks.validateState.mockReturnValue(true);
    githubOauthMocks.exchangeCodeForToken.mockResolvedValue({
      token: "ghp_secret",
      scopes: ["repo", "read:org", "read:project", "security_events"],
    });
    githubOauthMocks.fetchGitHubUsername.mockResolvedValue("octocat");
    githubOauthMocks.saveToken.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);

    await request(app).post("/exchange").send({ code: "abc", state: "good" });

    const payloads = infoPayloads().filter((p) => p.kind === "oauth-exchange");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      kind: "oauth-exchange",
      scopesGranted: ["repo", "read:org", "read:project", "security_events"],
      reconsentForCategories: ["code-scanning", "secret-scanning", "dependabot"],
    });
  });

  it("does not emit oauth-exchange when the exchange fails", async () => {
    githubOauthMocks.validateState.mockReturnValue(true);
    githubOauthMocks.exchangeCodeForToken.mockRejectedValue(new Error("upstream 502"));

    await request(app).post("/exchange").send({ code: "abc", state: "good" });

    expect(infoPayloads().filter((p) => p.kind === "oauth-exchange")).toHaveLength(0);
  });

  it("returns 500 when the GitHub exchange fails", async () => {
    githubOauthMocks.validateState.mockReturnValue(true);
    githubOauthMocks.exchangeCodeForToken.mockRejectedValue(new Error("upstream 502"));

    const res = await request(app).post("/exchange").send({ code: "abc", state: "good" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "upstream 502" });
    expect(githubOauthMocks.saveToken).not.toHaveBeenCalled();
    expect(githubMocks.refreshAuth).not.toHaveBeenCalled();
    expect(pluginManagerMocks.invalidateConnectionStatus).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("attaches RateLimit response headers (middleware is mounted)", async () => {
    githubOauthMocks.buildAuthorizationUrl.mockReturnValue({
      url: "https://github.com/login/oauth/authorize?state=abc",
    });

    const res = await request(app).post("/authorize");
    expect(res.status).toBe(200);
    // express-rate-limit (draft-7) sets these headers when the limiter runs.
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});
