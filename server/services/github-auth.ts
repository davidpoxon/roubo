import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRouboDir, atomicWrite, ensureDirs } from "./state.js";
import type { GitHubAuthStatus, GitHubAuthUrl } from "@roubo/shared";

interface PersistedAuth {
  githubToken: string;
  username: string;
  scopes: string[];
  authorizedAt: string; // ISO 8601
}

// Falls back to the bundled OAuth App. Override per-environment via env vars.
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "Ov23li8FytWzZPHmc7fm";
const GITHUB_CLIENT_SECRET =
  process.env.GITHUB_CLIENT_SECRET ?? "fea51c04671e04a4c813875bcd437a05c8181d72";
const REDIRECT_URI = process.env.GITHUB_REDIRECT_URI ?? "roubo://oauth/github/callback";
const REQUIRED_SCOPES = ["repo", "read:org", "read:project"];
const SCOPES = REQUIRED_SCOPES.join(" ");

function areScopesOutdated(storedScopes: string[] | undefined): boolean {
  if (!storedScopes) return true;
  return REQUIRED_SCOPES.some((s) => !storedScopes.includes(s));
}

export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Stored in process memory. Lost on server restart — any in-flight OAuth flows
// will fail after a restart with an "invalid state" error, which is safe.
const pendingStates = new Map<string, number>();

function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [state, timestamp] of pendingStates) {
    if (now - timestamp >= STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

export function buildAuthorizationUrl(): GitHubAuthUrl {
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

  // Remove the state unconditionally — it is single-use regardless of expiry.
  pendingStates.delete(state);

  // Check expiry after deletion so a replayed expired token is also rejected.
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

const AUTH_FILE = path.join(getRouboDir(), "auth.json");

export const STATUS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface StatusCache {
  status: GitHubAuthStatus;
  cachedAt: number;
}

let statusCache: StatusCache | null = null;

export function clearStatusCache(): void {
  statusCache = null;
}

export function saveCredentials(githubToken: string, username: string, scopes: string[]): void {
  // Tokens are stored in plaintext — acceptable for a local dev tool where the
  // file is owner-readable only (same pattern as git credential helpers).
  ensureDirs();
  const data: PersistedAuth = {
    githubToken,
    username,
    scopes,
    authorizedAt: new Date().toISOString(),
  };
  atomicWrite(AUTH_FILE, JSON.stringify(data, null, 2), 0o600);
}

export function deleteCredentials(): void {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  clearStatusCache();
}

function readAuthFile(): PersistedAuth | null {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")) as PersistedAuth;
    if (data.githubToken && typeof data.githubToken === "string") return data;
  } catch {
    // malformed auth.json
  }
  return null;
}

export async function getConnectionStatus(): Promise<GitHubAuthStatus> {
  // Return cached status if still fresh
  if (statusCache !== null && Date.now() - statusCache.cachedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.status;
  }

  const auth = readAuthFile();
  if (!auth) {
    const status: GitHubAuthStatus = { connected: false };
    statusCache = { status, cachedAt: Date.now() };
    return status;
  }

  // Validate the token against GitHub API and fetch the canonical username
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${auth.githubToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (res.status === 401) {
      // Token has been revoked or is invalid
      const status: GitHubAuthStatus = { connected: false };
      statusCache = { status, cachedAt: Date.now() };
      return status;
    }

    if (res.ok) {
      const data = (await res.json()) as { login: string };
      const scopes = Array.isArray(auth.scopes) ? auth.scopes : undefined;
      const status: GitHubAuthStatus = {
        connected: true,
        username: data.login,
        scopes,
        scopesOutdated: areScopesOutdated(scopes),
        authorizedAt: typeof auth.authorizedAt === "string" ? auth.authorizedAt : undefined,
      };
      statusCache = { status, cachedAt: Date.now() };
      return status;
    }

    // Non-401 error (5xx, network flake) — fall through to stored data
  } catch {
    // Network failure — fall through to stored data
  }

  // Optimistic fallback: return stored data rather than marking disconnected
  const fallbackScopes = Array.isArray(auth.scopes) ? auth.scopes : undefined;
  const status: GitHubAuthStatus = {
    connected: true,
    username: typeof auth.username === "string" ? auth.username : undefined,
    scopes: fallbackScopes,
    scopesOutdated: areScopesOutdated(fallbackScopes),
    authorizedAt: typeof auth.authorizedAt === "string" ? auth.authorizedAt : undefined,
  };
  statusCache = { status, cachedAt: Date.now() };
  return status;
}
