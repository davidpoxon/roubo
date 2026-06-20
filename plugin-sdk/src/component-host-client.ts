import type { MessageConnection } from "vscode-jsonrpc/node.js";
import type {
  CapabilityQueryResult,
  ComponentHostClient,
  ComponentStatus,
  ProcessRunResult,
  ProcessStatusResult,
} from "./types.js";

let activeConnection: MessageConnection | null = null;

export function bindComponentHostConnection(connection: MessageConnection): void {
  activeConnection = connection;
}

export function unbindComponentHostConnection(connection: MessageConnection): void {
  if (activeConnection === connection) {
    activeConnection = null;
  }
}

function requireConnection(): MessageConnection {
  if (!activeConnection) {
    throw new Error(
      "@roubo/plugin-sdk: host.* called before defineComponentPlugin(). Call defineComponentPlugin({...}) once at module top level.",
    );
  }
  return activeConnection;
}

/**
 * The host broker surface a component plugin drives over JSON-RPC. The host
 * owns every process and container handle; these calls ask the host to act on
 * the plugin's behalf. `reportStatus` / `reportLog` are notifications (push,
 * fire-and-forget); everything else is a request that resolves with a result.
 */
export const host: ComponentHostClient = Object.freeze({
  process: Object.freeze({
    async start(params: {
      id: string;
      command: string;
      args?: string[];
      env: Record<string, string>;
      cwd: string;
    }): Promise<{ pid: number }> {
      return requireConnection().sendRequest<{ pid: number }>("host.process.start", params);
    },
    async run(params: {
      id: string;
      command: string;
      args?: string[];
      env: Record<string, string>;
      cwd: string;
      timeoutMs: number;
    }): Promise<ProcessRunResult> {
      return requireConnection().sendRequest<ProcessRunResult>("host.process.run", params);
    },
    async stop(params: { id: string }): Promise<void> {
      await requireConnection().sendRequest<null>("host.process.stop", params);
    },
    async status(params: { id: string }): Promise<ProcessStatusResult> {
      return requireConnection().sendRequest<ProcessStatusResult>("host.process.status", params);
    },
    async logs(params: { id: string }): Promise<string[]> {
      return requireConnection().sendRequest<string[]>("host.process.logs", params);
    },
  }),
  docker: Object.freeze({
    async composeUp(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      service: string;
      env: Record<string, string>;
    }): Promise<{ containerId: string }> {
      return requireConnection().sendRequest<{ containerId: string }>(
        "host.docker.composeUp",
        params,
      );
    },
    async waitForHealthy(params: {
      projectName: string;
      service: string;
      timeoutMs: number;
    }): Promise<{ healthy: boolean }> {
      return requireConnection().sendRequest<{ healthy: boolean }>(
        "host.docker.waitForHealthy",
        params,
      );
    },
    async composeRunInit(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      initService: string;
    }): Promise<void> {
      await requireConnection().sendRequest<null>("host.docker.composeRunInit", params);
    },
    async composeStop(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      service?: string;
    }): Promise<void> {
      await requireConnection().sendRequest<null>("host.docker.composeStop", params);
    },
    async composeDown(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
    }): Promise<void> {
      await requireConnection().sendRequest<null>("host.docker.composeDown", params);
    },
    async assignContainer(params: { componentName: string; containerId: string }): Promise<void> {
      await requireConnection().sendRequest<null>("host.docker.assignContainer", params);
    },
  }),
  ports: Object.freeze({
    async get(params: { componentName: string }): Promise<number> {
      return requireConnection().sendRequest<number>("host.ports.get", params);
    },
  }),
  component: Object.freeze({
    reportStatus(status: ComponentStatus): void {
      void requireConnection().sendNotification("host.component.reportStatus", status);
    },
    reportLog(params: { source: "stdout" | "stderr"; text: string; ts: number }): void {
      void requireConnection().sendNotification("host.component.reportLog", params);
    },
  }),
  capability: Object.freeze({
    async query(params: { method: string }): Promise<CapabilityQueryResult> {
      return requireConnection().sendRequest<CapabilityQueryResult>(
        "host.capability.query",
        params,
      );
    },
  }),
});
