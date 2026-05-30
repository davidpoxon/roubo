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

interface SpawnResponse {
  code: number;
  stdout?: string;
  stderr?: string;
}

// Auto-respond to a sequence of `spawn` calls in order. Each response drives one
// child: optional stdout/stderr then a close with the given exit code, emitted on
// the next tick so `runCommand` has attached its listeners first. Needed now that
// `set`/`deleteSlot` issue multiple `security` calls (purge loop, write, verify).
function programSpawns(
  responses: SpawnResponse[],
  options?: { withStdin?: boolean },
): Array<ReturnType<typeof createMockChild>> {
  const procs: Array<ReturnType<typeof createMockChild>> = [];
  let i = 0;
  vi.mocked(spawn).mockImplementation(((): ReturnType<typeof createMockChild> => {
    const proc = createMockChild(1234, options);
    procs.push(proc);
    const spec = responses[i] ?? { code: 0 };
    i += 1;
    setImmediate(() => {
      if (spec.stdout) proc.stdout?.emit("data", Buffer.from(spec.stdout));
      if (spec.stderr) proc.stderr?.emit("data", Buffer.from(spec.stderr));
      proc.emit("close", spec.code);
    });
    return proc;
  }) as unknown as typeof spawn);
  return procs;
}

const NOT_FOUND: SpawnResponse = {
  code: 44,
  stderr: "The specified item could not be found in the keychain.\n",
};

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
      // set purges first (nothing to remove → exit 44), adds, then verifies the
      // readback by reading the value back.
      programSpawns([NOT_FOUND, { code: 0 }, { code: 0, stdout: "secret-value\n" }]);
      await set("jira-plugin", "jira-token", "secret-value");

      expect(spawn).toHaveBeenNthCalledWith(
        1,
        "security",
        ["delete-generic-password", "-a", "jira-plugin/jira-token", "-s", "roubo-plugins"],
        expect.anything(),
      );
      expect(spawn).toHaveBeenNthCalledWith(
        2,
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
      // Third call is the verify-after-write readback.
      expect(spawn).toHaveBeenNthCalledWith(
        3,
        "security",
        ["find-generic-password", "-a", "jira-plugin/jira-token", "-s", "roubo-plugins", "-w"],
        expect.anything(),
      );

      // A standalone get reads via find-generic-password.
      const getProc = createMockChild();
      vi.mocked(spawn).mockReset();
      vi.mocked(spawn).mockReturnValueOnce(getProc);
      const getPromise = get("jira-plugin", "jira-token");
      getProc.stdout?.emit("data", Buffer.from("secret-value\n"));
      getProc.emit("close", 0);
      const result = await getPromise;

      expect(spawn).toHaveBeenCalledWith(
        "security",
        ["find-generic-password", "-a", "jira-plugin/jira-token", "-s", "roubo-plugins", "-w"],
        expect.anything(),
      );
      expect(result).toBe("secret-value");
    });

    it("purges every pre-existing duplicate before adding the new value", async () => {
      // Two stale duplicates (exit 0 twice), then not-found, then add, then verify.
      programSpawns([
        { code: 0 },
        { code: 0 },
        NOT_FOUND,
        { code: 0 },
        { code: 0, stdout: "new-token\n" },
      ]);
      await set("github-com", "github-token", "new-token");

      const deletes = vi
        .mocked(spawn)
        .mock.calls.filter((c) => c[1]?.[0] === "delete-generic-password");
      expect(deletes).toHaveLength(3); // 2 removed + 1 confirming none remain
      const adds = vi.mocked(spawn).mock.calls.filter((c) => c[1]?.[0] === "add-generic-password");
      expect(adds).toHaveLength(1);
    });

    it("throws keyring-write-failed when the readback does not match what was written", async () => {
      // purge → add ok → readback returns a DIFFERENT (stale) value.
      programSpawns([NOT_FOUND, { code: 0 }, { code: 0, stdout: "stale-token\n" }]);
      await expect(set("github-com", "github-token", "fresh-token")).rejects.toMatchObject({
        code: "keyring-write-failed",
      });
    });

    it("throws keyring-write-failed when the readback is missing", async () => {
      // purge → add ok → readback reports not-found (null).
      programSpawns([NOT_FOUND, { code: 0 }, NOT_FOUND]);
      await expect(set("github-com", "github-token", "fresh-token")).rejects.toMatchObject({
        code: "keyring-write-failed",
      });
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

    it("throws keyring-write-failed when security add fails", async () => {
      // purge finds nothing (44), then the add itself fails.
      programSpawns([NOT_FOUND, { code: 1, stderr: "write failed" }]);
      await expect(set("plugin", "slot", "value")).rejects.toMatchObject({
        code: "keyring-write-failed",
      });
    });

    it("treats delete of missing entry as idempotent success", async () => {
      programSpawns([NOT_FOUND]);
      await expect(deleteSlot("plugin", "slot")).resolves.toBeUndefined();
    });

    it("loops delete until no matching item remains", async () => {
      // Two duplicates removed, then not-found stops the loop.
      programSpawns([{ code: 0 }, { code: 0 }, NOT_FOUND]);
      await deleteSlot("plugin", "slot");
      expect(spawn).toHaveBeenCalledTimes(3);
      for (let n = 1; n <= 3; n++) {
        expect(spawn).toHaveBeenNthCalledWith(
          n,
          "security",
          ["delete-generic-password", "-a", "plugin/slot", "-s", "roubo-plugins"],
          expect.anything(),
        );
      }
    });

    it("succeeds on delete with exit 0 then stops at not-found", async () => {
      programSpawns([{ code: 0 }, NOT_FOUND]);
      await expect(deleteSlot("plugin", "slot")).resolves.toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("throws keyring-delete-failed on an unexpected delete error", async () => {
      programSpawns([{ code: 1, stderr: "boom" }]);
      await expect(deleteSlot("plugin", "slot")).rejects.toMatchObject({
        code: "keyring-delete-failed",
      });
    });
  });

  describe("on Linux (TC-012)", () => {
    beforeEach(() => {
      setPlatform("linux");
    });

    it("stores a credential via secret-tool with the secret piped on stdin", async () => {
      // store, then the verify-after-write readback via lookup.
      const procs = programSpawns([{ code: 0 }, { code: 0, stdout: "secret-value\n" }], {
        withStdin: true,
      });

      await set("jira-plugin", "jira-token", "secret-value");

      expect(spawn).toHaveBeenNthCalledWith(
        1,
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
      expect(procs[0].stdin?.write).toHaveBeenCalledWith("secret-value");
      expect(procs[0].stdin?.end).toHaveBeenCalled();
      // Verify-after-write reads the value straight back.
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        "secret-tool",
        ["lookup", "service", "roubo-plugins", "account", "jira-plugin/jira-token"],
        expect.anything(),
      );
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

    it("throws keyring-unavailable on delete when daemon is missing", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = deleteSlot("plugin", "slot");
      proc.stderr?.emit("data", Buffer.from("Cannot autolaunch D-Bus\n"));
      proc.emit("close", 1);
      await expect(promise).rejects.toMatchObject({ code: "keyring-unavailable" });
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
