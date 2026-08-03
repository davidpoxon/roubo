import { expect, type APIRequestContext } from "@playwright/test";

// Shared setup for the agent-plugin e2e specs (issue #681).
//
// Every helper here drives a REAL API route rather than touching disk, for the
// same reason the AP-TC-087 guard clears its Claude defaults through
// `PUT /api/agents/:id/config`: the state these specs depend on outlives
// `/test/__reset`, so it has to be set (and unset) the way the app itself would.
//
// What /test/__reset does NOT clear, and therefore what these helpers exist for:
//
//   - `settings.json`, which holds both the default agent
//     (`jigs.defaultAgentPluginId`, AP-FR-005) and the app-level agent tool
//     presets (`agentTools`, AP-FR-008). A default left behind by one spec would
//     silently satisfy the next one's precondition (NFR-018).
//   - `plugins-consent.json`. Consent has no revoke route and survives the
//     server process, which is why the second-agent fixture is gated on the
//     ENABLE ledger instead: see `OPT_IN_AGENT_FIXTURE_PLUGIN_IDS` in
//     server/routes/test.ts.

/** The argv-capturing agent overlay: the one these specs actually launch. */
export const CLAUDE_PLUGIN_ID = "claude-code";
export const CLAUDE_AGENT_NAME = "Claude Code";

/**
 * The second agent overlay (added for AP-TC-113), reused here so the
 * default-agent picker has a choice to make (AP-TC-018). Force-disabled by every
 * `/test/__reset`, so a spec that wants it must call {@link enablePlugin} first
 * and hand it back disabled.
 */
export const CODEX_PLUGIN_ID = "codex-cli";
export const CODEX_AGENT_NAME = "Codex CLI";

/** The `agent` binding value that follows the default agent (AP-FR-009). */
export const DEFAULT_AGENT_BINDING = "default";

interface JigSettings {
  autoInject?: boolean;
  autoExecute?: boolean;
  defaultJigId?: string;
  defaultAgentPluginId?: string;
}

interface SettingsSnapshot {
  theme?: string;
  jigs?: JigSettings;
}

/** One app-level agent tool preset, as `PUT /api/settings` accepts it. */
export interface AppAgentToolInput {
  id: string;
  name: string;
  agent: string;
  params?: Record<string, unknown>;
  jig?: string;
}

async function readSettings(request: APIRequestContext): Promise<SettingsSnapshot> {
  const res = await request.get("/api/settings");
  expect(res.status(), "GET /api/settings").toBe(200);
  return (await res.json()) as SettingsSnapshot;
}

/**
 * The `jigs` block as `PUT /api/settings` requires it: both booleans are
 * mandatory, and each default is only sent when it has a value, because the
 * route reads an absent key as "no default chosen".
 */
function jigsPayload(current: JigSettings | undefined, defaultAgentPluginId: string | null) {
  return {
    autoInject: current?.autoInject ?? true,
    autoExecute: current?.autoExecute ?? true,
    ...(current?.defaultJigId != null && { defaultJigId: current.defaultJigId }),
    // An explicit null clears it: the route drops any nullish default rather
    // than persisting it.
    defaultAgentPluginId,
  };
}

/**
 * Pin (or, with `null`, clear) the app-level default agent. Every spec here sets
 * it explicitly instead of leaning on the "exactly one available agent is the
 * default" fallback, because a spec that installs a second agent removes that
 * fallback for itself and for whatever runs next.
 */
export async function setDefaultAgent(
  request: APIRequestContext,
  pluginId: string | null,
): Promise<void> {
  const current = await readSettings(request);
  const res = await request.put("/api/settings", {
    data: {
      theme: current.theme ?? "dark",
      jigs: jigsPayload(current.jigs, pluginId),
    },
  });
  expect(res.status(), `PUT /api/settings (default agent = ${pluginId ?? "none"})`).toBe(200);
}

/** Replace the app-level agent tool presets. Pass `[]` to clear them. */
export async function setAppAgentTools(
  request: APIRequestContext,
  agentTools: AppAgentToolInput[],
): Promise<void> {
  const current = await readSettings(request);
  const res = await request.put("/api/settings", {
    data: { theme: current.theme ?? "dark", agentTools },
  });
  expect(res.status(), "PUT /api/settings (agentTools)").toBe(200);
}

/** The app-level agent tool presets as they were actually persisted. */
export async function readAppAgentTools(
  request: APIRequestContext,
): Promise<Record<string, unknown>[]> {
  const res = await request.get("/api/settings");
  expect(res.status(), "GET /api/settings").toBe(200);
  const body = (await res.json()) as { agentTools?: Record<string, unknown>[] };
  return body.agentTools ?? [];
}

/** One app-level jig, as `POST /api/jigs` accepts it. */
export interface AppJigInput {
  name: string;
  description: string;
  content: string;
}

/**
 * Create an app-level jig through the real route, and answer the id the server
 * minted for it (`slugify(name)`, jig-manager.ts).
 *
 * App jigs live in `~/.roubo-dev/<checkout>/jigs/*.md`, which `/test/__reset`
 * does not clear, so a jig created here has to be removed by the spec that
 * created it (see {@link deleteAppJig}) or the next run's create fails as a
 * duplicate name and the leftover shows up in every other spec's jig picker
 * (NFR-018).
 */
export async function createAppJig(request: APIRequestContext, jig: AppJigInput): Promise<string> {
  const res = await request.post("/api/jigs", { data: jig });
  expect(res.status(), `POST /api/jigs (${jig.name})`).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/**
 * Remove an app-level jig. A 404 is success: the point is that the jig is gone,
 * and a teardown that throws on an already-absent jig would mask the failure the
 * test itself is reporting.
 */
export async function deleteAppJig(request: APIRequestContext, jigId: string): Promise<void> {
  const res = await request.delete(`/api/jigs/${jigId}`);
  expect([204, 404], `DELETE /api/jigs/${jigId}`).toContain(res.status());
}

/**
 * Acknowledge an agent overlay's declared permissions. All of them declare an
 * empty permission set (no hosts, no credential slots, no filesystem paths,
 * `processes: false`), so the acknowledgement set is empty, but the record still
 * has to exist: `resolveAgent` refuses an unconsented agent before it ever hands
 * out a connection, so without this the agent reads unavailable everywhere.
 */
export async function consentAgent(request: APIRequestContext, pluginId: string): Promise<void> {
  const res = await request.post(`/api/plugins/${pluginId}/consent`, {
    data: { acknowledgedCategories: [] },
  });
  expect(res.status(), `POST /api/plugins/${pluginId}/consent`).toBe(200);
}

/**
 * Drop an agent's application-level defaults.
 *
 * They live in `~/.roubo-dev/<checkout>/agents/_global/` and are NOT among the
 * files `/test/__reset` truncates, so defaults saved by an earlier spec (the
 * AP-TC-087 journey saves model/effort/mode/extraArgs and leaves them there)
 * would otherwise layer under every launch this directory asserts an argv for.
 */
export async function clearAgentConfig(
  request: APIRequestContext,
  pluginId: string,
): Promise<void> {
  const res = await request.put(`/api/agents/${pluginId}/config`, { data: { config: {} } });
  expect(res.status(), `PUT /api/agents/${pluginId}/config (clear defaults)`).toBe(200);
}

/** Enable a plugin through the real route, spawning it. Answers 204. */
export async function enablePlugin(request: APIRequestContext, pluginId: string): Promise<void> {
  const res = await request.post(`/api/plugins/${pluginId}/enable`);
  expect(res.status(), `POST /api/plugins/${pluginId}/enable`).toBe(204);
}

/** Disable a plugin through the real route. Answers 204. */
export async function disablePlugin(request: APIRequestContext, pluginId: string): Promise<void> {
  const res = await request.post(`/api/plugins/${pluginId}/disable`);
  expect(res.status(), `POST /api/plugins/${pluginId}/disable`).toBe(204);
}

/**
 * Block until the named agents all report `unavailable: null` on the real
 * inventory route, i.e. installed, compatible, consented and running. Enabling a
 * plugin spawns a child process, so the screen under test can otherwise render
 * before the agent it is about is resolvable.
 */
export async function waitForAvailableAgents(
  request: APIRequestContext,
  pluginIds: string[],
): Promise<void> {
  let seen = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await request.get("/api/agents");
    if (res.status() === 200) {
      const body = (await res.json()) as {
        agents: { id: string; unavailable: { reason: string } | null }[];
      };
      seen = body.agents.map((a) => `${a.id}=${a.unavailable?.reason ?? "available"}`).join(", ");
      const available = new Set(
        body.agents.filter((a) => a.unavailable === null).map((agent) => agent.id),
      );
      if (pluginIds.every((id) => available.has(id))) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Agents never became available: expected ${pluginIds.join(", ")}; saw ${seen}`);
}
