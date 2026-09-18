/**
 * The notifier program core ships for the `spawned-notifier` notification
 * wiring (issue #698).
 *
 * `atomicWrite` is deliberately NOT mocked: the point of these cases is that a
 * real file lands on disk, executable, with the resolved endpoint baked in. Only
 * the state directory is redirected, into a temp dir.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";

const execFileAsync = promisify(execFile);

const hoisted = vi.hoisted(() => ({ rouboDir: "" }));
vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return { ...actual, getRouboDir: () => hoisted.rouboDir };
});

import {
  NOTIFIER_PROGRAM_NAME,
  buildNotifierScript,
  ensureNotifierInstalled,
  getNotifierDir,
  getNotifierPath,
} from "./agent-notifier.js";

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-notifier-"));
  hoisted.rouboDir = home;
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ensureNotifierInstalled (issue #698)", () => {
  it("writes an executable program under the Roubo state dir", () => {
    const installed = ensureNotifierInstalled("51234");

    expect(installed).toBe(getNotifierPath());
    expect(path.dirname(installed)).toBe(getNotifierDir());
    expect(path.basename(installed)).toBe(NOTIFIER_PROGRAM_NAME);
    expect(fs.existsSync(installed)).toBe(true);
    // Owner-executable is what matters: the agent spawns it as this user.
    expect(fs.statSync(installed).mode & 0o100).toBe(0o100);
  });

  it("bakes the resolved port into the endpoint, so nothing is read at runtime", () => {
    const body = fs.readFileSync(ensureNotifierInstalled("51234"), "utf-8");

    expect(body).toContain("http://localhost:51234/api/hooks/agent-notification");
    expect(body).not.toContain("ROUBO_PORT");
  });

  it("rewrites the program when the port changes", () => {
    ensureNotifierInstalled("51234");
    const body = fs.readFileSync(ensureNotifierInstalled("60000"), "utf-8");

    expect(body).toContain("http://localhost:60000/api/hooks/agent-notification");
    expect(body).not.toContain("51234");
  });

  it("is idempotent: a second install at the same port leaves the same bytes", () => {
    const first = fs.readFileSync(ensureNotifierInstalled("51234"), "utf-8");
    const second = fs.readFileSync(ensureNotifierInstalled("51234"), "utf-8");

    expect(second).toBe(first);
  });

  it("carries no agent-specific vocabulary", () => {
    const body = fs.readFileSync(ensureNotifierInstalled("51234"), "utf-8").toLowerCase();

    expect(body).not.toContain("codex");
    expect(body).not.toContain("claude");
  });
});

describe("the notifier script itself", () => {
  it("rejects an invocation carrying no arguments with a usage exit", () => {
    const script = path.join(home, "probe-arity");
    fs.writeFileSync(script, buildNotifierScript("http://127.0.0.1:1/api/hooks/x"), {
      mode: 0o755,
    });

    let status: number | null = null;
    try {
      execFileSync(script, [], { stdio: "pipe" });
    } catch (err) {
      status = (err as { status: number | null }).status;
    }
    expect(status).toBe(2);
  });

  it("selects the stdin path by argument count alone, never by a terminal test", () => {
    expect(buildNotifierScript("http://127.0.0.1:1/api/hooks/x")).not.toContain("[ -t");
  });

  it("exits cleanly when the host is not listening, so a turn never fails on it", () => {
    const script = path.join(home, "probe-offline");
    fs.writeFileSync(script, buildNotifierScript("http://127.0.0.1:1/api/hooks/x"), {
      mode: 0o755,
    });

    // Port 1 refuses the connection; the notifier must still exit 0 and say
    // nothing. What the body looked like is not observable here (the script
    // ends in `|| exit 0`, so a malformed one exits the same way); the
    // round-trip case below is what pins the escaping.
    const stdout = execFileSync(script, ["token", '{"type":"turn-complete","msg":"a\nb"}'], {
      stdio: "pipe",
    });

    expect(stdout.toString()).toBe("");
  });

  // Regression guard for the json_string pipeline (issue #707). Only the
  // double-quote rule was previously guarded (by spawned-notifier-e2e.test.ts,
  // whose payload has no backslash and no newline), so deleting the
  // backslash-doubling rule or the newline rule left the suite green. Asserting
  // an exact round-trip against a real listener pins all three rules, plus the
  // first-arg/last-arg argv contract, in one case.
  it("round-trips a payload carrying a quote, a backslash and a newline", async () => {
    let deliver: (body: string) => void = () => {};
    const received = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const server = http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf-8");
      req.on("data", (chunk: string) => {
        raw += chunk;
      });
      req.on("end", () => {
        // curl waits on the response, so answer before resolving.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        deliver(raw);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const script = path.join(home, "probe-escaping");
      fs.writeFileSync(
        script,
        buildNotifierScript(`http://127.0.0.1:${port}/api/hooks/agent-notification`),
        { mode: 0o755 },
      );

      const token = "9c1f4c2e-b0a1-4f3d-9c77-1f0f2f3a4b5c";
      // All three rules in one value: a double quote, a backslash, and a
      // newline that is deliberately INTERIOR. A trailing newline is dropped by
      // command substitution, so asserting a round-trip on one would pin
      // behaviour the program does not have.
      const payload = '{"type":"turn-complete","msg":"she said \\"go\\"\nlog at C:\\\\tmp"}';

      await execFileAsync(script, [token, payload]);

      const body = JSON.parse(await received);
      expect(body.token).toBe(token);
      expect(body.payload).toBe(payload);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Issue roubo-development#855 (APCC-TC-005, APCC-TC-006): a token as the
  // only argument reads the event JSON from standard input and posts the same
  // body to the same endpoint as the argument path.
  describe("with the payload on standard input", () => {
    const token = "4d2e8a10-7b3c-4f1e-a9d0-2c5b6e7f8a9b";

    async function withListener(
      fn: (endpoint: string, next: () => Promise<string>) => Promise<void>,
    ): Promise<void> {
      const bodies: string[] = [];
      const waiters: ((body: string) => void)[] = [];
      const server = http.createServer((req, res) => {
        let raw = "";
        req.setEncoding("utf-8");
        req.on("data", (chunk: string) => {
          raw += chunk;
        });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          const waiter = waiters.shift();
          if (waiter) waiter(raw);
          else bodies.push(raw);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const next = () => {
        const queued = bodies.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise<string>((resolve) => waiters.push(resolve));
      };
      try {
        await fn(`http://127.0.0.1:${port}/api/hooks/agent-notification`, next);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    function writeScript(name: string, endpoint: string): string {
      const script = path.join(home, name);
      fs.writeFileSync(script, buildNotifierScript(endpoint), { mode: 0o755 });
      return script;
    }

    function runWithStdin(script: string, args: string[], input: string): Promise<number | null> {
      return new Promise((resolve, reject) => {
        const child = spawn(script, args, { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code));
        child.stdin.end(input);
      });
    }

    it("posts the token and the stdin payload to the endpoint", async () => {
      await withListener(async (endpoint, next) => {
        const script = writeScript("probe-stdin", endpoint);
        const payload = '{"type":"stop","msg":"she said \\"go\\"\nlog at C:\\\\tmp"}';

        expect(await runWithStdin(script, [token], payload)).toBe(0);

        const body = JSON.parse(await next());
        expect(body).toEqual({ token, payload });
      });
    });

    it("posts the same body as the payload-argument path", async () => {
      await withListener(async (endpoint, next) => {
        const script = writeScript("probe-stdin-parity", endpoint);
        const payload = '{"type":"stop","status":"completed"}';

        await execFileAsync(script, [token, payload]);
        const fromArgv = await next();
        // A trailing newline, as a writer piping JSON usually sends, is not
        // part of the payload on either path.
        expect(await runWithStdin(script, [token], `${payload}\n`)).toBe(0);
        const fromStdin = await next();

        expect(fromStdin).toBe(fromArgv);
      });
    });

    it("posts an empty payload when stdin closes without data", async () => {
      await withListener(async (endpoint, next) => {
        const script = writeScript("probe-stdin-empty", endpoint);

        expect(await runWithStdin(script, [token], "")).toBe(0);

        expect(JSON.parse(await next())).toEqual({ token, payload: "" });
      });
    });

    it("stops within the bound when stdin is held open, leaving no live child", async () => {
      const script = writeScript("probe-stdin-held", "http://127.0.0.1:1/api/hooks/x");
      // Detached, so the notifier leads its own process group and any reader
      // it starts in the background is a member of that group.
      const child = spawn(script, ["held"], {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      });
      const pgid = child.pid;
      if (pgid === undefined) throw new Error("the notifier did not start");
      const started = Date.now();

      // Stdin is written to but never ended, so no end of file arrives.
      child.stdin.write('{"type":"stop"');
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      const elapsed = Date.now() - started;

      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(10_000);

      // The leader has been reaped, so the group is empty only if no child of
      // the notifier outlived it.
      let groupAlive = true;
      try {
        process.kill(-pgid, 0);
      } catch (err) {
        groupAlive = (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (groupAlive) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      expect(groupAlive).toBe(false);
      child.stdin.destroy();
    }, 20_000);
  });
});
