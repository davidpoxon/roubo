import type { ConnectionStatus, ValidateConfigResult } from "@roubo/plugin-sdk";
import * as pluginManager from "./plugin-manager.js";

const RPC_TIMEOUT_MS = 5_000;

/**
 * Host-side wrapper around the plugin's `getConnectionStatus` RPC
 * (host-API 1.1.0+, FR-055). Plugins built against 1.0.0 do not implement
 * `getConnectionStatus`; the host catches the resulting `MethodNotFound`
 * and falls back to invoking `validateConfig`, inferring `connected` vs
 * `auth-problem` from the result. See `.specifications/integration-plugins/prd.md`
 * (FR-055) and TC-113 for the contract.
 *
 * The wrapper is config-agnostic: the caller resolves the plugin-wide
 * config (same shape as `setActiveConfig`) and passes it in. That keeps
 * this module free of the project-registry / overrides plumbing the UI
 * consumer will own.
 */
export async function getConnectionStatus(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<ConnectionStatus> {
  try {
    return await pluginManager.invoke<ConnectionStatus>(
      pluginId,
      "getConnectionStatus",
      undefined,
      { timeoutMs: RPC_TIMEOUT_MS },
    );
  } catch (err) {
    if (!isMethodNotFound(err)) {
      return {
        state: "errored",
        detail: errorMessage(err),
        checkedAt: nowIso(),
      };
    }
    return await fallbackViaValidateConfig(pluginId, config);
  }
}

async function fallbackViaValidateConfig(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<ConnectionStatus> {
  let result: ValidateConfigResult;
  try {
    result = await pluginManager.invoke<ValidateConfigResult>(
      pluginId,
      "validateConfig",
      { config },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
  } catch (err) {
    if (isMethodNotFound(err)) {
      // No plugin-wide config to validate (e.g. github.com with a fixed
      // API host). The spec treats this as healthy in the fallback path.
      return { state: "connected", checkedAt: nowIso() };
    }
    return {
      state: "errored",
      detail: errorMessage(err),
      checkedAt: nowIso(),
    };
  }

  if (result.ok) {
    return { state: "connected", checkedAt: nowIso() };
  }
  return {
    state: "auth-problem",
    detail: result.errors?.[0]?.message,
    checkedAt: nowIso(),
  };
}

function isMethodNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code === "MethodNotFound";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

function nowIso(): string {
  return new Date().toISOString();
}
