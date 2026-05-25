import { describe, it, expect, vi, beforeEach } from "vitest";
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

beforeEach(() => {
  for (const fn of Object.values(githubOauthMocks)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  githubMocks.refreshAuth.mockReset();
  pluginManagerMocks.invalidateConnectionStatus.mockReset();
});

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
