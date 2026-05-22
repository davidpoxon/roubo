import { ApiError } from "./api";

// Unwraps a verbatim plugin error message from an ApiError thrown by the
// host's plugin-RPC routes. Falls back to the generic Error message, then to
// the caller-supplied default.
export function extractPluginErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const details = err.details;
    if (details && typeof details === "object" && "message" in details) {
      const m = (details as { message?: unknown }).message;
      if (typeof m === "string" && m.length > 0) return m;
    }
  }
  if (err instanceof Error && err.message.length > 0) return err.message;
  return fallback;
}
