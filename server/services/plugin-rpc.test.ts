import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResponseError } from "vscode-jsonrpc/node";
import { createConnection, CancellationTokenSource } from "./plugin-rpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENTRY = path.join(here, "__fixtures__", "plugins", "echo", "index.cjs");
const CALLER_ENTRY = path.join(here, "__fixtures__", "plugins", "caller", "index.cjs");

const spawnedProcs: ChildProcess[] = [];

afterEach(async () => {
  for (const proc of spawnedProcs) {
    if (!proc.killed && proc.pid !== undefined) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  spawnedProcs.length = 0;
});

function spawnEcho(): ChildProcess {
  const proc = spawn(process.execPath, [ECHO_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawnedProcs.push(proc);
  return proc;
}

function spawnCaller(): ChildProcess {
  const proc = spawn(process.execPath, [CALLER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawnedProcs.push(proc);
  return proc;
}

describe("plugin-rpc", () => {
  it("round-trips a request to a child process", async () => {
    const proc = spawnEcho();
    const conn = createConnection(proc);
    const tokenSource = new CancellationTokenSource();
    const result = await conn.sendRequest<{ hello: string }>(
      "echo",
      { hello: "world" },
      tokenSource.token,
    );
    expect(result).toEqual({ hello: "world" });
    conn.dispose();
    tokenSource.dispose();
  });

  it("fires onClose when the child exits", async () => {
    const proc = spawnEcho();
    const conn = createConnection(proc);
    const closed = new Promise<void>((resolve) => conn.onClose(resolve));
    proc.kill("SIGTERM");
    await closed;
    conn.dispose();
  });

  it("throws when the child has no piped stdio", () => {
    const fakeProc = {} as ChildProcess;
    expect(() => createConnection(fakeProc)).toThrow();
  });

  it("dispatches incoming requests from the child to onRequest handlers", async () => {
    const proc = spawnCaller();
    const conn = createConnection(proc);
    conn.onRequest<{ slot: string }, { value: string }>("host.example", (params) => ({
      value: `got:${params.slot}`,
    }));

    const tokenSource = new CancellationTokenSource();
    const response = await conn.sendRequest<{ ok: boolean; result: { value: string } }>(
      "invokeHost",
      { method: "host.example", payload: { slot: "abc" } },
      tokenSource.token,
    );

    expect(response).toEqual({ ok: true, result: { value: "got:abc" } });
    conn.dispose();
    tokenSource.dispose();
  });

  it("does not crash the host when a write fails after the plugin's pipe breaks (#927)", async () => {
    const proc = spawnEcho();
    const conn = createConnection(proc);

    const rpcErrors: Error[] = [];
    conn.onError((error) => rpcErrors.push(error));

    // Capture any unhandled rejection ourselves. Before #927 a write that failed
    // because the plugin died mid-write escaped vscode-jsonrpc's async
    // sendRequest executor as an unhandled rejection, which Node turns into a
    // fatal uncaught exception that takes down the whole host server.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // Simulate the plugin process dying mid-write: break its stdin so the next
      // JSON-RPC write fails (EPIPE / ERR_STREAM_DESTROYED). The child (and its
      // stdout, hence the reader) stays alive, so the connection is still open,
      // mirroring an in-flight request write to a just-dead plugin. The request
      // must be dispatched synchronously, before stdin's async 'close' reaches
      // the connection, so it exercises the write path rather than a closed one.
      const { stdin } = proc;
      if (!stdin) throw new Error("test setup: child stdin should be piped");
      stdin.destroy();
      const tokenSource = new CancellationTokenSource();
      // Guard the request promise the way plugin-manager's invoke() does. With
      // the fix the write no longer rejects, so this settles when the connection
      // is disposed below (mirroring proc.on('exit') -> handleChildExit).
      const pending = conn
        .sendRequest("echo", { hello: "world" }, tokenSource.token)
        .catch(() => undefined);

      // Let any escaping rejection surface on the task queue.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The host survives: no unhandled rejection escaped the failed write.
      expect(unhandled).toEqual([]);
      // The transport error is still routed to onError, so the failure degrades
      // to this plugin's errored/crashed handling instead of killing the host.
      expect(rpcErrors.length).toBeGreaterThan(0);

      conn.dispose();
      await pending;
      tokenSource.dispose();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("routes an unregistered method to the star fallback handler end-to-end (#409)", async () => {
    const proc = spawnCaller();
    const conn = createConnection(proc);
    // A single-function registration installs the star/fallback handler that
    // vscode-jsonrpc invokes for any method without a specific handler. This is
    // the production path the broker relies on to reply its own descriptive
    // -32601 instead of the transport's bare one, so exercise the routing
    // through a real connection (the broker's message content is covered
    // separately in component-broker.test.ts).
    conn.onRequest((method) => {
      throw new ResponseError(-32601, `Method not found: "${method}"`, {
        code: "method-not-found",
        method,
      });
    });

    const tokenSource = new CancellationTokenSource();
    const response = await conn.sendRequest<{
      ok: boolean;
      error: { code: number; message: string; data: { code: string; method: string } };
    }>("invokeHost", { method: "host.nope.unregistered", payload: {} }, tokenSource.token);

    expect(response.ok).toBe(false);
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain("host.nope.unregistered");
    expect(response.error.data).toMatchObject({
      code: "method-not-found",
      method: "host.nope.unregistered",
    });
    conn.dispose();
    tokenSource.dispose();
  });
});
