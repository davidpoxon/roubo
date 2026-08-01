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
import { execFile, execFileSync } from "node:child_process";
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
  it("rejects an invocation carrying no event payload", () => {
    const script = path.join(home, "probe-arity");
    fs.writeFileSync(script, buildNotifierScript("http://127.0.0.1:1/api/hooks/x"), {
      mode: 0o755,
    });

    expect(() => execFileSync(script, ["token-only"], { stdio: "pipe" })).toThrow();
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
});
