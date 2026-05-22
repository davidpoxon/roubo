import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, CancellationTokenSource } from "./plugin-rpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENTRY = path.join(here, "__fixtures__", "plugins", "echo", "index.cjs");

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
});
