import type { MessageConnection } from "vscode-jsonrpc/node.js";
import type { FetchInit, FetchResult, HostClient, LogPayload } from "./types.js";

let activeConnection: MessageConnection | null = null;

export function bindHostConnection(connection: MessageConnection): void {
  activeConnection = connection;
}

export function unbindHostConnection(connection: MessageConnection): void {
  if (activeConnection === connection) {
    activeConnection = null;
  }
}

function requireConnection(): MessageConnection {
  if (!activeConnection) {
    throw new Error(
      "@roubo/plugin-sdk: host.* called before definePlugin(). Call definePlugin({...}) once at module top level.",
    );
  }
  return activeConnection;
}

function logText(payload: LogPayload): { message: string; data?: unknown } {
  if (typeof payload === "string") return { message: payload };
  return { message: payload.message, data: payload.data };
}

export const host: HostClient = Object.freeze({
  async fetch(url: string, init?: FetchInit): Promise<FetchResult> {
    return requireConnection().sendRequest<FetchResult>("host.fetch", { url, init: init ?? {} });
  },
  credentials: Object.freeze({
    async get(slot: string): Promise<string | null> {
      return requireConnection().sendRequest<string | null>("host.credentials.get", { slot });
    },
    async set(slot: string, value: string): Promise<void> {
      await requireConnection().sendRequest<null>("host.credentials.set", { slot, value });
    },
  }),
  logger: Object.freeze({
    info(payload: LogPayload): void {
      void requireConnection().sendNotification("host.logger.info", logText(payload));
    },
    warn(payload: LogPayload): void {
      void requireConnection().sendNotification("host.logger.warn", logText(payload));
    },
    error(payload: LogPayload): void {
      void requireConnection().sendNotification("host.logger.error", logText(payload));
    },
  }),
});
