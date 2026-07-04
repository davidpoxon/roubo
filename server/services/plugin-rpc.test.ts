import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResponseError } from "vscode-jsonrpc/node.js";
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
