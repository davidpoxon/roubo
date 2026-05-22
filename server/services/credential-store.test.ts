import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockChild } from "../test/fixtures.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { get, set, deleteSlot, CredentialStoreError } from "./credential-store.js";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
}

describe("credential-store", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    restorePlatform();
  });

  describe("on unsupported platforms", () => {
    it("throws unsupported-platform on get", async () => {
      setPlatform("win32" as NodeJS.Platform);
      await expect(get("plugin", "slot")).rejects.toBeInstanceOf(CredentialStoreError);
      await expect(get("plugin", "slot")).rejects.toMatchObject({ code: "unsupported-platform" });
      expect(spawn).not.toHaveBeenCalled();
    });

    it("throws unsupported-platform on set", async () => {
      setPlatform("win32" as NodeJS.Platform);
      await expect(set("plugin", "slot", "value")).rejects.toMatchObject({
        code: "unsupported-platform",
      });
      expect(spawn).not.toHaveBeenCalled();
    });

    it("throws unsupported-platform on delete", async () => {
      setPlatform("win32" as NodeJS.Platform);
      await expect(deleteSlot("plugin", "slot")).rejects.toMatchObject({
        code: "unsupported-platform",
      });
    });
  });

  describe("on macOS (TC-011)", () => {
    beforeEach(() => {
      setPlatform("darwin");
    });

    it("round-trips a credential via security set then get", async () => {
      // First call: set
      const setProc = createMockChild();
      vi.mocked(spawn).mockReturnValueOnce(setProc);
      const setPromise = set("jira-plugin", "jira-token", "secret-value");
      setProc.emit("close", 0);
      await setPromise;

      expect(spawn).toHaveBeenNthCalledWith(
        1,
        "security",
        [
          "add-generic-password",
          "-a",
          "jira-plugin/jira-token",
          "-s",
          "roubo-plugins",
          "-w",
          "secret-value",
          "-U",
        ],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );

      // Second call: get
      const getProc = createMockChild();
      vi.mocked(spawn).mockReturnValueOnce(getProc);
      const getPromise = get("jira-plugin", "jira-token");
      getProc.stdout?.emit("data", Buffer.from("secret-value\n"));
      getProc.emit("close", 0);
      const result = await getPromise;

      expect(spawn).toHaveBeenNthCalledWith(
        2,
        "security",
        ["find-generic-password", "-a", "jira-plugin/jira-token", "-s", "roubo-plugins", "-w"],
        expect.anything(),
      );
      expect(result).toBe("secret-value");
    });

    it("returns null when security reports not-found (exit 44)", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = get("plugin", "missing");
      proc.stderr?.emit(
        "data",
        Buffer.from("The specified item could not be found in the keychain.\n"),
      );
      proc.emit("close", 44);
      await expect(promise).resolves.toBeNull();
    });

    it("throws keyring-read-failed on other non-zero exits", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = get("plugin", "slot");
      proc.stderr?.emit("data", Buffer.from("permission denied"));
      proc.emit("close", 1);
      await expect(promise).rejects.toMatchObject({ code: "keyring-read-failed" });
    });

    it("throws keyring-write-failed when security set fails", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = set("plugin", "slot", "value");
      proc.stderr?.emit("data", Buffer.from("write failed"));
      proc.emit("close", 1);
      await expect(promise).rejects.toMatchObject({ code: "keyring-write-failed" });
    });

    it("treats delete of missing entry as idempotent success", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = deleteSlot("plugin", "slot");
      proc.stderr?.emit("data", Buffer.from("could not be found"));
      proc.emit("close", 44);
      await expect(promise).resolves.toBeUndefined();
    });

    it("succeeds on delete with exit 0", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = deleteSlot("plugin", "slot");
      proc.emit("close", 0);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe("on Linux (TC-012)", () => {
    beforeEach(() => {
      setPlatform("linux");
    });

    it("stores a credential via secret-tool with the secret piped on stdin", async () => {
      const proc = createMockChild(1234, { withStdin: true });
      vi.mocked(spawn).mockReturnValue(proc);

      const promise = set("jira-plugin", "jira-token", "secret-value");
      proc.emit("close", 0);
      await promise;

      expect(spawn).toHaveBeenCalledWith(
        "secret-tool",
        [
          "store",
          "--label",
          "roubo-jira-plugin-jira-token",
          "service",
          "roubo-plugins",
          "account",
          "jira-plugin/jira-token",
        ],
        expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
      );
      expect(proc.stdin?.write).toHaveBeenCalledWith("secret-value");
      expect(proc.stdin?.end).toHaveBeenCalled();
    });

    it("reads a credential via secret-tool lookup", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);

      const promise = get("jira-plugin", "jira-token");
      proc.stdout?.emit("data", Buffer.from("secret-value\n"));
      proc.emit("close", 0);
      const result = await promise;

      expect(spawn).toHaveBeenCalledWith(
        "secret-tool",
        ["lookup", "service", "roubo-plugins", "account", "jira-plugin/jira-token"],
        expect.anything(),
      );
      expect(result).toBe("secret-value");
    });

    it("returns null when secret-tool lookup exits 1 with empty stderr", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = get("plugin", "missing");
      proc.emit("close", 1);
      await expect(promise).resolves.toBeNull();
    });

    it("throws keyring-unavailable when secret-tool cannot reach a daemon", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = get("plugin", "slot");
      proc.stderr?.emit("data", Buffer.from("Cannot autolaunch D-Bus without X11 $DISPLAY\n"));
      proc.emit("close", 1);
      await expect(promise).rejects.toMatchObject({ code: "keyring-unavailable" });
    });

    it("throws keyring-unavailable on set when daemon is missing", async () => {
      const proc = createMockChild(1234, { withStdin: true });
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = set("plugin", "slot", "value");
      proc.stderr?.emit("data", Buffer.from("Cannot autolaunch D-Bus\n"));
      proc.emit("close", 1);
      await expect(promise).rejects.toMatchObject({ code: "keyring-unavailable" });
    });

    it("treats secret-tool clear exit 1 as idempotent success", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = deleteSlot("plugin", "slot");
      proc.emit("close", 1);
      await expect(promise).resolves.toBeUndefined();
    });

    it("succeeds on delete with exit 0", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = deleteSlot("plugin", "slot");
      proc.emit("close", 0);
      await expect(promise).resolves.toBeUndefined();
    });
  });
});
