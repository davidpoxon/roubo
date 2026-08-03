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
//   - the app-level jig files under `<rouboDir>/jigs/*.md`. `/test/__reset`
//     drops `projects.json`, `state.json`, the marketplace tree and the
//     integration overrides, and nothing else; a custom jig created by a spec
//     survives every reset and every server restart, so a spec that mints one
//     has to delete it again (AP-TC-020, NFR-018).

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
 * Write an agent's application-level defaults, the way the AI Agents card's
 * Save defaults button writes them. The body replaces the whole record rather
 * than merging, so this both sets a precondition and is the only thing needed to
 * unset one.
 */
export async function setAgentConfig(
  request: APIRequestContext,
  pluginId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`/api/agents/${pluginId}/config`, { data: { config } });
  expect(res.status(), `PUT /api/agents/${pluginId}/config`).toBe(200);
}

/**
 * An agent's application-level defaults as they were actually persisted, read
 * back through the real route rather than off disk. A spec asserting that a
 * per-launch override wrote nothing needs the saved record, not the form's
 * optimistic state (AP-TC-028 S004).
 */
export async function readAgentConfig(
  request: APIRequestContext,
  pluginId: string,
): Promise<Record<string, unknown>> {
  const res = await request.get(`/api/agents/${pluginId}/config`);
  expect(res.status(), `GET /api/agents/${pluginId}/config`).toBe(200);
  const body = (await res.json()) as { config?: Record<string, unknown> };
  return body.config ?? {};
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
  await setAgentConfig(request, pluginId, {});
}

/**
 * Write one project's override SUBSET for an agent, the way the project
 * settings > Agent overrides card writes it: a key present means the project
 * overrides that field, and `{}` clears every override for that plugin.
 *
 * The route 404s on an unregistered project, so this has to run AFTER
 * `/test/__register-fixture-project`. Like the app-level defaults, the file it
 * writes outlives `/test/__reset`, so a spec that sets one hands it back.
 */
export async function setProjectAgentOverride(
  request: APIRequestContext,
  projectId: string,
  pluginId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`/api/projects/${projectId}/agents/${pluginId}/config`, {
    data: { config },
  });
  expect(res.status(), `PUT /api/projects/${projectId}/agents/${pluginId}/config`).toBe(200);
}

/** One installed agent as the project-scoped route reports it. */
export interface ProjectAgentSnapshot {
  id: string;
  appDefaults?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  effective?: Record<string, unknown>;
}

/**
 * Every installed agent's app defaults, this project's override subset and the
 * overlay of the two, kept SEPARATE by the route. Reading the three apart is
 * what lets a spec say which layer a value came from (AP-TC-028 S004).
 */
export async function readProjectAgents(
  request: APIRequestContext,
  projectId: string,
): Promise<ProjectAgentSnapshot[]> {
  const res = await request.get(`/api/projects/${projectId}/agents`);
  expect(res.status(), `GET /api/projects/${projectId}/agents`).toBe(200);
  const body = (await res.json()) as { agents?: ProjectAgentSnapshot[] };
  return body.agents ?? [];
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

/** One custom jig as `POST /api/jigs` accepts it (`JigCreateRequest`). */
export interface AppJigInput {
  name: string;
  description: string;
  content: string;
  /**
   * The agent binding (AP-FR-006). Omitted leaves the jig unbound, which is how
   * a jig follows whichever agent is currently the default.
   */
  agentPluginId?: string;
}

/**
 * Create an app-level custom jig through the real route and answer its id.
 *
 * The id is read from the 201 body rather than assumed to be the name's slug,
 * because the slug rule is `jig-manager`'s business and a spec that restated it
 * would silently drift from it.
 *
 * Any jig already carrying this name is deleted first. Jigs outlive
 * `/test/__reset` (see the file header), so a run interrupted before its
 * cleanup would otherwise leave one behind and the next `POST` would fail with
 * DUPLICATE_NAME, turning one bad run into a permanently red spec (NFR-018).
 */
export async function createAppJig(
  request: APIRequestContext,
  input: AppJigInput,
): Promise<string> {
  const listRes = await request.get("/api/jigs");
  expect(listRes.status(), "GET /api/jigs").toBe(200);
  const existing = (await listRes.json()) as { id: string; name: string }[];
  for (const jig of existing) {
    if (jig.name === input.name) await deleteAppJig(request, jig.id);
  }

  const res = await request.post("/api/jigs", { data: input });
  expect(res.status(), `POST /api/jigs (${input.name})`).toBe(201);
  const created = (await res.json()) as { id: string };
  return created.id;
}

/** Delete an app-level jig. A jig that is already gone counts as success. */
export async function deleteAppJig(request: APIRequestContext, jigId: string): Promise<void> {
  const res = await request.delete(`/api/jigs/${jigId}`);
  expect([204, 404], `DELETE /api/jigs/${jigId}`).toContain(res.status());
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
