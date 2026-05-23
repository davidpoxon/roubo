import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BUNDLED_PLUGIN_IDS, copyResources } from "./copy-resources.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "copy-resources-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function makeRepoArtifacts(repoRoot: string) {
  await mkdir(path.join(repoRoot, "server", "dist"), { recursive: true });
  await mkdir(path.join(repoRoot, "client", "dist"), { recursive: true });
  await mkdir(path.join(repoRoot, "schema"), { recursive: true });
  await writeFile(path.join(repoRoot, "server", "dist", "index.js"), "server code");
  await writeFile(path.join(repoRoot, "client", "dist", "index.html"), "<html>client</html>");
  await writeFile(path.join(repoRoot, "schema", "roubo-config.schema.json"), "{}");

  for (const id of BUNDLED_PLUGIN_IDS) {
    const pluginRoot = path.join(repoRoot, "plugins", id);
    await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
    await mkdir(path.join(pluginRoot, "src"), { recursive: true });
    await mkdir(path.join(pluginRoot, "node_modules", "junk"), { recursive: true });
    await writeFile(path.join(pluginRoot, "dist", "index.js"), `${id} dist`);
    await writeFile(path.join(pluginRoot, "src", "index.ts"), `${id} src`);
    await writeFile(path.join(pluginRoot, "roubo-plugin.yaml"), `id: ${id}\n`);
    await writeFile(path.join(pluginRoot, "package.json"), `{"name":"${id}"}`);
    await writeFile(path.join(pluginRoot, "README.md"), `# ${id}`);
    await writeFile(path.join(pluginRoot, "tsconfig.json"), "{}");
    await writeFile(path.join(pluginRoot, "node_modules", "junk", "x.js"), "should not ship");
  }
}

describe("copyResources", () => {
  it("copies server/dist, client/dist, and schema/ into electron/resources/", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await mkdir(electronRoot);

    await copyResources({ repoRoot, electronRoot });

    const serverIndex = await readFile(
      path.join(electronRoot, "resources", "server", "dist", "index.js"),
      "utf8",
    );
    expect(serverIndex).toBe("server code");

    const clientHtml = await readFile(
      path.join(electronRoot, "resources", "client", "dist", "index.html"),
      "utf8",
    );
    expect(clientHtml).toBe("<html>client</html>");

    const schema = await readFile(
      path.join(electronRoot, "resources", "schema", "roubo-config.schema.json"),
      "utf8",
    );
    expect(schema).toBe("{}");
  });

  it("is idempotent: replaces stale content on rerun", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await mkdir(electronRoot);

    await copyResources({ repoRoot, electronRoot });

    await writeFile(path.join(repoRoot, "server", "dist", "index.js"), "updated server code");
    await copyResources({ repoRoot, electronRoot });

    const serverIndex = await readFile(
      path.join(electronRoot, "resources", "server", "dist", "index.js"),
      "utf8",
    );
    expect(serverIndex).toBe("updated server code");
  });

  it("throws when server/dist is missing", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await mkdir(path.join(repoRoot, "client", "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "schema"), { recursive: true });
    await mkdir(electronRoot);

    await expect(copyResources({ repoRoot, electronRoot })).rejects.toThrow(
      "server/dist not found — run `npm run build` from repo root first",
    );
  });

  it("throws when client/dist is missing", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await mkdir(path.join(repoRoot, "server", "dist"), { recursive: true });
    await writeFile(path.join(repoRoot, "server", "dist", "index.js"), "code");
    await mkdir(path.join(repoRoot, "schema"), { recursive: true });
    await mkdir(electronRoot);

    await expect(copyResources({ repoRoot, electronRoot })).rejects.toThrow(
      "client/dist not found — run `npm run build` from repo root first",
    );
  });

  it("throws when schema/ is missing", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await mkdir(path.join(repoRoot, "server", "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "client", "dist"), { recursive: true });
    await writeFile(path.join(repoRoot, "server", "dist", "index.js"), "code");
    await writeFile(path.join(repoRoot, "client", "dist", "index.html"), "<html>");
    await mkdir(electronRoot);

    await expect(copyResources({ repoRoot, electronRoot })).rejects.toThrow(
      "schema/ not found — expected at repo root",
    );
  });

  it("throws when a bundled plugin dist/ is missing", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await rm(path.join(repoRoot, "plugins", "github-com", "dist"), {
      recursive: true,
      force: true,
    });
    await mkdir(electronRoot);

    await expect(copyResources({ repoRoot, electronRoot })).rejects.toThrow(
      "plugins/github-com/dist not found — run `npm run build` from repo root first",
    );
  });

  it("stages each bundled plugin (manifest + package.json + dist) and skips build-time files", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await mkdir(electronRoot);

    await copyResources({ repoRoot, electronRoot });

    for (const id of BUNDLED_PLUGIN_IDS) {
      const dest = path.join(electronRoot, "resources", "plugins", id);

      const manifest = await readFile(path.join(dest, "roubo-plugin.yaml"), "utf8");
      expect(manifest).toBe(`id: ${id}\n`);

      const pkg = await readFile(path.join(dest, "package.json"), "utf8");
      expect(pkg).toBe(`{"name":"${id}"}`);

      const dist = await readFile(path.join(dest, "dist", "index.js"), "utf8");
      expect(dist).toBe(`${id} dist`);

      // Build-time and workspace junk must not ship.
      await expect(lstat(path.join(dest, "tsconfig.json"))).rejects.toThrow();
      await expect(lstat(path.join(dest, "src"))).rejects.toThrow();
      await expect(lstat(path.join(dest, "node_modules"))).rejects.toThrow();
    }
  });

  it("idempotently refreshes staged plugins on rerun", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await mkdir(electronRoot);

    await copyResources({ repoRoot, electronRoot });
    await writeFile(
      path.join(repoRoot, "plugins", "github-com", "dist", "index.js"),
      "updated github-com dist",
    );
    await copyResources({ repoRoot, electronRoot });

    const updated = await readFile(
      path.join(electronRoot, "resources", "plugins", "github-com", "dist", "index.js"),
      "utf8",
    );
    expect(updated).toBe("updated github-com dist");
  });

  it("dereferences symlinks into real files", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await rm(path.join(repoRoot, "server", "dist", "index.js"));

    const realFile = path.join(tmpDir, "real.js");
    await writeFile(realFile, "real content");
    await symlink(realFile, path.join(repoRoot, "server", "dist", "index.js"));

    await mkdir(electronRoot);
    await copyResources({ repoRoot, electronRoot });

    const destPath = path.join(electronRoot, "resources", "server", "dist", "index.js");
    const stat = await lstat(destPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(destPath, "utf8");
    expect(content).toBe("real content");
  });
});
