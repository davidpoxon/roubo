import type {
  CapturedUserId,
  IntegrationTestErrorKind,
  IntegrationTestResult,
  PluginManifest,
  PluginRecord,
} from "@roubo/shared";
import { CapturedUserIdSchema } from "@roubo/shared";
import * as credentialStore from "./credential-store.js";
import * as pluginManager from "./plugin-manager.js";

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

// Runs the plugin's validateConfig + getCurrentUser pair against an arbitrary
// config snapshot and classifies any failure. Shared between the project- and
// plugin-scoped Configure dialogs (the only difference between them is which
// override file a successful test eventually writes to).
export async function runIntegrationTest(
  record: PluginRecord,
  config: Record<string, unknown>,
): Promise<IntegrationTestResult> {
  try {
    await pluginManager.invoke(record.id, "validateConfig", { config }, { timeoutMs: 15_000 });
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
    return { ok: true, identity: parsedIdentity.data };
  } catch (err) {
    const message = errorMessage(err);
    return { ok: false, error: { kind: classifyError(message), message } };
  }
}
