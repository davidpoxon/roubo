import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginRecord } from "@roubo/shared";

vi.mock("./exec.js", () => ({
  runCommand: vi.fn(),
}));

vi.mock("./plugin-manager.js", () => ({
  HOST_API_VERSION: "1.0.0",
  getUserPluginsRoot: vi.fn(),
  listInstalled: vi.fn(() => []),
  registerInstalled: vi.fn(),
  uninstall: vi.fn(),
  uninstallForUpdate: vi.fn(),
}));

import * as pluginInstaller from "./plugin-installer.js";
import * as exec from "./exec.js";
import * as pluginManager from "./plugin-manager.js";
import { resolveWithin } from "../lib/safe-path.js";

const ECHO_MANIFEST = `id: echo
name: Echo
version: 0.0.0
description: Test fixture
kind: integration
roubo: ^1.0.0
entry: ./index.js
permissions:
  network:
    hosts: ["api.example.com/*"]
  credentials:
    slots:
      - slot: token
        scope: read
        description: API token
  filesystem:
    paths: ["~/.config/echo"]
  processes: false
`;

const INCOMPATIBLE_MANIFEST = `id: incompatible
name: Incompatible
version: 0.0.0
description: Requires future host
kind: integration
roubo: ^9.0.0
entry: ./index.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;

let pluginsRoot: string;

beforeEach(async () => {
  pluginInstaller.__test.reset();
  pluginsRoot = await mkdtemp(path.join(tmpdir(), "roubo-installer-test-"));
  vi.mocked(pluginManager.getUserPluginsRoot).mockReturnValue(pluginsRoot);
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(exec.runCommand).mockReset();
  vi.mocked(pluginManager.registerInstalled).mockReset();
  vi.mocked(pluginManager.uninstall).mockReset();
  vi.mocked(pluginManager.uninstall).mockResolvedValue(undefined);
  vi.mocked(pluginManager.uninstallForUpdate).mockReset();
  vi.mocked(pluginManager.uninstallForUpdate).mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(pluginsRoot, { recursive: true, force: true });
});

async function listStaging(): Promise<string[]> {
  const stagingDir = pluginInstaller.__test.stagingRoot();
  try {
    return await readdir(resolveWithin(stagingDir));
  } catch {
    return [];
  }
}

function fakeClone(manifest: string) {
  // Pretend `git clone <url> <dest>` succeeded by writing a manifest into dest.
  vi.mocked(exec.runCommand).mockImplementation(async (_cmd, args) => {
    const dest = args[args.length - 1] as string;
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "roubo-plugin.yaml"), manifest, "utf8");
    return { code: 0, stdout: "", stderr: "" };
  });
}

function fakeCloneFailure(code: number, stderr: string) {
  vi.mocked(exec.runCommand).mockResolvedValue({ code, stdout: "", stderr });
}

describe("previewFromGitUrl", () => {
  it("clones, validates, and returns a preview with the manifest and source", async () => {
    fakeClone(ECHO_MANIFEST);
    const preview = await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    expect(preview.manifest.id).toBe("echo");
    expect(preview.source).toEqual({
      type: "git",
      url: "https://github.com/example/echo.git",
    });
    expect(pluginInstaller.isValidStagingToken(preview.stagingToken)).toBe(true);
    expect(await listStaging()).toContain(preview.stagingToken);
  });

  it("rejects non-URL inputs without shelling out (TC-058 input guard)", async () => {
    await expect(pluginInstaller.previewFromGitUrl("   ")).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(pluginInstaller.previewFromGitUrl("/tmp/local")).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(exec.runCommand).not.toHaveBeenCalled();
  });

  it("rejects URLs that begin with '-' to prevent git option injection", async () => {
    // Without this guard a value like `--upload-pack=...` would be interpreted
    // as a git option and could trigger arbitrary command execution.
    await expect(pluginInstaller.previewFromGitUrl("--upload-pack=evil")).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(pluginInstaller.previewFromGitUrl("-fconfig=bad")).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(exec.runCommand).not.toHaveBeenCalled();
  });

  it("invokes git clone with '--' before the URL to terminate option parsing", async () => {
    fakeClone(ECHO_MANIFEST);
    await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    expect(exec.runCommand).toHaveBeenCalledTimes(1);
    const args = vi.mocked(exec.runCommand).mock.calls[0][1];
    const dashDashIdx = args.indexOf("--");
    const urlIdx = args.indexOf("https://github.com/example/echo.git");
    expect(dashDashIdx).toBeGreaterThanOrEqual(0);
    expect(urlIdx).toBeGreaterThan(dashDashIdx);
  });

  it("surfaces git failure with the exit code and stderr tail; leaves no staging dir (TC-058)", async () => {
    fakeCloneFailure(128, "remote: Repository not found.\nfatal: repository ... not found");
    await expect(
      pluginInstaller.previewFromGitUrl("https://github.com/missing/missing.git"),
    ).rejects.toMatchObject({
      code: "clone-failed",
      message: expect.stringMatching(/git exited with code 128.*Repository not found/),
    });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects incompatible-host manifests and cleans up staging", async () => {
    fakeClone(INCOMPATIBLE_MANIFEST);
    await expect(
      pluginInstaller.previewFromGitUrl("https://github.com/example/incompatible.git"),
    ).rejects.toMatchObject({ code: "incompatible-host" });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a duplicate plugin id and cleans up staging", async () => {
    fakeClone(ECHO_MANIFEST);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([mockRecord({ id: "echo" })]);
    await expect(
      pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git"),
    ).rejects.toMatchObject({ code: "duplicate-id" });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a clone whose result has no manifest", async () => {
    vi.mocked(exec.runCommand).mockImplementation(async (_cmd, args) => {
      const dest = args[args.length - 1] as string;
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, "README.md"), "no manifest here", "utf8");
      return { code: 0, stdout: "", stderr: "" };
    });
    await expect(
      pluginInstaller.previewFromGitUrl("https://github.com/example/empty.git"),
    ).rejects.toMatchObject({ code: "missing-manifest" });
    expect(await listStaging()).toEqual([]);
  });
});

describe("previewFromGitUrl with a source subdirectory (issue #750)", () => {
  // Pretend `git clone <url> <cloneDest>` succeeded by writing the manifest into
  // `<cloneDest>/<directory>`, the monorepo-subdir layout the installer extracts.
  function fakeCloneSubdir(manifest: string, directory: string) {
    vi.mocked(exec.runCommand).mockImplementation(async (_cmd, args) => {
      const dest = args[args.length - 1] as string;
      const pkg = path.join(dest, directory);
      await mkdir(pkg, { recursive: true });
      await writeFile(path.join(pkg, "roubo-plugin.yaml"), manifest, "utf8");
      return { code: 0, stdout: "", stderr: "" };
    });
  }

  it("clones the repo and stages only the given subdirectory", async () => {
    fakeCloneSubdir(ECHO_MANIFEST, "plugins/echo");
    const preview = await pluginInstaller.previewFromGitUrl(
      "https://github.com/example/monorepo.git",
      undefined,
      "plugins/echo",
    );
    expect(preview.manifest.id).toBe("echo");
    expect(preview.source).toEqual({
      type: "git",
      url: "https://github.com/example/monorepo.git",
      directory: "plugins/echo",
    });
    // The staged package is the subdirectory; the temp clone dir is removed.
    const staging = await listStaging();
    expect(staging).toContain(preview.stagingToken);
    expect(staging.some((n) => n.endsWith(".clone"))).toBe(false);
  });

  it("rejects when the subdirectory is absent from the clone (missing-manifest) and cleans up", async () => {
    fakeCloneSubdir(ECHO_MANIFEST, "plugins/elsewhere");
    await expect(
      pluginInstaller.previewFromGitUrl(
        "https://github.com/example/monorepo.git",
        undefined,
        "plugins/missing",
      ),
    ).rejects.toMatchObject({ code: "missing-manifest" });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a traversal subdirectory without cloning (invalid-input)", async () => {
    await expect(
      pluginInstaller.previewFromGitUrl(
        "https://github.com/example/monorepo.git",
        undefined,
        "../escape",
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(exec.runCommand).not.toHaveBeenCalled();
  });
});

describe("previewFromGitUrl integrity verification (issue #622)", () => {
  it("rejects a package whose digest does not match the expected catalog digest (CP-TC-107/108)", async () => {
    fakeClone(ECHO_MANIFEST);
    await expect(
      pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git", "sha256-wrong"),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    // No partial files: the staging directory is removed on the failure path.
    expect(await listStaging()).toEqual([]);
  });

  it("accepts a package whose digest matches the expected catalog digest", async () => {
    fakeClone(ECHO_MANIFEST);
    // Stage once with no expected digest to learn the staged digest, then
    // re-stage with that exact digest as the expectation.
    const probe = await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    const stagingDir = resolveWithin(pluginInstaller.__test.stagingRoot(), probe.stagingToken);
    const { computePackageDigest } = await import("./marketplace-integrity.js");
    const digest = await computePackageDigest(stagingDir);
    await pluginInstaller.cancel(probe.stagingToken);

    const preview = await pluginInstaller.previewFromGitUrl(
      "https://github.com/example/echo.git",
      digest,
    );
    expect(preview.manifest.id).toBe("echo");
    expect(await listStaging()).toContain(preview.stagingToken);
  });

  it("skips the integrity check when no expected digest is supplied (raw install path)", async () => {
    fakeClone(ECHO_MANIFEST);
    const preview = await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    expect(preview.manifest.id).toBe("echo");
  });
});

describe("previewUpdateFromGitUrl integrity verification (issue #622)", () => {
  it("rejects a tampered update package and leaves the existing version intact (CP-TC-112)", async () => {
    // The installed copy stays on disk: the update is rejected at the preview
    // stage, before commit ever runs, so the existing version is never touched.
    const target = path.join(pluginsRoot, "echo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "OLD"), "old", "utf8");

    fakeClone(ECHO_MANIFEST);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    await expect(
      pluginInstaller.previewUpdateFromGitUrl(
        "https://github.com/example/echo.git",
        "echo",
        "sha256-wrong",
      ),
    ).rejects.toMatchObject({ code: "integrity-failed" });

    // The existing copy and its sentinel survive; nothing is left in staging.
    expect((await stat(path.join(target, "OLD"))).isFile()).toBe(true);
    expect(await listStaging()).toEqual([]);
  });
});

describe("previewFromLocalPath", () => {
  let sourceDir: string;

  beforeEach(async () => {
    sourceDir = await mkdtemp(path.join(tmpdir(), "roubo-installer-src-"));
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("validates a local directory and copies it into staging (TC-019)", async () => {
    await writeFile(path.join(sourceDir, "roubo-plugin.yaml"), ECHO_MANIFEST, "utf8");
    await writeFile(path.join(sourceDir, "index.js"), "// noop", "utf8");

    const preview = await pluginInstaller.previewFromLocalPath(sourceDir);
    expect(preview.manifest.id).toBe("echo");
    expect(preview.source).toEqual({ type: "local", path: sourceDir });
    const stagingDir = resolveWithin(pluginInstaller.__test.stagingRoot(), preview.stagingToken);
    const copied = await stat(resolveWithin(stagingDir, "index.js"));
    expect(copied.isFile()).toBe(true);
  });

  it("rejects a directory without roubo-plugin.yaml (TC-059) and leaves staging empty", async () => {
    await writeFile(path.join(sourceDir, "README.md"), "no manifest", "utf8");
    await expect(pluginInstaller.previewFromLocalPath(sourceDir)).rejects.toMatchObject({
      code: "missing-manifest",
      message: expect.stringContaining(sourceDir),
    });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a relative path", async () => {
    await expect(pluginInstaller.previewFromLocalPath("./relative")).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("rejects a non-existent path", async () => {
    await expect(
      pluginInstaller.previewFromLocalPath(path.join(sourceDir, "missing")),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("normalizes the source path before performing filesystem operations", async () => {
    await writeFile(path.join(sourceDir, "roubo-plugin.yaml"), ECHO_MANIFEST, "utf8");
    // Pass a path containing `..` segments; the recorded source.path must be
    // the resolved/normalized form and the filesystem call must still succeed.
    const messy = path.join(sourceDir, "sub", "..");
    const preview = await pluginInstaller.previewFromLocalPath(messy);
    expect(preview.source).toEqual({ type: "local", path: path.resolve(messy) });
  });
});

describe("commit", () => {
  it("moves the staging dir into the user plugins root and registers the plugin", async () => {
    fakeClone(ECHO_MANIFEST);
    const preview = await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(
      mockRecord({ id: "echo", status: "enabled" }),
    );

    const record = await pluginInstaller.commit(preview.stagingToken);
    expect(record.id).toBe("echo");
    expect(record.status).toBe("enabled");
    const target = path.join(pluginsRoot, "echo");
    const s = await stat(target);
    expect(s.isDirectory()).toBe(true);
    expect(pluginManager.registerInstalled).toHaveBeenCalledWith(target);
    expect(pluginInstaller.__test.listTokens()).not.toContain(preview.stagingToken);
  });

  it("throws unknown-token for an unknown token", async () => {
    await expect(
      pluginInstaller.commit("00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "unknown-token" });
  });

  it("rejects duplicate-id at commit time if another install raced through", async () => {
    fakeClone(ECHO_MANIFEST);
    const preview = await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    vi.mocked(pluginManager.listInstalled).mockReturnValue([mockRecord({ id: "echo" })]);

    await expect(pluginInstaller.commit(preview.stagingToken)).rejects.toMatchObject({
      code: "duplicate-id",
    });
    expect(await listStaging()).not.toContain(preview.stagingToken);
  });
});

describe("previewUpdateFromGitUrl (issue #621)", () => {
  it("clones and stages an update for an installed plugin without a duplicate error", async () => {
    fakeClone(ECHO_MANIFEST);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    const preview = await pluginInstaller.previewUpdateFromGitUrl(
      "https://github.com/example/echo.git",
      "echo",
    );
    expect(preview.manifest.id).toBe("echo");
    expect(await listStaging()).toContain(preview.stagingToken);
  });

  it("rejects update-target-missing when the plugin is not installed", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    await expect(
      pluginInstaller.previewUpdateFromGitUrl("https://github.com/example/echo.git", "echo"),
    ).rejects.toMatchObject({ code: "update-target-missing" });
    expect(exec.runCommand).not.toHaveBeenCalled();
  });

  it("refuses to update a bundled plugin", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "bundled" }),
    ]);
    await expect(
      pluginInstaller.previewUpdateFromGitUrl("https://github.com/example/echo.git", "echo"),
    ).rejects.toMatchObject({ code: "update-target-missing" });
  });

  it("rejects a cloned manifest whose id differs from the catalog id", async () => {
    fakeClone(ECHO_MANIFEST);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "other", source: "user" }),
    ]);
    await expect(
      pluginInstaller.previewUpdateFromGitUrl("https://github.com/example/echo.git", "other"),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(await listStaging()).toEqual([]);
  });

  it("commit swaps in the staged copy via uninstallForUpdate, leaving no backup", async () => {
    // The installed copy must exist on disk: commit moves it aside as a backup
    // before swapping in the staged copy (no data loss).
    const target = path.join(pluginsRoot, "echo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "OLD"), "old", "utf8");

    fakeClone(ECHO_MANIFEST);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    const preview = await pluginInstaller.previewUpdateFromGitUrl(
      "https://github.com/example/echo.git",
      "echo",
    );
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(
      mockRecord({ id: "echo", status: "enabled" }),
    );

    const record = await pluginInstaller.commit(preview.stagingToken);
    // The update tears down via uninstallForUpdate (no active-integration guard,
    // no directory delete), never the plain uninstall.
    expect(pluginManager.uninstallForUpdate).toHaveBeenCalledWith("echo");
    expect(pluginManager.uninstall).not.toHaveBeenCalled();
    expect(record.id).toBe("echo");
    // The staged copy is now at the target (its manifest replaced the OLD copy).
    expect((await stat(path.join(target, "roubo-plugin.yaml"))).isFile()).toBe(true);
    // No backup or staging directory is left behind on success.
    expect(await listStaging()).toEqual([]);
  });

  it("restores the existing plugin if registering the staged copy fails (no data loss)", async () => {
    // A pre-existing installed copy with a sentinel file we can check survives.
    const target = path.join(pluginsRoot, "echo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "OLD"), "old", "utf8");

    fakeClone(ECHO_MANIFEST);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    const preview = await pluginInstaller.previewUpdateFromGitUrl(
      "https://github.com/example/echo.git",
      "echo",
    );
    // First registerInstalled (the new copy) fails; the second (the restore of
    // the backed-up old copy) succeeds.
    vi.mocked(pluginManager.registerInstalled)
      .mockRejectedValueOnce(new Error("register boom"))
      .mockResolvedValue(mockRecord({ id: "echo", status: "enabled" }));

    await expect(pluginInstaller.commit(preview.stagingToken)).rejects.toMatchObject({
      code: "internal",
    });

    // The previously-installed copy is restored at the target (the sentinel is
    // back), and nothing is left in staging.
    expect((await stat(path.join(target, "OLD"))).isFile()).toBe(true);
    expect(await listStaging()).toEqual([]);
  });
});

describe("cancel", () => {
  it("removes the staging directory and forgets the token", async () => {
    fakeClone(ECHO_MANIFEST);
    const preview = await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    expect(await listStaging()).toContain(preview.stagingToken);

    await pluginInstaller.cancel(preview.stagingToken);
    expect(await listStaging()).not.toContain(preview.stagingToken);
    expect(pluginInstaller.__test.listTokens()).not.toContain(preview.stagingToken);
  });

  it("is a no-op for an unknown token", async () => {
    await expect(
      pluginInstaller.cancel("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });
});

function mockRecord(overrides: Partial<PluginRecord>): PluginRecord {
  return {
    id: "echo",
    manifest: null,
    manifestPath: "/p/echo/roubo-plugin.yaml",
    pluginDir: "/p/echo",
    source: "user",
    status: "disabled",
    lastError: null,
    restartHistory: [],
    pid: null,
    ...overrides,
  };
}
