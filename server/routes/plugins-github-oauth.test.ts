import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const { githubOauthMocks, githubMocks, pluginManagerMocks, credentialStoreMocks } = vi.hoisted(
  () => ({
    githubOauthMocks: {
      startDeviceFlow: vi.fn(),
      pollDeviceFlow: vi.fn(),
      fetchGitHubUsername: vi.fn(),
      saveToken: vi.fn(),
      GITHUB_PLUGIN_ID: "github-com",
      GITHUB_TOKEN_SLOT: "github-token",
      // IP-WU-036: REQUIRED_SCOPES is consumed by the route to log `scopesRequested`.
      REQUIRED_SCOPES: ["repo", "read:org", "read:project", "security_events"],
    },
    githubMocks: { refreshAuth: vi.fn() },
    pluginManagerMocks: { invalidateConnectionStatus: vi.fn(), invoke: vi.fn() },
    credentialStoreMocks: { deleteSlot: vi.fn(), set: vi.fn(), get: vi.fn() },
  }),
);
vi.mock("../services/github-oauth.js", () => githubOauthMocks);
vi.mock("../services/github.js", () => githubMocks);
vi.mock("../services/plugin-manager.js", () => pluginManagerMocks);
vi.mock("../services/credential-store.js", () => credentialStoreMocks);

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
  pluginManagerMocks.invoke.mockReset();
  pluginManagerMocks.invoke.mockResolvedValue(undefined);
  credentialStoreMocks.deleteSlot.mockReset();
  credentialStoreMocks.set.mockReset();
  credentialStoreMocks.get.mockReset();
  // IP-WU-036: silence the structured oauth-authorize / oauth-exchange lines
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

const DEVICE_FLOW = {
  flowId: "f".repeat(64),
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
  interval: 5,
};

describe("POST /device", () => {
  it("returns the device flow produced by the service", async () => {
    githubOauthMocks.startDeviceFlow.mockResolvedValue(DEVICE_FLOW);

    const res = await request(app).post("/device");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEVICE_FLOW);
  });

  it("emits a structured oauth-authorize log with the required scopes and no user code", async () => {
    githubOauthMocks.startDeviceFlow.mockResolvedValue(DEVICE_FLOW);

    await request(app).post("/device");

    const payloads = infoPayloads().filter((p) => p.kind === "oauth-authorize");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      kind: "oauth-authorize",
      scopesRequested: ["repo", "read:org", "read:project", "security_events"],
    });
    // The user code approves the sign-in for whoever holds it, and the flowId
    // is the handle to the server-held device code: neither may be logged.
    for (const call of consoleInfo.mock.calls) {
      const arg = String(call[0] ?? "");
      expect(arg).not.toContain(DEVICE_FLOW.userCode);
      expect(arg).not.toContain(DEVICE_FLOW.flowId);
    }
  });

  it("returns 500 when the service throws", async () => {
    githubOauthMocks.startDeviceFlow.mockRejectedValue(
      new Error("GitHub sign-in is unavailable: the device flow is not enabled on the OAuth App"),
    );

    const res = await request(app).post("/device");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/device flow is not enabled/);
  });
});

describe("POST /device/poll", () => {
  function approve(scopes: string[]): void {
    githubOauthMocks.pollDeviceFlow.mockResolvedValue({
      status: "complete",
      token: "ghp_secret",
      scopes,
    });
    githubOauthMocks.fetchGitHubUsername.mockResolvedValue("octocat");
    githubOauthMocks.saveToken.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);
  }

  it("rejects a missing flowId with 400", async () => {
    const res = await request(app).post("/device/poll").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
    expect(githubOauthMocks.pollDeviceFlow).not.toHaveBeenCalled();
  });

  it.each([[{ status: "pending", interval: 5 }], [{ status: "expired" }], [{ status: "denied" }]])(
    "passes %o through without touching the credential",
    async (result) => {
      githubOauthMocks.pollDeviceFlow.mockResolvedValue(result);

      const res = await request(app).post("/device/poll").send({ flowId: "abc" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
      expect(githubOauthMocks.pollDeviceFlow).toHaveBeenCalledWith("abc");
      expect(githubOauthMocks.saveToken).not.toHaveBeenCalled();
      expect(pluginManagerMocks.invalidateConnectionStatus).not.toHaveBeenCalled();
    },
  );

  it("persists the token to the keychain and refreshes legacy auth on approval", async () => {
    approve(["repo", "read:org", "read:project"]);

    const res = await request(app).post("/device/poll").send({ flowId: "abc" });

    expect(res.status).toBe(200);
    // The token itself never goes back to the renderer.
    expect(res.body).toEqual({ status: "complete", username: "octocat" });
    expect(githubOauthMocks.fetchGitHubUsername).toHaveBeenCalledWith("ghp_secret");
    expect(githubOauthMocks.saveToken).toHaveBeenCalledWith("ghp_secret");
    expect(githubMocks.refreshAuth).toHaveBeenCalled();
    // IP-WU-031: invalidate the cached connection-status so the next UI poll
    // re-probes under the freshly-saved token (incl. any newly granted scopes).
    expect(pluginManagerMocks.invalidateConnectionStatus).toHaveBeenCalledWith("github-com");
    // Reset the plugin process's cached Octokit so the derived-sources preview
    // and Cut List re-read the freshly-saved token instead of the pre-OAuth one.
    expect(pluginManagerMocks.invoke).toHaveBeenCalledWith("github-com", "setActiveConfig", {
      config: {},
    });
  });

  it("emits an oauth-exchange log with empty reconsentForCategories when security_events not granted", async () => {
    approve(["repo", "read:org", "read:project"]);

    await request(app).post("/device/poll").send({ flowId: "abc" });

    const payloads = infoPayloads().filter((p) => p.kind === "oauth-exchange");
    expect(payloads).toEqual([
      {
        kind: "oauth-exchange",
        scopesGranted: ["repo", "read:org", "read:project"],
        reconsentForCategories: [],
      },
    ]);
  });

  it("emits oauth-exchange with all three categories when security_events is granted", async () => {
    approve(["repo", "read:org", "read:project", "security_events"]);

    await request(app).post("/device/poll").send({ flowId: "abc" });

    const payloads = infoPayloads().filter((p) => p.kind === "oauth-exchange");
    expect(payloads).toEqual([
      {
        kind: "oauth-exchange",
        scopesGranted: ["repo", "read:org", "read:project", "security_events"],
        reconsentForCategories: ["code-scanning", "secret-scanning", "dependabot"],
      },
    ]);
  });

  it("still succeeds when the plugin cache reset fails (best-effort, swallowed)", async () => {
    approve(["repo"]);
    // The plugin may not be running; the reset RPC rejecting must not fail OAuth.
    pluginManagerMocks.invoke.mockRejectedValue(new Error("plugin-not-enabled"));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).post("/device/poll").send({ flowId: "abc" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "complete", username: "octocat" });
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    const warned = JSON.parse(String(consoleWarn.mock.calls[0]?.[0]));
    expect(warned).toMatchObject({ kind: "oauth-plugin-reset-failed", pluginId: "github-com" });
    consoleWarn.mockRestore();
  });

  it("returns 500 and saves nothing when the poll fails", async () => {
    githubOauthMocks.pollDeviceFlow.mockRejectedValue(new Error("GitHub request failed: 502"));

    const res = await request(app).post("/device/poll").send({ flowId: "abc" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "GitHub request failed: 502" });
    expect(githubOauthMocks.saveToken).not.toHaveBeenCalled();
    expect(githubMocks.refreshAuth).not.toHaveBeenCalled();
    expect(pluginManagerMocks.invalidateConnectionStatus).not.toHaveBeenCalled();
    expect(infoPayloads().filter((p) => p.kind === "oauth-exchange")).toHaveLength(0);
  });
});

describe("POST /disconnect", () => {
  it("clears the stored token, refreshes legacy auth, and invalidates connection status", async () => {
    credentialStoreMocks.deleteSlot.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);

    const res = await request(app).post("/disconnect");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(credentialStoreMocks.deleteSlot).toHaveBeenCalledWith("github-com", "github-token");
    expect(githubMocks.refreshAuth).toHaveBeenCalled();
    expect(pluginManagerMocks.invalidateConnectionStatus).toHaveBeenCalledWith("github-com");
    // Drop the plugin's cached client so source-bound RPCs stop using the
    // now-cleared token immediately.
    expect(pluginManagerMocks.invoke).toHaveBeenCalledWith("github-com", "setActiveConfig", {
      config: {},
    });
  });

  it("emits a structured oauth-disconnect log line", async () => {
    credentialStoreMocks.deleteSlot.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);

    await request(app).post("/disconnect");

    const payloads = infoPayloads().filter((p) => p.kind === "oauth-disconnect");
    expect(payloads).toEqual([{ kind: "oauth-disconnect", pluginId: "github-com" }]);
  });

  it("is idempotent when the keychain reports no token to delete", async () => {
    // The OS keychain implementations differ; deleteSlot is contracted to
    // resolve successfully whether or not a slot existed, so the route should
    // never surface a 5xx for a redundant disconnect.
    credentialStoreMocks.deleteSlot.mockResolvedValue(undefined);
    githubMocks.refreshAuth.mockResolvedValue(undefined);

    const first = await request(app).post("/disconnect");
    const second = await request(app).post("/disconnect");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(credentialStoreMocks.deleteSlot).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when the credential store throws", async () => {
    credentialStoreMocks.deleteSlot.mockRejectedValue(new Error("keychain locked"));

    const res = await request(app).post("/disconnect");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "keychain locked" });
    expect(githubMocks.refreshAuth).not.toHaveBeenCalled();
    expect(pluginManagerMocks.invalidateConnectionStatus).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("attaches RateLimit response headers (middleware is mounted)", async () => {
    githubOauthMocks.startDeviceFlow.mockResolvedValue(DEVICE_FLOW);

    const res = await request(app).post("/device");
    expect(res.status).toBe(200);
    // express-rate-limit (draft-7) sets these headers when the limiter runs.
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});
