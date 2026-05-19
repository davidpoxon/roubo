import { describe, it, expect, vi, afterEach } from "vitest";
import { shutdownWithTimeout } from "./shutdown.js";

const makeHandle = (opts?: { rejects?: boolean; hangs?: boolean }) => ({
  port: 0,
  shutdown: opts?.rejects
    ? vi.fn().mockRejectedValue(new Error("shutdown error"))
    : opts?.hangs
      ? vi.fn().mockReturnValue(new Promise(() => {}))
      : vi.fn().mockResolvedValue(undefined),
});

const makeLogger = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("shutdownWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("null handle: resolves immediately without logging or calling timers", async () => {
    const setTimer = vi.fn();
    const clearTimer = vi.fn();
    const logger = makeLogger();

    await shutdownWithTimeout({ handle: null, timeoutMs: 5000, setTimer, clearTimer, logger });

    expect(setTimer).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("fast shutdown: logs start, calls shutdown, clears timer, no warn", async () => {
    const clearTimer = vi.fn();
    const setTimer = vi.fn().mockImplementation((cb: () => void, ms: number) => setTimeout(cb, ms));
    const logger = makeLogger();
    const handle = makeHandle();

    await shutdownWithTimeout({ handle, timeoutMs: 5000, setTimer, clearTimer, logger });

    expect(logger.log).toHaveBeenCalledWith("[roubo] shutting down server...");
    expect(handle.shutdown).toHaveBeenCalledOnce();
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[0].value);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("shutdown rejects: error logged, promise still resolves, timer cleared", async () => {
    const clearTimer = vi.fn();
    const setTimer = vi.fn().mockImplementation((cb: () => void, ms: number) => setTimeout(cb, ms));
    const logger = makeLogger();
    const handle = makeHandle({ rejects: true });

    await expect(
      shutdownWithTimeout({ handle, timeoutMs: 5000, setTimer, clearTimer, logger }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith("[roubo] shutdown failed:", expect.any(Error));
    expect(clearTimer).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("timeout: resolves with warn log when shutdown does not complete in time", async () => {
    vi.useFakeTimers();

    const logger = makeLogger();
    const handle = makeHandle({ hangs: true });

    const promise = shutdownWithTimeout({
      handle,
      timeoutMs: 5000,
      logger,
    });

    vi.advanceTimersByTime(5000);

    await promise;

    expect(logger.warn).toHaveBeenCalledWith(
      "[roubo] shutdown timed out after 5000ms; force-quitting",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
