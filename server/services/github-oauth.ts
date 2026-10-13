import crypto from "node:crypto";
import * as credentialStore from "./credential-store.js";

// Plugin-scoped OAuth helper for the bundled github-com integration plugin.
// The plugin reads its token from credentialStore.get("github-com",
// "github-token"); this module is the only writer in the host process.
//
// Sign-in uses GitHub's OAuth device flow, which needs the client ID only. A
// packaged desktop app cannot keep a client secret, so it has none: the device
// flow must be enabled on the OAuth App (see docs/integrations.md).

export const GITHUB_PLUGIN_ID = "github-com";
export const GITHUB_TOKEN_SLOT = "github-token";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "Ov23li8FytWzZPHmc7fm";
// IP-WU-036: exported so the host route can log `scopesRequested` when a flow
// starts without duplicating the scope set. Architecture addendum line 952.
export const REQUIRED_SCOPES = ["repo", "read:org", "read:project", "security_events"] as const;
const SCOPES = REQUIRED_SCOPES.join(" ");

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// GitHub's documented minimum poll interval, and the increment RFC 8628
// prescribes when the server answers `slow_down` without a new interval.
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_INCREMENT_S = 5;

interface PendingFlow {
  // The device code is a bearer for the token GitHub issues once the user
  // approves. It never leaves this process: the renderer polls by flowId.
  deviceCode: string;
  intervalS: number;
  expiresAt: number;
  nextPollAt: number;
}

// In-memory flow map. Lost on server restart, which reports any in-flight flow
// as expired on its next poll, so the user starts again with a fresh code.
const pendingFlows = new Map<string, PendingFlow>();

function pruneExpiredFlows(now: number): void {
  for (const [flowId, flow] of pendingFlows) {
    if (now >= flow.expiresAt) pendingFlows.delete(flowId);
  }
}

async function postGitHub(url: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub request failed: ${res.status}`);
  }
  return res.json();
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

export interface DeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

// IP-WU-031 / NFR (logs): the user code is a short-lived approval secret.
// Do NOT log the result or pass it to any plugin-process log surface. The
// renderer receives it directly from the route and shows it to the user.
export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const data = (await postGitHub(DEVICE_CODE_URL, {
    client_id: GITHUB_CLIENT_ID,
    scope: SCOPES,
  })) as DeviceCodeResponse;

  if (data.error === "device_flow_disabled") {
    throw new Error(
      "GitHub sign-in is unavailable: the device flow is not enabled on the OAuth App",
    );
  }
  if (data.error) {
    throw new Error(`GitHub sign-in failed: ${data.error_description ?? data.error}`);
  }
  if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in) {
    throw new Error("GitHub sign-in failed: incomplete device code response");
  }

  const now = Date.now();
  pruneExpiredFlows(now);
  const intervalS = data.interval ?? DEFAULT_INTERVAL_S;
  const flowId = crypto.randomBytes(32).toString("hex");
  pendingFlows.set(flowId, {
    deviceCode: data.device_code,
    intervalS,
    expiresAt: now + data.expires_in * 1000,
    nextPollAt: now + intervalS * 1000,
  });

  return {
    flowId,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: intervalS,
  };
}

interface AccessTokenResponse {
  access_token?: string;
  scope?: string;
  token_type?: string;
  interval?: number;
  error?: string;
  error_description?: string;
}

export type DeviceFlowPoll =
  | { status: "pending"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "complete"; token: string; scopes: string[] };

export async function pollDeviceFlow(flowId: string): Promise<DeviceFlowPoll> {
  const now = Date.now();
  const flow = pendingFlows.get(flowId);
  if (!flow || now >= flow.expiresAt) {
    pendingFlows.delete(flowId);
    return { status: "expired" };
  }
  // A poll that arrives early is answered locally, so a caller that ignores
  // the interval cannot earn a `slow_down` from GitHub for the whole flow.
  if (now < flow.nextPollAt) {
    return { status: "pending", interval: flow.intervalS };
  }

  let data: AccessTokenResponse;
  try {
    data = (await postGitHub(ACCESS_TOKEN_URL, {
      client_id: GITHUB_CLIENT_ID,
      device_code: flow.deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    })) as AccessTokenResponse;
  } catch (err) {
    pendingFlows.delete(flowId);
    throw err;
  }

  if (data.access_token) {
    pendingFlows.delete(flowId);
    const scopes = data.scope ? data.scope.split(",").map((s) => s.trim()) : [];
    return { status: "complete", token: data.access_token, scopes };
  }

  switch (data.error) {
    case "authorization_pending":
      flow.nextPollAt = Date.now() + flow.intervalS * 1000;
      return { status: "pending", interval: flow.intervalS };
    case "slow_down":
      flow.intervalS = data.interval ?? flow.intervalS + SLOW_DOWN_INCREMENT_S;
      flow.nextPollAt = Date.now() + flow.intervalS * 1000;
      return { status: "pending", interval: flow.intervalS };
    case "expired_token":
      pendingFlows.delete(flowId);
      return { status: "expired" };
    case "access_denied":
      pendingFlows.delete(flowId);
      return { status: "denied" };
    default:
      pendingFlows.delete(flowId);
      throw new Error(
        `GitHub sign-in failed: ${data.error_description ?? data.error ?? "no access_token returned"}`,
      );
  }
}

export async function fetchGitHubUsername(token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub user fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { login: string };
  return data.login;
}

export async function saveToken(token: string): Promise<void> {
  await credentialStore.set(GITHUB_PLUGIN_ID, GITHUB_TOKEN_SLOT, token);
}

// Test-only helpers so vitest's module isolation can clear and inspect flows.
export const __test = {
  reset(): void {
    pendingFlows.clear();
  },
  seedFlow(flowId: string, flow: Partial<PendingFlow> = {}): void {
    const now = Date.now();
    pendingFlows.set(flowId, {
      deviceCode: "device-code",
      intervalS: DEFAULT_INTERVAL_S,
      expiresAt: now + 15 * 60 * 1000,
      nextPollAt: now,
      ...flow,
    });
  },
  getFlow(flowId: string): PendingFlow | undefined {
    return pendingFlows.get(flowId);
  },
};
