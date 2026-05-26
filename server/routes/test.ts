import { Router, type Request, type Response } from "express";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";

const router: Router = Router();

const SCENARIO_NAME_RE = /^[a-z][a-z0-9-]*$/;

interface ResetBody {
  scenario?: unknown;
  now?: unknown;
}

interface ParsedResetConfig {
  scenario: string | null;
  now: string | null;
}

// Parse the optional { scenario, now } body that Playwright specs pass to pin
// the stubbed plugin to a specific scenario pack and frozen-now ISO. Returns
// the parsed config on success; returns an error message on validation failure
// so the caller can respond with 400.
function parseResetBody(body: ResetBody | undefined): ParsedResetConfig | string {
  const scenarioRaw = body?.scenario;
  const nowRaw = body?.now;
  let scenario: string | null = null;
  let now: string | null = null;
  if (scenarioRaw !== undefined && scenarioRaw !== null) {
    if (typeof scenarioRaw !== "string" || !SCENARIO_NAME_RE.test(scenarioRaw)) {
      return "scenario must be a kebab-case string matching /^[a-z][a-z0-9-]*$/";
    }
    scenario = scenarioRaw;
  }
  if (nowRaw !== undefined && nowRaw !== null) {
    if (typeof nowRaw !== "string") return "now must be an ISO-8601 string";
    const parsed = new Date(nowRaw);
    if (Number.isNaN(parsed.getTime())) return "now must be a parseable ISO-8601 string";
    now = nowRaw;
  }
  return { scenario, now };
}

// POST /test/__reset (FR-079): wipe module-level singletons so Playwright
// specs can start from a clean state without restarting the server. Gated by
// ROUBO_E2E so production builds return 404 for this URL. The e2e harness
// sets ROUBO_E2E=1 when launching the test server.
//
// Optional JSON body { scenario?, now? } pins the stubbed plugin (WU-063): the
// values are passed to plugin-manager so the next spawn appends them as
// --scenario / --now argv. Omitting the body resets the pinning to defaults.
router.post("/__reset", async (req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }

  const parsed = parseResetBody(req.body as ResetBody | undefined);
  if (typeof parsed === "string") {
    return res.status(400).json({ error: parsed });
  }

  try {
    migrate.__test.reset();
    githubOauth.__test.reset();
    // Clear the connection-status cache before shutdown. shutdown() itself
    // clears `plugins` and `enableStateCache` but leaves the status maps
    // populated, which would otherwise survive the reset.
    pluginManager.__test.resetConnectionStatusCache();
    // WU-064: also clear the state-transition journal so TC-169 starts from
    // an empty log. Remove this when #221 (TC-153) lands and the journal +
    // /test/__connection-state-log route are replaced by durable logging.
    pluginManager.__test.resetConnectionStateLog();
    await pluginManager.shutdown();
    // Reload project-registry before re-initializing plugin-manager so
    // discovery sees the right project set.
    projectRegistry.__test.reset();
    projectRegistry.initialize();
    // Apply the pinning AFTER project-registry init and BEFORE plugin-manager
    // initialize: initialize() is what spawns the plugin processes, and the
    // pinning must be in place at spawn time so spawnPlugin sees it.
    pluginManager.__test.setE2EConfig(parsed);
    await pluginManager.initialize();
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/test/__reset failed:", message);
    res.status(500).json({ error: message });
  }
});

// WU-064: read the in-memory connection-state transition journal. Gated by
// ROUBO_E2E so production builds return 404 for this URL. This is a stand-in
// for the production-grade observability logging tracked by #221 (TC-153);
// remove the route and the journal together when that lands.
router.get("/__connection-state-log", (_req: Request, res: Response) => {
  if (process.env.ROUBO_E2E !== "1") {
    return res.status(404).end();
  }
  res.status(200).json({ entries: pluginManager.__test.getConnectionStateLog() });
});

export default router;
