import type { Response } from "express";
import type { PluginError } from "@roubo/shared";

// Serialises a thrown plugin-RPC error into the response shape that
// `client/src/lib/api.ts:ApiError` expects: `body.error` is the human message
// and `body.code` is the plugin code (e.g. "rpc-error", "rpc-init-failed",
// "plugin-not-enabled", "unknown-plugin", "timeout"). This mirrors the shape
// emitted by `sendGitHubErrorResponse` so both error paths round-trip through
// ApiError the same way.
export function sendPluginRpcError(res: Response, err: unknown): void {
  const pluginErr = err as Partial<PluginError> & { message?: string };
  const code = typeof pluginErr.code === "string" ? pluginErr.code : "rpc-error";
  const message = pluginErr.message ?? "Plugin call failed";
  const status =
    code === "plugin-not-enabled" || code === "unknown-plugin"
      ? 503
      : code === "timeout"
        ? 504
        : 502;
  res.status(status).json({ error: message, code, params: {} });
}
