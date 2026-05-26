import crypto from "node:crypto";
import * as credentialStore from "./credential-store.js";

// Plugin-scoped OAuth helper for the bundled github-com integration plugin.
// The plugin reads its token from credentialStore.get("github-com",
// "github-token"); this module is the only writer in the host process.

export const GITHUB_PLUGIN_ID = "github-com";
export const GITHUB_TOKEN_SLOT = "github-token";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "Ov23li8FytWzZPHmc7fm";
const GITHUB_CLIENT_SECRET =
  process.env.GITHUB_CLIENT_SECRET ?? "fea51c04671e04a4c813875bcd437a05c8181d72";
const REDIRECT_URI = process.env.GITHUB_REDIRECT_URI ?? "roubo://oauth/github/callback";
// WU-036: exported so the host route can log `scopesRequested` on
// /authorize without duplicating the scope set. Architecture addendum line 952.
export const REQUIRED_SCOPES = ["repo", "read:org", "read:project", "security_events"] as const;
const SCOPES = REQUIRED_SCOPES.join(" ");

export const STATE_TTL_MS = 10 * 60 * 1000;

// In-memory state map. Lost on server restart, which fails any in-flight flow
// with an "invalid state" error on the next callback. That's the desired
// behaviour; restarting the server should not silently accept a stale code.
const pendingStates = new Map<string, number>();

function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [state, timestamp] of pendingStates) {
    if (now - timestamp >= STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

// WU-031 / NFR (logs): the returned URL embeds a single-use `state` nonce.
// Do NOT log the URL or pass it to any plugin-process log surface. The renderer
// receives it directly from /authorize and hands it to the system browser.
export function buildAuthorizationUrl(): { url: string } {
  pruneExpiredStates();
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
  });
  return { url: `https://github.com/login/oauth/authorize?${params.toString()}` };
}

export function validateState(state: string): boolean {
  const timestamp = pendingStates.get(state);
  if (timestamp === undefined) return false;
  pendingStates.delete(state);
  if (Date.now() - timestamp >= STATE_TTL_MS) return false;
  return true;
}

interface TokenResponse {
  access_token: string;
  scope: string;
  token_type: string;
}

export async function exchangeCodeForToken(
  code: string,
): Promise<{ token: string; scopes: string[] }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`);
  }

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error("GitHub token exchange returned no access_token");
  }

  const scopes = data.scope ? data.scope.split(",").map((s) => s.trim()) : [];
  return { token: data.access_token, scopes };
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

// Test-only reset so vitest's module isolation can clear pendingStates.
export const __test = {
  reset(): void {
    pendingStates.clear();
  },
  seedState(state: string, timestamp: number = Date.now()): void {
    pendingStates.set(state, timestamp);
  },
};
