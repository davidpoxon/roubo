import { ResponseError } from "vscode-jsonrpc/node.js";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import * as credentialStore from "./credential-store.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";

// JSON-RPC server-error range; we use a single app-level code and surface the
// specific reason via the structured `data` payload.
const PERMISSION_DENIED_CODE = -32001;
const INTERNAL_ERROR_CODE = -32603;

export type HostLogger = (level: "info" | "warn" | "error", text: string) => void;

export interface PermissionDeniedData {
  code: "permission-denied";
  category: "credentials";
  slot: string;
  reason: "slot-not-declared" | "scope-read-only";
}

export interface CredentialStoreLike {
  get(pluginId: string, slot: string): Promise<string | null>;
  set(pluginId: string, slot: string, value: string): Promise<void>;
  deleteSlot(pluginId: string, slot: string): Promise<void>;
}

interface RegisterOptions {
  store?: CredentialStoreLike;
}

function findSlot(manifest: PluginManifest, slot: string) {
  return manifest.permissions.credentials.slots.find((s) => s.slot === slot);
}

function denyPermission(
  pluginId: string,
  methodName: string,
  log: HostLogger,
  data: PermissionDeniedData,
): never {
  log("warn", `${pluginId}.${methodName} denied: slot="${data.slot}" reason="${data.reason}"`);
  throw new ResponseError<PermissionDeniedData>(
    PERMISSION_DENIED_CODE,
    `Permission denied: ${data.reason} for slot "${data.slot}"`,
    data,
  );
}

function wrapInternal(pluginId: string, methodName: string, log: HostLogger, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "internal-error";
  log("error", `${pluginId}.${methodName} failed: ${code}: ${message}`);
  throw new ResponseError(INTERNAL_ERROR_CODE, message, { code });
}

export function registerHostHandlers(
  connection: JsonRpcConnection,
  record: PluginRecord,
  log: HostLogger,
  options: RegisterOptions = {},
): void {
  const manifest = record.manifest;
  if (!manifest) return;
  const pluginId = record.id;
  const store: CredentialStoreLike = options.store ?? credentialStore;

  connection.onRequest<{ slot: string }, string | null>("host.credentials.get", async (params) => {
    const slot = params?.slot;
    const method = "host.credentials.get";
    if (typeof slot !== "string" || slot.length === 0) {
      throw new ResponseError(PERMISSION_DENIED_CODE, `Missing slot parameter`, {
        code: "invalid-params",
        category: "credentials",
      });
    }
    const declared = findSlot(manifest, slot);
    if (!declared) {
      denyPermission(pluginId, method, log, {
        code: "permission-denied",
        category: "credentials",
        slot,
        reason: "slot-not-declared",
      });
    }
    try {
      return await store.get(pluginId, slot);
    } catch (err) {
      wrapInternal(pluginId, method, log, err);
    }
  });

  connection.onRequest<{ slot: string; value: string }, null>(
    "host.credentials.set",
    async (params) => {
      const slot = params?.slot;
      const value = params?.value;
      const method = "host.credentials.set";
      if (typeof slot !== "string" || slot.length === 0 || typeof value !== "string") {
        throw new ResponseError(PERMISSION_DENIED_CODE, `Missing slot or value parameter`, {
          code: "invalid-params",
          category: "credentials",
        });
      }
      const declared = findSlot(manifest, slot);
      if (!declared) {
        denyPermission(pluginId, method, log, {
          code: "permission-denied",
          category: "credentials",
          slot,
          reason: "slot-not-declared",
        });
      }
      if (declared.scope !== "read-write") {
        denyPermission(pluginId, method, log, {
          code: "permission-denied",
          category: "credentials",
          slot,
          reason: "scope-read-only",
        });
      }
      try {
        await store.set(pluginId, slot, value);
        return null;
      } catch (err) {
        wrapInternal(pluginId, method, log, err);
      }
    },
  );

  connection.onRequest<{ slot: string }, null>("host.credentials.delete", async (params) => {
    const slot = params?.slot;
    const method = "host.credentials.delete";
    if (typeof slot !== "string" || slot.length === 0) {
      throw new ResponseError(PERMISSION_DENIED_CODE, `Missing slot parameter`, {
        code: "invalid-params",
        category: "credentials",
      });
    }
    const declared = findSlot(manifest, slot);
    if (!declared) {
      denyPermission(pluginId, method, log, {
        code: "permission-denied",
        category: "credentials",
        slot,
        reason: "slot-not-declared",
      });
    }
    if (declared.scope !== "read-write") {
      denyPermission(pluginId, method, log, {
        code: "permission-denied",
        category: "credentials",
        slot,
        reason: "scope-read-only",
      });
    }
    try {
      await store.deleteSlot(pluginId, slot);
      return null;
    } catch (err) {
      wrapInternal(pluginId, method, log, err);
    }
  });
}
