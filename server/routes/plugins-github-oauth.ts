import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchGitHubUsername,
  GITHUB_PLUGIN_ID,
  saveToken,
  validateState,
} from "../services/github-oauth.js";
import { refreshAuth } from "../services/github.js";
import { invalidateConnectionStatus } from "../services/plugin-manager.js";

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

router.post("/authorize", (_req, res) => {
  try {
    const result = buildAuthorizationUrl();
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
    const { token } = await exchangeCodeForToken(code);
    const username = await fetchGitHubUsername(token);
    await saveToken(token);
    await refreshAuth();
    // WU-031: drop the cached connection-status for github-com so the next UI
    // poll re-probes under the freshly-saved token (incl. its new scopes).
    invalidateConnectionStatus(GITHUB_PLUGIN_ID);
    res.json({ ok: true, username });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
