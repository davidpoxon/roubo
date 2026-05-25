import type {
  ConnectionState,
  GlobalPluginIntegrationState,
  IntegrationConfig,
  PluginRecord,
} from "@roubo/shared";

export type PrimaryActionLabel = "Connect" | "Configure" | "Sign in again";

/**
 * Derives the `ConnectionStatusPill` state from data already on the client
 * (the lifecycle `PluginRecord.status` and, when fetched, the effective
 * `IntegrationConfig` returned by `useGlobalPluginIntegration`).
 *
 * The `auth-problem` branch is intentionally unreachable here: surfacing it
 * needs a live `getConnectionStatus()` round-trip the client cannot make
 * today. Issue #204 tracks adding the `/api/plugins/:id/connection-status`
 * route, the `useConnectionStatus` hook, and the rechecking-state plumbing
 * so this helper can prefer live data over the derive-from-config fallback.
 */
export function derivePluginConnectionState(
  plugin: PluginRecord,
  integration?: GlobalPluginIntegrationState | undefined,
): ConnectionState {
  if (plugin.status === "disabled") return "disabled";
  if (plugin.status === "errored") return "errored";
  // Lifecycle errors (manifest invalid, host-API mismatch) get their own
  // dedicated banners on the tile; the chip falls back to `errored` so the
  // header still carries a non-green signal.
  if (plugin.status === "incompatible" || plugin.status === "invalid") return "errored";

  // status === "enabled": treat the plugin as connected if we have evidence
  // of a successful credential exchange. Until the live status query lands
  // (issue #204), absence-of-effective-config implies "not yet connected".
  return hasCredentials(integration?.effective) ? "connected" : "disconnected";
}

export function primaryActionLabelFor(state: ConnectionState): PrimaryActionLabel {
  switch (state) {
    case "disconnected":
    case "disabled":
      return "Connect";
    case "auth-problem":
      return "Sign in again";
    case "connected":
    case "errored":
    default:
      return "Configure";
  }
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
