import { Router, type Request, type Response } from "express";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";

const router: Router = Router();

// POST /test/__reset (FR-079): wipe module-level singletons so Playwright
// specs can start from a clean state without restarting the server. Gated by
// ROUBO_E2E so production builds return 404 for this URL. The e2e harness
// sets ROUBO_E2E=1 when launching the test server.
router.post("/__reset", async (_req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }

  try {
    migrate.__test.reset();
    githubOauth.__test.reset();
    // Clear the connection-status cache before shutdown. shutdown() itself
    // clears `plugins` and `enableStateCache` but leaves the status maps
    // populated, which would otherwise survive the reset.
    pluginManager.__test.resetConnectionStatusCache();
    await pluginManager.shutdown();
    // Reload project-registry before re-initializing plugin-manager so
    // discovery sees the right project set.
    projectRegistry.__test.reset();
    projectRegistry.initialize();
    await pluginManager.initialize();
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__reset failed:", message);
    res.status(500).json({ error: message });
  }
});

export default router;
