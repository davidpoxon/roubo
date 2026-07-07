import { AsyncLocalStorage } from "node:async_hooks";
import type { MessageConnection } from "vscode-jsonrpc/node";
import type {
  CapabilityQueryResult,
  ComponentHostClient,
  ComponentStatus,
  ProcessRunResult,
  ProcessStatusResult,
} from "./types.js";

let activeConnection: MessageConnection | null = null;

/**
 * The routing key the host needs to dispatch a broker call to the right bench
 * (and, for reportLog, the right component). A component plugin is spawned once
 * and multiplexes benches over one shared connection, so the broker params must
 * name the bench the call acts for (#685). The SDK stamps this from the
 * in-flight lifecycle call rather than burdening plugin authors with passing it
 * by hand: each lifecycle handler dispatch sets the routing context for the
 * duration of the call (see defineComponentPlugin), and every outgoing host.*
 * request/notification reads it back here.
 */
export interface HostRoutingContext {
  benchId: number;
  componentName: string;
}

const routingStore = new AsyncLocalStorage<HostRoutingContext>();

/**
 * Run `fn` with the given routing context bound, so any host.* call it makes
 * (synchronously or via awaited continuations) stamps `benchId` /
 * `componentName` onto its params. Used by defineComponentPlugin to wrap each
 * lifecycle handler dispatch.
 */
export function runWithHostRoutingContext<T>(ctx: HostRoutingContext, fn: () => T): T {
  return routingStore.run(ctx, fn);
}

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
 * The bench this broker call acts for. A host.* call made outside any lifecycle
 * handler (no ambient routing context) cannot be routed, so it throws here
 * rather than silently mis-resolving: the host has no way to attribute it.
 */
function requireBenchId(method: string): number {
  const ctx = routingStore.getStore();
  if (!ctx) {
    throw new Error(
      `@roubo/plugin-sdk: ${method} called outside a lifecycle handler; the host cannot route it to a bench.`,
    );
  }
  return ctx.benchId;
}

function requireComponentName(method: string): string {
  const ctx = routingStore.getStore();
  if (!ctx) {
    throw new Error(
      `@roubo/plugin-sdk: ${method} called outside a lifecycle handler; the host cannot route it to a component.`,
    );
  }
  return ctx.componentName;
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
      const method = "host.process.start";
      return requireConnection().sendRequest<{ pid: number }>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async run(params: {
      id: string;
      command: string;
      args?: string[];
      env: Record<string, string>;
      cwd: string;
      timeoutMs: number;
    }): Promise<ProcessRunResult> {
      const method = "host.process.run";
      return requireConnection().sendRequest<ProcessRunResult>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async stop(params: { id: string }): Promise<void> {
      const method = "host.process.stop";
      await requireConnection().sendRequest<null>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async status(params: { id: string }): Promise<ProcessStatusResult> {
      const method = "host.process.status";
      return requireConnection().sendRequest<ProcessStatusResult>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async logs(params: { id: string }): Promise<string[]> {
      const method = "host.process.logs";
      return requireConnection().sendRequest<string[]>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
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
      const method = "host.docker.composeUp";
      return requireConnection().sendRequest<{ containerId: string }>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async waitForHealthy(params: {
      projectName: string;
      service: string;
      timeoutMs: number;
    }): Promise<{ healthy: boolean }> {
      const method = "host.docker.waitForHealthy";
      return requireConnection().sendRequest<{ healthy: boolean }>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async composeRunInit(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      initService: string;
    }): Promise<void> {
      const method = "host.docker.composeRunInit";
      await requireConnection().sendRequest<null>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async composeStop(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      service?: string;
    }): Promise<void> {
      const method = "host.docker.composeStop";
      await requireConnection().sendRequest<null>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async composeDown(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
    }): Promise<void> {
      const method = "host.docker.composeDown";
      await requireConnection().sendRequest<null>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
    async assignContainer(params: { componentName: string; containerId: string }): Promise<void> {
      const method = "host.docker.assignContainer";
      await requireConnection().sendRequest<null>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
  }),
  ports: Object.freeze({
    async get(params: { componentName: string }): Promise<number> {
      const method = "host.ports.get";
      return requireConnection().sendRequest<number>(method, {
        ...params,
        benchId: requireBenchId(method),
      });
    },
  }),
  component: Object.freeze({
    reportStatus(status: ComponentStatus): void {
      const method = "host.component.reportStatus";
      void requireConnection().sendNotification(method, {
        ...status,
        benchId: requireBenchId(method),
      });
    },
    reportLog(params: { source: "stdout" | "stderr"; text: string; ts: number }): void {
      const method = "host.component.reportLog";
      void requireConnection().sendNotification(method, {
        ...params,
        benchId: requireBenchId(method),
        componentName: requireComponentName(method),
      });
    },
  }),
  capability: Object.freeze({
    async query(params: { method: string }): Promise<CapabilityQueryResult> {
      // capability.query is not bench-routed (it answers a static version gate),
      // so it carries no benchId and works outside a lifecycle handler.
      return requireConnection().sendRequest<CapabilityQueryResult>(
        "host.capability.query",
        params,
      );
    },
  }),
});
