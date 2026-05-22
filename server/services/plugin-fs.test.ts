import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import {
  assertPathAllowed,
  isPathAllowed,
  resolveAllowedRoots,
  resolveRealPath,
} from "./plugin-fs.js";

function makeManifest(paths: string[]): PluginManifest {
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
      filesystem: { paths },
      processes: false,
    },
  };
}

function makeRecord(pluginDir: string, paths: string[] = []): PluginRecord {
  const manifest = makeManifest(paths);
  return {
    id: manifest.id,
    manifest,
    manifestPath: path.join(pluginDir, "roubo-plugin.yaml"),
    pluginDir,
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 1234,
  };
}

describe("plugin-fs", () => {
  describe("resolveAllowedRoots", () => {
    it("always includes the plugin's own directory", () => {
      const roots = resolveAllowedRoots(makeRecord("/opt/plugins/jira"));
      expect(roots).toEqual([path.resolve("/opt/plugins/jira")]);
    });

    it("appends declared paths, resolving relative entries against pluginDir", () => {
      const roots = resolveAllowedRoots(makeRecord("/opt/plugins/jira", ["data", "/var/log/jira"]));
      expect(roots).toEqual([
        path.resolve("/opt/plugins/jira"),
        path.resolve("/opt/plugins/jira/data"),
        path.resolve("/var/log/jira"),
      ]);
    });

    it("returns only pluginDir when manifest is missing", () => {
      const record: PluginRecord = {
        id: "broken",
        manifest: null,
        manifestPath: "/x",
        pluginDir: "/opt/plugins/broken",
        source: "user",
        status: "invalid",
        lastError: { code: "invalid-manifest", message: "x" },
        restartHistory: [],
        pid: null,
      };
      expect(resolveAllowedRoots(record)).toEqual([path.resolve("/opt/plugins/broken")]);
    });
  });

  describe("isPathAllowed", () => {
    const roots = ["/opt/plugins/jira", "/var/log/jira"].map((p) => path.resolve(p));

    it("allows the root itself", () => {
      expect(isPathAllowed("/opt/plugins/jira", roots)).toBe(true);
    });

    it("allows paths inside a root", () => {
      expect(isPathAllowed("/opt/plugins/jira/data/cache.json", roots)).toBe(true);
      expect(isPathAllowed("/var/log/jira/today.log", roots)).toBe(true);
    });

    it("denies sibling paths that share a prefix string", () => {
      expect(isPathAllowed("/opt/plugins/jira-evil/secret", roots)).toBe(false);
      expect(isPathAllowed("/var/log/jira-evil", roots)).toBe(false);
    });

    it("denies paths outside every root", () => {
      expect(isPathAllowed("/tmp/exfiltrate.txt", roots)).toBe(false);
      expect(isPathAllowed("/etc/passwd", roots)).toBe(false);
    });

    it("treats `..` traversal as a logical resolution before checking", () => {
      // path.resolve flattens "../" so an attempt to escape via ".." lands
      // outside the root and is denied.
      expect(isPathAllowed("/opt/plugins/jira/../jira-evil/secret", roots)).toBe(false);
    });
  });

  describe("resolveRealPath", () => {
    let tmpRoot: string;

    beforeEach(async () => {
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-fs-realpath-"));
    });

    afterEach(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("returns the realpath of an existing file (resolving symlinks)", async () => {
      const realDir = await fs.realpath(tmpRoot);
      const target = path.join(realDir, "target.txt");
      await fs.writeFile(target, "x");
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-fs-link-"));
      const linkPath = path.join(linkDir, "alias.txt");
      await fs.symlink(target, linkPath);

      try {
        expect(await resolveRealPath(linkPath)).toBe(target);
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });

    it("re-attaches missing tail segments when the path does not exist yet", async () => {
      const realRoot = await fs.realpath(tmpRoot);
      const missing = path.join(realRoot, "a", "b", "c", "newfile.txt");
      // tmpRoot exists; a/b/c does not. resolveRealPath should walk up to
      // tmpRoot, realpath it, then re-attach a/b/c/newfile.txt in order.
      expect(await resolveRealPath(missing)).toBe(missing);
    });
  });

  describe("assertPathAllowed", () => {
    let tmpRoot: string;
    let logCalls: Array<["info" | "warn" | "error", string]>;
    const log = (level: "info" | "warn" | "error", text: string) => {
      logCalls.push([level, text]);
    };

    beforeEach(async () => {
      tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plugin-fs-assert-")));
      logCalls = [];
    });

    afterEach(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("returns the resolved path when inside a root", async () => {
      const file = path.join(tmpRoot, "ok.txt");
      await fs.writeFile(file, "x");
      const resolved = await assertPathAllowed(
        "jira-plugin",
        "host.fs.readFile",
        file,
        [tmpRoot],
        log,
      );
      expect(resolved).toBe(file);
    });

    it("denies and logs a path outside every root (TC-080 path)", async () => {
      const outside = "/tmp/exfiltrate-" + Date.now() + ".txt";
      try {
        await assertPathAllowed("jira-plugin", "host.fs.writeFile", outside, [tmpRoot], log);
        throw new Error("expected denial");
      } catch (err) {
        const responseErr = err as ResponseError<{
          code: string;
          category: string;
          path: string;
          reason: string;
        }>;
        expect(responseErr).toBeInstanceOf(ResponseError);
        expect(responseErr.data?.code).toBe("permission-denied");
        expect(responseErr.data?.category).toBe("filesystem");
        expect(responseErr.data?.reason).toBe("path-not-in-allowlist");
      }
      expect(
        logCalls.some(
          ([level, text]) =>
            level === "warn" &&
            text.includes("jira-plugin.host.fs.writeFile") &&
            text.includes("path-not-in-allowlist"),
        ),
      ).toBe(true);
    });

    it("denies an empty or non-string path with reason invalid-params", async () => {
      try {
        await assertPathAllowed(
          "jira-plugin",
          "host.fs.readFile",
          "" as unknown as string,
          [tmpRoot],
          log,
        );
        throw new Error("expected denial");
      } catch (err) {
        const responseErr = err as ResponseError<{ reason: string }>;
        expect(responseErr.data?.reason).toBe("invalid-params");
      }
    });

    it("denies a symlink that escapes the allowlist by resolving its real target", async () => {
      const outside = path.join(os.tmpdir(), "plugin-fs-outside-" + Date.now() + ".txt");
      await fs.writeFile(outside, "secret");
      const link = path.join(tmpRoot, "alias.txt");
      await fs.symlink(outside, link);
      try {
        try {
          await assertPathAllowed("jira-plugin", "host.fs.readFile", link, [tmpRoot], log);
          throw new Error("expected denial");
        } catch (err) {
          const responseErr = err as ResponseError<{ reason: string }>;
          expect(responseErr.data?.reason).toBe("path-not-in-allowlist");
        }
      } finally {
        await fs.rm(outside, { force: true });
      }
    });
  });
});
