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
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

    // Port 1 refuses the connection; the notifier must still exit 0, and it
    // must reach that point rather than dying on its own JSON escaping.
    const stdout = execFileSync(script, ["token", '{"type":"turn-complete","msg":"a\nb"}'], {
      stdio: "pipe",
    });

    expect(stdout.toString()).toBe("");
  });
});
