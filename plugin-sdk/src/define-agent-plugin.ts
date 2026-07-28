import type { MessageConnection } from "vscode-jsonrpc/node";
import { createPluginConnection } from "./connection.js";
import {
  SUPPORTED_AGENT_CONTRACT_VERSION,
  type AgentContract,
  type AgentContractMethodName,
  type AgentPluginHandle,
  type DefineAgentPluginOptions,
} from "./types.js";

const AGENT_CONTRACT_METHODS: readonly AgentContractMethodName[] = ["translateLaunch"] as const;

/**
 * Register an agent plugin's contract over the host JSON-RPC channel, parallel
 * to `definePlugin()` and `defineComponentPlugin()`. Plugin authors call this
 * once, at module top-level, after defining their contract.
 *
 * An agent plugin is declarative only: it implements the single method
 * `translateLaunch({ config, context })` and returns an `AgentLaunchDescriptor`
 * the host validates and executes. There is deliberately NO imperative escape
 * hatch and NO host broker client, so the plugin holds no privilege beyond what
 * the runtime sandbox already grants an integration plugin (AP-NFR-001). Every
 * privileged action, the PTY spawn, workspace writes, hook wiring, and the
 * version probe, is expressed as declarative data on the descriptor and carried
 * out by the host.
 *
 * ```ts
 * import { defineAgentPlugin } from "@roubo/plugin-sdk";
 *
 * defineAgentPlugin({
 *   translateLaunch({ config, context }) {
 *     return {
 *       schemaVersion: 1,
 *       kind: "agent-launch",
 *       command: "my-agent",
 *       args: ["--session-id", "{{sessionId}}"],
 *       cwd: context.workspacePath,
 *     };
 *   },
 * });
 * ```
 *
 * Validation is synchronous (throws at definition time, never at launch time):
 *
 * - An incompatible `contractVersion` is rejected (it must equal
 *   `SUPPORTED_AGENT_CONTRACT_VERSION`).
 * - A contract that does not implement `translateLaunch` is rejected here,
 *   rather than surfacing as a MethodNotFound at the first launch.
 */
export function defineAgentPlugin(
  contract: AgentContract,
  options: DefineAgentPluginOptions = {},
): AgentPluginHandle {
  const contractVersion = options.contractVersion ?? SUPPORTED_AGENT_CONTRACT_VERSION;
  if (contractVersion !== SUPPORTED_AGENT_CONTRACT_VERSION) {
    throw new Error(
      `@roubo/plugin-sdk: defineAgentPlugin contractVersion ${contractVersion} is incompatible with the host (supported: ${SUPPORTED_AGENT_CONTRACT_VERSION}). Rejected at validation.`,
    );
  }

  const fields = contract as unknown as Record<string, unknown>;
  if (typeof fields.translateLaunch !== "function") {
    throw new Error(
      "@roubo/plugin-sdk: an agent plugin must implement translateLaunch. Rejected at validation.",
    );
  }

  const connection: MessageConnection = createPluginConnection(options.streams);

  for (const method of AGENT_CONTRACT_METHODS) {
    const handler = fields[method];
    if (typeof handler !== "function") continue;
    connection.onRequest(method, (params: unknown) =>
      (handler as (p: unknown) => unknown)(params as never),
    );
  }

  // No broker handlers and no host client are bound here. Agent plugins are
  // spawned-and-RPC like integration plugins, never bench-supervised like
  // component plugins, so the component broker surface
  // (`host.process.start`/`run`/`stop`/`status`/`logs`, `host.docker.*`,
  // `host.ports.*`) is absent and no `host` client is bound. An agent plugin
  // gets no more than the same v1 host surface an integration plugin already
  // has, including `host.process.spawn` capped by its declared executables.
  connection.listen();

  return Object.freeze({
    dispose(): void {
      connection.dispose();
    },
  });
}
