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
 * The React Query keys an input change of each surface refreshes (HR-FR-016).
 * Only these keys are invalidated: the rest of the cache, the screen, the
 * selection, the scroll position and any unsent form input stay as they are.
 * Each surface takes the keys of the input it reports: a project's roubo.yaml
 * for `project-config`, a plugin folder for `plugin` (whose consent and
 * enable-state files refresh `["plugins"]`, a subset of it), settings.json for
 * `settings`, state.json for `bench`, auth.json for `github` and .env for
 * `environment`.
 */
export const SURFACE_QUERY_KEYS: Record<InputSurface, (event: InputChangedEvent) => QueryKey[]> = {
  // The raw config editor seeds its text from ["raw-config", projectId] once,
  // so a refetch refreshes the saved copy without discarding unsent edits.
  // ["project-settings", projectId] is not here: roubo.yaml does not feed it
  // (HR-TC-035).
  "project-config": (event) => [
    ["projects"],
    ...(event.projectId === undefined ? [] : [["raw-config", event.projectId]]),
    ["benches"],
  ],
  plugin: () => [["plugins"], ["project-integration"], ["benches"]],
  settings: () => [["settings"]],
  bench: () => [["benches"]],
  github: () => [["settings"], ["issues"]],
  environment: () => [["settings"]],
};

/** The keys to refresh for one event; none for a surface this client does not know. */
export function inputChangedQueryKeys(event: InputChangedEvent): QueryKey[] {
  const keys = SURFACE_QUERY_KEYS[event.surface];
  return keys ? keys(event) : [];
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
