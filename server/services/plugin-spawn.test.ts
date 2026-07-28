import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResponseError } from "vscode-jsonrpc/node";
import type { PluginManifest } from "@roubo/shared";
import {
  assertExecutableNotInWorkspace,
  assertNoWorkspacePathArgs,
  assertSpawnAllowed,
  assertSpawnCwdConfined,
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

  // Issue #633: the executable allowlist says what may run; these two say where.
  describe("spawn confinement (issue #633)", () => {
    let tmpRoot: string;
    let pluginDir: string;
    let declaredDir: string;
    let workspacesRoot: string;
    let benchDir: string;
    let logCalls: Array<["info" | "warn" | "error", string]>;

    const log = (level: "info" | "warn" | "error", text: string) => {
      logCalls.push([level, text]);
    };

    beforeAll(async () => {
      tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "roubo-spawn-")));
      pluginDir = path.join(tmpRoot, "plugins", "jira-plugin");
      declaredDir = path.join(tmpRoot, "declared");
      workspacesRoot = path.join(tmpRoot, "workspaces");
      benchDir = path.join(workspacesRoot, "roubo", "bench-1");
      await fs.mkdir(path.join(pluginDir, "nested"), { recursive: true });
      await fs.mkdir(declaredDir, { recursive: true });
      await fs.mkdir(benchDir, { recursive: true });
      // A symlink inside the plugin directory pointing at a bench workspace:
      // lexically confined, but it escapes once symlinks are resolved.
      await fs.symlink(benchDir, path.join(pluginDir, "bench-link"), "dir");
    });

    afterAll(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    function reset() {
      logCalls = [];
    }

    async function denialFor(run: () => Promise<unknown>): Promise<{
      reason: string;
      path?: string;
      category: string;
    }> {
      try {
        await run();
      } catch (err) {
        const responseErr = err as ResponseError<{
          reason: string;
          path?: string;
          category: string;
        }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        return responseErr.data as { reason: string; path?: string; category: string };
      }
      throw new Error("expected denial");
    }

    describe("assertSpawnCwdConfined", () => {
      it("defaults an omitted cwd to the plugin directory", async () => {
        reset();
        const cwd = await assertSpawnCwdConfined(
          "jira-plugin",
          "host.process.spawn",
          "git",
          undefined,
          pluginDir,
          workspacesRoot,
          log,
        );
        expect(cwd).toBe(pluginDir);
        expect(logCalls).toEqual([]);
      });

      it("allows a cwd inside the plugin directory", async () => {
        reset();
        const nested = path.join(pluginDir, "nested");
        const cwd = await assertSpawnCwdConfined(
          "jira-plugin",
          "host.process.spawn",
          "git",
          nested,
          pluginDir,
          workspacesRoot,
          log,
        );
        expect(cwd).toBe(nested);
        expect(logCalls).toEqual([]);
      });

      it("denies a declared-but-external filesystem path as cwd", async () => {
        reset();
        const data = await denialFor(() =>
          assertSpawnCwdConfined(
            "jira-plugin",
            "host.process.spawn",
            "git",
            declaredDir,
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.category).toBe("processes");
        expect(data.reason).toBe("cwd-not-in-plugin-dir");
        expect(data.path).toBe(declaredDir);
        expect(
          logCalls.some(
            ([level, text]) => level === "warn" && text.includes("cwd-not-in-plugin-dir"),
          ),
        ).toBe(true);
      });

      it("denies a bench workspace as cwd", async () => {
        reset();
        const data = await denialFor(() =>
          assertSpawnCwdConfined(
            "jira-plugin",
            "host.process.spawn",
            "git",
            benchDir,
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("cwd-not-in-plugin-dir");
      });

      it("denies a symlink inside the plugin directory that points at a bench workspace", async () => {
        reset();
        const data = await denialFor(() =>
          assertSpawnCwdConfined(
            "jira-plugin",
            "host.process.spawn",
            "git",
            path.join(pluginDir, "bench-link"),
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        // Realpath resolution takes it out of the plugin directory first; either
        // barrier is a denial, and the workspace stays unreachable.
        expect(["cwd-not-in-plugin-dir", "workspace-path-denied"]).toContain(data.reason);
        expect(data.path).toBe(benchDir);
      });

      it("denies a bench workspace even when the plugin directory contains it", async () => {
        reset();
        // Pathological but explicit: confinement to the plugin directory alone
        // would allow this, so the workspace denial is a separate barrier.
        const data = await denialFor(() =>
          assertSpawnCwdConfined(
            "jira-plugin",
            "host.process.spawn",
            "git",
            benchDir,
            workspacesRoot,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(benchDir);
      });

      it("denies an empty cwd as invalid params", async () => {
        reset();
        const data = await denialFor(() =>
          assertSpawnCwdConfined(
            "jira-plugin",
            "host.process.spawn",
            "git",
            "",
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("invalid-params");
      });
    });

    describe("assertNoWorkspacePathArgs", () => {
      it("leaves non-path arguments untouched", async () => {
        reset();
        await expect(
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            ["status", "--porcelain", "-rf", ""],
            pluginDir,
            workspacesRoot,
            log,
          ),
        ).resolves.toBeUndefined();
        expect(logCalls).toEqual([]);
      });

      it("allows a path argument inside the plugin directory", async () => {
        reset();
        await expect(
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            [path.join(pluginDir, "nested"), "./nested"],
            pluginDir,
            workspacesRoot,
            log,
          ),
        ).resolves.toBeUndefined();
        expect(logCalls).toEqual([]);
      });

      it("denies an absolute bench-workspace argument", async () => {
        reset();
        const data = await denialFor(() =>
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            ["status", path.join(benchDir, "CLAUDE.md")],
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.category).toBe("processes");
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(path.join(benchDir, "CLAUDE.md"));
      });

      it("denies a relative argument that climbs out of cwd into a workspace", async () => {
        reset();
        const relative = path.relative(pluginDir, benchDir);
        const data = await denialFor(() =>
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            [relative],
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("workspace-path-denied");
      });

      it("denies a workspace path hidden in a --flag=<value> argument", async () => {
        reset();
        const data = await denialFor(() =>
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            [`--git-dir=${benchDir}`],
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(benchDir);
      });

      it("denies a symlinked argument that resolves into a workspace", async () => {
        reset();
        const data = await denialFor(() =>
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            [path.join(pluginDir, "bench-link")],
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(benchDir);
      });

      it("denies a bare symlink name carrying no path separator", async () => {
        reset();
        // The child's cwd is the plugin directory, so a bare name resolves
        // against it: `bench-link` reaches the workspace without ever looking
        // like a path.
        const data = await denialFor(() =>
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            ["bench-link"],
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(benchDir);
      });

      it("denies a workspace path in the tail of a multi-`=` argument", async () => {
        reset();
        const data = await denialFor(() =>
          assertNoWorkspacePathArgs(
            "jira-plugin",
            "host.process.spawn",
            "git",
            [`-c=include.path=${benchDir}`],
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(benchDir);
      });
    });

    describe("assertExecutableNotInWorkspace", () => {
      it("allows a bare executable name", async () => {
        reset();
        await expect(
          assertExecutableNotInWorkspace(
            "jira-plugin",
            "host.process.spawn",
            "git",
            pluginDir,
            workspacesRoot,
            log,
          ),
        ).resolves.toBeUndefined();
        expect(logCalls).toEqual([]);
      });

      it("denies a workspace-resident executable that passes the basename allowlist", async () => {
        reset();
        // `isExecutableAllowed` matches a bare-name declaration by basename, so
        // an absolute path to a workspace binary would otherwise satisfy a
        // declaration of just `node`.
        const data = await denialFor(() =>
          assertExecutableNotInWorkspace(
            "jira-plugin",
            "host.process.spawn",
            path.join(benchDir, "node"),
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.category).toBe("processes");
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(path.join(benchDir, "node"));
      });

      it("denies an executable reached through a symlink in the plugin directory", async () => {
        reset();
        const data = await denialFor(() =>
          assertExecutableNotInWorkspace(
            "jira-plugin",
            "host.process.spawn",
            "bench-link/node",
            pluginDir,
            workspacesRoot,
            log,
          ),
        );
        expect(data.reason).toBe("workspace-path-denied");
        expect(data.path).toBe(path.join(benchDir, "node"));
      });
    });
  });
});
