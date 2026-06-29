import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { copyResources } from "./copy-resources.js";

let tmpDir: string;

// The real seed step downloads over the network at package time; the unit test
// stays fully offline by injecting a stub. Each test passes `seed: noopSeed`
// (or a spy) so `copyResources` never touches the network.
const noopSeed = async () => {};

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
}

describe("copyResources", () => {
  it("copies server/dist, client/dist, and schema/ into electron/resources/", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await mkdir(electronRoot);

    await copyResources({ repoRoot, electronRoot, seed: noopSeed });

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

    await copyResources({ repoRoot, electronRoot, seed: noopSeed });

    await writeFile(path.join(repoRoot, "server", "dist", "index.js"), "updated server code");
    await copyResources({ repoRoot, electronRoot, seed: noopSeed });

    const serverIndex = await readFile(
      path.join(electronRoot, "resources", "server", "dist", "index.js"),
      "utf8",
    );
    expect(serverIndex).toBe("updated server code");
  });

  it("ships no plugin source: resources/plugins/ is never produced", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await mkdir(electronRoot);

    await copyResources({ repoRoot, electronRoot, seed: noopSeed });

    await expect(lstat(path.join(electronRoot, "resources", "plugins"))).rejects.toThrow();
  });

  it("removes a stale resources/plugins/ left by a pre-seed build", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    const stalePlugins = path.join(electronRoot, "resources", "plugins", "github-com", "src");
    await mkdir(stalePlugins, { recursive: true });
    await writeFile(path.join(stalePlugins, "index.ts"), "stale source");

    await copyResources({ repoRoot, electronRoot, seed: noopSeed });

    await expect(lstat(path.join(electronRoot, "resources", "plugins"))).rejects.toThrow();
  });

  it("delegates to the injected seed step with the electron root", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await makeRepoArtifacts(repoRoot);
    await mkdir(electronRoot);

    const seed = vi.fn(async () => {});
    await copyResources({ repoRoot, electronRoot, seed });

    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledWith({ electronRoot });
  });

  it("throws when server/dist is missing", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const electronRoot = path.join(tmpDir, "electron");
    await mkdir(path.join(repoRoot, "client", "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "schema"), { recursive: true });
    await mkdir(electronRoot);

    await expect(copyResources({ repoRoot, electronRoot, seed: noopSeed })).rejects.toThrow(
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

    await expect(copyResources({ repoRoot, electronRoot, seed: noopSeed })).rejects.toThrow(
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

    await expect(copyResources({ repoRoot, electronRoot, seed: noopSeed })).rejects.toThrow(
      "schema/ not found — expected at repo root",
    );
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
    await copyResources({ repoRoot, electronRoot, seed: noopSeed });

    const destPath = path.join(electronRoot, "resources", "server", "dist", "index.js");
    const stat = await lstat(destPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    const content = await readFile(destPath, "utf8");
    expect(content).toBe("real content");
  });
});
