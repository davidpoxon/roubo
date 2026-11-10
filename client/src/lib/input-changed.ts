import type { QueryKey } from "@tanstack/react-query";
import type { InputChangedEvent, InputSurface } from "@roubo/shared";

/** How long an applied or refused input-change notice stays before it goes. */
export const INPUT_NOTICE_TIMEOUT_MS = 8_000;

/** The line a rejected notice ends with: the change did not replace the running one. */
export const LAST_GOOD_LINE = "Last good configuration still in effect.";

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

function benchKeys(event: InputChangedEvent): QueryKey[] {
  if (event.projectId === undefined) return [];
  return (event.benchIds ?? []).map((benchId) => ["bench", event.projectId, benchId]);
}

/**
 * The React Query keys an input change of each surface refreshes (HR-FR-016).
 * Only these keys are invalidated: the rest of the cache, the screen, the
 * selection, the scroll position and any unsent form input stay as they are.
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
    ...benchKeys(event),
  ],
  plugin: () => [["plugins"], ["agent-plugins"], ["project-integration"]],
  settings: () => [["settings"]],
  bench: (event) => [["benches"], ...benchKeys(event)],
  github: (event) => [
    ...(event.projectId === undefined
      ? [["project-integration"]]
      : [
          ["project-integration", event.projectId],
          ["github-derived-sources", event.projectId],
        ]),
    ["project-items"],
  ],
  // The Setup view lists the .env key names, so a .env edit refreshes them.
  environment: (event) => [["benches"], ...benchKeys(event), ["env-keys"]],
};

/** The keys to refresh for one event; none for a surface this client does not know. */
export function inputChangedQueryKeys(event: InputChangedEvent): QueryKey[] {
  const keys = SURFACE_QUERY_KEYS[event.surface];
  return keys ? keys(event) : [];
}

/**
 * The one line of a notice. It starts with the surface's thing; a rejection
 * adds the file path, the first validation error and the last-good line. A
 * summary that already names the path and the first error is the whole
 * notice: its sender wrote the sentence, and says the last good config is
 * live only when the target has one, so nothing is added to it.
 */
export function inputNoticeText(event: InputChangedEvent): string {
  const thing = surfaceThing(event.surface);
  const summary = event.summary.trim();
  const head = summary.startsWith(thing) ? summary : `${thing} ${summary}`.trim();
  if (event.outcome !== "rejected") return head;
  if (event.error && head.includes(`${event.error.path}: ${event.error.first}`)) return head;
  const where = event.error ? `: ${event.error.path}: ${event.error.first}` : "";
  return `${head}${where}. ${LAST_GOOD_LINE}`;
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
