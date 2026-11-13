import type { QueryKey } from "@tanstack/react-query";
import type { InputChangedEvent, InputSurface } from "@roubo/shared";

/** How long an applied or refused input-change notice stays before it goes. */
export const INPUT_NOTICE_TIMEOUT_MS = 8_000;

/** The line a rejected notice ends with: the change did not replace the running one. */
export const LAST_GOOD_LINE = "Last good config is still live.";

const SURFACE_THINGS: Record<InputSurface, string> = {
  "project-config": "Project",
  plugin: "Plugin",
  settings: "Settings",
  bench: "Bench",
  github: "GitHub",
  environment: "Environment",
};

/** The word every notice about `surface` starts with. */
export function surfaceThing(surface: InputSurface): string {
  return SURFACE_THINGS[surface] ?? surface;
}

/**
 * The inputs a change can come from, each with its own query keys. A surface
 * that more than one input feeds is split by the event's `input`, the state
 * file it names: `project-config` comes from a project's roubo.yaml or from
 * projects.json (`projects`), and `plugin` from a plugin folder, from
 * plugins-consent.json (`consent`) or from plugins-state.json
 * (`plugin-state`). The other surfaces each have one input: settings.json for
 * `settings`, state.json for `bench-state`, auth.json for `auth` and .env for
 * `env`.
 */
export type ChangedInput =
  | "project-config"
  | "plugin"
  | "settings"
  | "projects"
  | "bench-state"
  | "auth"
  | "consent"
  | "plugin-state"
  | "env";

/** The input an event is about, or undefined for a surface this client does not know. */
export function changedInputOf(event: InputChangedEvent): ChangedInput | undefined {
  switch (event.surface) {
    case "project-config":
      return event.input === "projects.json" ? "projects" : "project-config";
    case "plugin":
      if (event.input === "plugins-consent.json") return "consent";
      if (event.input === "plugins-state.json") return "plugin-state";
      return "plugin";
    case "settings":
      return "settings";
    case "bench":
      return "bench-state";
    case "github":
      return "auth";
    case "environment":
      return "env";
    default:
      return undefined;
  }
}

/** The plugin whose credential slot a token put in auth.json goes into. */
const GITHUB_PLUGIN_ID = "github-com";

/** The detail keys of the benches an event names, or the prefix of them all when it names none. */
function benchKeys(event: InputChangedEvent): QueryKey[] {
  if (event.projectId === undefined || event.benchIds === undefined) return [["bench"]];
  return event.benchIds.map((benchId) => ["bench", event.projectId, benchId]);
}

/**
 * The React Query keys a change of each input refreshes (HR-FR-016). Only
 * these keys are invalidated: the rest of the cache, the screen, the
 * selection, the scroll position and any unsent form input stay as they are.
 */
export const INPUT_QUERY_KEYS: Record<ChangedInput, (event: InputChangedEvent) => QueryKey[]> = {
  // The raw config editor seeds its text from ["raw-config", projectId] once,
  // so a refetch refreshes the saved copy without discarding unsent edits.
  // ["project-settings", projectId] is not here: roubo.yaml does not feed it
  // (HR-TC-035).
  "project-config": (event) => [
    ["projects"],
    ...(event.projectId === undefined ? [] : [["raw-config", event.projectId]]),
    ["benches"],
  ],
  // ["agent-plugins"] is the AI Agents tab and the default-agent picker: a
  // plugin folder adds or swaps an agent plugin, and consent and the enable
  // state decide whether one is available, so each of those inputs refreshes it.
  plugin: () => [["plugins"], ["agent-plugins"], ["project-integration"], ["benches"]],
  settings: () => [["settings"]],
  projects: () => [["projects"], ["benches"], ["issues"]],
  // A bench's detail view reads ["bench", projectId, benchId], which
  // ["benches"] does not prefix-match.
  "bench-state": (event) => [["benches"], ...benchKeys(event)],
  // A token put in auth.json goes into the github-com credential slot: the
  // connection status and the repos and projects the token can see change.
  // ["project-integration"] is not here: it reads the project's integration
  // config and the plugin's process status, never the token. The event names
  // no project, so every project's derived sources are refreshed.
  auth: () => [
    ["settings"],
    ["issues"],
    ["plugin-connection-status", GITHUB_PLUGIN_ID],
    ["github-derived-sources"],
  ],
  consent: () => [["plugins"], ["agent-plugins"]],
  "plugin-state": () => [["plugins"], ["agent-plugins"]],
  // The Setup view lists the .env key names from ["env-keys"].
  env: () => [["settings"], ["env-keys"]],
};

/** The keys to refresh for one event; none for a surface this client does not know. */
export function inputChangedQueryKeys(event: InputChangedEvent): QueryKey[] {
  const input = changedInputOf(event);
  return input === undefined ? [] : INPUT_QUERY_KEYS[input](event);
}

/** `text` with every trailing full stop taken off. */
function withoutStop(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

/**
 * The one line of a notice. It starts with the surface's thing. A rejection
 * reads `<summary>. <path>: <first error>. Last good config is still live.`,
 * with one full stop after the summary and one after the first error, or
 * `<summary>. Last good config is still live.` when it carries no error. A
 * summary that already names the path and the first error is the whole
 * notice: its sender wrote the sentence, and says the last good config is
 * live only when the target has one, so nothing is added to it.
 */
export function inputNoticeText(event: InputChangedEvent): string {
  const thing = surfaceThing(event.surface);
  const summary = event.summary.trim();
  const head = summary.startsWith(thing) ? summary : `${thing} ${summary}`.trim();
  if (event.outcome !== "rejected") return head;
  const where = event.error ? `${event.error.path}: ${withoutStop(event.error.first)}` : undefined;
  if (where !== undefined && head.includes(where)) return head;
  const parts = [`${withoutStop(head)}.`];
  if (where !== undefined) parts.push(`${where}.`);
  parts.push(LAST_GOOD_LINE);
  return parts.join(" ");
}

/** Whether two events are about the same target of the same surface. */
export function sameInputTarget(a: InputChangedEvent, b: InputChangedEvent): boolean {
  return a.surface === b.surface && a.projectId === b.projectId && a.pluginId === b.pluginId;
}

type Listener = (event: InputChangedEvent) => void;

const listeners = new Set<Listener>();

/** Listen for input-changed events from the notification stream. */
export function subscribeInputChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hand one input-changed event to every listener, such as the notice list. */
export function publishInputChanged(event: InputChangedEvent): void {
  for (const listener of listeners) listener(event);
}
