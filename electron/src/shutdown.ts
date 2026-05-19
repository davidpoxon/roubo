import type { ServerHandleLike } from "./bootstrap.js";

type Logger = Pick<Console, "log" | "warn" | "error">;

export interface ShutdownDeps {
  handle: ServerHandleLike | null;
  timeoutMs: number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: Logger;
}

export async function shutdownWithTimeout({
  handle,
  timeoutMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}: ShutdownDeps): Promise<void> {
  if (!handle) return;

  logger.log("[roubo] shutting down server...");

  await new Promise<void>((resolve) => {
    const timer = setTimer(() => {
      logger.warn(`[roubo] shutdown timed out after ${timeoutMs}ms; force-quitting`);
      resolve();
    }, timeoutMs);

    handle.shutdown().then(
      () => {
        clearTimer(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimer(timer);
        logger.error("[roubo] shutdown failed:", err);
        resolve();
      },
    );
  });
}
