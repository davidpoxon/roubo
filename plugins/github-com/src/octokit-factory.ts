import { Octokit } from "octokit";
import { getHost } from "./host-binding.js";
import { createHostFetchAdapter } from "./host-fetch-adapter.js";

/** Minimum surface githubRequest uses; tests can substitute a mock with the same shape. */
export interface OctokitLike {
  request: (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    headers?: Record<string, string | undefined>;
    status: number;
  }>;
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

let octokit: OctokitLike | null = null;
let tokenLoaded = false;
let cachedToken: string | null = null;
let injectedForTests: OctokitLike | null = null;

/** Replace the singleton Octokit instance. Only call this in tests. */
export function __setOctokitForTests(client: OctokitLike | null): void {
  injectedForTests = client;
}

/**
 * Returns a singleton Octokit instance authenticated with the token stored at
 * the `github-token` credential slot, with `request.fetch` wired through the
 * host. The token is loaded lazily on first use and cached for the process
 * lifetime. Call `resetOctokit()` to clear the cache (e.g. on token rotation).
 */
export async function getOctokit(): Promise<OctokitLike> {
  if (injectedForTests) return injectedForTests;
  if (octokit) return octokit;

  const host = getHost();
  if (!tokenLoaded) {
    cachedToken = await host.credentials.get("github-token");
    tokenLoaded = true;
  }

  if (!cachedToken) {
    throw new Error(
      "[github-com] GitHub token missing. Set the github-token credential slot before invoking the plugin.",
    );
  }

  octokit = new Octokit({
    auth: cachedToken,
    request: { fetch: createHostFetchAdapter(host) },
  }) as unknown as OctokitLike;
  return octokit;
}

export function resetOctokit(): void {
  octokit = null;
  tokenLoaded = false;
  cachedToken = null;
  injectedForTests = null;
}
