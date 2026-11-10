/**
 * What a change of the app-level settings changed, as the names a notice
 * shows (HR-FR-011): "Settings applied: default agent." The server reads every
 * setting per request, so a change applies to the next request with no
 * relaunch, and the notice says which settings it now applies.
 */
import type { UserPreferences } from "@roubo/shared";
import { canonicalize } from "../lib/canonical-json.js";
import { broadcastInputChanged } from "./sse.js";

/** Each setting a notice can name, in the order a notice names them, with how to read it. */
const SETTING_NAMES: ReadonlyArray<readonly [string, (s: UserPreferences) => unknown]> = [
  ["theme", (s) => s.theme],
  ["default agent", (s) => s.jigs?.defaultAgentPluginId],
  ["default jig", (s) => s.jigs?.defaultJigId],
  ["jig auto-inject", (s) => s.jigs?.autoInject],
  ["jig auto-execute", (s) => s.jigs?.autoExecute],
  ["issue type mappings", (s) => s.jigs?.issueTypeMappings],
  ["agent tools", (s) => s.agentTools ?? []],
  ["issue dependencies", (s) => s.benches?.enforceIssueDependencies],
  ["component auto-start", (s) => s.benches?.autoStartComponents],
  ["bench limit", (s) => s.benches?.maxGlobal],
  ["TestBench", (s) => s.testBench?.enabled],
  ["issue type cache", (s) => s.github?.issueTypesCacheTtlSeconds],
];

/** The names of the settings that differ between `before` and `after`. */
export function changedSettingNames(before: UserPreferences, after: UserPreferences): string[] {
  return SETTING_NAMES.filter(
    ([, read]) => canonicalize(read(before) ?? null) !== canonicalize(read(after) ?? null),
  ).map(([name]) => name);
}

/** "Settings applied: default agent." or, naming none, "Settings applied." */
export function settingsAppliedNotice(names: readonly string[]): string {
  return names.length === 0 ? "Settings applied." : `Settings applied: ${names.join(", ")}.`;
}

/**
 * Send the applied notice of a settings change the app made, such as a save
 * in Settings. The app's write of settings.json is a self-write, so the state
 * dir watch sends nothing for it. A save that changes no setting sends none.
 */
export function announceSettingsChange(before: UserPreferences, after: UserPreferences): void {
  const names = changedSettingNames(before, after);
  if (names.length === 0) return;
  broadcastInputChanged({
    surface: "settings",
    outcome: "applied",
    summary: settingsAppliedNotice(names),
  });
}
