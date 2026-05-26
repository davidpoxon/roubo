import type {
  ConnectionState,
  ConnectionStatus,
  IntegrationConfig,
  PluginStatus,
} from "@roubo/shared";

export type PrimaryActionLabel = "Connect" | "Configure" | "Sign in again";

const PRIMARY_ACTION_LABELS: Record<ConnectionState, PrimaryActionLabel> = {
  connected: "Configure",
  errored: "Configure",
  disconnected: "Connect",
  disabled: "Connect",
  "auth-problem": "Sign in again",
};

/**
 * Derives the `ConnectionStatusPill` state for a plugin tile. Lifecycle
 * statuses (`disabled`, `errored`, `incompatible`, `invalid`) always win,
 * since those carry dedicated banners. For an enabled (or not-yet-loaded)
 * plugin, a live `ConnectionStatus` from `useConnectionStatus` is preferred;
 * absent that, the helper falls back to deriving from the effective
 * `IntegrationConfig` (presence of a captured user or instance URL).
 *
 * Shared between the global `PluginCard` and the per-project
 * `IssueSourceTile`, which is why it accepts a bare `PluginStatus | null`.
 */
export function derivePluginConnectionState(
  status: PluginStatus | null,
  effective?: IntegrationConfig | undefined,
  live?: ConnectionStatus | null | undefined,
): ConnectionState {
  if (status === "disabled") return "disabled";
  if (status === "errored") return "errored";
  // Lifecycle errors (manifest invalid, host-API mismatch) get their own
  // dedicated banners on the tile; the chip falls back to `errored` so the
  // header still carries a non-green signal.
  if (status === "incompatible" || status === "invalid") return "errored";

  // status === "enabled" (or null, which only occurs for not-yet-loaded
  // installed plugins on the project tile). Prefer the live status when the
  // query has resolved; otherwise fall back to derive-from-config so the
  // first paint (before the query resolves) still has a sensible answer.
  if (live) return live.state;
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
  // Intentionally optimistic; the live `ConnectionStatus` path replaces this
  // once the query resolves.
  if (typeof effective.instance === "string" && effective.instance.length > 0) return true;
  return false;
}
