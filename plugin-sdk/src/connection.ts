import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

/**
 * Optional stdio-stream override shared by every `define*Plugin` entry point.
 * Test harnesses inject paired in-memory streams; production plugin code
 * leaves this unset and the bootstrap defaults to `process.stdin` /
 * `process.stdout`.
 */
export interface PluginStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Resolve the JSON-RPC streams (defaulting to process stdio) and create the
 * vscode-jsonrpc message connection. This is the shared plumbing that both
 * `definePlugin` and `defineComponentPlugin` use so the transport lives in one
 * place. The caller registers its own `onRequest` handlers, binds the host
 * client, and calls `connection.listen()`.
 */
export function createPluginConnection(streams?: PluginStreams): MessageConnection {
  const input = streams?.input ?? process.stdin;
  const output = streams?.output ?? process.stdout;

  const reader = new StreamMessageReader(input);
  const writer = new StreamMessageWriter(output);
  return createMessageConnection(reader, writer);
}
