import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const credentialMocks = {
  set: vi.fn<(p: string, s: string, v: string) => Promise<void>>(),
};
vi.mock("./credential-store.js", () => credentialMocks);

let mod: typeof import("./github-oauth.js");

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<unknown>>>;

function stubFetch(...bodies: unknown[]): FetchMock {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: FetchMock, call = 0): Record<string, string> {
  return JSON.parse(String(fetchMock.mock.calls[call]?.[1].body)) as Record<string, string>;
}

const DEVICE_CODE_RESPONSE = {
  device_code: "dev-123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

beforeEach(async () => {
  credentialMocks.set.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mod = await import("./github-oauth.js");
  mod.__test.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startDeviceFlow", () => {
  it("requests a device code with the client ID and scopes, and no client secret", async () => {
    const fetchMock = stubFetch(DEVICE_CODE_RESPONSE);

    await mod.startDeviceFlow();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://github.com/login/device/code");
    const body = requestBody(fetchMock);
    expect(body.client_id).toBeTruthy();
    expect(body.scope.split(" ")).toEqual(
      expect.arrayContaining(["repo", "read:org", "read:project", "security_events"]),
    );
    expect(body).not.toHaveProperty("client_secret");
  });

  it("returns the user code and verification URL but never the device code", async () => {
    stubFetch(DEVICE_CODE_RESPONSE);

    const result = await mod.startDeviceFlow();

    expect(result).toEqual({
      flowId: expect.stringMatching(/^[0-9a-f]{64}$/),
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
    expect(JSON.stringify(result)).not.toContain("dev-123");
    expect(mod.__test.getFlow(result.flowId)?.deviceCode).toBe("dev-123");
  });

  it("issues a distinct flowId per flow", async () => {
    stubFetch(DEVICE_CODE_RESPONSE, DEVICE_CODE_RESPONSE);
    const a = await mod.startDeviceFlow();
    const b = await mod.startDeviceFlow();
    expect(a.flowId).not.toBe(b.flowId);
  });

  // The device-code endpoint sends its OAuth errors with HTTP 400 (observed
  // live for device_flow_disabled), so the stubs carry that status.
  function stubErrorReply(status: number, body: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: status < 400, status, json: async () => body })),
    );
  }

  it("explains a device flow that is not enabled on the OAuth App", async () => {
    stubErrorReply(400, { error: "device_flow_disabled", error_description: "must be enabled" });
    await expect(mod.startDeviceFlow()).rejects.toThrow(/device flow is not enabled/);
  });

  it("throws the error description on any other error response", async () => {
    stubErrorReply(400, { error: "unauthorized_client", error_description: "bad client" });
    await expect(mod.startDeviceFlow()).rejects.toThrow(/bad client/);
  });

  it("throws the status when a non-2xx reply carries no OAuth error", async () => {
    stubErrorReply(502, {});
    await expect(mod.startDeviceFlow()).rejects.toThrow(/502/);
  });

  it("throws the status when the reply body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    );
    await expect(mod.startDeviceFlow()).rejects.toThrow(/503/);
  });
});

describe("pollDeviceFlow", () => {
  it("reports an unknown flow as expired without calling GitHub", async () => {
    const fetchMock = stubFetch();
    await expect(mod.pollDeviceFlow("nope")).resolves.toEqual({ status: "expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a flow past its expiry as expired and forgets it", async () => {
    const fetchMock = stubFetch();
    mod.__test.seedFlow("old", { expiresAt: Date.now() - 1 });
    await expect(mod.pollDeviceFlow("old")).resolves.toEqual({ status: "expired" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.__test.getFlow("old")).toBeUndefined();
  });

  it("answers an early poll locally without calling GitHub", async () => {
    const fetchMock = stubFetch();
    mod.__test.seedFlow("f", { nextPollAt: Date.now() + 60_000, intervalS: 7 });
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "pending", interval: 7 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls with the device code and grant type, and no client secret", async () => {
    const fetchMock = stubFetch({ error: "authorization_pending" });
    mod.__test.seedFlow("f", { deviceCode: "dev-xyz" });

    await mod.pollDeviceFlow("f");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://github.com/login/oauth/access_token");
    const body = requestBody(fetchMock);
    expect(body.device_code).toBe("dev-xyz");
    expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.client_id).toBeTruthy();
    expect(body).not.toHaveProperty("client_secret");
  });

  it("maps authorization_pending to pending and schedules the next poll", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    stubFetch({ error: "authorization_pending" });
    mod.__test.seedFlow("f");

    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "pending", interval: 5 });
    expect(mod.__test.getFlow("f")?.nextPollAt).toBe(1_000_000 + 5_000);
  });

  it("raises the interval on slow_down to the value GitHub returns", async () => {
    stubFetch({ error: "slow_down", interval: 10 });
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "pending", interval: 10 });
    expect(mod.__test.getFlow("f")?.intervalS).toBe(10);
  });

  it("adds 5 seconds on slow_down when GitHub returns no interval", async () => {
    stubFetch({ error: "slow_down" });
    mod.__test.seedFlow("f", { intervalS: 5 });
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "pending", interval: 10 });
  });

  it("maps expired_token to expired and forgets the flow", async () => {
    stubFetch({ error: "expired_token" });
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "expired" });
    expect(mod.__test.getFlow("f")).toBeUndefined();
  });

  it("maps access_denied to denied and forgets the flow", async () => {
    stubFetch({ error: "access_denied" });
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "denied" });
    expect(mod.__test.getFlow("f")).toBeUndefined();
  });

  it("returns the token and parsed scopes on approval and forgets the flow", async () => {
    stubFetch({
      access_token: "ghp_secret",
      scope: "repo,read:org,read:project",
      token_type: "bearer",
    });
    mod.__test.seedFlow("f");

    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({
      status: "complete",
      token: "ghp_secret",
      scopes: ["repo", "read:org", "read:project"],
    });
    expect(mod.__test.getFlow("f")).toBeUndefined();
  });

  it("throws and forgets the flow on an unrecognised error", async () => {
    stubFetch({ error: "incorrect_device_code", error_description: "bad code" });
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).rejects.toThrow(/bad code/);
    expect(mod.__test.getFlow("f")).toBeUndefined();
  });

  it("keeps the flow and reports pending when GitHub returns a 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
    );
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "pending", interval: 5 });
    expect(mod.__test.getFlow("f")).toBeDefined();
  });

  it("keeps the flow and reports pending when the request fails on the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "pending", interval: 5 });
    expect(mod.__test.getFlow("f")).toBeDefined();
  });

  it("throws and forgets the flow on a 4xx that carries no OAuth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).rejects.toThrow(/404/);
    expect(mod.__test.getFlow("f")).toBeUndefined();
  });

  it("maps a token-endpoint error sent with a 4xx status by name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "expired_token" }),
      })),
    );
    mod.__test.seedFlow("f");
    await expect(mod.pollDeviceFlow("f")).resolves.toEqual({ status: "expired" });
  });
});

describe("saveToken", () => {
  it("writes to the github-com plugin keychain slot only", async () => {
    credentialMocks.set.mockResolvedValue();
    await mod.saveToken("ghp_x");
    expect(credentialMocks.set).toHaveBeenCalledWith("github-com", "github-token", "ghp_x");
  });
});
