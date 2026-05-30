import type {
  CapturedUserId,
  IntegrationCategoryReport,
  IntegrationCategoryStatus,
  IntegrationConfig,
  IntegrationTestErrorKind,
  IntegrationTestResult,
  PluginManifest,
  PluginRecord,
} from "@roubo/shared";
import { CapturedUserIdSchema, INTEGRATION_CATEGORY_LABELS } from "@roubo/shared";
import type {
  ProbeAlertCategoriesResult,
  ProbeAlertCategory,
  ValidateConfigResult,
} from "@roubo/plugin-sdk";
import * as credentialStore from "./credential-store.js";
import * as pluginManager from "./plugin-manager.js";
import { translateSources } from "./plugin-source-translation.js";

export function passwordFieldKeys(manifest: PluginManifest | null | undefined): string[] {
  if (!manifest?.configSchema) return [];
  const props = (manifest.configSchema as { properties?: Record<string, unknown> }).properties;
  if (!props) return [];
  const keys: string[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as { type?: unknown }).type === "string" &&
      (raw as { format?: unknown }).format === "password"
    ) {
      keys.push(key);
    }
  }
  return keys;
}

// Persist secret form values to the OS keyring before validateConfig runs so
// the plugin's `host.credentials.get` returns the freshly-typed value. Slot
// name follows the convention `key === manifest.permissions.credentials.slots[*].slot`;
// if the manifest doesn't declare a matching slot the field name itself is used
// (so a plugin that adds a password field without declaring a slot still works,
// at the cost of skipping the manifest's slot-description on the dialog hint).
export async function persistSecretFields(
  pluginId: string,
  manifest: PluginManifest | null | undefined,
  config: Record<string, unknown>,
): Promise<void> {
  const keys = passwordFieldKeys(manifest);
  for (const key of keys) {
    const value = config[key];
    if (typeof value !== "string" || value.length === 0) continue;
    await credentialStore.set(pluginId, key, value);
  }
}

const TLS_PATTERNS = [
  /self.signed certificate/i,
  /DEPTH_ZERO_SELF_SIGNED_CERT/,
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE/,
  /unable to verify the first certificate/i,
  /CERT_[A-Z_]+/,
];
const NETWORK_PATTERNS = [/ENOTFOUND/, /ECONNREFUSED/, /ETIMEDOUT/, /EAI_AGAIN/];
const AUTH_PATTERNS = [/\b401\b/, /\b403\b/, /unauthor/i, /authenticat/i, /forbidden/i];

export function classifyError(message: string): IntegrationTestErrorKind {
  if (TLS_PATTERNS.some((p) => p.test(message))) return "tls";
  if (NETWORK_PATTERNS.some((p) => p.test(message))) return "network";
  if (AUTH_PATTERNS.some((p) => p.test(message))) return "auth";
  return "other";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

// Plugin ids that model the three GitHub Advanced Security alert categories.
// Other plugins ignore the per-source alert flags entirely, so the host
// shouldn't ask them to probe.
const GITHUB_FAMILY_PLUGIN_IDS = new Set(["github-com", "ghe"]);

// Host-side budgets for the per-category probe (FR-047, WU-034). The per-probe
// value is what gets handed to the plugin so it can race each individual HTTP
// probe (5s per-probe cap); the invoke timeout caps the whole RPC round-trip
// (12s overall budget). Probes run in parallel inside the plugin via
// `Promise.allSettled`, so the wall-clock budget is roughly the slowest
// per-probe value plus RPC overhead, bounded above by the invoke timeout.
const PROBE_PER_REQUEST_TIMEOUT_MS = 5_000;
const PROBE_INVOKE_TIMEOUT_MS = 12_000;

interface SourceWithAlertFlags {
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

export interface RunIntegrationTestContext {
  /**
   * The project's currently-saved effective integration config. Drives which
   * alert categories the host asks the plugin to probe: the union across all
   * saved sources. At global plugin scope the route passes no context, so no
   * category probes run and only the always-on Issues row is emitted.
   */
  effective: IntegrationConfig;
}

function issuesRow(): IntegrationCategoryReport {
  return {
    category: "issues",
    label: INTEGRATION_CATEGORY_LABELS.issues,
    status: "ok",
  };
}

function computeEnabledCategories(sources: readonly SourceWithAlertFlags[]): ProbeAlertCategory[] {
  let codeQl = false;
  let secret = false;
  let dependabot = false;
  for (const source of sources) {
    if (source.includeCodeQLAlerts === true) codeQl = true;
    if (source.includeSecretScanningAlerts === true) secret = true;
    if (source.includeDependabotAlerts === true) dependabot = true;
  }
  const out: ProbeAlertCategory[] = [];
  if (codeQl) out.push("code-scanning");
  if (secret) out.push("secret-scanning");
  if (dependabot) out.push("dependabot");
  return out;
}

function categoryIdFor(
  probeCategory: ProbeAlertCategory,
): "code-scanning" | "secret-scanning" | "dependabot" {
  return probeCategory;
}

function buildErrorReports(
  enabledCategories: readonly ProbeAlertCategory[],
  detail: string,
): IntegrationCategoryReport[] {
  return enabledCategories.map((category) => ({
    category: categoryIdFor(category),
    label: INTEGRATION_CATEGORY_LABELS[categoryIdFor(category)],
    status: "error" as IntegrationCategoryStatus,
    detail,
  }));
}

function isMethodNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code === "MethodNotFound";
}

async function runCategoryProbes(
  record: PluginRecord,
  ctx: RunIntegrationTestContext,
): Promise<IntegrationCategoryReport[]> {
  // Only the GitHub-family plugins model these categories today. Anything else
  // returns just the Issues row.
  if (!GITHUB_FAMILY_PLUGIN_IDS.has(record.id)) return [];

  const sources = translateSources(ctx.effective.sources);
  if (sources.length === 0) return [];

  const enabledCategories = computeEnabledCategories(sources);
  if (enabledCategories.length === 0) return [];

  try {
    const result = await pluginManager.invoke<ProbeAlertCategoriesResult>(
      record.id,
      "probeAlertCategories",
      {
        sources,
        enabledCategories,
        timeoutMsPerProbe: PROBE_PER_REQUEST_TIMEOUT_MS,
      },
      { timeoutMs: PROBE_INVOKE_TIMEOUT_MS },
    );

    if (!result || !Array.isArray(result.reports)) {
      return buildErrorReports(enabledCategories, "Plugin returned an invalid probe response.");
    }

    const byCategory = new Map<ProbeAlertCategory, (typeof result.reports)[number]>();
    for (const report of result.reports) {
      byCategory.set(report.category, report);
    }
    return enabledCategories.map<IntegrationCategoryReport>((category) => {
      const id = categoryIdFor(category);
      const report = byCategory.get(category);
      if (!report) {
        return {
          category: id,
          label: INTEGRATION_CATEGORY_LABELS[id],
          status: "error",
          detail: "Plugin did not report this category.",
        };
      }
      return {
        category: id,
        label: INTEGRATION_CATEGORY_LABELS[id],
        status: report.status,
        ...(report.detail !== undefined ? { detail: report.detail } : {}),
        ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
      };
    });
  } catch (err) {
    if (isMethodNotFound(err)) {
      // Plugin doesn't implement the optional method: surface no category
      // rows beyond Issues, leaving the test "ok" per FR-047.
      return [];
    }
    return buildErrorReports(enabledCategories, errorMessage(err));
  }
}

// Runs the plugin's validateConfig + getCurrentUser pair against an arbitrary
// config snapshot and classifies any failure. Shared between the project- and
// plugin-scoped Configure dialogs (the only difference between them is which
// override file a successful test eventually writes to, and whether the
// per-category probe runs).
export async function runIntegrationTest(
  record: PluginRecord,
  config: Record<string, unknown>,
  ctx?: RunIntegrationTestContext,
): Promise<IntegrationTestResult> {
  try {
    // Inspect the validateConfig result rather than blindly proceeding. When
    // validation resolves with { ok: false } the plugin has not set its active
    // config (e.g. GHE rolls back to null on a failed probe), so calling
    // getCurrentUser next would throw a misleading "No active configuration"
    // error that masks the real reason (TLS / auth / network) and defeats the
    // self-signed-TLS opt-in affordance, which keys off the classified kind.
    // A plugin that resolves undefined (no plugin-wide config to validate) is
    // still treated as success.
    const validation = await pluginManager.invoke<ValidateConfigResult | undefined>(
      record.id,
      "validateConfig",
      { config },
      { timeoutMs: 15_000 },
    );
    if (validation && validation.ok === false) {
      const first = validation.errors?.[0];
      const message = first
        ? `${first.field ? `${first.field}: ` : ""}${first.message}`
        : "Configuration validation failed.";
      return { ok: false, error: { kind: classifyError(message), message } };
    }
    const identity = await pluginManager.invoke<CapturedUserId>(
      record.id,
      "getCurrentUser",
      {},
      { timeoutMs: 15_000 },
    );
    const parsedIdentity = CapturedUserIdSchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return {
        ok: false,
        error: {
          kind: "other",
          message: "Plugin returned an invalid getCurrentUser response.",
        },
      };
    }
    const categories: IntegrationCategoryReport[] = [issuesRow()];
    if (ctx) {
      const probed = await runCategoryProbes(record, ctx);
      categories.push(...probed);
    }
    return { ok: true, identity: parsedIdentity.data, categories };
  } catch (err) {
    const message = errorMessage(err);
    return { ok: false, error: { kind: classifyError(message), message } };
  }
}
