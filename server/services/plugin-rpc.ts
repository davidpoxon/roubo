import type { ChildProcess } from "node:child_process";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

export interface JsonRpcConnection {
  sendRequest<T>(method: string, params: unknown, token: CancellationToken): Promise<T>;
  sendNotification(method: string, params?: unknown): Promise<void>;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  dispose(): void;
}

export function createConnection(proc: ChildProcess): JsonRpcConnection {
  if (!proc.stdout || !proc.stdin) {
    throw new Error("Child process must have piped stdin and stdout");
  }

  const reader = new StreamMessageReader(proc.stdout);
  const writer = new StreamMessageWriter(proc.stdin);
  const connection: MessageConnection = createMessageConnection(reader, writer);

  let disposed = false;
  connection.listen();

  return {
    sendRequest<T>(method: string, params: unknown, token: CancellationToken) {
      return connection.sendRequest<T>(method, params, token);
    },
    async sendNotification(method: string, params?: unknown) {
      await connection.sendNotification(method, params);
    },
    onError(handler) {
      connection.onError(([error]) => handler(error));
      reader.onError(handler);
      writer.onError(([error]) => handler(error));
    },
    onClose(handler) {
      connection.onClose(handler);
      reader.onClose(handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        connection.dispose();
      } catch {
        // ignore — child may already be gone
      }
    },
  };
}

export { CancellationTokenSource };
export type { CancellationToken };
