import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  fetchGitHubUsername,
  GITHUB_PLUGIN_ID,
  GITHUB_TOKEN_SLOT,
  pollDeviceFlow,
  REQUIRED_SCOPES,
  saveToken,
  startDeviceFlow,
} from "../services/github-oauth.js";
import { invalidateConnectionStatus, invoke } from "../services/plugin-manager.js";
import * as credentialStore from "../services/credential-store.js";

const router = Router();

// Defence-in-depth rate limit on the OAuth surface. Roubo runs as a
// localhost-only service, but these routes touch the credential store and
// the GitHub OAuth endpoints, so we cap requests per minute per IP to prevent
// runaway loops or a misbehaving caller from hammering GitHub. A device-flow
// poll every 5 seconds is 12 requests a minute, well inside the cap.
const oauthRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.use(oauthRateLimiter);

// IP-WU-036: maps the granted `security_events` scope back to the alert
// categories it unlocks. The host emits this when a device flow completes so a
// "Connection upgraded" UI flip can be correlated with a structured log line
// (architecture addendum line 952).
const SECURITY_EVENTS_CATEGORIES = ["code-scanning", "secret-scanning", "dependabot"] as const;

// Best-effort: tell the github-com plugin process to drop its cached Octokit and
// alerts-runtime token after the credential changes, so the next source-bound
// RPC (listSourceCandidates, listIssues, ...) re-reads the freshly saved or
// cleared token instead of a client cached before the rotation. The plugin
// process caches a valid token for its lifetime, so without this the derived-
// sources preview and Cut List keep using the pre-disconnect token until a
// validateConfig happens to run. A failure here (plugin not running, RPC error)
// must never break the OAuth flow, so it is swallowed with a structured warning.
async function resetGithubPluginAuthCache(): Promise<void> {
  try {
    await invoke(GITHUB_PLUGIN_ID, "setActiveConfig", { config: {} });
  } catch (err) {
    console.warn(
      JSON.stringify({
        kind: "oauth-plugin-reset-failed",
        pluginId: GITHUB_PLUGIN_ID,
        error: (err as Error).message,
      }),
    );
  }
}

// Starts a device flow. The response carries the user code and the URL where
// the user enters it; the device code stays in the server, keyed by flowId.
router.post("/device", async (_req, res) => {
  try {
    const result = await startDeviceFlow();
    // IP-WU-036: surface the scope set without logging the user code, which
    // approves the sign-in for whoever holds it (github-oauth.ts).
    console.info(
      JSON.stringify({
        kind: "oauth-authorize",
        scopesRequested: REQUIRED_SCOPES,
      }),
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Polled by the renderer at the interval the flow returned. One GitHub request
// per call at most; on approval the token is saved here and never returned.
router.post("/device/poll", async (req, res) => {
  const flowId = typeof req.body?.flowId === "string" ? req.body.flowId : undefined;
  if (!flowId) {
    res.status(400).json({ error: "Missing required parameters" });
    return;
  }

  try {
    const result = await pollDeviceFlow(flowId);
    if (result.status !== "complete") {
      res.json(result);
      return;
    }

    const { token, scopes } = result;
    const username = await fetchGitHubUsername(token);
    await saveToken(token);
    // IP-WU-031: drop the cached connection-status for github-com so the next UI
    // poll re-probes under the freshly-saved token (incl. its new scopes).
    invalidateConnectionStatus(GITHUB_PLUGIN_ID);
    await resetGithubPluginAuthCache();
    // IP-WU-036: architecture addendum line 952. Emit the granted scopes and
    // the alert categories this re-consent unlocks (empty when the user did
    // not grant `security_events`, so a connection that never enabled any
    // category produces a zero-category line rather than no line at all).
    const reconsentForCategories = scopes.includes("security_events")
      ? [...SECURITY_EVENTS_CATEGORIES]
      : [];
    console.info(
      JSON.stringify({
        kind: "oauth-exchange",
        scopesGranted: scopes,
        reconsentForCategories,
      }),
    );
    res.json({ status: "complete", username });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Clears the persisted github-com token. Idempotent: calling it when no token
// is stored still resolves cleanly. After deletion the next connection-status
// poll reports `auth-problem`, which the Configure modal renders as the
// disconnected state.
router.post("/disconnect", async (_req, res) => {
  try {
    await credentialStore.deleteSlot(GITHUB_PLUGIN_ID, GITHUB_TOKEN_SLOT);
    invalidateConnectionStatus(GITHUB_PLUGIN_ID);
    await resetGithubPluginAuthCache();
    console.info(
      JSON.stringify({
        kind: "oauth-disconnect",
        pluginId: GITHUB_PLUGIN_ID,
      }),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
