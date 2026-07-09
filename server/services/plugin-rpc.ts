import type { ChildProcess } from "node:child_process";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
  type Message,
  type MessageConnection,
} from "vscode-jsonrpc/node";

/**
 * A StreamMessageWriter whose write() never rejects.
 *
 * #927: vscode-jsonrpc dispatches request writes from inside an async Promise
 * executor in connection.sendRequest:
 *
 *     return new Promise(async (resolve, reject) => {
 *       try { ... await messageWriter.write(requestMessage); ... }
 *       catch (error) { ...reject the request...; throw error; }
 *     });
 *
 * When the write rejects (the plugin process died mid-write, so its stdin pipe
 * breaks with EPIPE / ERR_STREAM_DESTROYED) that catch rejects the request
 * promise AND re-throws. Because the executor is an async function, its own
 * returned promise is unowned, so the re-thrown error surfaces as an *unhandled
 * rejection*. Under Node's default policy an unhandled rejection is a fatal
 * uncaught exception, so a single dying plugin takes down the entire host
 * server (every project, every bench), not just its own connection: the exact
 * crash reported in #927 (triggerUncaughtException(..., fromPromise)).
 *
 * Note the raw stream 'error' EventEmitter path is NOT the leak here: vscode-jsonrpc's
 * writer/reader already attach 'error' listeners to the child's stdio streams,
 * and the failed write is already reported to onError via the writer's error
 * event (fireError, wired through createMessageConnection). The only thing that
 * escapes is the write promise's rejection. Swallowing it after the fact stops
 * the executor's re-throw from ever becoming an unhandled rejection, so the
 * mid-write death degrades to this plugin's crashed/errored state, which is
 * driven the normal way by proc.on('exit') -> handleChildExit (which disposes
 * the connection and rejects any still-pending request) or the caller's own RPC
 * timeout. It never crashes the host.
 */
class NonRejectingStreamMessageWriter extends StreamMessageWriter {
  override async write(msg: Message): Promise<void> {
    try {
      await super.write(msg);
    } catch {
      // Intentionally swallowed: the error was already surfaced to onError
      // listeners via this writer's error event before write() rejected. Letting
      // the rejection propagate is what crashes the host (#927), so we stop here.
    }
  }
}

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
  // #927: a NonRejectingStreamMessageWriter (not a plain StreamMessageWriter) so a
  // write that fails because the plugin process died mid-write cannot escape as an
  // unhandled rejection that kills the host. See the class doc comment above.
  const writer = new NonRejectingStreamMessageWriter(proc.stdin);
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
