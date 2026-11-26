import { z } from "zod";

// WU-046 / #164: persistent per-plugin enable state. See:
//   .specifications/integration-plugins/prd.md (FR-059, FR-060, NFR-019, US-016)
//   .specifications/integration-plugins/architecture.md (lines 1064-1097)

export const PLUGIN_ENABLE_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Manifest ids of the bundled plugins shipped in `<repo>/plugins/`. The
 * greenfield migration path seeds `plugins-state.json` with one `"disabled"`
 * entry per id so a fresh install opts in to each integration explicitly.
 */
export const BUNDLED_PLUGIN_IDS = ["github-com", "ghe", "jira-self-hosted"] as const;
export type BundledPluginId = (typeof BUNDLED_PLUGIN_IDS)[number];

/**
 * `"awaiting-consent"` marks a component or agent plugin in the user plugins
 * root that has no ConsentRecord (HR-FR-008): one the plugins directory watch
 * registered from disk, or one that launch found with no consent. It is not
 * started, also after a relaunch, until consent is granted, which turns it
 * `"enabled"`.
 *
 * `"disabled-awaiting-consent"` marks such a held plugin that the user
 * disabled during its hold. It is disabled everywhere, and enable and restart
 * refuse it, also after a relaunch, until consent is granted, which turns it
 * `"disabled"`: the user's disable survives the grant. Launch holds each such
 * plugin with no ConsentRecord whatever its value, so a plain `"enabled"` or
 * `"disabled"` stands for a plugin that has consent, or for a bundled or
 * integration plugin, which is never held.
 */
export const PluginEnableStateValueSchema = z.enum([
  "enabled",
  "disabled",
  "awaiting-consent",
  "disabled-awaiting-consent",
]);
export type PluginEnableStateValue = z.infer<typeof PluginEnableStateValueSchema>;

export const PluginEnableStateSchema = z
  .object({
    schemaVersion: z.literal(PLUGIN_ENABLE_STATE_SCHEMA_VERSION),
    plugins: z.record(z.string().min(1), PluginEnableStateValueSchema),
    // Sentinel that this install has been through the greenfield seeding pass.
    // Prevents re-seeding a fresh-cloned alpha install that happens to look
    // greenfield. Set to true at the same atomic write that seeds `plugins`.
    installInitialized: z.boolean(),
  })
  .strict();
export type PluginEnableState = z.infer<typeof PluginEnableStateSchema>;
