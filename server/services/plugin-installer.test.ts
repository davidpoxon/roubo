import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { PluginRecord } from "@roubo/shared";
import { FIRST_PARTY_URL } from "./marketplace-sources-state.js";

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

vi.mock("undici", () => ({
  fetch: vi.fn(),
  // guarded-fetch builds a connect-pinning Agent (issue #590); the mocked fetch
  // ignores the dispatcher, so a constructable stub is all this mock needs.
  Agent: vi.fn(),
}));

// Issue #558: the ledger is real-filesystem state under ~/.roubo. Mock it so the
// commit paths can be asserted without writing the developer's own state dir.
vi.mock("./plugin-provenance-state.js", () => ({
  recordProvenance: vi.fn(),
  removeProvenance: vi.fn(),
  getProvenance: vi.fn(() => null),
}));

import * as pluginInstaller from "./plugin-installer.js";
import * as exec from "./exec.js";
import * as pluginManager from "./plugin-manager.js";
import * as pluginProvenanceState from "./plugin-provenance-state.js";
import { fetch } from "undici";
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
// Temp directories created by the tarball fixtures, cleaned up after each test.
const tmpDirs: string[] = [];

async function trackTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  pluginInstaller.__test.reset();
  pluginsRoot = await mkdtemp(path.join(tmpdir(), "roubo-installer-test-"));
  vi.mocked(pluginManager.getUserPluginsRoot).mockReturnValue(pluginsRoot);
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(exec.runCommand).mockReset();
  vi.mocked(fetch).mockReset();
  vi.mocked(pluginManager.registerInstalled).mockReset();
  vi.mocked(pluginManager.uninstall).mockReset();
  vi.mocked(pluginManager.uninstall).mockResolvedValue(undefined);
  vi.mocked(pluginManager.uninstallForUpdate).mockReset();
  vi.mocked(pluginManager.uninstallForUpdate).mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(pluginsRoot, { recursive: true, force: true });
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
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

// Issue #558 AC4 / CPHMTP-TC-042: an explicit pick-a-source install records the
// chosen source. A PluginRecord is rebuilt from disk on every load, so the ledger
// is the only thing carrying the choice forward: these assert the wiring from the
// commit paths into it, which the service-level tests (which mock this module
// wholesale) cannot see.
describe("commit records the marketplace provenance (issue #558, AC4)", () => {
  const PROVENANCE = {
    sourceId: "marketplace-acme-example-1a2b3c4d",
    sourceUrl: "https://marketplace.acme.example/catalog.json",
    unverified: true,
  };

  beforeEach(() => {
    // Reset call history and re-arm the default, as the suite does for its other
    // module mocks: the factory's implementation does not survive between tests.
    vi.mocked(pluginProvenanceState.recordProvenance).mockReset();
    vi.mocked(pluginProvenanceState.removeProvenance).mockReset();
    vi.mocked(pluginProvenanceState.getProvenance).mockReset();
    vi.mocked(pluginProvenanceState.getProvenance).mockReturnValue(null);
  });

  /** Stage a marketplace-sourced install of `echo` carrying `PROVENANCE`. */
  async function stageMarketplaceInstall(): Promise<string> {
    fakeClone(ECHO_MANIFEST);
    const preview = await pluginInstaller.previewFromGitUrl(
      "https://github.com/example/echo.git",
      undefined,
      undefined,
      undefined,
      PROVENANCE,
    );
    return preview.stagingToken;
  }

  it("writes the chosen source to the ledger before registering", async () => {
    const token = await stageMarketplaceInstall();
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(
      mockRecord({ id: "echo", status: "enabled" }),
    );

    await pluginInstaller.commit(token);

    expect(pluginProvenanceState.recordProvenance).toHaveBeenCalledWith({
      pluginId: "echo",
      ...PROVENANCE,
    });
    // registerInstalled rebuilds the record by READING the ledger, so the write
    // must land first or this install's record stays unstamped until a reload.
    expect(
      vi.mocked(pluginProvenanceState.recordProvenance).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(pluginManager.registerInstalled).mock.invocationCallOrder[0]);
  });

  it("stamps a fail-closed row keyed on the git URL for the raw git path (#607)", async () => {
    fakeClone(ECHO_MANIFEST);
    const gitUrl = "https://github.com/example/echo.git";
    const preview = await pluginInstaller.previewFromGitUrl(gitUrl);
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(
      mockRecord({ id: "echo", status: "enabled" }),
    );

    await pluginInstaller.commit(preview.stagingToken);

    // No marketplace source, so the raw path records its own unverified row keyed
    // on the git URL rather than leaving the ledger empty. Stamping every install
    // path is what lets the client fail closed on absent provenance instead of
    // reading it as first-party (davidpoxon/roubo-development#607).
    expect(pluginProvenanceState.recordProvenance).toHaveBeenCalledWith({
      pluginId: "echo",
      sourceId: gitUrl,
      sourceUrl: gitUrl,
      unverified: true,
    });
    expect(pluginProvenanceState.removeProvenance).not.toHaveBeenCalled();
  });

  it("stamps a fail-closed row keyed on the local path for the local install path (#607)", async () => {
    const sourceDir = await trackTmp("roubo-installer-localprov-");
    await writeFile(path.join(sourceDir, "roubo-plugin.yaml"), ECHO_MANIFEST, "utf8");
    const preview = await pluginInstaller.previewFromLocalPath(sourceDir);
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(
      mockRecord({ id: "echo", status: "enabled" }),
    );

    await pluginInstaller.commit(preview.stagingToken);

    expect(pluginProvenanceState.recordProvenance).toHaveBeenCalledWith({
      pluginId: "echo",
      sourceId: sourceDir,
      sourceUrl: sourceDir,
      unverified: true,
    });
    expect(pluginProvenanceState.removeProvenance).not.toHaveBeenCalled();
  });

  it("drops the row again when registering the install fails", async () => {
    const token = await stageMarketplaceInstall();
    vi.mocked(pluginManager.registerInstalled).mockRejectedValue(new Error("register boom"));

    await expect(pluginInstaller.commit(token)).rejects.toMatchObject({ code: "internal" });

    // A rolled-back install must leave no row claiming a plugin that is not there.
    expect(pluginProvenanceState.removeProvenance).toHaveBeenCalledWith("echo");
  });

  it("restores the pre-update row when an update fails to register", async () => {
    const target = path.join(pluginsRoot, "echo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "OLD"), "old", "utf8");

    const previous = {
      pluginId: "echo",
      sourceId: "first-party",
      sourceUrl: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
      unverified: false,
      installedAt: "2026-07-01T00:00:00.000Z",
    };
    vi.mocked(pluginProvenanceState.getProvenance).mockReturnValue(previous);

    fakeClone(ECHO_MANIFEST);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    const preview = await pluginInstaller.previewUpdateFromGitUrl(
      "https://github.com/example/echo.git",
      "echo",
      undefined,
      undefined,
      undefined,
      PROVENANCE,
    );
    // The new copy fails to register; restoring the backed-up old copy succeeds.
    vi.mocked(pluginManager.registerInstalled)
      .mockRejectedValueOnce(new Error("register boom"))
      .mockResolvedValue(mockRecord({ id: "echo", status: "enabled" }));

    await expect(pluginInstaller.commit(preview.stagingToken)).rejects.toMatchObject({
      code: "internal",
    });

    // The old copy is back on disk, so the ledger must describe it again rather
    // than the update that was rolled back.
    expect(pluginProvenanceState.recordProvenance).toHaveBeenLastCalledWith({
      pluginId: "echo",
      sourceId: previous.sourceId,
      sourceUrl: previous.sourceUrl,
      unverified: previous.unverified,
    });
    // And it must land BEFORE the restore re-registers the old copy: that
    // registerInstalled stamps its record from the ledger, so restoring the row
    // afterwards would leave the first-party copy reported as the discarded
    // update's unverified third-party source until the next reload.
    const ledgerWrites = vi.mocked(pluginProvenanceState.recordProvenance).mock.invocationCallOrder;
    const registrations = vi.mocked(pluginManager.registerInstalled).mock.invocationCallOrder;
    expect(ledgerWrites[ledgerWrites.length - 1]).toBeLessThan(
      registrations[registrations.length - 1],
    );
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

// --- Built-artifact (Release asset) install path (issue #370) ----------------

const ASSET_URL = "https://example.com/echo.tgz";

type FetchResult = Awaited<ReturnType<typeof fetch>>;

// Build a real gzipped tarball on disk from a flat list of files, returning its
// path. Each file's `path` is its location inside the archive.
async function makeTarball(files: { path: string; content: string }[]): Promise<string> {
  const src = await trackTmp("roubo-asset-src-");
  const entries: string[] = [];
  for (const f of files) {
    const abs = path.join(src, f.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf8");
    if (!entries.includes(f.path)) entries.push(f.path);
  }
  const out = await trackTmp("roubo-asset-tgz-");
  const tgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: tgz, cwd: src }, entries);
  return tgz;
}

// A tarball with a path-traversing (`../`) entry, the zip-slip vector. preservePaths
// is required: tar.c strips `..` entries by default.
async function makeZipSlipTarball(): Promise<string> {
  const wrap = await trackTmp("roubo-zipslip-");
  const pkg = path.join(wrap, "pkg");
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(wrap, "evil.txt"), "owned", "utf8");
  await writeFile(path.join(pkg, "roubo-plugin.yaml"), ECHO_MANIFEST, "utf8");
  const out = await trackTmp("roubo-asset-tgz-");
  const tgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: tgz, cwd: pkg, preservePaths: true }, [
    "../evil.txt",
    "roubo-plugin.yaml",
  ]);
  return tgz;
}

// A tarball carrying a symlink entry (an unsupported entry type).
async function makeSymlinkTarball(): Promise<string> {
  const src = await trackTmp("roubo-symlink-");
  await writeFile(path.join(src, "roubo-plugin.yaml"), ECHO_MANIFEST, "utf8");
  await symlink("/etc/passwd", path.join(src, "link"));
  const out = await trackTmp("roubo-asset-tgz-");
  const tgz = path.join(out, "asset.tgz");
  await tar.c({ gzip: true, file: tgz, cwd: src }, ["roubo-plugin.yaml", "link"]);
  return tgz;
}

// Mock undici.fetch to stream the given tarball; a fresh read stream per call so
// the body can be consumed more than once across re-staging.
function fakeDownload(tgzPath: string) {
  vi.mocked(fetch).mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: createReadStream(tgzPath),
      }) as unknown as FetchResult,
  );
}

function fakeDownloadStatus(status: number) {
  vi.mocked(fetch).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: null,
  } as unknown as FetchResult);
}

describe("previewFromRelease (issue #370)", () => {
  it("downloads, unpacks, and stages a built artifact with a runnable dist/index.js (no build step)", async () => {
    fakeDownload(
      await makeTarball([
        { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
        { path: "dist/index.js", content: "module.exports = {};\n" },
      ]),
    );
    const preview = await pluginInstaller.previewFromRelease(ASSET_URL);
    expect(preview.manifest.id).toBe("echo");
    expect(preview.source).toEqual({ type: "release", assetUrl: ASSET_URL });
    expect(pluginInstaller.isValidStagingToken(preview.stagingToken)).toBe(true);

    const staging = await listStaging();
    expect(staging).toContain(preview.stagingToken);
    // The temp tarball is removed once unpacked; only the staged dir remains.
    expect(staging.some((n) => n.endsWith(".tgz"))).toBe(false);
    const stagingDir = resolveWithin(pluginInstaller.__test.stagingRoot(), preview.stagingToken);
    expect((await stat(resolveWithin(stagingDir, "dist/index.js"))).isFile()).toBe(true);
  });

  it("commit moves the unpacked artifact into the plugins dir atomically (runnable dist present)", async () => {
    fakeDownload(
      await makeTarball([
        { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
        { path: "dist/index.js", content: "module.exports = {};\n" },
      ]),
    );
    const preview = await pluginInstaller.previewFromRelease(ASSET_URL);
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(
      mockRecord({ id: "echo", status: "enabled" }),
    );

    const record = await pluginInstaller.commit(preview.stagingToken);
    expect(record.id).toBe("echo");
    const target = path.join(pluginsRoot, "echo");
    expect((await stat(resolveWithin(target, "dist/index.js"))).isFile()).toBe(true);
    expect(await listStaging()).not.toContain(preview.stagingToken);
  });

  it("rejects a tampered artifact (integrity-failed) and removes staging (nothing written)", async () => {
    fakeDownload(await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]));
    await expect(
      pluginInstaller.previewFromRelease(ASSET_URL, "sha256-wrong"),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await listStaging()).toEqual([]);
  });

  it("accepts an artifact whose digest matches the expected catalog digest", async () => {
    const tgz = await makeTarball([
      { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
      { path: "dist/index.js", content: "module.exports = {};\n" },
    ]);
    // Stage once with no expected digest to learn the unpacked digest, then
    // re-stage with that exact digest as the expectation.
    fakeDownload(tgz);
    const probe = await pluginInstaller.previewFromRelease(ASSET_URL);
    const stagingDir = resolveWithin(pluginInstaller.__test.stagingRoot(), probe.stagingToken);
    const { computePackageDigest } = await import("./marketplace-integrity.js");
    const digest = await computePackageDigest(stagingDir);
    await pluginInstaller.cancel(probe.stagingToken);

    fakeDownload(tgz);
    const preview = await pluginInstaller.previewFromRelease(ASSET_URL, digest);
    expect(preview.manifest.id).toBe("echo");
    expect(await listStaging()).toContain(preview.stagingToken);
  });

  it("rejects a zip-slip / path-escaping entry (unpack-failed); nothing is written outside staging", async () => {
    fakeDownload(await makeZipSlipTarball());
    await expect(pluginInstaller.previewFromRelease(ASSET_URL)).rejects.toMatchObject({
      code: "unpack-failed",
    });
    // The escape target would land in the staging root's parent had extraction
    // run; the validation pass rejects before any write, so staging is empty.
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a symlink entry (unsupported entry type) fail-closed", async () => {
    fakeDownload(await makeSymlinkTarball());
    await expect(pluginInstaller.previewFromRelease(ASSET_URL)).rejects.toMatchObject({
      code: "unpack-failed",
    });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects an over-entry-count tarball fail-closed", async () => {
    pluginInstaller.__test.setLimits({ maxTarballEntries: 2 });
    fakeDownload(
      await makeTarball([
        { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
        { path: "a.txt", content: "a" },
        { path: "b.txt", content: "b" },
      ]),
    );
    await expect(pluginInstaller.previewFromRelease(ASSET_URL)).rejects.toMatchObject({
      code: "unpack-failed",
    });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects an over-size (unpacked bytes) tarball fail-closed", async () => {
    pluginInstaller.__test.setLimits({ maxUnpackedBytes: 10 });
    fakeDownload(await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]));
    await expect(pluginInstaller.previewFromRelease(ASSET_URL)).rejects.toMatchObject({
      code: "unpack-failed",
    });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a download whose body exceeds the download limit (streaming guard)", async () => {
    pluginInstaller.__test.setLimits({ maxDownloadBytes: 10 });
    fakeDownload(await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]));
    await expect(pluginInstaller.previewFromRelease(ASSET_URL)).rejects.toMatchObject({
      code: "download-failed",
    });
    expect(await listStaging()).toEqual([]);
  });

  it("maps a non-200 download to download-failed and leaves no staging dir", async () => {
    fakeDownloadStatus(404);
    await expect(pluginInstaller.previewFromRelease(ASSET_URL)).rejects.toMatchObject({
      code: "download-failed",
    });
    expect(fetch).toHaveBeenCalled();
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a non-http(s) or empty asset URL without fetching", async () => {
    await expect(
      pluginInstaller.previewFromRelease("ftp://example.com/x.tgz"),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(pluginInstaller.previewFromRelease("   ")).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an artifact with no manifest (missing-manifest) and cleans up staging", async () => {
    fakeDownload(await makeTarball([{ path: "README.md", content: "no manifest" }]));
    await expect(pluginInstaller.previewFromRelease(ASSET_URL)).rejects.toMatchObject({
      code: "missing-manifest",
    });
    expect(await listStaging()).toEqual([]);
  });
});

describe("previewUpdateFromRelease (issue #370)", () => {
  it("downloads, unpacks, and stages an update for an installed plugin without a duplicate error", async () => {
    fakeDownload(
      await makeTarball([
        { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
        { path: "dist/index.js", content: "module.exports = {};\n" },
      ]),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    const preview = await pluginInstaller.previewUpdateFromRelease(ASSET_URL, "echo");
    expect(preview.manifest.id).toBe("echo");
    expect(preview.source).toEqual({ type: "release", assetUrl: ASSET_URL });
    expect(await listStaging()).toContain(preview.stagingToken);
  });

  it("commit swaps in the staged release copy via uninstallForUpdate, leaving no backup", async () => {
    // The installed copy must exist on disk: commit moves it aside as a backup
    // before swapping in the staged copy (no data loss).
    const target = path.join(pluginsRoot, "echo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "OLD"), "old", "utf8");

    fakeDownload(
      await makeTarball([
        { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
        { path: "dist/index.js", content: "module.exports = {};\n" },
      ]),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    const preview = await pluginInstaller.previewUpdateFromRelease(ASSET_URL, "echo");
    vi.mocked(pluginManager.registerInstalled).mockResolvedValue(
      mockRecord({ id: "echo", status: "enabled" }),
    );

    const record = await pluginInstaller.commit(preview.stagingToken);
    // The update tears down via uninstallForUpdate (no active-integration guard,
    // no directory delete), never the plain uninstall.
    expect(pluginManager.uninstallForUpdate).toHaveBeenCalledWith("echo");
    expect(pluginManager.uninstall).not.toHaveBeenCalled();
    expect(record.id).toBe("echo");
    // The staged built artifact is now at the target (its dist replaced OLD).
    expect((await stat(path.join(target, "dist", "index.js"))).isFile()).toBe(true);
    expect(await listStaging()).toEqual([]);
  });

  it("rejects update-target-missing when the plugin is not installed, without fetching", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    await expect(pluginInstaller.previewUpdateFromRelease(ASSET_URL, "echo")).rejects.toMatchObject(
      { code: "update-target-missing" },
    );
    // The installed-plugin guard runs before any download.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to update a bundled plugin, without fetching", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "bundled" }),
    ]);
    await expect(pluginInstaller.previewUpdateFromRelease(ASSET_URL, "echo")).rejects.toMatchObject(
      { code: "update-target-missing" },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unpacked manifest whose id differs from the catalog id", async () => {
    fakeDownload(await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "other", source: "user" }),
    ]);
    await expect(
      pluginInstaller.previewUpdateFromRelease(ASSET_URL, "other"),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a tampered update artifact and leaves the existing version intact (integrity-failed)", async () => {
    // The installed copy stays on disk: the update is rejected at the preview
    // stage, before commit ever runs, so the existing version is never touched.
    const target = path.join(pluginsRoot, "echo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "OLD"), "old", "utf8");

    fakeDownload(await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      mockRecord({ id: "echo", source: "user" }),
    ]);
    await expect(
      pluginInstaller.previewUpdateFromRelease(ASSET_URL, "echo", "sha256-wrong"),
    ).rejects.toMatchObject({ code: "integrity-failed" });

    // The existing copy and its sentinel survive; nothing is left in staging.
    expect((await stat(path.join(target, "OLD"))).isFile()).toBe(true);
    expect(await listStaging()).toEqual([]);
  });
});

// Compute the digest installSeedArtifact will verify against: unpack the
// tarball exactly as the installer does and digest the unpacked tree.
async function digestOfTarball(tgz: string): Promise<string> {
  const out = await trackTmp("roubo-seed-digest-");
  await tar.x({ file: tgz, cwd: out });
  const { computePackageDigest } = await import("./marketplace-integrity.js");
  return computePackageDigest(out);
}

describe("installSeedArtifact (first-run seed, davidpoxon/roubo-development#310)", () => {
  beforeEach(() => {
    // The provenance ledger mock is a module-mock `vi.fn`; `restoreMocks` does not
    // clear those, so reset call history here (as the commit-records suite does)
    // before asserting the seed stamp is / is not recorded (#607).
    vi.mocked(pluginProvenanceState.recordProvenance).mockReset();
  });

  it("verifies the digest and places the built artifact in the user root (no register/spawn)", async () => {
    const tgz = await makeTarball([
      { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
      { path: "dist/index.js", content: "module.exports = {};\n" },
    ]);
    const digest = await digestOfTarball(tgz);

    const result = await pluginInstaller.installSeedArtifact(tgz, "echo", digest);
    expect(result).toEqual({ installed: true });

    const target = path.join(pluginsRoot, "echo");
    expect((await stat(path.join(target, "roubo-plugin.yaml"))).isFile()).toBe(true);
    expect((await stat(path.join(target, "dist", "index.js"))).isFile()).toBe(true);
    // The seed path never registers/spawns; the user-root discovery pass owns that.
    expect(pluginManager.registerInstalled).not.toHaveBeenCalled();
    // A genuine seed install stamps a first-party ledger row so the client grades
    // the seed by its row, not its id, and absent provenance fails closed (#607).
    expect(pluginProvenanceState.recordProvenance).toHaveBeenCalledWith({
      pluginId: "echo",
      sourceId: FIRST_PARTY_SOURCE_ID,
      sourceUrl: FIRST_PARTY_URL,
      unverified: false,
    });
    expect(await listStaging()).toEqual([]);
  });

  it("is offline: it performs no network fetch", async () => {
    const tgz = await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]);
    const digest = await digestOfTarball(tgz);
    await pluginInstaller.installSeedArtifact(tgz, "echo", digest);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on a digest mismatch and writes nothing (CPHM-NFR-001)", async () => {
    const tgz = await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]);
    await expect(
      pluginInstaller.installSeedArtifact(tgz, "echo", "sha256-wrong"),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    await expect(stat(path.join(pluginsRoot, "echo"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listStaging()).toEqual([]);
  });

  it("fails closed when a null/empty digest is supplied (seed always requires one)", async () => {
    const tgz = await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]);
    await expect(pluginInstaller.installSeedArtifact(tgz, "echo", "")).rejects.toMatchObject({
      code: "integrity-failed",
    });
    expect(await listStaging()).toEqual([]);
  });

  it("fails closed when the manifest id does not match the seed catalog id", async () => {
    const tgz = await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]);
    const digest = await digestOfTarball(tgz);
    await expect(
      pluginInstaller.installSeedArtifact(tgz, "github-com", digest),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(stat(path.join(pluginsRoot, "github-com"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await listStaging()).toEqual([]);
  });

  it("no-clobber: leaves an already-installed plugin untouched and reports installed:false", async () => {
    const target = path.join(pluginsRoot, "echo");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "UPDATED"), "marketplace", "utf8");

    const tgz = await makeTarball([{ path: "roubo-plugin.yaml", content: ECHO_MANIFEST }]);
    const digest = await digestOfTarball(tgz);
    const result = await pluginInstaller.installSeedArtifact(tgz, "echo", digest);

    expect(result).toEqual({ installed: false });
    // The existing (e.g. marketplace-updated) copy and its sentinel survive.
    expect((await stat(path.join(target, "UPDATED"))).isFile()).toBe(true);
    // The no-clobber early return stamps nothing: it must not overwrite the
    // existing plugin's row with a first-party one, which would re-grade a
    // possibly-third-party install that took a seed id as verified (#607).
    expect(pluginProvenanceState.recordProvenance).not.toHaveBeenCalled();
    expect(await listStaging()).toEqual([]);
  });

  it("rejects an incompatible seed artifact (host-API mismatch) fail-closed", async () => {
    const tgz = await makeTarball([{ path: "roubo-plugin.yaml", content: INCOMPATIBLE_MANIFEST }]);
    const digest = await digestOfTarball(tgz);
    await expect(
      pluginInstaller.installSeedArtifact(tgz, "incompatible", digest),
    ).rejects.toMatchObject({ code: "incompatible-host" });
    expect(await listStaging()).toEqual([]);
  });

  it("rejects a missing seed artifact path (invalid-input)", async () => {
    await expect(
      pluginInstaller.installSeedArtifact(
        path.join(pluginsRoot, "does-not-exist.tgz"),
        "echo",
        "sha256-x",
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});

// --- Mandatory digest + guarded artifact download for third-party (unsigned)
// --- installs (CPHMTP-NFR-004 / CPHMTP-US-005, issue #559) -------------------

const TP_ORIGIN = "https://example.com";
const THIRD_PARTY: pluginInstaller.ThirdPartyInstallContext = { sourceOrigin: TP_ORIGIN };

// Every value that must count as "no usable digest": absent, empty, and the
// malformed shapes. A malformed value must NOT reach a digest comparison (which
// would report it as a tampered artifact); it means the entry is unverifiable.
const UNUSABLE_DIGESTS: { label: string; value: string | null | undefined }[] = [
  { label: "undefined (absent)", value: undefined },
  { label: "null", value: null },
  { label: "empty string", value: "" },
  { label: "whitespace only", value: "   " },
  { label: "no sha256- prefix", value: "a".repeat(64) },
  { label: "wrong algorithm", value: `sha512-${"a".repeat(64)}` },
  { label: "hex too short", value: `sha256-${"a".repeat(63)}` },
  { label: "hex too long", value: `sha256-${"a".repeat(65)}` },
  { label: "uppercase hex", value: `sha256-${"A".repeat(64)}` },
  { label: "non-hex characters", value: `sha256-${"z".repeat(64)}` },
];

// Well-formed but matching no real artifact: exercises the MISMATCH path
// (integrity-failed), which is a different failure from an unusable digest.
const WELL_FORMED_WRONG_DIGEST = `sha256-${"0".repeat(64)}`;

async function echoTarball(): Promise<string> {
  return makeTarball([
    { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
    { path: "dist/index.js", content: "module.exports = {};\n" },
  ]);
}

// Stage once with no expected digest to learn the unpacked artifact's real
// digest, then discard the staging so the caller can re-stage against it.
async function digestOf(tgz: string): Promise<string> {
  fakeDownload(tgz);
  const probe = await pluginInstaller.previewFromRelease(ASSET_URL);
  const stagingDir = resolveWithin(pluginInstaller.__test.stagingRoot(), probe.stagingToken);
  const { computePackageDigest } = await import("./marketplace-integrity.js");
  const digest = await computePackageDigest(stagingDir);
  await pluginInstaller.cancel(probe.stagingToken);
  vi.mocked(fetch).mockReset();
  return digest;
}

/** The init object guardedFetch passed to the injected transport for hop 0. */
function firstFetchInit(): { headers?: Record<string, string> } {
  const call = vi.mocked(fetch).mock.calls[0];
  return (call?.[1] ?? {}) as { headers?: Record<string, string> };
}

describe("third-party install requires a per-artifact digest (issue #559)", () => {
  it.each(UNUSABLE_DIGESTS)(
    "previewFromRelease rejects $label as missing-integrity before any artifact is fetched",
    async ({ value }) => {
      // The download is armed and must nonetheless never be reached.
      fakeDownload(await echoTarball());
      await expect(
        pluginInstaller.previewFromRelease(ASSET_URL, value, THIRD_PARTY),
      ).rejects.toMatchObject({ code: "missing-integrity" });
      expect(fetch).not.toHaveBeenCalled();
      expect(await listStaging()).toEqual([]);
    },
  );

  it.each(UNUSABLE_DIGESTS)(
    "previewUpdateFromRelease rejects $label as missing-integrity before any artifact is fetched",
    async ({ value }) => {
      vi.mocked(pluginManager.listInstalled).mockReturnValue([mockRecord({ id: "echo" })]);
      fakeDownload(await echoTarball());
      await expect(
        pluginInstaller.previewUpdateFromRelease(ASSET_URL, "echo", value, THIRD_PARTY),
      ).rejects.toMatchObject({ code: "missing-integrity" });
      expect(fetch).not.toHaveBeenCalled();
      expect(await listStaging()).toEqual([]);
    },
  );

  it.each(UNUSABLE_DIGESTS)(
    "previewFromGitUrl rejects $label as missing-integrity before the repository is cloned",
    async ({ value }) => {
      fakeClone(ECHO_MANIFEST);
      await expect(
        pluginInstaller.previewFromGitUrl(
          "https://github.com/example/echo.git",
          value,
          undefined,
          THIRD_PARTY,
        ),
      ).rejects.toMatchObject({ code: "missing-integrity" });
      expect(exec.runCommand).not.toHaveBeenCalled();
      expect(await listStaging()).toEqual([]);
    },
  );

  it.each(UNUSABLE_DIGESTS)(
    "previewUpdateFromGitUrl rejects $label as missing-integrity before the repository is cloned",
    async ({ value }) => {
      vi.mocked(pluginManager.listInstalled).mockReturnValue([mockRecord({ id: "echo" })]);
      fakeClone(ECHO_MANIFEST);
      await expect(
        pluginInstaller.previewUpdateFromGitUrl(
          "https://github.com/example/echo.git",
          "echo",
          value,
          undefined,
          THIRD_PARTY,
        ),
      ).rejects.toMatchObject({ code: "missing-integrity" });
      expect(exec.runCommand).not.toHaveBeenCalled();
      expect(await listStaging()).toEqual([]);
    },
  );

  it("accepts a third-party artifact whose recomputed digest matches", async () => {
    const tgz = await echoTarball();
    const digest = await digestOf(tgz);

    fakeDownload(tgz);
    const preview = await pluginInstaller.previewFromRelease(ASSET_URL, digest, THIRD_PARTY);
    expect(preview.manifest.id).toBe("echo");
    expect(await listStaging()).toContain(preview.stagingToken);
  });
});

describe("third-party install recomputes the digest over the fetched artifact (issue #559)", () => {
  it("rejects a mismatch fail-closed: no plugin record, no files written", async () => {
    fakeDownload(await echoTarball());
    await expect(
      pluginInstaller.previewFromRelease(ASSET_URL, WELL_FORMED_WRONG_DIGEST, THIRD_PARTY),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    // Unlike the missing-digest path, the artifact WAS fetched: the rejection
    // comes from recomputing sha256 over what arrived, not from the pre-fetch guard.
    expect(fetch).toHaveBeenCalled();
    expect(await listStaging()).toEqual([]);
    expect(pluginManager.registerInstalled).not.toHaveBeenCalled();
    await expect(stat(path.join(pluginsRoot, "echo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a tampered artifact whose content changed after the digest was published", async () => {
    const digest = await digestOf(await echoTarball());
    // Same manifest, different dist payload: the published digest no longer holds.
    fakeDownload(
      await makeTarball([
        { path: "roubo-plugin.yaml", content: ECHO_MANIFEST },
        { path: "dist/index.js", content: "module.exports = { owned: true };\n" },
      ]),
    );
    await expect(
      pluginInstaller.previewFromRelease(ASSET_URL, digest, THIRD_PARTY),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await listStaging()).toEqual([]);
    expect(pluginManager.registerInstalled).not.toHaveBeenCalled();
  });

  it("rejects a mismatch on the third-party git path fail-closed", async () => {
    fakeClone(ECHO_MANIFEST);
    await expect(
      pluginInstaller.previewFromGitUrl(
        "https://github.com/example/echo.git",
        WELL_FORMED_WRONG_DIGEST,
        undefined,
        THIRD_PARTY,
      ),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await listStaging()).toEqual([]);
    expect(pluginManager.registerInstalled).not.toHaveBeenCalled();
  });
});

describe("third-party artifact download is guarded and origin-scoped (issue #559)", () => {
  it("attaches the registered source's credential on the source origin", async () => {
    const tgz = await echoTarball();
    const digest = await digestOf(tgz);

    fakeDownload(tgz);
    await pluginInstaller.previewFromRelease(ASSET_URL, digest, {
      sourceOrigin: TP_ORIGIN,
      credential: "tp-token",
    });
    expect(firstFetchInit().headers?.authorization).toBe("Bearer tp-token");
  });

  it("sends no Authorization on the first-party path (no third-party context)", async () => {
    const tgz = await echoTarball();
    const digest = await digestOf(tgz);

    fakeDownload(tgz);
    await pluginInstaller.previewFromRelease(ASSET_URL, digest);
    expect(firstFetchInit().headers?.authorization).toBeUndefined();
  });

  it("blocks an artifact hosted off the registered source origin, before the transport", async () => {
    const digest = await digestOf(await echoTarball());
    fakeDownload(await echoTarball());
    // The guard consents to exactly one hop-0 origin: the registered source's.
    // An asset URL on any other origin is refused (a cross-origin CDN must be
    // reached by a redirect FROM the source origin, which the guard re-validates).
    await expect(
      pluginInstaller.previewFromRelease("https://cdn.other.example/echo.tgz", digest, {
        sourceOrigin: TP_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "download-failed" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await listStaging()).toEqual([]);
  });

  it("refuses a plain-http source that did not opt in to http at registration", async () => {
    const digest = await digestOf(await echoTarball());
    fakeDownload(await echoTarball());
    await expect(
      pluginInstaller.previewFromRelease("http://example.com/echo.tgz", digest, {
        sourceOrigin: "http://example.com",
      }),
    ).rejects.toMatchObject({ code: "download-failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("permits plain http when the source consented to it at registration", async () => {
    const tgz = await echoTarball();
    const digest = await digestOf(tgz);
    fakeDownload(tgz);
    const preview = await pluginInstaller.previewFromRelease(
      "http://example.com/echo.tgz",
      digest,
      {
        sourceOrigin: "http://example.com",
        allowHttp: true,
      },
    );
    expect(preview.manifest.id).toBe("echo");
    expect(fetch).toHaveBeenCalled();
  });
});

describe("first-party install behaviour is unchanged (CPHMTP-NFR-001, issue #559)", () => {
  it("still installs with NO digest when no third-party context is passed", async () => {
    fakeDownload(await echoTarball());
    const preview = await pluginInstaller.previewFromRelease(ASSET_URL);
    expect(preview.manifest.id).toBe("echo");
    expect(fetch).toHaveBeenCalled();
  });

  it("still treats an empty first-party digest as integrity-failed, not missing-integrity", async () => {
    // The mandatory-digest rule is scoped to third-party installs: the raw
    // git/local paths keep their existing null-skip, and an empty catalog digest
    // keeps failing the comparison exactly as before.
    fakeDownload(await echoTarball());
    await expect(pluginInstaller.previewFromRelease(ASSET_URL, "")).rejects.toMatchObject({
      code: "integrity-failed",
    });
  });

  it("still installs a raw git URL with no digest (non-catalog path keeps the null-skip)", async () => {
    fakeClone(ECHO_MANIFEST);
    const preview = await pluginInstaller.previewFromGitUrl("https://github.com/example/echo.git");
    expect(preview.manifest.id).toBe("echo");
    expect(exec.runCommand).toHaveBeenCalled();
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
