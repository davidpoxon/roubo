// ── roubo.yaml configuration types (derived from Zod schema in config-schema.ts) ──

import type {
  RouboConfig,
  ComponentConfig,
  ConfigFieldError,
  LoginConfig,
  ToolConfig,
  JigSettings,
} from "./config-schema.js";

export type {
  RouboConfig,
  ProjectConfig,
  LayoutConfig,
  ComponentType,
  ComponentConfig,
  ComponentBinding,
  DockerComponentConfig,
  MigrationConfig,
  ConnectionConfig,
  PortConfig,
  LoginStep,
  LoginConfig,
  ToolConfig,
  InspectionConfig,
  BenchesConfig,
  JigsConfig,
  UserConfig,
  IntegrationConfig,
  IntegrationAdvanced,
  IntegrationOverride,
  CapturedUserId,
  ConfigFieldError,
  JigSettings,
  SourceEntry,
  MarketplaceDeclaration,
} from "./config-schema.js";

export {
  RouboConfigSchema,
  ProjectConfigSchema,
  LayoutConfigSchema,
  ComponentConfigSchema,
  ComponentBindingSchema,
  PortConfigSchema,
  ToolConfigSchema,
  InspectionConfigSchema,
  BenchesConfigSchema,
  UserConfigSchema,
  IntegrationConfigSchema,
  IntegrationAdvancedSchema,
  IntegrationOverrideSchema,
  CapturedUserIdSchema,
  SourceEntrySchema,
  MarketplaceDeclarationSchema,
  zodIssuesToValidationErrors,
  zodIssuesToFieldMap,
} from "./config-schema.js";

export { deepMergeIntegration } from "./deep-merge.js";

// ── roubo-plugin.yaml manifest types (derived from Zod schema in plugin-manifest-schema.ts) ──

export {
  PluginManifestSchema,
  CredentialSlotSchema,
  NetworkPermissionsSchema,
  CredentialsPermissionsSchema,
  FilesystemPermissionsSchema,
  ProcessesPermissionSchema,
  PluginPermissionsSchema,
  PluginCapabilitiesSchema,
  PluginDefaultIntegrationConfigSchema,
  PluginIconSchema,
  PluginLifecycleSchema,
} from "./plugin-manifest-schema.js";

export type {
  PluginManifest,
  CredentialSlot,
  NetworkPermissions,
  CredentialsPermissions,
  FilesystemPermissions,
  ProcessesPermission,
  PluginPermissions,
  PluginCapabilities,
  PluginDefaultIntegrationConfig,
  PluginIcon,
  PluginLifecycle,
} from "./plugin-manifest-schema.js";

export { parseManifest } from "./plugin-manifest.js";
export type { ParseManifestResult } from "./plugin-manifest.js";

export {
  PLUGIN_ENABLE_STATE_SCHEMA_VERSION,
  BUNDLED_PLUGIN_IDS,
  PluginEnableStateSchema,
  PluginEnableStateValueSchema,
} from "./plugin-enable-state-schema.js";
export type {
  PluginEnableState,
  PluginEnableStateValue,
  BundledPluginId,
} from "./plugin-enable-state-schema.js";

export {
  PLUGIN_CONSENT_STATE_SCHEMA_VERSION,
  PERMISSION_CATEGORIES,
  ConsentRecordSchema,
  PluginConsentStateSchema,
  declaredCategories,
  isFullyAcknowledged,
} from "./plugin-consent-schema.js";
export type {
  PermissionCategory,
  ConsentRecord,
  PluginConsentState,
} from "./plugin-consent-schema.js";

export {
  MARKETPLACE_SOURCES_STATE_SCHEMA_VERSION,
  MarketplaceSourceSchema,
  MarketplaceSourcesStateSchema,
} from "./marketplace-sources-schema.js";
export type {
  MarketplaceSource,
  MarketplaceSourcesState,
  MarketplaceSourceSummary,
} from "./marketplace-sources-schema.js";

export type {
  SourceCandidateIcon,
  SourceCandidateItem,
  SourceCandidateCategory,
  SourceCandidatesShape,
  SourceCandidatesResponse,
  SearchableSourceCategory,
  SourceCategoryOption,
  GetSourceOptionsParams,
  SourceOptionsResult,
  SourceSelection,
  SourceSelectionEntry,
} from "./integration-types.js";

export type {
  PluginStatus,
  PluginSource,
  RestartEvent,
  PluginError,
  LogLine,
  IsolationNotice,
  PluginRecord,
} from "./plugin-runtime-types.js";

import type { CapturedUserId, IntegrationConfig } from "./config-schema.js";
import type {
  PluginPermissions,
  PluginDefaultIntegrationConfig,
  PluginLifecycle,
} from "./plugin-manifest-schema.js";
import type { IsolationNotice, PluginStatus } from "./plugin-runtime-types.js";
import type { PluginManifest } from "./plugin-manifest-schema.js";

/**
 * Result of the first stage of the plugin install flow
 * (`POST /api/plugins/install`). The host has cloned (Git URL flow) or copied
 * (local directory flow) the candidate plugin into a staging directory under
 * `~/.roubo/plugins/.staging/<stagingToken>/`, parsed and validated its
 * `roubo-plugin.yaml`, and is now waiting for the user to either accept the
 * declared permissions (`POST /install/:token/confirm`) or cancel
 * (`POST /install/:token/cancel`, which removes the staging directory).
 */
export interface InstallPreview {
  stagingToken: string;
  manifest: PluginManifest;
  source: InstallSource;
}

export type InstallSource =
  | { type: "git"; url: string; directory?: string }
  // A built-artifact install: the installer streams the Release asset tarball
  // named by `assetUrl`, unpacks it under containment + size limits, and
  // verifies the unpacked artifact's digest before commit (issue #370). No git
  // clone and no build step run on the user's machine.
  | { type: "release"; assetUrl: string }
  | { type: "local"; path: string };

/**
 * Stable error codes emitted by the install pipeline. Routes map these to
 * HTTP status codes; the client surfaces the human-readable message in an
 * inline red banner.
 */
export type InstallErrorCode =
  | "invalid-input"
  | "clone-failed"
  | "missing-manifest"
  | "invalid-manifest"
  | "incompatible-host"
  | "duplicate-id"
  | "unknown-token"
  | "update-target-missing"
  // The Release asset could not be downloaded (non-200 response, network error,
  // or it exceeded the maximum download size) on the built-artifact install path
  // (issue #370). Nothing is written or executed.
  | "download-failed"
  // The downloaded tarball could not be safely unpacked: a path-escaping
  // (zip-slip) entry, a symlink/hardlink/device entry, or an over-size /
  // over-entry-count tarball (issue #370). Fails closed: nothing is written
  // outside staging.
  | "unpack-failed"
  // The staged package's content digest did not match the expected digest from
  // the signed catalog entry (CP-FR-021): a tampered or substituted package.
  | "integrity-failed"
  // The catalog entry has been revoked / taken down (CP-FR-021): it cannot be
  // installed or updated.
  | "revoked"
  // The static catalog failed signature verification (CP-FR-021): a tampered,
  // missing, or unsigned catalog. The marketplace fails closed (zero listings).
  | "catalog-unverified"
  // The hosted marketplace could not be reached / verified, so the catalog is
  // being served from the on-disk cache or the bundled seed (CPHM-FR-009). A new
  // install/update is paused with a clear message until the marketplace is
  // reachable again; seeded and already-installed plugins keep working.
  | "marketplace-unreachable"
  | "internal";

export interface InstallErrorBody {
  error: string;
  code: InstallErrorCode;
}

// --- Marketplace catalog (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621) ----
//
// The marketplace serves a first-party-curated catalog of plugins (both
// `component` and `integration` kinds). The catalog is a static, checked-in
// manifest read server-side; each entry is cross-referenced against the
// installed plugin set to annotate its install / update state.
//
// Channel integrity (CP-FR-021, issue #622): the catalog is wrapped in a signed
// envelope (a detached ed25519 signature over the canonical payload bytes,
// verified against a bundled first-party public key) and every entry carries an
// expected content `integrity` digest plus an optional `revoked` flag. The
// `verified` flag is a display-only first-party curation marker, distinct from
// the cryptographic signature: a card shows "Verified" when `verified` is true
// AND the catalog signature validated. There is no third-party submission path.

/**
 * Plugin kinds surfaced by the marketplace. Mirrors the host's plugin-manifest
 * `kind` discriminator (PluginKindSchema in plugin-manifest-schema.ts) in
 * lockstep; restated here so `shared` consumers don't reach into the manifest
 * schema for the marketplace UI. Widens alongside PluginKindSchema: `agent`
 * lands with the agent-plugin work (AP-FR-001).
 */
export type MarketplaceKind = "component" | "integration" | "agent";

/**
 * One curated catalog entry as authored in the static manifest. The `source`
 * is a discriminated union (mirroring the installer's InstallSource) naming where
 * the install/update flow stages the plugin from: a `git` source is cloned (its
 * optional `directory` names the subdirectory of the cloned repository that holds
 * the plugin package, the monorepo-subdir source model, issue #750, so a component
 * published inside a monorepo, e.g. `plugins/process`, stages and installs just
 * that subdirectory rather than the whole repo); a `release` source is a built
 * artifact whose tarball is downloaded from `assetUrl` and unpacked (its optional
 * `sha256` is the reproducible asset digest the publish gate self-checks, issue
 * #370). `verified` is the display-only first-party curation flag.
 *
 * `integrity` is the expected content digest of the staged package
 * (`sha256-<hex>`); after staging and before commit, the installer recomputes
 * the staged package digest and rejects a mismatch (CP-FR-021). `provenance` is
 * the registry path shown in the detail drawer. `revoked` marks a withdrawn /
 * taken-down entry: it is filtered out of `listCatalog` and rejected by
 * install / update.
 */
export interface MarketplaceCatalogEntry {
  id: string;
  name: string;
  kind: MarketplaceKind;
  version: string;
  summary: string;
  source:
    | { type: "git"; url: string; directory?: string }
    | { type: "release"; assetUrl: string; sha256?: string };
  provenance: string;
  integrity: string;
  revoked?: boolean;
  verified: boolean;
}

/**
 * The signed catalog payload. The hosted-marketplace catalog carries
 * `schemaVersion` / `generatedAt` / `keyId` (the `keyId` resolves the
 * operational signing key through the signed key-ring, CPHM-FR-007); the legacy
 * bundled seed catalog omits them and is verified directly against the bundled
 * first-party key. Both shapes are accepted, so these provenance fields are
 * optional.
 */
export interface SignedMarketplaceCatalogPayload {
  entries: MarketplaceCatalogEntry[];
  schemaVersion?: number;
  generatedAt?: string;
  keyId?: string;
}

/**
 * The signed catalog envelope as authored in the static manifest. `signature`
 * is a base64-encoded detached ed25519 signature over the canonical bytes of
 * `payload` (see the server's marketplace-integrity service). The server
 * verifies the signature (against the key-ring-resolved operational key for the
 * hosted catalog, or the bundled key for the seed) and fails closed (zero
 * listings) on any mismatch.
 */
export interface SignedMarketplaceCatalog {
  payload: SignedMarketplaceCatalogPayload;
  signature: string;
}

/**
 * One operational signing key as listed in the signed key-ring. `keyId` is the
 * stable fingerprint of `publicKeyPem` (`ed25519-<sha256(spki der) first 16
 * hex>`); `status` distinguishes a currently-active operational key from a
 * rotated-out (revoked) one. A catalog's `payload.keyId` resolves to one of
 * these entries.
 */
export interface KeyRingEntry {
  keyId: string;
  publicKeyPem: string;
  status: "active" | "revoked";
}

/**
 * The signed key-ring envelope served alongside the hosted catalog.
 * `signature` is a base64 detached ed25519 signature over the canonical bytes
 * of `payload`, made by the long-lived bootstrap ROOT key the app embeds. The
 * app verifies the ring against the root key, then resolves a catalog's `keyId`
 * to an `active` ring entry and verifies the catalog against that operational
 * key, so operational keys rotate and revoke without an app release
 * (CPHM-FR-007 / CPHM-NFR-004).
 */
export interface SignedKeyRing {
  payload: { keys: KeyRingEntry[]; generatedAt?: string };
  signature: string;
}

/**
 * A catalog entry annotated with the consumer's local install state. Returned
 * by `GET /api/marketplace/plugins`. `installed` reflects whether a plugin with
 * this id is present in `listInstalled()`; `installedVersion` is its on-disk
 * manifest version (null when the manifest is unreadable); `updateAvailable` is
 * true when the catalog version is strictly newer than the installed version.
 */
export interface MarketplaceListing extends MarketplaceCatalogEntry {
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
  // Derived, PRE-INSTALL provenance the detail drawer renders (issue #401). These
  // are NOT part of the signed catalog `payload` (changing that requires the
  // out-of-band signing key and would trip the marketplace drift guard); the
  // server derives them in `annotate()` by reading the plugin's declared manifest
  // (the installed record, or the bundled `plugins/<id>` source), the same way
  // `installed` / `updateAvailable` are derived.
  //
  // `declaredPermissions` is the plugin's declared permission set (the drawer
  // runs `declaredCategories()` over it to list each requested category with a
  // human-readable label + detail); `null` when the manifest is unavailable
  // pre-install (a non-bundled or release-sourced, not-yet-installed entry).
  // `lifecycle` is the component lifecycle shape (long-running / one-shot), or
  // `null` for integration plugins and when the manifest is unavailable.
  declaredPermissions: PluginPermissions | null;
  lifecycle: PluginLifecycle | null;
}

/**
 * Where the served catalog came from, surfaced so the Plugins view can render an
 * offline / staleness banner (CPHM-FR-009 / CPHM-NFR-003, issue #372). The
 * catalog-client degrades NETWORK -> CACHE -> SEED fail-closed; `cache` and
 * `seed` both mean the hosted marketplace was unreachable and the last verified
 * catalog is being shown. The server-side `CatalogSource` (catalog-client.ts)
 * aliases this single definition so the value behaviour stays identical.
 */
export type MarketplaceCatalogSource = "network" | "cache" | "seed";

/**
 * Response shape for `GET /api/marketplace/plugins`. `source` and `fetchedAt`
 * carry the served catalog's provenance to the client: when `source !== "network"`
 * the marketplace was unreachable and the Plugins view shows the offline /
 * staleness banner. `fetchedAt` is the ISO timestamp the served envelope was
 * fetched (network / cache), or `null` for the bundled seed (no fetch happened).
 */
export interface MarketplaceCatalogResponse {
  curated: true;
  listings: MarketplaceListing[];
  source: MarketplaceCatalogSource;
  fetchedAt: string | null;
}

/**
 * Error body returned by `GET /api/marketplace/plugins` when the static catalog
 * fails signature verification (CP-FR-021). The server fails closed: it returns
 * this typed error (HTTP 502) with zero listings rather than a silent empty
 * success, so the client can render an unverified-catalog error and render no
 * plugin cards (CP-TC-118). Distinct from a transport / registry-unavailable
 * failure, which surfaces as a generic load error (CP-TC-106).
 */
export interface MarketplaceCatalogErrorBody {
  error: string;
  code: "catalog-unverified";
}

/**
 * Tells the Issue source tile which caption to render under the configured
 * variant. Derived server-side from the committed roubo.yaml integration block
 * and the per-user override.
 */
export type IntegrationCaptionKey = "yaml-only" | "override-only" | "yaml-and-override" | "none";

/**
 * Snapshot of a project's effective integration state, returned by
 * `GET /api/projects/:projectId/integration`. The tile consumes this directly
 * and routes to one of three variants:
 *   - `plugin == null`                       → unconfigured
 *   - `plugin != null && !plugin.installed`  → missing-plugin
 *   - otherwise                              → configured
 */
export interface ProjectIntegrationState {
  effective: IntegrationConfig;
  committed: IntegrationConfig | null;
  override: IntegrationConfig | null;
  plugin: {
    id: string;
    installed: boolean;
    status: PluginStatus | null;
    manifest: {
      name: string;
      /**
       * JSON-Schema-derived shape describing the per-project config form.
       * Opaque to roubo; rendered by the client's ConfigSchemaForm.
       */
      configSchema?: Record<string, unknown>;
      /**
       * Full declared permissions for the plugin. The Configure dialog reads
       * `credentials.slots[*].description` to label password fields.
       */
      permissions?: PluginPermissions;
      /**
       * Plugin-global default integration config (FR-064). The Configure dialog
       * reads `excludedStatusCategories` to seed and gate the status-category
       * exclusion control without a second fetch.
       */
      defaultIntegrationConfig?: PluginDefaultIntegrationConfig;
    } | null;
  } | null;
  captionKey: IntegrationCaptionKey;
  /**
   * Set when the committed roubo.yaml resolves to a different integration than
   * the effective (override-resolved) one, along either axis that changes which
   * host a teammate would reach: the `plugin` id, or (for multi-instance
   * plugins like `ghe`) the `instance`. The integration works locally because
   * the per-user override wins, but a teammate cloning the repo would resolve
   * the committed values instead, against a host they likely cannot reach. The
   * tile surfaces this and offers to promote the effective integration into the
   * committed config. `null` when committed and effective agree, or the
   * committed config names no plugin.
   */
  integrationMismatch?: {
    committedPlugin: string;
    effectivePlugin: string;
    committedInstance: string | null;
    effectiveInstance: string | null;
  } | null;
}

/**
 * Result of GET /api/plugins/:pluginId/integration: the global-defaults
 * read used by the Plugins settings page's Configure dialog. Mirrors the
 * `plugin` and `effective` shape of `ProjectIntegrationState` so the
 * existing dialog can seed itself the same way, but omits the
 * committed/override/captionKey fields that only make sense in a project
 * scope.
 */
export interface GlobalPluginIntegrationState {
  effective: IntegrationConfig;
  plugin: NonNullable<ProjectIntegrationState["plugin"]>;
}

/**
 * Classifier for plugin-reported test-connection failures. The host
 * translates raw plugin error strings into one of these kinds so the
 * Configure dialog can render the right result-strip variant and the
 * inline "Enable self-signed TLS" recovery affordance (TC-060/061/062).
 */
export type IntegrationTestErrorKind = "auth" | "network" | "tls" | "other";

export interface IntegrationTestErrorPayload {
  kind: IntegrationTestErrorKind;
  message: string;
}

/**
 * Stable identifier for a row in the Test Connection result strip. `"issues"`
 * is always present on a successful test; the three alert categories appear
 * only when the project has at least one source with that category enabled.
 */
export type IntegrationCategoryId = "issues" | "code-scanning" | "secret-scanning" | "dependabot";

/**
 * Per-row status in the Test Connection result strip (FR-047, WU-041, WU-034).
 *
 * - `ok`: probe succeeded
 * - `scope-missing`: token lacks the required scope (401/403)
 * - `not-enabled`: feature is not enabled for the probed repo (404/410/451)
 * - `timed-out`: probe exceeded the per-probe cap (rendered amber; does not
 *   fail the overall test)
 * - `error`: probe returned an unexpected status or threw a non-timeout error
 */
export type IntegrationCategoryStatus =
  | "ok"
  | "scope-missing"
  | "not-enabled"
  | "timed-out"
  | "error";

/**
 * One row in the Test Connection result strip. `label` is the human-facing
 * string the strip renders (sourced from `INTEGRATION_CATEGORY_LABELS` below).
 * `detail` is rendered verbatim
 * underneath the row when present (e.g. "Timed out", "Token missing
 * `security_events` scope"). `httpStatus` is included for diagnostics and
 * tests; the UI does not render it directly.
 */
export interface IntegrationCategoryReport {
  category: IntegrationCategoryId;
  label: string;
  status: IntegrationCategoryStatus;
  detail?: string;
  httpStatus?: number;
}

/**
 * Response shape for `POST /api/projects/:projectId/integration/test` and
 * `POST /api/plugins/:pluginId/integration/test`. On `ok: true`, `identity`
 * carries the value returned by `plugin.getCurrentUser`, which the dialog
 * stashes and submits as `capturedUserId` when the user saves. `categories`
 * drives the per-row Test Connection result strip (WU-041); the host always
 * emits at least an Issues row on success, and adds alert-category rows for
 * each category enabled by at least one saved source. Omitted on the failure
 * variant.
 */
export type IntegrationTestResult =
  | { ok: true; identity: CapturedUserId; categories?: IntegrationCategoryReport[] }
  | { ok: false; error: IntegrationTestErrorPayload };

/**
 * Human-facing labels for each Test Connection result-strip row. Kept in
 * `shared/` so client, server, and plugin code all read from one place.
 */
export const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategoryId, string> = {
  issues: "Issues",
  "code-scanning": "Code Scanning alerts",
  "secret-scanning": "Secret Scanning alerts",
  dependabot: "Dependabot alerts",
};

/**
 * Discrete states a plugin's connection can be in. Drives the
 * `ConnectionStatusPill` taxonomy (mockups §21) and will back the
 * `getConnectionStatus()` plugin RPC (FR-055) when that lands in a later WU.
 *
 * - `connected`: healthy, last check succeeded
 * - `disconnected`: plugin is enabled but no credentials are configured
 * - `auth-problem`: token expired / 401 / re-auth needed
 * - `errored`: rate-limited, unreachable, crashed, or never-checked
 * - `disabled`: plugin not enabled; never reflects connectivity
 */
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "auth-problem"
  | "errored"
  | "disabled";

/**
 * Cached connection-status snapshot for a plugin. `detail` is surfaced in the
 * pill's tooltip on `auth-problem` and `errored`. `checkedAt` is an ISO
 * timestamp the pill renders as an "as of HH:MM" suffix; omit for the
 * `disabled` variant (which never carries a timestamp).
 */
export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
  checkedAt?: string;
  // Present on `connected` when the plugin can cheaply resolve the
  // authenticated account (e.g. from the same `GET /user` probe). Drives the
  // "Connected as <login>" label in the Configure dialog; omitted otherwise.
  account?: { login: string };
}

/**
 * Body shape for `PUT /api/projects/:projectId/integration/config`. Every key
 * is optional; provided keys replace their counterpart in the existing
 * override (per FR-023's "arrays REPLACE" rule, which extends to objects
 * here since the override is shallow per top-level key).
 */
export interface IntegrationConfigUpdate {
  instance?: string;
  sources?: Record<string, Array<string | number>>;
  advanced?: Record<string, unknown>;
  capturedUserId?: CapturedUserId;
  /**
   * Root-level status-category exclusion (FR-010), editable from the Configure
   * dialog. Shallow-replaces the committed value in the per-project override;
   * an empty array means "exclude nothing", distinct from omitting the key
   * (which leaves the existing override untouched).
   */
  excludedStatusCategories?: string[];
}

/**
 * Response of `GET /integration/status-categories` (issue #453). `supported` is
 * true only when the active plugin's discovery RPC returned; on any failure
 * (no active plugin, discovery unimplemented, network / auth error) the host
 * returns `{ supported: false, categories: [] }` so the Configure dialog falls
 * back to its canonical status-category set.
 */
export interface StatusCategoriesResponse {
  supported: boolean;
  categories: string[];
}

/**
 * Project-scoped fields owned by the active integration plugin (FR-070).
 * Returned by `GET /api/projects/:projectId/integration/fields`. Stored
 * canonically in roubo.yaml; the plugin's Configure modal is the edit
 * surface and the legacy config/raw PUT shims forward into the setter.
 */
export interface IntegrationFields {
  repo?: string;
  githubProject?: number;
  submodules?: Record<string, string>;
  /** Echoed so the client can hide meta-repo-only controls without a second fetch. */
  layoutType?: "meta-repo" | "monorepo" | "single-repo";
}

/**
 * Body shape for `PUT /api/projects/:projectId/integration/fields`. Each key
 * is optional; provided keys overwrite their counterpart, `undefined` keys
 * are left alone, and an explicit `null` clears the field in roubo.yaml.
 */
export interface IntegrationFieldsUpdate {
  repo?: string | null;
  githubProject?: number | null;
  submodules?: Record<string, string> | null;
}

/**
 * Serializable subset of `PluginRecord` returned by `GET /api/plugins`. Drives
 * the radio list inside the Switch integration dialog.
 */
export interface InstalledPluginSummary {
  id: string;
  name: string;
  status: PluginStatus;
  lastError?: string;
  isolationNotices?: IsolationNotice[];
}

export const DONE_STATUSES = new Set(["done", "closed", "archived", "cancelled"]);

// ── Project registry types ──

/**
 * Per-project settings. Keep this shape extensible: new per-project features
 * (e.g. per-project jig defaults, per-project Claude Code overrides)
 * should be added as new top-level keys alongside `worktreeSource`, not
 * nested inside it. A missing `settings` key in persisted state is
 * interpreted as all defaults. See `project-registry.ts` for the
 * "missing = on" defaulting rule (R4).
 */
export interface ProjectSettings {
  worktreeSource: {
    branchFromDefault: boolean;
    pullLatest: boolean;
  };
}

/**
 * Default `ProjectSettings` used when persisted state has no `settings` key.
 * NOTE: both toggles default to `true`, which is the OPPOSITE of the usual
 * "missing field = false" convention. See R4 in
 * `specs/prd-worktree-source-settings.md`.
 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  worktreeSource: {
    branchFromDefault: true,
    pullLatest: true,
  },
};

/**
 * GET /:projectId/settings response: persisted ProjectSettings plus the
 * server-computed default branch (or the R1 error if detection fails).
 * These two extras are read-only: never persisted, never accepted by PUT.
 */
export interface ProjectSettingsResponse extends ProjectSettings {
  defaultBranch?: string;
  defaultBranchError?: string;
}

export interface RegisteredProject {
  id: string;
  repoPath: string;
  config?: RouboConfig;
  configValid: boolean;
  configError?: string;
  // Path-keyed config errors when the config is invalid. Populated from the zod
  // parse pass and from the plugin-aware component-binding second pass so
  // invalid component config surfaces as path-keyed errors at config-load
  // (issue #399, CP-TC-005).
  fieldErrors?: ConfigFieldError[];
  settings: ProjectSettings;
}

// ── Bench types ──

export type BenchStatus = "idle" | "preparing" | "active" | "error" | "clearing";
export type ComponentStatusValue =
  | "stopped"
  | "starting"
  | "running"
  | "error"
  | "stopping"
  | "completed";

export type ProvisioningStepStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface ProvisioningStep {
  id: string;
  label: string;
  status: ProvisioningStepStatus;
  error?: string;
  phases?: ComponentPhase[];
}

export type ComponentPhaseStatus = "pending" | "running" | "done" | "error";

export interface ComponentPhase {
  label: string;
  status: ComponentPhaseStatus;
}

/**
 * A component's observable lifecycle state, pushed by the host (never polled,
 * NFR-002). Most components rest in `running` or `stopped`; `completed` is the
 * one-shot terminal state (FR-014 / FR-022): a run-to-completion descriptor that
 * exits 0 is neither `stopped` (idle, never started) nor `error` (failed), so it
 * lands in its own distinct terminal state. A non-zero exit or a `timeoutMs`
 * breach drives `error` instead.
 */
export interface ComponentStatus {
  name: string;
  status: ComponentStatusValue;
  pid?: number;
  containerId?: string;
  error?: string;
  statusDetail?: string;
  statusDetailStartedAt?: string;
  startedAt?: string;
  phases?: ComponentPhase[];
  /**
   * True once the component's `setup` command has run successfully on this
   * bench, or trivially true if the component config defines no setup. Lets a
   * subsequent Start skip re-running setup after a Stop → Start cycle.
   */
  setupComplete: boolean;
}

/**
 * A single log line a component plugin pushes to the host via
 * `host.component.reportLog`. Push-based so the host never polls the plugin for
 * logs (NFR-002).
 */
export interface ComponentLogLine {
  source: "stdout" | "stderr";
  text: string;
  ts: string;
}

/**
 * The permission categories the broker enforces (F2.1, #618). Every broker
 * method maps to one of these; a call whose category the plugin did not declare
 * is denied with a permission-denied error before reaching the host delegate.
 */
export type BrokerPermissionCategory = "process" | "docker" | "ports";

/**
 * Structured payload carried by a broker permission-denied error
 * (PERMISSION_DENIED_CODE, -32001). Mirrors FilesystemPermissionDeniedData /
 * ProcessesPermissionDeniedData so every host surface reports denials in the
 * same shape. `method` is the broker method that was denied; `reason` is fixed
 * (the plugin did not declare the category the method needs).
 */
export interface BrokerPermissionDeniedData {
  code: "permission-denied";
  category: BrokerPermissionCategory;
  method: string;
  reason: "category-not-declared";
}

/**
 * One record of a privileged HostComponentBroker call (FR-019, v2 audit). The
 * AuditLog appends one entry per gated method invocation (host.process.*,
 * host.docker.*, host.ports.get): `outcome` is "allowed" when the plugin held
 * the permission category, "denied" when it did not. `params` captures the raw
 * incoming arguments (recorded before per-param validation, so a denied or
 * early-rejected call still has its params logged). The ungated
 * host.component.report* and host.capability.query methods are not privileged
 * and produce no entry.
 */
export interface AuditEntry {
  /** ISO-8601 timestamp of when the call was recorded. */
  ts: string;
  /** The plugin that made the call. */
  pluginId: string;
  /** The bench the call was scoped to. */
  benchId: number;
  /** The broker method name (e.g. "host.process.start"). */
  method: string;
  /** The raw incoming params, captured before validation. */
  params: unknown;
  /** Whether the plugin held the required permission category. */
  outcome: "allowed" | "denied";
  /**
   * Where the entry was attributed (F2.3, #620). Omitted (or "broker") for the
   * always-on broker choke-point; "sandbox" for an OS-layer denial the
   * PluginIsolationSandbox could attribute to the plugin (e.g. an undeclared
   * outbound connection blocked at the container/VM boundary). The broker and
   * the OS tier share one audit shape so a query returns both in one stream.
   */
  source?: "broker" | "sandbox";
}

/**
 * One record of a privileged gate-lifecycle plugin call (FR-007, NFR-001). The
 * broker `AuditEntry` above is bench-scoped (it carries a `benchId` and a
 * `host.*` broker `method`), but a gate close is project- and gate-scoped: it
 * has no bench, and it routes through the integration plugin's
 * `applyTransition` RPC rather than the HostComponentBroker. Rather than overload
 * the bench-scoped shape, the GateLifecycleCoordinator records this dedicated
 * entry: which gate's tracker issue was transitioned, via which plugin and
 * transition, and whether the privileged call was applied or skipped (the
 * already-done idempotent no-op).
 */
export interface GateAuditEntry {
  /** ISO-8601 timestamp of when the call was recorded. */
  ts: string;
  /** The project the gate belongs to. */
  projectId: string;
  /** The integration plugin the transition was routed through. */
  pluginId: string;
  /** The verify unit (gate) whose tracker issue was acted on. */
  gateId: string;
  /** The gate's tracker issue ref (issue number / key) that was transitioned. */
  trackerRef: string;
  /** The plugin transition name applied (e.g. "close"); omitted when skipped. */
  transitionName?: string;
  /**
   * "closed" when a done-bound transition was applied; "already-done" when the
   * issue was already in a done state and the close was an idempotent no-op.
   * "reopened" when a reopen-bound transition was applied to a signed-off gate;
   * "already-open" when the issue was already open and the reopen was an
   * idempotent no-op.
   */
  outcome: "closed" | "already-done" | "reopened" | "already-open";
}

/**
 * One record of a privileged tracker-action plugin call routed through the
 * TrackerActionGateway (verify-gate FR-011, NFR-001, NFR-005; #705). These ops
 * (create-issue, add-blocking-link, close-gate) are project-scoped, not
 * bench-scoped, so they do not fit the bench-scoped broker `AuditEntry` (which
 * carries a `benchId` and a `host.*` method); and unlike the gate-close-only
 * `GateAuditEntry` they cover create / link too and must record the
 * capability-refused attempt. The gateway records one entry per attempt: an
 * "applied" outcome for a performed op (including a close-on-pass whose
 * underlying issue was already done, since `onGatePassed` returns void and the
 * gateway cannot observe that idempotent no-op; the already-done nuance is
 * captured at gate granularity by `GateAuditEntry`), a "skipped" outcome when
 * there is nothing to do (a close-gate for a gate with no filed tracker issue),
 * and a "refused" outcome when a missing capability or absent consent blocked
 * the call before it reached the plugin. No tracker tokens or secrets are ever
 * placed on this entry (NFR-001).
 */
export interface TrackerActionAuditEntry {
  /** ISO-8601 timestamp of when the call was recorded. */
  ts: string;
  /** The project the action was scoped to. */
  projectId: string;
  /** The integration plugin the action was routed through. */
  pluginId: string;
  /** The privileged op attempted. */
  action: "createIssue" | "addBlockedBy" | "closeGate" | "reopenGate";
  /**
   * Whether the privileged op was performed ("applied"; for close-gate this also
   * covers the case where `onGatePassed` found the issue already done, an
   * idempotent no-op the void-returning call cannot distinguish here), there was
   * nothing to do ("skipped", e.g. a close-gate for a gate with no filed tracker
   * issue), or it was blocked before the plugin call by a missing capability or
   * absent consent ("refused").
   */
  outcome: "applied" | "skipped" | "refused";
  /**
   * Present on a "refused" outcome: the legible reason the op was blocked (e.g.
   * "capability supportsCreateIssue not declared" or "plugin not consented").
   * Never carries a token or secret.
   */
  reason?: string;
  /**
   * Non-secret op identifiers for traceability (issue refs, gate id). The
   * gateway only ever populates this with public refs, never credentials.
   */
  refs?: Record<string, string>;
}

/**
 * Whether the fix-issue filer completed both of its steps. `complete` means the
 * fix issue was created AND registered as a blocker on the gate. `link_pending`
 * means the issue was created but the block-link step failed afterwards, so the
 * partial state is surfaced for a link-only retry (verify-gate FR-009, FR-010,
 * NFR-003; #706). The gate is never falsely passable in either state: the failed
 * gating case keeps it non-passable regardless of the link's outcome.
 */
export type FixIssueLinkStatus = "complete" | "link_pending";

/**
 * The per-request outcome of filing a fix issue for a failed gating case and
 * wiring it to block the gate (verify-gate FR-009, FR-010, NFR-003; #706).
 *
 * The filer is create-then-link: it creates the tracker issue, then registers it
 * as a blocker on the gate. When the link step fails after the issue is created,
 * the record returns `linkStatus: 'link_pending'` carrying the created
 * `fixIssueRef`, so a link-only retry (driven by `existingFixRef` on the request)
 * covers only the outstanding link step rather than creating a duplicate issue.
 * This record is per-request and never persisted: the durable blocking state
 * lives in the tracker (`tracker.blocked_by_refs` is its derived projection), and
 * the gate's passability is decided by the pure evaluator over the recorded case
 * results, not by this record.
 */
export interface FixIssueRecord {
  /** The created fix issue's external tracker ref (e.g. "owner/repo#452"). */
  fixIssueRef: string;
  /** The gate's tracker ref the fix issue was wired to block (e.g. "owner/repo#451"). */
  gateRef: string;
  /** The failed gating case id the fix issue was filed for (e.g. "TC-024"). */
  failedCaseId: string;
  /** Whether both steps completed, or the link step is still pending a retry. */
  linkStatus: FixIssueLinkStatus;
  /** ISO-8601 timestamp of when the record was produced. */
  createdAt: string;
}

/**
 * Request body for `POST /api/projects/:projectId/gates/:gateId/fix-issues`
 * (verify-gate FR-009, FR-010, NFR-001, NFR-003; #706). `notes` is required and
 * must be non-empty (empty notes are rejected with a 422). `evidence` is an
 * optional in-workspace relative path for a notes artifact, confined by the
 * `resolveWithin` safe-path barrier (a path-escaping value is rejected). The
 * optional `existingFixRef` drives the link-only retry: when set, the filer skips
 * the create step and runs only the block-link step against that already-created
 * ref (NFR-003).
 */
export interface FileFixIssueRequest {
  /** The failed gating case the fix issue is filed for. */
  failedCaseId: string;
  /** The verifier's failure notes. Required and non-empty. */
  notes: string;
  /** Optional in-workspace relative path for a notes artifact (safe-path confined). */
  evidence?: string;
  /** Optional already-created fix issue ref, to run only the link step (NFR-003). */
  existingFixRef?: string;
}

/**
 * The OS-isolation tiers the PluginIsolationSandbox can place a component plugin
 * process inside (F2.3, #620; backend chosen by SPK-2 / spike #599). Ordered
 * highest-isolation-first: `vz-vm` (Virtualization.framework per-plugin VM) is
 * the strongest, then `apple-container` (the macOS 15+ Apple container
 * framework), then `docker` (container-per-plugin where a Docker engine is
 * already present), degrading to the `broker-only` floor where no isolation
 * runtime is available. The floor carries no isolation-attributable overhead and
 * is always selectable, so enforcement never depends on Docker (FR-018).
 */
export type IsolationTier = "vz-vm" | "apple-container" | "docker" | "broker-only";

/**
 * Which OS-isolation runtimes the host can actually drive (F2.3, #620). Probed
 * at runtime via the NFR-005 host-capability gate, never assumed: a host without
 * any runtime degrades to the `broker-only` floor. Each flag is true only when
 * the runtime is present AND usable (e.g. the Docker daemon is reachable, not
 * merely installed).
 */
export interface IsolationCapabilities {
  /** Virtualization.framework is present and a per-plugin VM can be driven. */
  vzVm: boolean;
  /** The Apple `container` framework (macOS 15+, Apple silicon) is present. */
  appleContainer: boolean;
  /** A Docker engine is installed and the daemon is reachable. */
  docker: boolean;
}

/**
 * The egress policy the sandbox applies to a plugin process, derived from the
 * manifest's `permissions.network` declaration (F2.3, #620). When the plugin
 * declares no network hosts, the sandbox denies all egress (`mode: "deny-all"`)
 * so an undeclared outbound connection is blocked at the OS layer: there is no
 * `host.network.*` broker method, so undeclared egress can only be stopped
 * below the broker. When hosts are declared, the policy carries that allowlist
 * for the runtime to apply.
 */
export interface SandboxEgressPolicy {
  mode: "deny-all" | "allow-listed";
  /** Declared network hosts (empty when `mode` is "deny-all"). */
  allowedHosts: string[];
}

/**
 * The concrete spawn the host should perform to run a plugin under a non-floor
 * isolation tier (F2.3, #620). `command` + `args` replace the direct
 * `spawn(process.execPath, [entry])`. For the `docker` tier the shape depends
 * on the egress policy:
 *
 * - deny-all (no declared network hosts):
 *   `docker run --rm -i --network none -v <pluginDir>:/roubo-plugin:ro
 *   -w /roubo-plugin node:24-slim node /roubo-plugin/<entryRel>`
 *
 * - allow-listed (declared hosts present):
 *   `docker run --rm -i --cap-add NET_ADMIN
 *   -e ROUBO_ALLOWED_HOSTS=<comma-separated hosts>
 *   -v <pluginDir>:/roubo-plugin:ro -w /roubo-plugin
 *   roubo-plugin-egress:node24 sh -c '<iptables-setup>; exec node /roubo-plugin/<entryRel>'`
 *
 * `env` is merged over the base spawn env. `egress` is the derived network
 * policy. The `broker-only` floor produces no SandboxedSpawn; the host spawns
 * the plugin directly.
 */
export interface SandboxedSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
  egress: SandboxEgressPolicy;
}

/**
 * Per-bench data the HostComponentBroker needs to service a component plugin's
 * privileged calls. Injected at broker construction so handlers never reach into
 * globals: ports are pre-resolved host-side, status and log reporting are
 * push-based sinks, and the enforced permission check is supplied by the caller.
 */
export interface BrokerContext {
  /** The plugin this broker serves; stamped onto every audit entry. */
  pluginId: string;
  /** The bench this broker is scoped to; stamped onto every audit entry. */
  benchId: number;
  /**
   * The component whose lifecycle this context was last registered for. An
   * imperative plugin's `host.component.reportStatus` arrives as a JSON-RPC
   * notification carrying no `name` (the SDK never stamps one), so the broker
   * routes that push to this component when the status omits `name` (#396).
   * Optional: a context registered by the declarative path may leave it unset.
   */
  componentName?: string;
  /** Host-allocated ports for this bench, keyed by component name. */
  ports: Record<string, number>;
  /** Push sink invoked by `host.component.reportStatus`. */
  reportStatus: (status: ComponentStatus) => void;
  /**
   * Push sink invoked by `host.component.reportLog`. The `componentName` is the
   * one the call named in its params, so a bench with two plugin-bound
   * components routes each component's output to its own log instead of
   * overwriting whichever provisioned last (#685).
   */
  reportLog: (componentName: string, line: ComponentLogLine) => void;
  /**
   * Permission check. Returns false when the plugin did not declare a category.
   * The broker denies any call whose category returns false with a
   * permission-denied error, before delegating to the host (F2.1, #618).
   */
  hasPermission: (category: BrokerPermissionCategory) => boolean;
  /**
   * Audit sink invoked for every privileged broker call (FR-019). Records the
   * call's outcome (allowed or denied) into the AuditLog.
   */
  recordAudit: (entry: AuditEntry) => void;
  /** Records an externally-assigned container against a component. */
  assignContainer?: (componentName: string, containerId: string) => void;
}

/**
 * Result of `host.capability.query`. For a known method `available` is true and
 * `introducedIn` carries the broker API version that first shipped it; for an
 * unknown or future method `available` is false and `introducedIn` is omitted.
 * The query never produces a host-side error (FR-017).
 */
export interface CapabilityQueryResult {
  available: boolean;
  introducedIn?: string;
}

export interface Bench {
  id: number;
  projectId: string;
  branch: string;
  workspacePath: string;
  status: BenchStatus;
  ports: Record<string, number>;
  components: Record<string, ComponentStatus>;
  createdAt: string;
  error?: string;
  provisioningSteps: ProvisioningStep[];
  teardownSteps: ProvisioningStep[];
  assignedContainers?: Record<string, AssignedContainer>;
  assignedIssue?: AssignedIssue;
  notifications: BenchNotification[];
  /**
   * The branch the worktree was cut from (e.g. "main"). Captured at
   * provisioning time. Absent on benches created before this field existed.
   */
  baseBranch?: string;
  /**
   * The 7-character short SHA of HEAD in the new worktree immediately after
   * `git worktree add`. Absent on legacy benches or if rev-parse failed.
   */
  baseCommit?: string;
  /**
   * The ID of the jig that was auto-injected when this bench was created
   * via an issue assignment. Absent on benches created without issue assignment
   * or when auto-injection was disabled.
   */
  injectedJigId?: string;
  /**
   * Where the injected jig came from in the resolution hierarchy.
   * Always `undefined` when `injectedJigId` is `undefined`.
   */
  injectedJigSource?: JigDefaultSource;
  /**
   * Bench variant discriminator. Absent (`undefined`) means a normal bench;
   * `'testbench'` marks a TestBench variant, which surfaces the TestBench tab
   * and binds a focused spec. Normal benches never carry this field, so they
   * are unaffected by TestBench behaviour.
   */
  variant?: "testbench";
  /**
   * Absolute path to the spec the TestBench is currently focused on. Mutable
   * and re-pointable: a TestBench can be retargeted at a different spec over
   * its lifetime. Only meaningful when `variant === 'testbench'`. Re-validated
   * with resolveWithin when loaded (enforcement lives in the testbench store).
   */
  focusedSpecPath?: string;
}

// ── Git dirty-state types ──

export type DirtyReasonKind =
  | "dirty-worktree"
  | "stash"
  | "unpushed-commits"
  | "no-upstream"
  | "local-only-after-merge";

/**
 * A single reason a bench is not safe to tear down.
 * `location` is `'workspace'` for the main worktree, or the submodule's
 * `$displaypath` (relative to the superproject root) for a submodule.
 * `detail` is a short human-readable qualifier, e.g. "3 modified, 1 untracked",
 * "1 stash", "2 commits ahead".
 */
export interface DirtyReason {
  kind: DirtyReasonKind;
  location: string;
  detail: string;
}

export interface DirtyState {
  clean: boolean;
  reasons: DirtyReason[];
}

// ── Notification types ──

export type NotificationType =
  | "claude-exited"
  | "claude-waiting"
  | "terminal-waiting"
  | "bench-ready"
  | "bench-error"
  | "inspection-complete"
  | "component-error";

export type NotificationPriority = "info" | "action-needed";

export interface BenchNotification {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  sourceSessionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ── Resolved tool types ──

export interface ResolvedTool {
  name: string;
  icon: string;
  type: "browser" | "shell";
  url?: string;
  command?: string;
  requires?: string;
  login?: LoginConfig;
  enabled: boolean;
  requiresUserPicker: boolean;
}

export interface ExecuteToolRequest {
  userName?: string;
}

export interface ToolResult {
  success: boolean;
  error?: string;
  login?: LoginConfig;
}

// ── Container assignment types ──

export interface AssignedContainer {
  containerId: string;
  containerName: string;
  port: number;
}

export interface AssignContainerRequest {
  containerId: string;
  component: string;
}

// ── API request/response types ──

export interface RegisterProjectRequest {
  repoPath: string;
}

export interface CreateBenchRequest {
  branch?: string;
  /**
   * The issue's externalId (e.g. `owner/repo#123`, `owner/repo#code-scanning-117`,
   * or a Jira key like `PROJ-45`). When set, the server fetches the issue via the
   * active plugin's `getIssue` and creates a bench assigned to it.
   */
  externalId?: string;
  branchConflictResolution?: "resume" | "new";
  /**
   * TestBench variant discriminator. When `'testbench'`, the create path ignores
   * issue/branch coupling and instead binds the bench to `focusedSpecPath`.
   */
  variant?: "testbench";
  /**
   * Absolute (or repo-relative) path to the focused spec's `test-cases.json`.
   * Required when `variant === 'testbench'`; validated for containment against
   * the project repo server-side.
   */
  focusedSpecPath?: string;
}

export interface ApiError {
  error: string;
  details?: string;
}

// ── Persisted state types ──

export interface PersistedProjectEntry {
  id: string;
  repoPath: string;
  settings?: ProjectSettings;
}

export interface PersistedBench {
  id: number;
  projectId: string;
  branch: string;
  workspacePath: string;
  ports: Record<string, number>;
  createdAt: string;
  assignedContainers?: Record<string, AssignedContainer>;
  assignedIssue?: AssignedIssue;
  notifications?: BenchNotification[];
  /** Persisted mirror of Bench.baseBranch. */
  baseBranch?: string;
  /** Persisted mirror of Bench.baseCommit. */
  baseCommit?: string;
  /** Persisted mirror of Bench.injectedJigId. */
  injectedJigId?: string;
  /** Persisted mirror of Bench.injectedJigSource. */
  injectedJigSource?: JigDefaultSource;
  /**
   * Persisted mirror of Bench.variant. Absent means a normal bench;
   * `'testbench'` marks a TestBench variant.
   */
  variant?: "testbench";
  /**
   * Persisted mirror of Bench.focusedSpecPath: the absolute path to the spec
   * the TestBench is focused on. Mutable and re-pointable across reboots. Only
   * meaningful when `variant === 'testbench'`.
   */
  focusedSpecPath?: string;
  /**
   * Persisted mirror of `bench.components[name].setupComplete`, keyed by
   * component name. Components themselves are runtime-only; only this flag
   * survives reboots so a future Start can skip re-running setup.
   * Absent on benches written before this field existed; load-time migration
   * coerces missing entries to `true` (those benches were created under the
   * old full-provisioning flow, so setup already ran).
   */
  componentSetupState?: Record<string, boolean>;
}

/**
 * One ResourceOwnershipLedger entry: the processes and compose projects the
 * host started on a single plugin's behalf, scoped to a single bench. The host
 * owns every handle, so the ledger is how the startup orphan sweep (issue #613)
 * can reap resources that escaped a plugin crash or a host restart (FR-015).
 *
 * Stored as a flat array of entries (not a nested `Record<pluginId, ...>`) so a
 * plugin-supplied `pluginId` never becomes an object key. That keeps the
 * persisted shape off the CodeQL prototype-pollution surface that indexing by a
 * user-controlled name would otherwise create.
 */
export interface ResourceOwnershipEntry {
  /** The plugin that owns these resources. May be plugin-supplied; never used as an object key. */
  pluginId: string;
  /** The bench the resources belong to. */
  benchId: number;
  /** Opaque process-manager ids the host spawned for this (plugin, bench). */
  processIds: string[];
  /** Compose project names (the `roubo-<projectId>-bench-<N>` convention) the host brought up. */
  composeProjects: string[];
}

export interface PersistedState {
  benches: PersistedBench[];
  /**
   * ResourceOwnershipLedger (FR-015): per-plugin, per-bench record of host-owned
   * processes and compose projects. Optional and additive, so a state.json
   * written before this field existed loads unchanged (no schema migration).
   */
  resourceOwnership?: ResourceOwnershipEntry[];
  /**
   * Single commit point for the pre-plugin → plugin migration (WU-024 / issue #42).
   * Absent on pre-migration installs; bumped to 1 only after every migration
   * side-effect has succeeded. Used as the idempotency gate.
   */
  schemaVersion?: number;
  /** Set alongside `schemaVersion` so the one-time banner can pick its variant. */
  migration?: MigrationRecord;
  /**
   * One-time notice markers, keyed by a stable marker id, recording an ISO 8601
   * timestamp when each notice became applicable. Distinct from the WU-024
   * single `migration` record above so independent one-time notices never
   * overwrite one another. The client renders a marker's banner once and uses
   * its timestamp as the localStorage dismissal key, so it never reappears
   * after dismiss. A fresh install seeds every known marker as already-satisfied
   * (timestamp `"seeded"`) so a banner explaining a changed default never shows
   * to a user who never saw the old default. See `onlyToDoNoticeMarker` (issue #558).
   */
  notices?: Record<string, string>;
}

/**
 * Marker id for the only-to-do default-change notice (FR-018, issue #558). The
 * banner explaining that the cut list now excludes In Progress by default shows
 * once on the first boot of an existing install after upgrade, then never again.
 */
export const ONLY_TO_DO_NOTICE_MARKER = "only-to-do-default-v1";

export interface MigrationRecord {
  status: "success" | "rolled-back";
  /** ISO 8601. The banner uses this as the dismissal-marker key. */
  at: string;
  reason?: string;
  migratedProjectIds: string[];
}

export interface PersistedProjects {
  projects: PersistedProjectEntry[];
}

export interface ProjectPermissions {
  allow: string[];
  deny: string[];
  // optional for legacy state files written before ask support was added
  ask?: string[];
}

// ── Filesystem browsing types ──

export interface DirectoryEntry {
  name: string;
  path: string;
  hasGit: boolean;
}

export interface BrowseDirectoryResponse {
  path: string;
  entries: DirectoryEntry[];
}

// ── Config creator types ──

export interface SuggestedComponent {
  key: string;
  config: ComponentConfig;
  source: string;
}

export interface SuggestedTool {
  config: ToolConfig;
  source: string;
}

export interface RepoScanResult {
  detected: {
    hasGit: boolean;
    submodules: Record<string, string>;
    structureType: "meta-repo" | "monorepo" | "single-repo";
    dockerComposeFiles: string[];
    dockerComposeServiceNames: Record<string, string[]>;
    dockerComposePortVars: Record<string, Record<string, string | null>>; // composeFile → serviceName → port env var name (or null if hardcoded)
    dockerComposeVars: Record<string, Record<string, Record<string, string | null>>>; // composeFile → serviceName → varName → default value (or null)
    dotnetProjects: string[];
    solutionFiles: string[];
    viteProjects: string[];
    envFiles: string[];
    suggestedName: string;
    suggestedRepo: string | null;
    suggestedComponents: SuggestedComponent[];
    suggestedTools: SuggestedTool[];
  };
  existingConfig: { path: string; config: RouboConfig } | null;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  portConflicts: Array<{
    port: string;
    base: number;
    conflictsWith: {
      projectId: string;
      projectName: string;
      port: string;
      range: [number, number];
    };
  }>;
}

export interface SaveConfigRequest {
  repoPath: string;
  config: RouboConfig;
}

export interface SaveConfigResponse {
  path: string;
  config: RouboConfig;
}

export interface ValidateConfigRequest {
  config: RouboConfig;
  currentProjectId?: string;
}

export interface ScanRepoRequest {
  repoPath: string;
}

export interface CheckConfigRequest {
  repoPath: string;
}

export interface CheckConfigPreview {
  name: string;
  displayName: string;
  ports: { name: string; base: number }[];
  benchCap: number;
}

export interface CheckConfigResult {
  hasConfig: boolean;
  configValid: boolean;
  projectName?: string;
  displayName?: string;
  error?: string;
  alreadyRegistered: boolean;
  project?: RegisteredProject;
  preview?: CheckConfigPreview;
}

// ── Terminal types ──

export type ClaudeCodeMode = "auto" | "plan" | "plan-auto";

export function deriveClaudeCodeMode(settings?: ClaudeCodeSettings): ClaudeCodeMode | undefined {
  if (!settings) return undefined;
  const { enableAutoMode, startInPlanMode } = settings;
  if (enableAutoMode && startInPlanMode) return "plan-auto";
  if (enableAutoMode) return "auto";
  if (startInPlanMode) return "plan";
  return undefined;
}

export interface TerminalSession {
  id: string;
  benchKey: string;
  label: string;
  createdAt: string;
  command?: string;
  status: "live" | "ended";
  exitCode?: number;
  claudeCodeMode?: ClaudeCodeMode;
}

export interface PersistedTerminalSession {
  session: TerminalSession;
  buffer: string[];
  persistedAt: string;
}

export interface TerminalCreateRequest {
  command?: string;
  jigId?: string;
}

export interface TerminalCreateResponse {
  sessionId: string;
  label: string;
  wsUrl: string;
  jigInjected?: boolean;
  /** Set when autoExecute=false: jig is scheduled to be written to PTY, not yet sent */
  jigScheduled?: boolean;
  /** Set when the resolved jig content exceeds MAX_CLI_PROMPT_LENGTH and was truncated */
  sizeWarning?: boolean;
}

// ── Inspection run types ──

export type InspectionRunStatus = "running" | "passed" | "failed" | "error" | "aborted";

export interface InspectionRun {
  id: string;
  projectId: string;
  benchId: number;
  status: InspectionRunStatus;
  filter?: string;
  output: string[];
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
}

export interface StartInspectionRequest {
  filter?: string;
}

// ── GitHub issue types ──
// Legacy: not on the issue-retrieval request path after WU-016. Still used by
// internal bench-assignment flows (server/services/{issue-assignment,auto-clear}.ts)
// pending a follow-up WU that migrates bench state to externalId.

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  assignee?: string;
  milestone?: string;
  type?: string;
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  htmlUrl: string;
  blockedBy?: Array<{ number: number; title: string }>;
  blockingCount?: number;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

/**
 * Plugin-produced normalized issue contract. Every integration plugin
 * (github-com, github-enterprise, jira, third-party) returns issues in
 * this shape; every Roubo consumer reads this shape.
 *
 * Intentionally excludes sprint, fixVersion, custom fields, attachments,
 * comments, and hierarchical links (parent/children/epic). See FR-021.
 */
export interface NormalizedIssue {
  integrationId: string;
  externalId: string;
  externalUrl: string;
  title: string;
  body: string | null;
  currentState: string;
  allowedTransitions: string[];
  assignees: Array<{ externalId: string; displayName: string }>;
  labels: string[];
  issueType: string | null;
  blocks: string[];
  blockedBy: string[];
  updatedAt: string;
  raw: unknown;
  // Keys match facet ids returned by `filterFacets` (host-API 1.1.0+). Plugins
  // built against 1.0.0 omit this; core treats absence as an empty map.
  facetValues?: Record<string, string | string[]>;
}

/**
 * A normalized comment on a NormalizedIssue, returned by the active
 * integration plugin's `getComments` JSON-RPC method (WU-016).
 */
export interface NormalizedComment {
  externalId: string;
  author: { externalId: string; displayName: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One entry of the source list the host passes into source-bound contract
 * methods. Mirrors `ConfiguredSource` in `@roubo/plugin-sdk`.
 */
export interface ConfiguredSource {
  kind: string;
  externalId: string;
  /**
   * Jira self-hosted only: the project key this source is scoped to under the
   * project-first selection model. Other plugins ignore.
   */
  project?: string;
  /**
   * Jira self-hosted only: for a `board` source, resolve to the active sprint
   * (default) or the whole board's backing filter.
   */
  boardMode?: "active-sprint" | "whole-board";
  /**
   * Jira self-hosted only: for the synthetic `mine` source, scope to the
   * in-scope projects or match anywhere.
   */
  mineScope?: "in-project" | "anywhere";
  /**
   * GitHub family only: per-source toggles for Code Scanning, Secret Scanning,
   * and Dependabot alerts. Default false on each. Other plugins ignore.
   */
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

/**
 * Discriminator for `ListIssuesWarning.code`. Mirrors
 * `ListIssuesWarningCode` in `@roubo/plugin-sdk`. The cut-list source picker
 * uses this to pick chip variants for the GitHub family's PAT/OAuth
 * remediation affordances.
 */
export type ListIssuesWarningCode =
  | "missing-scope"
  | "scope-unverifiable"
  | "feature-disabled"
  | "insufficient-permission"
  | "not-found"
  | "rate-limited"
  | "unknown";

/**
 * Non-fatal warning about a single source / category for a `listIssues` call.
 * Mirrors `ListIssuesWarning` in `@roubo/plugin-sdk`. A given
 * `(sourceExternalId, category)` warning clears on the next successful
 * page-1 pull that omits it.
 *
 * `code` is an optional discriminator the client uses to pick a chip variant.
 */
export interface ListIssuesWarning {
  category: "code-scanning" | "secret-scanning" | "dependabot" | string;
  sourceExternalId: string;
  cause: string;
  code?: ListIssuesWarningCode;
  detail?: { status?: number; code?: string; missingScope?: string };
}

/**
 * Descriptor returned by the active integration plugin's `filterFacets` RPC
 * (host-API 1.1.0+). The cut-list filter row renders one section per facet;
 * `enum-async` sections load their options lazily via `getFacetOptions`.
 * Mirrors `FilterFacet` in `@roubo/plugin-sdk` so the web client can consume
 * the server's `/integration/filter-facets` response without depending on
 * the plugin SDK.
 */
export interface FilterFacet {
  id: string;
  label: string;
  type: "enum" | "enum-async" | "multi-enum";
  options?: FilterFacetOption[];
}

/**
 * One option for a `FilterFacet`. Used both inline (eager `enum`/`multi-enum`)
 * and as the response shape of `getFacetOptions` (lazy `enum-async`). Mirrors
 * `FilterFacetOption` in `@roubo/plugin-sdk`.
 */
export interface FilterFacetOption {
  value: string;
  label: string;
}

/**
 * Descriptor returned by the active integration plugin's `getSortFields` RPC
 * (host-API 1.2.0+, CLI-FR-009). The cut-list sort picker renders one option
 * per field; `defaultDir` is the direction first applied when the user selects
 * the field. Mirrors `SortField` in `@roubo/plugin-sdk` so the web client can
 * consume the server's `/issues/sort-fields` response without depending on the
 * plugin SDK. An empty array (or `MethodNotFound` from an older plugin) means
 * the host renders no picker (CLI-FR-011).
 */
export interface SortField {
  id: string;
  label: string;
  defaultDir: "asc" | "desc";
}

/** Parameters for the plugin's paginated `listIssues` JSON-RPC call (FR-022). */
export interface ListIssuesParams {
  sources: ConfiguredSource[];
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
  /**
   * Plugin-declared sort selection (CLI-FR-009/CLI-FR-010). `sortBy` is a
   * field id the plugin returned from `getSortFields`; `sortDir` is the
   * direction. Applied source-side by the plugin so the order is stable across
   * pages. Absent means the plugin's natural order (key-ascending fallback,
   * CLI-FR-010); a plugin that ignores these fields yields its natural order.
   */
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /**
   * Status exclusion resolved by the host from the three-layer merge (FR-009,
   * FR-010). Applied in the query so excluded issues never occupy a result
   * page. `excludedStatusCategories` is the category-first default (e.g.
   * `["Done"]`); `excludedStatuses` is the status-name list used by a plugin
   * as the fallback when the instance does not support `statusCategory` in its
   * query language. A plugin that does not do server-side exclusion ignores both.
   */
  excludedStatusCategories?: string[];
  excludedStatuses?: string[];
}

/**
 * Server response to `GET /api/projects/:projectId/issues`.
 * `stalled` is set by the host when the plugin paginator misbehaves
 * (TC-071): in that case `nextCursor` is forced to `null` so the
 * client stops fetching, and the UI surfaces a note.
 *
 * FR-014: when the active plugin is `errored` or `disabled` and a prior
 * first-page response was cached, the host serves that snapshot with
 * `stale: true` and `snapshotCapturedAt` set to the ISO timestamp of the
 * captured response. The matching cut-list banner is tracked in #263.
 */
export interface PaginatedIssues {
  items: NormalizedIssue[];
  nextCursor: string | null;
  stalled?: boolean;
  /** Per-source per-category non-fatal warnings from the underlying plugin call. */
  warnings?: ListIssuesWarning[];
  /** True when this response is a cached snapshot served because the plugin is unavailable. */
  stale?: boolean;
  /**
   * ISO timestamp of the cached response. Present when this body carries a
   * persisted snapshot: set on the FR-014 errored/disabled stale serve and on
   * the stale-while-revalidate warm serve (`cacheStatus: 'revalidating'`).
   */
  snapshotCapturedAt?: string;
  /**
   * Where this first-page response came from, the stale-while-revalidate
   * cache-state signal the client maps onto the warm / revalidating / stale
   * indicator (CLI-FR-002):
   * - `'revalidating'`: served instantly from the persisted disk snapshot while
   *   a background revalidation fetches fresh data (the warm path).
   * - `'miss'`: no usable snapshot, the live response was fetched (and, for a
   *   first page, persisted).
   * - `'hit'`: served from the snapshot without triggering a background
   *   revalidation.
   * Additive and first-page-only; absent on paginated (cursor > 0) responses.
   */
  cacheStatus?: "hit" | "miss" | "revalidating";
  /**
   * Count of issues the active plugin dropped in-query (e.g. status-category
   * exclusion, FR-009/FR-010). Passed through from the plugin's
   * `ListIssuesResult`; omitted when the plugin can't cheaply report it.
   */
  excludedCount?: number;
}

/** Server response to `GET /api/projects/:projectId/issue-types` (WU-016). */
export type ProjectIssueTypesV2Response =
  | { configured: true; types: string[] }
  | {
      configured: false;
      reason: ProjectIssueTypesUnavailableReason;
      types: string[];
    };

export interface AssignedIssue {
  // Legacy GitHub issue number. Present for github-com issues and security
  // alerts (where it holds the alert number); load-time migration derives
  // externalId from this for pre-plugin benches. Absent for integrations whose
  // issues have no numeric form (e.g. Jira keys like PLNRPTGOOG-3782), which
  // identify by externalId/integrationId instead. Consumers that need a GitHub
  // issue number must guard on its presence.
  number?: number;
  integrationId: string;
  externalId: string;
  title: string;
  // Plugin-provided externalIds of the issues blocking this one (e.g.
  // `owner/repo#123` for GitHub, `PROJ-45` for Jira). Populated on bench-detail
  // fetch when enforceIssueDependencies is on. Empty/absent means unblocked.
  blockedBy?: string[];
  /**
   * PRs seeded at assignment time from CrossReferencedEvent timeline items
   * (e.g. `Closes #123` in PR bodies). Does not include PRs linked via
   * GitHub's UI sidebar (DevelopmentEvent/ConnectedEvent).
   */
  // Optional for backwards compat: state.json persisted before this field was added will lack it.
  linkedPullRequests?: Array<{
    repoFullName: string;
    number: number;
  }>;
  /**
   * Frozen snapshot of the issue's type at assignment time (e.g. "bug",
   * "security-dependabot"). Drives blueprint-by-issue-type counting in the
   * source-picker Configure dialog and survives the user toggling the alert
   * category off afterwards. Never re-validated against current listIssueTypes.
   * Optional: benches assigned before this field was added persist without it.
   */
  issueType?: string | null;
  /**
   * Plugin-scoped opaque payload (NFR-004). Allowed on the active bench's
   * assignedIssue so a plugin can re-hydrate context across Roubo restarts.
   * Removed from state.json when the bench is cleared (removeBench filters
   * the bench record out entirely). Plugins MUST NOT include PII here
   * unless functionally required.
   */
  raw?: unknown;
}

export interface AssignIssueRequest {
  /**
   * The issue's externalId (e.g. `owner/repo#123`, `owner/repo#code-scanning-117`,
   * or a Jira key like `PROJ-45`). The issue is resolved via the active plugin.
   */
  externalId: string;
}

export interface AssignIssueResponse {
  bench: Bench;
  terminalSessionId: string | undefined;
}

// ── GitHub project types ──

export interface GitHubProject {
  number: number;
  title: string;
}

// ── GitHub project item types ──

export interface GitHubProjectItem {
  issue: GitHubIssue;
  status?: string | null;
}

// ── GitHub issue type types ──

export interface GitHubIssueType {
  id: string;
  name: string;
  description?: string;
  color?: string;
}

export type ProjectIssueTypesUnavailableReason = "none-defined" | "not-connected";

export type ProjectIssueTypesResponse =
  | { configured: true; types: GitHubIssueType[] }
  | {
      configured: false;
      reason: ProjectIssueTypesUnavailableReason;
      types: GitHubIssueType[];
    };

// ── Jig management types ──

export type JigSource = "app" | "project";

export interface JigMeta {
  id: string;
  name: string;
  description: string;
  icon: string;
  source: JigSource;
  createdAt?: string; // ISO-8601; absent for the embedded global default
  updatedAt?: string; // ISO-8601
  approxTokens?: number; // chars/4 estimate, lets UIs render a context-usage signal
}

export interface JigDetail extends JigMeta {
  content: string;
  sizeBytes: number;
  sizeWarning?: boolean;
  approxTokens: number; // always present on detail responses
}

export const GLOBAL_DEFAULT_JIG_ID = "__global_default__";

/** Default Claude context window size in tokens. Used for jig context-usage estimates. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Prefix for component provisioning step IDs; must stay in sync between server and client. */
export const COMPONENT_STEP_PREFIX = "component:";

/**
 * Delay (ms) between creating a Claude terminal session and writing to it.
 * Claude Code needs time to start and begin accepting stdin; writing too early
 * causes the jig to be silently dropped. If Claude starts slowly (e.g. slow
 * machine, heavy load), this delay may still not be enough; the injection will
 * fail without any error signal.
 */
export const CLAUDE_STARTUP_DELAY_MS = 1500;

export const DEFAULT_JIG_SETTINGS: JigSettings = {
  autoInject: true,
  autoExecute: true,
};

export interface InjectJigRequest {
  jigId: string;
  sessionId?: string;
}

export interface InjectJigResponse {
  success: boolean;
  resolvedLength: number;
}

export interface JigCreateRequest {
  name: string; // 1–100 chars after trim
  description: string; // 1–300 chars after trim
  icon?: string; // optional; defaults to 'file-text'
  content: string; // non-empty; max 200 KB utf-8
}

export interface JigUpdateRequest {
  name?: string;
  description?: string;
  icon?: string;
  content?: string;
}

export type JigReference =
  | { type: "app-default" }
  | { type: "project-default"; projectId: string; projectName: string }
  | {
      type: "issue-type-mapping";
      projectId: string;
      projectName: string;
      issueType: string;
    };

export interface JigDeleteConflictResponse {
  error: string;
  code: "JIG_REFERENCED";
  references: JigReference[];
}

export type JigDefaultSource = "issue-type-mapping" | "project" | "app" | "global";

export interface ProjectDefaultJigResponse {
  jigId: string;
  source: JigDefaultSource;
}

export interface UpdateProjectDefaultJigRequest {
  jigId: string | null;
}

export interface JigPreviewRequest {
  content: string;
  projectId?: string;
  benchId?: number;
}

export interface JigPreviewResponse {
  resolved: string;
  unresolvedVariables: string[];
}

export interface ProjectIssueTypeMappingsResponse {
  mappings: Record<string, string>;
}

export interface UpdateProjectIssueTypeMappingsRequest {
  mappings: Record<string, string>;
}

// ── User preferences types ──

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export interface BenchSettings {
  enforceIssueDependencies: boolean;
  autoStartComponents: boolean;
  /** Application-wide cap on initialised benches. Positive integer (>= 1); absent means unlimited. */
  maxGlobal?: number;
}

export const DEFAULT_BENCH_SETTINGS: BenchSettings = {
  enforceIssueDependencies: false,
  autoStartComponents: false,
};

export interface TestBenchSettings {
  /** Master toggle for the TestBench feature. When false, no TestBench UI is offered. */
  enabled: boolean;
}

export const DEFAULT_TESTBENCH_SETTINGS: TestBenchSettings = {
  enabled: true,
};

export interface ClaudeCodeSettings {
  enableAutoMode: boolean;
  startInPlanMode: boolean;
}

export const DEFAULT_CLAUDE_CODE_SETTINGS: ClaudeCodeSettings = {
  enableAutoMode: false,
  startInPlanMode: false,
};

export interface GitHubSettings {
  issueTypesCacheTtlSeconds: number;
}

export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = {
  issueTypesCacheTtlSeconds: 300,
};

export interface UserPreferences {
  theme: ThemeMode;
  jigs?: JigSettings;
  benches?: BenchSettings;
  testBench?: TestBenchSettings;
  claudeCode?: ClaudeCodeSettings;
  github?: GitHubSettings;
}

export interface SettingsResponse extends UserPreferences {
  claudeCodeAutoModeAvailable: boolean;
  claudeCodeAutoModeReason?: string;
  contextWindow: number;
}

// ── Combined create-and-assign types ──

export interface BranchConflictInfo {
  branchExists: boolean;
  workspaceExists: boolean;
  branchName: string;
}

export type CreateBenchWithIssueResponse =
  | { status: "success"; bench: Bench; terminalSessionId: string | undefined }
  | { status: "conflict"; branchConflict: BranchConflictInfo };

export type GitHubErrorCode =
  | "NOT_CONNECTED"
  | "SCOPES_OUTDATED"
  | "ORG_APPROVAL_REQUIRED"
  | "SAML_SSO_REQUIRED"
  | "OWNER_NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK"
  | "UNKNOWN";
