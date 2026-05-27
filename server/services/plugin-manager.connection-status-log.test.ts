import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginManager from "./plugin-manager.js";

// TC-153 / NFR-023 assertion harness. Forces a connected → auth-problem
// transition and asserts the host structured logger emitted exactly the
// payload shape the spec requires, with no PII or token values bleeding into
// any output channel. The matching production emission lives in
// `recordConnectionStateTransition` (plugin-manager.ts); this test guards the
// observability contract independently of the unit tests that cover the
// surrounding state-machine cache behaviour.

const PLUGIN_ID = "github-com";
const CONFIG = { instance: "https://api.github.com" };
const FROZEN_TIME = new Date("2026-05-25T12:00:00.000Z");

// A recognisable sentinel that the test feeds nowhere into the production
// code. If it ever shows up in captured output, something is leaking values
// that were not part of the contract.
const TOKEN_MARKER = "tc153-secret-token-do-not-log-marker";

// Per NFR-023 the structured log payload carries pluginId + states + trigger
// + an ISO timestamp; nothing else. Any field that hints at credentials would
// be a spec violation.
const ALLOWED_KEYS = ["event", "pluginId", "previousState", "newState", "trigger", "at"].sort();
const FORBIDDEN_SUBSTRINGS = ["token", "secret", "credential", "password"];

interface Captured {
  console: string[];
  stdout: string[];
  stderr: string[];
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a == null) return String(a);
      if (typeof a === "string") return a;
      if (a instanceof Buffer) return a.toString("utf-8");
      if (a instanceof Uint8Array) return Buffer.from(a).toString("utf-8");
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

// Modelled on plugin-enable-state.telemetry.test.ts (TC-149). Scoped to the
// action so the vitest reporter's own writes between tests are not captured
// and not suppressed; forwarding stdout/stderr to the originals keeps the
// reporter functional during the action too.
async function withCapture(action: () => Promise<void> | void): Promise<Captured> {
  const captured: Captured = { console: [], stdout: [], stderr: [] };

  const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      captured.console.push(stringifyArgs(args));
    }),
  );

  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    captured.stdout.push(stringifyArgs([chunk]));
    return stdoutOrig(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write);

  const stderrOrig = process.stderr.write.bind(process.stderr);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    captured.stderr.push(stringifyArgs([chunk]));
    return stderrOrig(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write);

  try {
    await action();
  } finally {
    for (const s of consoleSpies) s.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return captured;
}

function allEmissions(c: Captured): string[] {
  return [...c.console, ...c.stdout, ...c.stderr];
}

type InvokerArgs = [string, string, unknown, { timeoutMs?: number } | undefined];
let invokerMock: ReturnType<typeof vi.fn<(...a: InvokerArgs) => Promise<unknown>>>;

beforeEach(() => {
  pluginManager.__test.reset();
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_TIME);
  invokerMock = vi.fn();
  pluginManager.__test.setConnectionStatusInvoker(invokerMock);
});

afterEach(() => {
  vi.useRealTimers();
  pluginManager.__test.setConnectionStatusInvoker(null);
  pluginManager.__test.resetConnectionStatusCache();
});

describe("TC-153: connection-status transitions logged via host structured logger", () => {
  it("forced connected→auth-problem transition emits exactly the contract payload, no PII or tokens", async () => {
    invokerMock
      .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() })
      .mockResolvedValueOnce({
        state: "auth-problem",
        // The plugin populates `detail` from its own RPC, e.g. after the host
        // invalidates the token slot. NFR-023 does NOT include `detail` in
        // the host log payload; the test confirms that below.
        detail: "Token expired",
        checkedAt: FROZEN_TIME.toISOString(),
      });

    const captured = await withCapture(async () => {
      // Precondition: plugin in `connected` state.
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { trigger: "ui-recheck" });
      // Forced transition to `auth-problem`.
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, {
        force: true,
        trigger: "ui-recheck",
      });
    });

    // Pick out only the structured connection-state log entries. Any other
    // captured line (e.g. an incidental warning from a different code path)
    // is fine here; the PII / token assertion below scopes to every channel.
    const entries: Record<string, unknown>[] = [];
    for (const line of captured.console) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).event === "plugin.connection-state.changed"
      ) {
        entries.push(parsed as Record<string, unknown>);
      }
    }
    expect(entries).toHaveLength(2);

    // The transition that the issue's acceptance criteria pin.
    const transition = entries[1];
    expect(transition).toEqual({
      event: "plugin.connection-state.changed",
      pluginId: PLUGIN_ID,
      previousState: "connected",
      newState: "auth-problem",
      trigger: "ui-recheck",
      at: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(transition.at as string))).toBe(false);

    // Strict shape: no extra fields. ALLOWED_KEYS is the full contract; if a
    // future change adds e.g. `detail` to the payload, this fails loudly.
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(ALLOWED_KEYS);
    }
  });

  it("no PII, token, or credential value appears in any output channel during a transition", async () => {
    invokerMock
      .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() })
      .mockResolvedValueOnce({
        state: "auth-problem",
        detail: "Token expired",
        checkedAt: FROZEN_TIME.toISOString(),
      });

    const captured = await withCapture(async () => {
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { trigger: "ui-recheck" });
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, {
        force: true,
        trigger: "ui-recheck",
      });
    });

    for (const line of allEmissions(captured)) {
      // The sentinel was never fed into the production path; finding it in
      // any captured emission would indicate cross-test contamination or a
      // host code path that echoes back caller-supplied strings unredacted.
      expect(line).not.toContain(TOKEN_MARKER);
      const lower = line.toLowerCase();
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(needle);
      }
    }
  });

  it('the plugin\'s `detail` field (e.g. "Token expired") never appears in the host log payload', async () => {
    invokerMock
      .mockResolvedValueOnce({ state: "connected", checkedAt: FROZEN_TIME.toISOString() })
      .mockResolvedValueOnce({
        state: "auth-problem",
        // A `detail` whose value is unambiguously distinct from anything the
        // transition payload should carry. If the host ever forwards `detail`
        // verbatim into the structured log, this fails.
        detail: TOKEN_MARKER,
        checkedAt: FROZEN_TIME.toISOString(),
      });

    const captured = await withCapture(async () => {
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, { trigger: "ui-recheck" });
      await pluginManager.getConnectionStatus(PLUGIN_ID, CONFIG, {
        force: true,
        trigger: "ui-recheck",
      });
    });

    for (const line of allEmissions(captured)) {
      expect(line).not.toContain(TOKEN_MARKER);
    }
  });
});
