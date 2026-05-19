import { describe, it, expect, vi } from "vitest";
import { resolveBootstrap } from "./bootstrap.js";

const makeImportServer = (port: number) =>
  vi.fn().mockResolvedValue({
    startServer: vi
      .fn()
      .mockResolvedValue({ port, shutdown: vi.fn().mockResolvedValue(undefined) }),
  });

describe("resolveBootstrap", () => {
  it("dev mode: returns Vite URL and null handle without importing server", async () => {
    const importServer = makeImportServer(0);
    const result = await resolveBootstrap({ env: { ROUBO_DEV: "1" }, importServer });
    expect(result.url).toBe("http://localhost:3334");
    expect(result.serverHandle).toBeNull();
    expect(importServer).not.toHaveBeenCalled();
  });

  it("production mode: starts server with port 0 and returns its URL", async () => {
    const importServer = makeImportServer(54321);
    const result = await resolveBootstrap({ env: {}, importServer });
    expect(result.url).toBe("http://127.0.0.1:54321");
    expect(result.serverHandle).not.toBeNull();
    expect(result.serverHandle?.port).toBe(54321);
    const { startServer } = await importServer.mock.results[0].value;
    expect(startServer).toHaveBeenCalledWith({ port: 0 });
  });

  it("production mode: sets ROUBO_PRODUCTION=1 on env before calling importServer", async () => {
    const env: Record<string, string> = {};
    let rouboProductionAtCallTime: string | undefined;
    const importServer = vi.fn().mockImplementation(() => {
      rouboProductionAtCallTime = env.ROUBO_PRODUCTION;
      return Promise.resolve({
        startServer: vi
          .fn()
          .mockResolvedValue({ port: 9999, shutdown: vi.fn().mockResolvedValue(undefined) }),
      });
    });
    await resolveBootstrap({ env, importServer });
    expect(rouboProductionAtCallTime).toBe("1");
    expect(env.ROUBO_PRODUCTION).toBe("1");
  });

  it("dev mode: does not set ROUBO_PRODUCTION", async () => {
    const env: Record<string, string> = { ROUBO_DEV: "1" };
    const importServer = makeImportServer(0);
    await resolveBootstrap({ env, importServer });
    expect(env.ROUBO_PRODUCTION).toBeUndefined();
  });

  it.each(["true", "0", ""])('ROUBO_DEV="%s" is treated as production', async (value) => {
    const importServer = makeImportServer(11111);
    const result = await resolveBootstrap({ env: { ROUBO_DEV: value }, importServer });
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(importServer).toHaveBeenCalled();
  });

  it("propagates startServer rejection", async () => {
    const importServer = vi.fn().mockResolvedValue({
      startServer: vi.fn().mockRejectedValue(new Error("port in use")),
    });
    await expect(resolveBootstrap({ env: {}, importServer })).rejects.toThrow("port in use");
  });

  it("propagates importServer rejection", async () => {
    const importServer = vi.fn().mockRejectedValue(new Error("module not found"));
    await expect(resolveBootstrap({ env: {}, importServer })).rejects.toThrow("module not found");
  });
});
