import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchGitHubUsername,
  GITHUB_PLUGIN_ID,
  GITHUB_TOKEN_SLOT,
  REQUIRED_SCOPES,
  saveToken,
  validateState,
} from "../services/github-oauth.js";
import { refreshAuth } from "../services/github.js";
import { invalidateConnectionStatus } from "../services/plugin-manager.js";
import * as credentialStore from "../services/credential-store.js";

const router = Router();

// Defence-in-depth rate limit on the OAuth surface. Roubo runs as a
// localhost-only service, but these routes touch the credential store and
// the GitHub OAuth exchange endpoint, so we cap requests per minute per IP
// to prevent runaway loops or a misbehaving caller from hammering GitHub.
const oauthRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.use(oauthRateLimiter);

// WU-036: maps the granted `security_events` scope back to the alert
// categories it unlocks. The host emits this on /exchange success so a
// "Connection upgraded" UI flip can be correlated with a structured log line
// (architecture addendum line 952).
const SECURITY_EVENTS_CATEGORIES = ["code-scanning", "secret-scanning", "dependabot"] as const;

router.post("/authorize", (_req, res) => {
  try {
    const result = buildAuthorizationUrl();
    // WU-036: surface the scope set without logging the authorize URL itself.
    // The URL embeds a single-use `state` nonce and must not appear in any
    // host log surface (github-oauth.ts:34–36).
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

// Called by the Electron main process after receiving a roubo://oauth/github/callback deep-link.
router.post("/exchange", async (req, res) => {
  const code = typeof req.body.code === "string" ? req.body.code : undefined;
  const state = typeof req.body.state === "string" ? req.body.state : undefined;

  if (!code || !state) {
    res.status(400).json({ error: "Missing required parameters" });
    return;
  }

  if (!validateState(state)) {
    res.status(400).json({ error: "Invalid or expired OAuth state" });
    return;
  }

  try {
    const { token, scopes } = await exchangeCodeForToken(code);
    const username = await fetchGitHubUsername(token);
    await saveToken(token);
    await refreshAuth();
    // WU-031: drop the cached connection-status for github-com so the next UI
    // poll re-probes under the freshly-saved token (incl. its new scopes).
    invalidateConnectionStatus(GITHUB_PLUGIN_ID);
    // WU-036: architecture addendum line 952. Emit the granted scopes and
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
    res.json({ ok: true, username });
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
    await refreshAuth();
    invalidateConnectionStatus(GITHUB_PLUGIN_ID);
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
