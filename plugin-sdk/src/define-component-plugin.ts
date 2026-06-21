import type { MessageConnection } from "vscode-jsonrpc/node.js";
import {
  bindComponentHostConnection,
  host,
  type HostRoutingContext,
  runWithHostRoutingContext,
  unbindComponentHostConnection,
} from "./component-host-client.js";
import { createPluginConnection } from "./connection.js";
import {
  SUPPORTED_CONTRACT_VERSION,
  type ComponentContract,
  type ComponentContractMethodName,
  type ComponentHostClient,
  type ComponentPluginHandle,
  type DefineComponentPluginOptions,
} from "./types.js";

const IMPERATIVE_HOOKS: readonly ComponentContractMethodName[] = [
  "start",
  "stop",
  "health",
  "cleanup",
] as const;

const COMPONENT_CONTRACT_METHODS: readonly ComponentContractMethodName[] = [
  "translate",
  ...IMPERATIVE_HOOKS,
] as const;

/** Pull the `context` field out of a `translate` call's `{ config, context }`. */
function extractContext(params: unknown): unknown {
  return params && typeof params === "object" ? (params as { context?: unknown }).context : params;
}

/**
 * Read the bench routing key (benchId + componentName) off a lifecycle call's
 * BenchContext. Returns null when the shape does not carry both, so the handler
 * runs without an ambient routing context rather than with a partial one.
 */
function readRouting(benchContext: unknown): HostRoutingContext | null {
  if (!benchContext || typeof benchContext !== "object") return null;
  const { benchId, componentName } = benchContext as {
    benchId?: unknown;
    componentName?: unknown;
  };
  if (typeof benchId !== "number" || typeof componentName !== "string") return null;
  return { benchId, componentName };
}

/**
 * Register a component plugin's contract over the host JSON-RPC channel,
 * parallel to `definePlugin()`. Plugin authors call this once, at module
 * top-level, after defining their contract.
 *
 * A component plugin is written in one of two mutually exclusive modes:
 *
 * - **Declarative (preferred):** implement `translate({ config, context })`,
 *   returning a `ProvisionDescriptor` the host's LifecycleEngine executes.
 * - **Imperative (escape hatch):** implement all four lifecycle hooks
 *   `start` / `stop` / `health` / `cleanup`, driving the host broker
 *   (`componentHost.process.*`, `componentHost.docker.*`,
 *   `componentHost.ports.*`) from inside them.
 *
 * ```ts
 * import { defineComponentPlugin, componentHost } from "@roubo/plugin-sdk";
 *
 * // declarative
 * defineComponentPlugin({
 *   translate({ config, context }) {
 *     return { schemaVersion: 1, kind: "process", command: config.command as string };
 *   },
 * });
 * ```
 *
 * Validation is synchronous (throws at definition time, never at call time):
 *
 * - An incompatible `contractVersion` is rejected (it must equal
 *   `SUPPORTED_CONTRACT_VERSION`).
 * - Implementing `translate` AND any imperative hook is rejected (translate XOR
 *   hooks; never silently both).
 * - The imperative mode must implement ALL of `start` / `stop` / `health` /
 *   `cleanup`; a plugin missing one (e.g. `stop`) is rejected here, not at
 *   stop-time.
 */
export function defineComponentPlugin(
  contract: ComponentContract,
  options: DefineComponentPluginOptions = {},
): ComponentPluginHandle {
  const contractVersion = options.contractVersion ?? SUPPORTED_CONTRACT_VERSION;
  if (contractVersion !== SUPPORTED_CONTRACT_VERSION) {
    throw new Error(
      `@roubo/plugin-sdk: defineComponentPlugin contractVersion ${contractVersion} is incompatible with the host (supported: ${SUPPORTED_CONTRACT_VERSION}). Rejected at validation.`,
    );
  }

  const fields = contract as unknown as Record<string, unknown>;
  const hasTranslate = typeof fields.translate === "function";
  const implementedHooks = IMPERATIVE_HOOKS.filter((hook) => typeof fields[hook] === "function");

  if (hasTranslate && implementedHooks.length > 0) {
    throw new Error(
      "@roubo/plugin-sdk: a component plugin implements translate OR the imperative hooks (start/stop/health/cleanup), not both. Rejected at validation.",
    );
  }

  if (!hasTranslate) {
    if (implementedHooks.length === 0) {
      throw new Error(
        "@roubo/plugin-sdk: a component plugin must implement either translate or the imperative hooks (start/stop/health/cleanup). Rejected at validation.",
      );
    }
    const missing = IMPERATIVE_HOOKS.filter((hook) => !implementedHooks.includes(hook));
    if (missing.length > 0) {
      throw new Error(
        `@roubo/plugin-sdk: an imperative component plugin must implement all lifecycle hooks; missing ${missing.join(", ")}. Rejected at validation.`,
      );
    }
  }

  const connection: MessageConnection = createPluginConnection(options.streams);

  for (const method of COMPONENT_CONTRACT_METHODS) {
    const handler = fields[method];
    if (typeof handler !== "function") continue;
    connection.onRequest(method, (params: unknown) => {
      // Bind the in-flight lifecycle call's routing context for the duration of
      // the handler, so any host.* broker call it makes is stamped with this
      // bench/component (#685). `translate` receives `{ config, context }`; the
      // imperative hooks receive the BenchContext directly. Both carry benchId
      // and componentName. When the params do not carry a usable context (an
      // unexpected shape), dispatch the handler without a routing context: a
      // broker call inside it then throws the "outside a lifecycle handler"
      // error rather than mis-routing.
      const benchContext = method === "translate" ? extractContext(params) : params;
      const routing = readRouting(benchContext);
      const invoke = () => (handler as (p: unknown) => unknown)(params as never);
      return routing ? runWithHostRoutingContext(routing, invoke) : invoke();
    });
  }

  bindComponentHostConnection(connection);
  connection.listen();

  return Object.freeze({
    host: host as ComponentHostClient,
    dispose(): void {
      try {
        connection.dispose();
      } finally {
        unbindComponentHostConnection(connection);
      }
    },
  });
}
