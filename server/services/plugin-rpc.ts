import type { ChildProcess } from "node:child_process";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
  type MessageConnection,
} from "vscode-jsonrpc/node";

export interface JsonRpcConnection {
  sendRequest<T>(method: string, params: unknown, token: CancellationToken): Promise<T>;
  sendNotification(method: string, params?: unknown): Promise<void>;
  onRequest<P = unknown, R = unknown>(method: string, handler: (params: P) => R | Promise<R>): void;
  /**
   * Register a fallback (star) handler invoked for any request method that has
   * no specific handler registered. vscode-jsonrpc routes an unregistered method
   * to the star handler (with the method name and params) only when no specific
   * handler matched, instead of auto-replying its bare -32601. This lets a caller
   * emit its own descriptive method-not-found error (#409).
   */
  onRequest(handler: (method: string, params: unknown) => unknown): void;
  onNotification<P = unknown>(method: string, handler: (params: P) => void): void;
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
    onRequest(
      methodOrHandler: string | ((method: string, params: unknown) => unknown),
      handler?: (params: unknown) => unknown,
    ) {
      // Star form: a single function argument registers a fallback handler that
      // vscode-jsonrpc invokes (with the method name) for any request without a
      // specific handler, so the caller can reply its own descriptive -32601
      // instead of the transport's bare one (#409).
      if (typeof methodOrHandler === "function") {
        const starHandler = methodOrHandler;
        connection.onRequest((method: string, params: unknown) => starHandler(method, params));
        return;
      }
      connection.onRequest(methodOrHandler, (params: unknown) => handler?.(params));
    },
    onNotification<P>(method: string, handler: (params: P) => void) {
      connection.onNotification(method, (params: P) => handler(params));
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
        // ignore: child may already be gone
      }
    },
  };
}

export { CancellationTokenSource };
export type { CancellationToken };
