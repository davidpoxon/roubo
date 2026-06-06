import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { bindHostConnection, host, unbindHostConnection } from "./host-client.js";
import type {
  ContractMethodName,
  DefinePluginOptions,
  HostClient,
  PluginContract,
  PluginHandle,
} from "./types.js";

const CONTRACT_METHODS: readonly ContractMethodName[] = [
  "listSourceCandidates",
  "getSourceOptions",
  "listIssues",
  "getIssue",
  "getComments",
  "getCurrentUser",
  "validateConfig",
  "setActiveConfig",
  "applyTransition",
  "assignIssue",
  "unassignIssue",
  "getAvailableTransitions",
  "listIssueTypes",
  "listLabels",
  "getConnectionStatus",
  "probeAlertCategories",
  "probeRepoAccess",
  "filterFacets",
  "getFacetOptions",
] as const;

/**
 * Register the plugin contract and start listening on the host JSON-RPC
 * channel. Plugin authors call this once, at module top-level, after
 * defining their contract methods.
 *
 * ```ts
 * import { definePlugin, host } from "@roubo/plugin-sdk";
 *
 * definePlugin({
 *   async listIssues({ cursor, pageSize }) { ... },
 *   async getIssue({ externalId }) { ... },
 *   async getCurrentUser() {
 *     const token = await host.credentials.get("api-token");
 *     ...
 *   },
 * });
 * ```
 *
 * `host.*` calls inside contract methods resolve against the connection
 * established here. Calling `host.*` before `definePlugin` throws.
 */
export function definePlugin(
  contract: PluginContract,
  options: DefinePluginOptions = {},
): PluginHandle {
  const input = options.streams?.input ?? process.stdin;
  const output = options.streams?.output ?? process.stdout;

  const reader = new StreamMessageReader(input);
  const writer = new StreamMessageWriter(output);
  const connection: MessageConnection = createMessageConnection(reader, writer);

  for (const method of CONTRACT_METHODS) {
    const handler = contract[method];
    if (typeof handler !== "function") continue;
    connection.onRequest(method, (params: unknown) =>
      (handler as (p: unknown) => unknown)(params as never),
    );
  }

  bindHostConnection(connection);
  connection.listen();

  return Object.freeze({
    host: host as HostClient,
    dispose(): void {
      try {
        connection.dispose();
      } finally {
        unbindHostConnection(connection);
      }
    },
  });
}
