import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The spawn is a spy that runs the REAL bounded spawn unless a test overrides
// it, so the argv, stdin and bound tests below exercise a real child process
// while the cache tests stay deterministic.
vi.mock("./probe-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe-spawn.js")>();
  return { ...actual, spawnProbe: vi.fn(actual.spawnProbe) };
});

import {
  DETECTION_TTL_MS,
  readChoiceProbe,
  readProbe,
  resetProbeRunnerCache,
  runProbe,
  warmChoiceProbes,
} from "./agent-probe-runner.js";
import { spawnProbe } from "./probe-spawn.js";

const NODE = process.execPath;

/** Run `script` under node as a `dash-line-pairs` choice probe. */
function nodeProbe(script: string, extraArgs: string[] = []) {
  return runProbe({
    command: NODE,
    args: ["-e", script, ...extraArgs],
    parse: "dash-line-pairs",
    failurePolicy: "discard",
  });
}

function spawnReturns(stdout: string, code = 0, extra: object = {}) {
  vi.mocked(spawnProbe).mockResolvedValue({ code, stdout, stderr: "", ...extra });
}

let tmp: string;

beforeEach(() => {
  resetProbeRunnerCache();
  vi.mocked(spawnProbe).mockClear();
  tmp = mkdtempSync(path.join(os.tmpdir(), "probe-runner-"));
});

afterEach(async () => {
  vi.useRealTimers();
  const actual = await vi.importActual<typeof import("./probe-spawn.js")>("./probe-spawn.js");
  vi.mocked(spawnProbe).mockImplementation(actual.spawnProbe);
  rmSync(tmp, { recursive: true, force: true });
});

/** Put an executable named `name` in a fresh directory and return that directory. */
function binDir(name: string): string {
  const dir = mkdtempSync(path.join(tmp, "bin-"));
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return dir;
}

describe("spawning (APCC-TC-021, APCC-TC-020)", () => {
  it("spawns only the declared command with the declared arguments, through no shell", async () => {
    const hostile = ["$HOME", "a; echo pwned", "`id`", "*", "x && y"];
    const { result } = await nodeProbe(
      "process.argv.slice(1).forEach((a, i) => console.log(`arg${i} - ${a}`))",
      hostile,
    );

    // Each argument reached the child as one literal: no expansion, no split, no
    // second command. `node -e` puts nothing of its own after the script.
    expect(result.status).toBe("ok");
    expect(result.value?.map((pair) => pair.label)).toEqual(hostile);

    const [file, args] = vi.mocked(spawnProbe).mock.calls[0];
    expect(file).toBe(NODE);
    expect(args).toEqual(["-e", expect.any(String), ...hostile]);
  });

  it("gives the child no stdin to wait on", async () => {
    const { result } = await nodeProbe(
      "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('stdin - closed'))",
    );
    expect(result.value).toEqual([{ value: "stdin", label: "closed" }]);
  });

  it("bounds the output it reads and kills the child at the bound", async () => {
    const actual = await vi.importActual<typeof import("./probe-spawn.js")>("./probe-spawn.js");
    const output = await actual.spawnProbe(
      NODE,
      ["-e", "setInterval(() => process.stdout.write('m - M\\n'.repeat(1000)), 1)"],
      tmp,
      undefined,
      { timeoutMs: 10_000, maxOutputBytes: 4096 },
    );
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(4096);
  });

  it("refuses a listing larger than the 256 KiB bound as a parse error", async () => {
    const { result } = await nodeProbe("process.stdout.write('m - M\\n'.repeat(60000))");
    expect(result.status).toBe("failed");
    expect(result.cause).toBe("parse-error");
  });

  it("kills a child that never exits and reports it as timed out, even with empty stderr", async () => {
    const actual = await vi.importActual<typeof import("./probe-spawn.js")>("./probe-spawn.js");
    const started = Date.now();
    const output = await actual.spawnProbe(
      NODE,
      ["-e", "setInterval(() => {}, 1000)"],
      tmp,
      undefined,
      { timeoutMs: 200, maxOutputBytes: 4096 },
    );
    expect(output.timedOut).toBe(true);
    expect(output.stderr).toBe("");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("failure causes (never throws)", () => {
  it("reports a command that resolves nowhere as command-not-found, without spawning", async () => {
    const { result } = await runProbe({
      command: "roubo-no-such-probe-cli",
      args: ["--list"],
      parse: "dash-line-pairs",
      failurePolicy: "discard",
      searchPath: tmp,
    });
    expect(result.cause).toBe("command-not-found");
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it("reports a nonzero exit as a probe error with the first stderr line", async () => {
    const { result } = await nodeProbe("console.error('not signed in'); process.exit(3)");
    expect(result.cause).toBe("probe-error");
    expect(result.reason).toContain("exited with code 3: not signed in");
  });

  it("reports unreadable output as a parse error", async () => {
    const { result } = await nodeProbe("console.log('no pairs here')");
    expect(result.cause).toBe("parse-error");
  });

  it("reports a kill at the time bound as a timeout", async () => {
    spawnReturns("", 1, { timedOut: true });
    const { result } = await nodeProbe("");
    expect(result.status).toBe("failed");
    expect(result.cause).toBe("timeout");
  });

  it("reports a spawn that rejects as a probe error instead of throwing", async () => {
    vi.mocked(spawnProbe).mockRejectedValue(new Error("boom"));
    const { result } = await nodeProbe("");
    expect(result.cause).toBe("probe-error");
    expect(result.reason).toContain("boom");
  });

  it("refuses a templated command or search path without resolving or spawning", async () => {
    const templated = await runProbe({
      command: "{{workspace}}/cli",
      args: ["--list"],
      parse: "dash-line-pairs",
      failurePolicy: "discard",
    });
    const templatedPath = await runProbe({
      command: "cli",
      args: ["--list"],
      parse: "dash-line-pairs",
      failurePolicy: "discard",
      searchPath: "{{workspacePath}}/bin",
    });
    expect(templated.result.cause).toBe("probe-error");
    expect(templated.key).toBeUndefined();
    expect(templatedPath.result.reason).toContain("templated");
    expect(spawnProbe).not.toHaveBeenCalled();
  });
});

describe("caching (APCC-TC-024)", () => {
  it("serves a success from the cache inside the window, so the command spawns once", async () => {
    spawnReturns("a - Alpha");
    await nodeProbe("");
    await nodeProbe("");
    expect(spawnProbe).toHaveBeenCalledTimes(1);
  });

  it("runs at most one probe per key at a time", async () => {
    spawnReturns("a - Alpha");
    await Promise.all([nodeProbe(""), nodeProbe(""), nodeProbe("")]);
    expect(spawnProbe).toHaveBeenCalledTimes(1);
  });

  it("never keeps a failure under the discard policy, and drops the earlier success", async () => {
    vi.useFakeTimers();
    spawnReturns("a - Alpha");
    const first = await nodeProbe("");
    expect(readProbe(first.key ?? "")).toMatchObject({ status: "ok" });

    vi.advanceTimersByTime(DETECTION_TTL_MS + 1000);
    spawnReturns("", 1);
    const second = await nodeProbe("");
    expect(second.result.status).toBe("failed");
    expect(readProbe(second.key ?? "")).toBeUndefined();

    await nodeProbe("");
    expect(spawnProbe).toHaveBeenCalledTimes(3);
  });

  it("keeps a failure for the window under the keep-for-ttl policy", async () => {
    spawnReturns("no version");
    const request = {
      command: NODE,
      args: ["--version"],
      parse: "semver" as const,
      failurePolicy: "keep-for-ttl" as const,
    };
    await runProbe(request);
    const again = await runProbe(request);
    expect(again.result.cause).toBe("parse-error");
    expect(spawnProbe).toHaveBeenCalledTimes(1);
  });

  it("scopes a bare name's cache key to the search path it resolved against (#660)", async () => {
    spawnReturns("a - Alpha");
    const request = {
      command: "probe-cli",
      args: ["--list"],
      parse: "dash-line-pairs" as const,
      failurePolicy: "discard" as const,
    };
    await runProbe({ ...request, searchPath: binDir("probe-cli") });
    await runProbe({ ...request, searchPath: binDir("probe-cli") });
    expect(spawnProbe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawnProbe).mock.calls[0][3]).toEqual({
      PATH: expect.stringContaining("bin-"),
    });
  });

  it("resolves through the declared install locations (#712)", async () => {
    spawnReturns("a - Alpha");
    const located = path.join(binDir("probe-cli"), "probe-cli");
    const { result } = await runProbe({
      command: "probe-cli",
      args: ["--list"],
      parse: "dash-line-pairs",
      failurePolicy: "discard",
      searchPath: tmp,
      installLocations: [located],
    });
    expect(result.status).toBe("ok");
    expect(vi.mocked(spawnProbe).mock.calls[0][0]).toBe(located);
  });

  it("discards a kept command-not-found miss as soon as the command resolves", async () => {
    spawnReturns("1.2.3");
    const dir = mkdtempSync(path.join(tmp, "later-"));
    const request = {
      command: "probe-cli",
      args: ["--version"],
      parse: "semver" as const,
      failurePolicy: "keep-for-ttl" as const,
      searchPath: dir,
    };
    const miss = await runProbe(request);
    expect(miss.result.cause).toBe("command-not-found");
    expect(readProbe(miss.key ?? "")).toMatchObject({ cause: "command-not-found" });

    writeFileSync(path.join(dir, "probe-cli"), "#!/bin/sh\n");
    chmodSync(path.join(dir, "probe-cli"), 0o755);
    const hit = await runProbe(request);
    expect(hit.result).toMatchObject({ status: "ok", value: "1.2.3" });
  });
});

describe("warmChoiceProbes / readChoiceProbe (APCC-TC-024)", () => {
  const PROBES = { model: { command: NODE, args: ["--list"], parse: "dash-line-pairs" as const } };

  it("warms in the background and reads back without spawning", async () => {
    spawnReturns("a - Alpha\nb - Beta");
    expect(readChoiceProbe("example", "model")).toBeUndefined();
    warmChoiceProbes("example", PROBES);
    await vi.waitFor(() => expect(readChoiceProbe("example", "model")?.status).toBe("ok"));
    expect(readChoiceProbe("example", "model")?.value).toHaveLength(2);
    expect(spawnProbe).toHaveBeenCalledTimes(1);
  });

  it("spawns once for two warms inside the window", async () => {
    spawnReturns("a - Alpha");
    warmChoiceProbes("example", PROBES);
    await vi.waitFor(() => expect(readChoiceProbe("example", "model")).toBeDefined());
    warmChoiceProbes("example", PROBES);
    await vi.waitFor(() => expect(spawnProbe).toHaveBeenCalledTimes(1));
  });

  it("reports a later failure instead of the previously resolved list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    spawnReturns("a - Alpha");
    warmChoiceProbes("example", PROBES);
    await vi.waitFor(() => expect(readChoiceProbe("example", "model")?.status).toBe("ok"));

    vi.setSystemTime(Date.now() + DETECTION_TTL_MS + 1000);
    vi.mocked(spawnProbe).mockResolvedValue({ code: 1, stdout: "", stderr: "offline" });
    warmChoiceProbes("example", PROBES);
    await vi.waitFor(() => expect(readChoiceProbe("example", "model")?.status).toBe("failed"));

    const read = readChoiceProbe("example", "model");
    expect(read?.value).toBeUndefined();
    expect(read?.reason).toContain("offline");
  });
});
