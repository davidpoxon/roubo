import { z } from "zod";
import type { PluginPermissions } from "./plugin-manifest-schema.js";

// Issue #615 / CP-FR-011, CP-FR-012, CP-NFR-001. Per-plugin consent record.
// See:
//   .specifications/component-plugins/prd.md (CP-FR-011, CP-FR-012, CP-NFR-001)
//   .specifications/component-plugins/architecture.md ('Data model', lines 61, 108-109)
//
// v1 ships the declare-then-enforce trust model's declaration half: the consumer
// is shown every declared permission category and must acknowledge them before a
// component plugin runs. A ConsentRecord captures that acknowledgement so the
// server can refuse to start a component whose plugin has none. v2 adds runtime
// enforcement and sandboxing; this record is advisory in v1.

export const PLUGIN_CONSENT_STATE_SCHEMA_VERSION = 1 as const;

// The advisory permission categories a component plugin can declare. Kept in one
// place so the consent store, the route, and the UI agree on the canonical set.
export const PERMISSION_CATEGORIES = [
  "network",
  "credentials",
  "filesystem",
  "processes",
  "ports",
  "docker",
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export const ConsentRecordSchema = z
  .object({
    pluginId: z.string().min(1),
    acknowledgedCategories: z.array(z.string().min(1)),
    consentedAt: z.string().min(1),
  })
  .strict();
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

export const PluginConsentStateSchema = z
  .object({
    schemaVersion: z.literal(PLUGIN_CONSENT_STATE_SCHEMA_VERSION),
    plugins: z.record(z.string().min(1), ConsentRecordSchema),
  })
  .strict();
export type PluginConsentState = z.infer<typeof PluginConsentStateSchema>;

/**
 * Enumerates the permission categories a manifest actually declares, i.e. the
 * categories the consumer must acknowledge before the plugin may run. A category
 * is "declared" only when it requests something: an empty `network.hosts`,
 * `credentials.slots`, or `filesystem.paths`, a `false` `processes` / `ports` /
 * `docker`, or an absent optional category all count as not-declared and so do
 * not require acknowledgement.
 *
 * Order follows PERMISSION_CATEGORIES so the UI and the route render a stable
 * sequence.
 */
export function declaredCategories(permissions: PluginPermissions): PermissionCategory[] {
  const declared: PermissionCategory[] = [];
  if (permissions.network.hosts.length > 0) declared.push("network");
  if (permissions.credentials.slots.length > 0) declared.push("credentials");
  if (permissions.filesystem.paths.length > 0) declared.push("filesystem");
  if (permissions.processes !== false) declared.push("processes");
  if (permissions.ports !== undefined && permissions.ports !== false) declared.push("ports");
  if (permissions.docker !== undefined && permissions.docker !== false) declared.push("docker");
  return declared;
}

/**
 * True when every category the manifest declares appears in `acknowledged`.
 * Extra acknowledged categories are tolerated (forward-compatible); the gate is
 * only that no declared category is missing. Used by the POST /consent route to
 * reject a body that omits any declared category (400).
 */
export function isFullyAcknowledged(
  permissions: PluginPermissions,
  acknowledged: readonly string[],
): boolean {
  const ack = new Set(acknowledged);
  return declaredCategories(permissions).every((cat) => ack.has(cat));
}
