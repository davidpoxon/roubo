import type { ConnectionState, IntegrationConfig, PluginStatus } from "@roubo/shared";

export type PrimaryActionLabel = "Connect" | "Configure" | "Sign in again";

const PRIMARY_ACTION_LABELS: Record<ConnectionState, PrimaryActionLabel> = {
  connected: "Configure",
  errored: "Configure",
  disconnected: "Connect",
  disabled: "Connect",
  "auth-problem": "Sign in again",
};

/**
 * Derives the `ConnectionStatusPill` state from data already on the client
 * (the plugin's lifecycle `status` and, when fetched, the effective
 * `IntegrationConfig`). Accepts a bare `PluginStatus | null` so the global
 * `PluginCard` (`PluginRecord.status`) and the per-project `IssueSourceTile`
 * (`ProjectIntegrationState["plugin"].status`) can share one helper.
 *
 * The `auth-problem` branch is intentionally unreachable here: surfacing it
 * needs a live `getConnectionStatus()` round-trip the client cannot make
 * today. Issue #204 tracks adding the `/api/plugins/:id/connection-status`
 * route, the `useConnectionStatus` hook, and the rechecking-state plumbing
 * so this helper can prefer live data over the derive-from-config fallback.
 */
export function derivePluginConnectionState(
  status: PluginStatus | null,
  effective?: IntegrationConfig | undefined,
): ConnectionState {
  if (status === "disabled") return "disabled";
  if (status === "errored") return "errored";
  // Lifecycle errors (manifest invalid, host-API mismatch) get their own
  // dedicated banners on the tile; the chip falls back to `errored` so the
  // header still carries a non-green signal.
  if (status === "incompatible" || status === "invalid") return "errored";

  // status === "enabled" (or null, which only occurs for not-yet-loaded
  // installed plugins on the project tile): treat as connected if we have
  // evidence of a successful credential exchange. Until the live status
  // query lands (issue #204), absence-of-effective-config implies
  // "not yet connected".
  return hasCredentials(effective) ? "connected" : "disconnected";
}

export function primaryActionLabelFor(state: ConnectionState): PrimaryActionLabel {
  return PRIMARY_ACTION_LABELS[state];
}

function hasCredentials(effective: IntegrationConfig | undefined): boolean {
  if (!effective) return false;
  if (effective.capturedUserId) return true;
  // Instance-based plugins (GHE, Jira) may show "connected" once the user has
  // saved an instance URL even before the first successful auth round-trip.
  // This is intentionally optimistic; #204 will replace it with a real probe.
  if (typeof effective.instance === "string" && effective.instance.length > 0) return true;
  return false;
}
