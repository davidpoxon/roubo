import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockChild as _createMockChild } from "../test/fixtures.js";

function createMockChild() {
  return _createMockChild(12345);
}

vi.mock("tree-kill", () => ({ default: vi.fn() }));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

beforeEach(async () => {
  vi.resetModules();
  mockSpawn.mockReset();
});

const originalEnv = process.env;
afterEach(() => {
  process.env = originalEnv;
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadModule() {
  const mod = await import("./process-manager.js");
  return mod;
}

describe("startProcess", () => {
  it("spawns a process and returns pid", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess } = await loadModule();

    const result = await startProcess("test-1", "node", ["app.js"], { PORT: "3000" }, "/cwd");

    expect(result).toEqual({ pid: 12345 });
    expect(mockSpawn).toHaveBeenCalledWith(
      "node",
      ["app.js"],
      expect.objectContaining({
        cwd: "/cwd",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      }),
    );
  });

  it("strips ROUBO_ env vars from spawned process environment", async () => {
    process.env = { ...originalEnv, ROUBO_PRODUCTION: "1", ROUBO_PORT: "3333", MY_VAR: "kept" };
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess } = await loadModule();

    await startProcess("env-test", "node", ["app.js"], {}, "/cwd");

    const spawnedEnv = mockSpawn.mock.calls[0][2].env as Record<string, string>;
    expect(spawnedEnv.ROUBO_PRODUCTION).toBeUndefined();
    expect(spawnedEnv.ROUBO_PORT).toBeUndefined();
    expect(spawnedEnv.MY_VAR).toBe("kept");
  });

  it("kills existing process with same id", async () => {
    const treeKill = (await import("tree-kill")).default;
    const mockTreeKill = vi.mocked(treeKill);

    const child1 = createMockChild();
    child1.pid = 11111;
    const child2 = createMockChild();
    child2.pid = 22222;
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const { startProcess } = await loadModule();

    startProcess("same-id", "node", ["a.js"], {}, "/cwd");
    // Starting with the same ID should trigger stopProcess on the first
    startProcess("same-id", "node", ["b.js"], {}, "/cwd");

    expect(mockTreeKill).toHaveBeenCalledWith(11111, "SIGTERM", expect.any(Function));
  });
});

describe("log capture", () => {
  it("captures stdout and stderr", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess, getProcessLogs } = await loadModule();

    startProcess("log-test", "node", ["app.js"], {}, "/cwd");

    child.stdout.emit("data", Buffer.from("stdout line 1\nstdout line 2\n"));
    child.stderr.emit("data", Buffer.from("stderr line 1\n"));

    const logs = getProcessLogs("log-test");
    expect(logs).toEqual(["stdout line 1", "stdout line 2", "stderr line 1"]);
  });

  it("rotates logs at MAX_LOG_LINES (5000)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess, getProcessLogs } = await loadModule();

    startProcess("rotate-test", "node", ["app.js"], {}, "/cwd");

    // Push 5010 lines
    for (let i = 0; i < 5010; i++) {
      child.stdout.emit("data", Buffer.from(`line-${i}\n`));
    }

    const logs = getProcessLogs("rotate-test", 5000);
    expect(logs.length).toBe(5000);
    // Oldest lines should have been shifted out
    expect(logs[0]).toBe("line-10");
    expect(logs[logs.length - 1]).toBe("line-5009");
  });
});

describe("process events", () => {
  it("close event sets alive:false and exitCode", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess, getProcessStatus } = await loadModule();

    startProcess("close-test", "node", ["app.js"], {}, "/cwd");
    expect(getProcessStatus("close-test")).toEqual({ alive: true, exitCode: null });

    child.emit("close", 1);

    expect(getProcessStatus("close-test")).toEqual({ alive: false, exitCode: 1 });
  });

  it("error event sets alive:false and pushes error log", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess, getProcessStatus, getProcessLogs } = await loadModule();

    startProcess("error-test", "node", ["app.js"], {}, "/cwd");

    child.emit("error", new Error("spawn ENOENT"));

    expect(getProcessStatus("error-test")).toEqual({ alive: false, exitCode: null });
    const logs = getProcessLogs("error-test");
    expect(logs).toContainEqual("[process error] spawn ENOENT");
  });
});

describe("getProcessStatus", () => {
  it("returns alive:false for unknown id", async () => {
    const { getProcessStatus } = await loadModule();
    expect(getProcessStatus("unknown")).toEqual({ alive: false, exitCode: null });
  });
});

describe("getProcessLogs", () => {
  it("returns empty for unknown id", async () => {
    const { getProcessLogs } = await loadModule();
    expect(getProcessLogs("unknown")).toEqual([]);
  });

  it("returns tail slice for known process", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess, getProcessLogs } = await loadModule();

    startProcess("tail-test", "node", ["app.js"], {}, "/cwd");

    for (let i = 0; i < 10; i++) {
      child.stdout.emit("data", Buffer.from(`line-${i}\n`));
    }

    const logs = getProcessLogs("tail-test", 3);
    expect(logs).toEqual(["line-7", "line-8", "line-9"]);
  });
});

describe("getProcessPid", () => {
  it("returns pid for known process", async () => {
    const child = createMockChild();
    child.pid = 99999;
    mockSpawn.mockReturnValue(child);
    const { startProcess, getProcessPid } = await loadModule();

    startProcess("pid-test", "node", ["app.js"], {}, "/cwd");
    expect(getProcessPid("pid-test")).toBe(99999);
  });

  it("returns undefined for unknown id", async () => {
    const { getProcessPid } = await loadModule();
    expect(getProcessPid("unknown")).toBeUndefined();
  });
});

describe("stopProcess", () => {
  it("resolves for unknown process", async () => {
    const { stopProcess } = await loadModule();
    await expect(stopProcess("unknown")).resolves.toBeUndefined();
  });

  it("resolves for dead process", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess, stopProcess } = await loadModule();

    startProcess("dead-proc", "node", ["app.js"], {}, "/cwd");
    child.emit("close", 0);

    await expect(stopProcess("dead-proc")).resolves.toBeUndefined();
  });

  it("sends SIGTERM then SIGKILL after timeout", async () => {
    vi.useFakeTimers();

    const treeKill = (await import("tree-kill")).default;
    const mockTreeKill = vi.mocked(treeKill);
    mockTreeKill.mockReset();

    const child = createMockChild();
    child.pid = 55555;
    mockSpawn.mockReturnValue(child);
    const { startProcess, stopProcess } = await loadModule();

    startProcess("kill-test", "node", ["app.js"], {}, "/cwd");

    const stopPromise = stopProcess("kill-test");

    // SIGTERM should have been sent immediately
    expect(mockTreeKill).toHaveBeenCalledWith(55555, "SIGTERM", expect.any(Function));

    // Advance past the 5s timeout
    vi.advanceTimersByTime(5000);

    // SIGKILL should now have been sent
    expect(mockTreeKill).toHaveBeenCalledWith(55555, "SIGKILL", expect.any(Function));

    // Invoke the SIGKILL callback to resolve the promise
    const sigkillCall = mockTreeKill.mock.calls.find((c) => c[1] === "SIGKILL");
    if (!sigkillCall) throw new Error("expected SIGKILL call");
    const sigkillCallback = sigkillCall[2] as () => void;
    sigkillCallback();

    await stopPromise;
  });
});

describe("clearProcessLogs", () => {
  it("removes stored logs so subsequent reads return empty", async () => {
    const { storeCommandLogs, clearProcessLogs, getProcessLogs } = await loadModule();

    storeCommandLogs("clear-test", "old line\n", "");
    expect(getProcessLogs("clear-test")).toEqual(["old line"]);

    clearProcessLogs("clear-test");
    expect(getProcessLogs("clear-test")).toEqual([]);
  });

  it("is a no-op for unknown ids", async () => {
    const { clearProcessLogs } = await loadModule();
    expect(() => clearProcessLogs("nonexistent")).not.toThrow();
  });
});

describe("storeCommandLogs", () => {
  it("stores stdout and stderr lines under the given id", async () => {
    const { storeCommandLogs, getProcessLogs } = await loadModule();

    storeCommandLogs("cmd-test", "line1\nline2\n", "err1\n");

    expect(getProcessLogs("cmd-test")).toEqual(["line1", "line2", "err1"]);
  });

  it("appends to existing logs for a running process", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const { startProcess, storeCommandLogs, getProcessLogs } = await loadModule();

    startProcess("append-test", "node", ["app.js"], {}, "/cwd");
    child.stdout.emit("data", Buffer.from("from-process\n"));

    storeCommandLogs("append-test", "from-command\n", "");

    expect(getProcessLogs("append-test")).toEqual(["from-process", "from-command"]);
  });

  it("skips empty output", async () => {
    const { storeCommandLogs, getProcessLogs } = await loadModule();

    storeCommandLogs("empty-test", "", "");

    expect(getProcessLogs("empty-test")).toEqual([]);
  });
});

describe("stopAllProcesses", () => {
  it("stops all tracked processes", async () => {
    const treeKill = (await import("tree-kill")).default;
    const mockTreeKill = vi.mocked(treeKill);
    mockTreeKill.mockReset();

    const child1 = createMockChild();
    child1.pid = 10001;
    const child2 = createMockChild();
    child2.pid = 10002;
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const { startProcess, stopAllProcesses } = await loadModule();

    startProcess("proc-1", "node", ["a.js"], {}, "/cwd");
    startProcess("proc-2", "node", ["b.js"], {}, "/cwd");

    // Simulate processes closing after SIGTERM
    mockTreeKill.mockImplementation((_pid, _signal, cb) => {
      // Simulate the child close event on SIGTERM
      if (_signal === "SIGTERM") {
        if (_pid === 10001) child1.emit("close", 0);
        if (_pid === 10002) child2.emit("close", 0);
      }
      if (cb) cb();
    });

    await stopAllProcesses();

    expect(mockTreeKill).toHaveBeenCalledWith(10001, "SIGTERM", expect.any(Function));
    expect(mockTreeKill).toHaveBeenCalledWith(10002, "SIGTERM", expect.any(Function));
  });
});
