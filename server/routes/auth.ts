import { Router } from "express";
import {
  buildAuthorizationUrl,
  clearStatusCache,
  deleteCredentials,
  exchangeCodeForToken,
  fetchGitHubUsername,
  getConnectionStatus,
  saveCredentials,
  validateState,
} from "../services/github-auth.js";
import { resetOctokit } from "../services/github.js";

const router = Router();

router.get("/authorize", (_req, res) => {
  try {
    const result = buildAuthorizationUrl();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/status", async (_req, res) => {
  try {
    const status = await getConnectionStatus();
    res.json(status);
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
    saveCredentials(token, username, scopes);
    resetOctokit();
    clearStatusCache();
    res.json({ ok: true, username });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete("/", (_req, res) => {
  try {
    deleteCredentials();
    resetOctokit();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
