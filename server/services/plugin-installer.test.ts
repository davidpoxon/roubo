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
}));

import * as pluginInstaller from "./plugin-installer.js";
import * as exec from "./exec.js";
import * as pluginManager from "./plugin-manager.js";

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
});

afterEach(async () => {
  await rm(pluginsRoot, { recursive: true, force: true });
});

async function listStaging(): Promise<string[]> {
  const stagingDir = pluginInstaller.__test.stagingRoot();
  try {
    return await readdir(stagingDir);
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
    const stagingDir = path.join(pluginInstaller.__test.stagingRoot(), preview.stagingToken);
    const copied = await stat(path.join(stagingDir, "index.js"));
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
