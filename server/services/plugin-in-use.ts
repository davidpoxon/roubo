// The refusal of a plugin removal while a bench uses the plugin (HR-FR-010).
//
// It lives apart from plugin-manager so the plugins route, and its tests, use
// the real error and copy even where plugin-manager is replaced by a stub.

// "bench 2" for one bench, "benches 2 and 5" or "benches 2, 3 and 5" for more.
// The swap and update notices of plugin-dir-watch name their benches with it too.
export function benchList(benchIds: number[]): string {
  if (benchIds.length === 1) return `bench ${benchIds[0]}`;
  const ids = benchIds.map(String);
  return `benches ${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/**
 * The error of a refused removal, as the 409 body carries it: "Plugin database
 * is in use by benches 2 and 5". It names the plugin by id.
 */
export function pluginInUseMessage(pluginId: string, benchIds: number[]): string {
  return `Plugin ${pluginId} is in use by ${benchList(benchIds)}`;
}

/**
 * The notice a refused removal shows: "Plugin database not removed. Benches 2
 * and 5 use it. Clear those benches first." It names the plugin by id and each
 * bench that uses it, so the user knows which benches to clear first.
 */
export function pluginInUseNotice(pluginId: string, benchIds: number[]): string {
  const benches = benchList(benchIds);
  const subject = benches.charAt(0).toUpperCase() + benches.slice(1);
  return benchIds.length === 1
    ? `Plugin ${pluginId} not removed. ${subject} uses it. Clear that bench first.`
    : `Plugin ${pluginId} not removed. ${subject} use it. Clear those benches first.`;
}

/**
 * Thrown by plugin-manager's `uninstall` while a bench uses the plugin. Its
 * message is the body error and `notice` the text to show; the route answers
 * it with 409 `{ error, code: 'plugin-in-use', benchIds, notice }`.
 */
export class PluginInUseError extends Error {
  readonly code = "plugin-in-use";
  readonly pluginId: string;
  readonly benchIds: number[];
  readonly notice: string;

  constructor(pluginId: string, benchIds: number[]) {
    super(pluginInUseMessage(pluginId, benchIds));
    this.name = "PluginInUseError";
    this.pluginId = pluginId;
    this.benchIds = benchIds;
    this.notice = pluginInUseNotice(pluginId, benchIds);
  }
}
