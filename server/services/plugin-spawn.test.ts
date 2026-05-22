import { describe, it, expect } from "vitest";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { PluginManifest } from "@roubo/shared";
import {
  assertSpawnAllowed,
  isExecutableAllowed,
  resolveAllowedExecutables,
} from "./plugin-spawn.js";

function makeManifest(processes: PluginManifest["permissions"]["processes"]): PluginManifest {
  return {
    id: "jira-plugin",
    name: "Jira",
    version: "1.0.0",
    description: "Jira integration",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "dist/index.js",
    permissions: {
      network: { hosts: [] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes,
    },
  };
}

describe("plugin-spawn", () => {
  describe("resolveAllowedExecutables", () => {
    it("returns null when processes is false (every spawn denied)", () => {
      expect(resolveAllowedExecutables(makeManifest(false))).toBeNull();
    });

    it("returns the declared executables array when processes is an object", () => {
      const list = resolveAllowedExecutables(makeManifest({ executables: ["git", "/usr/bin/jq"] }));
      expect(list).toEqual(["git", "/usr/bin/jq"]);
    });

    it("returns an empty array when processes.executables is empty", () => {
      expect(resolveAllowedExecutables(makeManifest({ executables: [] }))).toEqual([]);
    });
  });

  describe("isExecutableAllowed", () => {
    it("matches bare-name declarations by basename of the requested executable", () => {
      expect(isExecutableAllowed("git", ["git"])).toBe(true);
      expect(isExecutableAllowed("/usr/bin/git", ["git"])).toBe(true);
    });

    it("requires exact path equality for path-bearing declarations", () => {
      expect(isExecutableAllowed("/usr/bin/jq", ["/usr/bin/jq"])).toBe(true);
      // bare name does not satisfy a path-bearing declaration
      expect(isExecutableAllowed("jq", ["/usr/bin/jq"])).toBe(false);
      // different absolute path does not satisfy
      expect(isExecutableAllowed("/usr/local/bin/jq", ["/usr/bin/jq"])).toBe(false);
    });

    it("denies executables not in the allow list", () => {
      expect(isExecutableAllowed("rm", ["git"])).toBe(false);
      expect(isExecutableAllowed("git", [])).toBe(false);
    });
  });

  describe("assertSpawnAllowed", () => {
    let logCalls: Array<["info" | "warn" | "error", string]>;
    const log = (level: "info" | "warn" | "error", text: string) => {
      logCalls.push([level, text]);
    };

    function reset() {
      logCalls = [];
    }

    it("passes for an allowed executable", () => {
      reset();
      expect(() =>
        assertSpawnAllowed("jira-plugin", "host.process.spawn", "git", ["git"], log),
      ).not.toThrow();
      expect(logCalls).toEqual([]);
    });

    it("denies and logs when processes is false (null allowed list)", () => {
      reset();
      try {
        assertSpawnAllowed("jira-plugin", "host.process.spawn", "rm", null, log);
        throw new Error("expected denial");
      } catch (err) {
        const responseErr = err as ResponseError<{
          code: string;
          category: string;
          executable: string;
          reason: string;
        }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.data).toEqual({
          code: "permission-denied",
          category: "processes",
          executable: "rm",
          reason: "all-spawning-denied",
        });
      }
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            text.includes("jira-plugin.host.process.spawn") &&
            text.includes("all-spawning-denied"),
        ),
      ).toBe(true);
    });

    it("denies an executable not declared in the allow list", () => {
      reset();
      try {
        assertSpawnAllowed("jira-plugin", "host.process.spawn", "curl", ["git"], log);
        throw new Error("expected denial");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("executable-not-declared");
      }
    });

    it("denies an empty or missing executable parameter", () => {
      reset();
      try {
        assertSpawnAllowed(
          "jira-plugin",
          "host.process.spawn",
          "" as unknown as string,
          ["git"],
          log,
        );
        throw new Error("expected denial");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("invalid-params");
      }
    });
  });
});
