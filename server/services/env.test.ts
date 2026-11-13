import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

vi.mock("node:fs");
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

/**
 * Points the automocked fs at a synthetic tree for the executability gate (#1060).
 * `files` are regular files, `dirs` are directories, and `executable` names the
 * subset carrying the execute bit (defaulting to every file). Anything unnamed
 * does not exist. Resolution tests drive statSync/accessSync through this rather
 * than existsSync, because that is what the resolvers now probe with.
 */
function mockFs(tree: { files?: string[]; dirs?: string[]; executable?: string[] }): void {
  const files = new Set(tree.files ?? []);
  const dirs = new Set(tree.dirs ?? []);
  const executable = new Set(tree.executable ?? tree.files ?? []);
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  vi.mocked(fs.statSync).mockImplementation(((p: fs.PathLike) => {
    const target = String(p);
    if (files.has(target)) return { isFile: () => true } as fs.Stats;
    if (dirs.has(target)) return { isFile: () => false } as fs.Stats;
    throw enoent(target);
  }) as typeof fs.statSync);
  vi.mocked(fs.accessSync).mockImplementation(((p: fs.PathLike) => {
    const target = String(p);
    if (!files.has(target) && !dirs.has(target)) throw enoent(target);
    if (!executable.has(target)) {
      throw Object.assign(new Error(`EACCES: ${target}`), { code: "EACCES" });
    }
  }) as typeof fs.accessSync);
}

/**
 * Renders `env -0` output: NUL-terminated KEY=VALUE records, which is what
 * importLoginShellEnv() parses. Values may contain newlines.
 */
function envOutput(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}=${value}\0`)
    .join("");
}

describe("cleanEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("strips ROUBO_ prefixed vars from the returned env", async () => {
    process.env.ROUBO_PRODUCTION = "1";
    process.env.ROUBO_PORT = "3333";
    process.env.ROUBO_QUIET = "1";
    const { cleanEnv } = await import("./env.js");
    const result = cleanEnv();
    expect(result.ROUBO_PRODUCTION).toBeUndefined();
    expect(result.ROUBO_PORT).toBeUndefined();
    expect(result.ROUBO_QUIET).toBeUndefined();
  });

  it("preserves non-ROUBO_ vars", async () => {
    process.env.MY_APP_VAR = "hello";
    const { cleanEnv } = await import("./env.js");
    const result = cleanEnv();
    expect(result.MY_APP_VAR).toBe("hello");
  });

  it("excludes undefined values", async () => {
    const { cleanEnv } = await import("./env.js");
    const result = cleanEnv();
    expect(Object.values(result).every((v) => v !== undefined)).toBe(true);
  });
});

describe("getEnvFileKeys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  async function getKeys(contents: string): Promise<string[]> {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(contents);
    const { getEnvFileKeys } = await import("./env.js");
    return getEnvFileKeys();
  }

  it("returns variable names from the env file", async () => {
    const keys = await getKeys("FOO=bar\nBAZ=qux");
    expect(keys).toContain("FOO");
    expect(keys).toContain("BAZ");
  });

  it("skips comment lines", async () => {
    const keys = await getKeys("# comment\nFOO=bar");
    expect(keys).toEqual(["FOO"]);
  });

  it("skips blank lines", async () => {
    const keys = await getKeys("\nFOO=bar\n\nBAR=baz\n");
    expect(keys).toEqual(["FOO", "BAR"]);
  });

  it("skips lines without equals sign", async () => {
    const keys = await getKeys("INVALID\nFOO=bar");
    expect(keys).toEqual(["FOO"]);
  });

  it("returns empty array when file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { getEnvFileKeys } = await import("./env.js");
    expect(getEnvFileKeys()).toEqual([]);
  });

  it("does not include values, only keys", async () => {
    const keys = await getKeys("SECRET_KEY=super-secret-value");
    expect(keys).toEqual(["SECRET_KEY"]);
    expect(keys.join("")).not.toContain("super-secret");
  });
});

describe("loadEnvFile", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function load(contents: string) {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(contents);
    // Re-import to pick up fresh mocks
    const { loadEnvFile } = await import("./env.js");
    loadEnvFile();
  }

  it("loads KEY=VALUE pairs into process.env", async () => {
    await load("FOO=bar\nBAZ=qux");
    expect(process.env.FOO).toBe("bar");
    expect(process.env.BAZ).toBe("qux");
  });

  it("strips double quotes from values", async () => {
    await load('TOKEN="my-secret"');
    expect(process.env.TOKEN).toBe("my-secret");
  });

  it("strips single quotes from values", async () => {
    await load("TOKEN='my-secret'");
    expect(process.env.TOKEN).toBe("my-secret");
  });

  it("skips comment lines", async () => {
    await load("# this is a comment\nFOO=bar");
    expect(process.env.FOO).toBe("bar");
  });

  it("skips blank lines", async () => {
    await load("\n\nFOO=bar\n\n");
    expect(process.env.FOO).toBe("bar");
  });

  it("does not overwrite existing process.env vars", async () => {
    process.env.EXISTING = "original";
    await load("EXISTING=override");
    expect(process.env.EXISTING).toBe("original");
  });

  it("handles missing file gracefully", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadEnvFile } = await import("./env.js");
    expect(() => loadEnvFile()).not.toThrow();
  });

  it("skips lines without an equals sign", async () => {
    await load("INVALID_LINE\nFOO=bar");
    expect(process.env.FOO).toBe("bar");
    expect(process.env.INVALID_LINE).toBeUndefined();
  });
});

describe("loadEnvFile called again", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.ROUBO_TEST_RELOAD;
    delete process.env.ROUBO_PORT;
    vi.resetAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { resetEnvFileLoads } = await import("./env.js");
    resetEnvFileLoads();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function load(contents: string): Promise<string[]> {
    vi.mocked(fs.readFileSync).mockReturnValue(contents);
    const { loadEnvFile } = await import("./env.js");
    return loadEnvFile();
  }

  it("HR-TC-024 applies a changed value and returns the keys it changed", async () => {
    expect(await load("ROUBO_TEST_RELOAD=1")).toEqual(["ROUBO_TEST_RELOAD"]);
    expect(await load("ROUBO_TEST_RELOAD=1\n# a comment")).toEqual([]);
    expect(await load("ROUBO_TEST_RELOAD='2'")).toEqual(["ROUBO_TEST_RELOAD"]);
    expect(process.env.ROUBO_TEST_RELOAD).toBe("2");
  });

  it("HR-TC-024 removes a key the file no longer has", async () => {
    await load("ROUBO_TEST_RELOAD=1");
    expect(await load("")).toEqual(["ROUBO_TEST_RELOAD"]);
    expect(process.env.ROUBO_TEST_RELOAD).toBeUndefined();
  });

  it("HR-TC-024 never changes or removes a value something else set since", async () => {
    await load("ROUBO_TEST_RELOAD=1");
    process.env.ROUBO_TEST_RELOAD = "set-by-the-app";
    expect(await load("ROUBO_TEST_RELOAD=2")).toEqual([]);
    expect(await load("")).toEqual([]);
    expect(process.env.ROUBO_TEST_RELOAD).toBe("set-by-the-app");
  });

  it("applies ROUBO_PORT on the first load only, since the server binds it once", async () => {
    await load("ROUBO_PORT=4000");
    expect(process.env.ROUBO_PORT).toBe("4000");
    expect(await load("ROUBO_PORT=5000")).toEqual([]);
    expect(process.env.ROUBO_PORT).toBe("4000");
  });

  it("keeps a boot-only key the first load set when a later save drops its line", async () => {
    delete process.env.ROUBO_E2E;
    await load("ROUBO_E2E=1\nROUBO_PORT=4000");
    expect(await load("")).toEqual([]);
    expect(process.env.ROUBO_E2E).toBe("1");
    expect(process.env.ROUBO_PORT).toBe("4000");
  });

  it("HR-TC-025 readEnvValue reads the file per call, and explicit env wins", async () => {
    const { readEnvValue } = await import("./env.js");
    vi.mocked(fs.readFileSync).mockReturnValue("ROUBO_TEST_RELOAD=first");
    expect(readEnvValue("ROUBO_TEST_RELOAD")).toBe("first");
    vi.mocked(fs.readFileSync).mockReturnValue('ROUBO_TEST_RELOAD="second"');
    expect(readEnvValue("ROUBO_TEST_RELOAD")).toBe("second");
    // A value the loader put in process.env still follows the file.
    await load("ROUBO_TEST_RELOAD=loaded");
    vi.mocked(fs.readFileSync).mockReturnValue("ROUBO_TEST_RELOAD=edited");
    expect(readEnvValue("ROUBO_TEST_RELOAD")).toBe("edited");
    process.env.ROUBO_TEST_RELOAD = "explicit";
    expect(readEnvValue("ROUBO_TEST_RELOAD")).toBe("explicit");
  });

  /** The boot import of the login shell, exporting `vars`. */
  async function importShell(vars: Record<string, string>): Promise<void> {
    vi.mocked(execFileSync).mockReturnValue(envOutput(vars));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
  }

  it("HR-TC-024 a key added to .env overrides the login shell's value, as a relaunch does", async () => {
    const { readEnvValue } = await import("./env.js");
    await load("");
    await importShell({ ROUBO_TEST_RELOAD: "from-shell" });
    expect(process.env.ROUBO_TEST_RELOAD).toBe("from-shell");

    expect(await load("ROUBO_TEST_RELOAD=from-file")).toEqual(["ROUBO_TEST_RELOAD"]);
    expect(process.env.ROUBO_TEST_RELOAD).toBe("from-file");
    expect(readEnvValue("ROUBO_TEST_RELOAD")).toBe("from-file");

    // Dropping the line again puts the shell's value back.
    expect(await load("")).toEqual(["ROUBO_TEST_RELOAD"]);
    expect(process.env.ROUBO_TEST_RELOAD).toBe("from-shell");
    expect(readEnvValue("ROUBO_TEST_RELOAD")).toBe("from-shell");
  });

  it("HR-TC-024 a .env line dropped by a save falls back to the login shell's value, as a relaunch does", async () => {
    const { readEnvValue } = await import("./env.js");
    // Boot: .env loads first and wins, the shell only fills gaps.
    await load("ROUBO_TEST_RELOAD=from-file");
    await importShell({ ROUBO_TEST_RELOAD: "from-shell" });
    expect(process.env.ROUBO_TEST_RELOAD).toBe("from-file");

    expect(await load("")).toEqual(["ROUBO_TEST_RELOAD"]);
    expect(process.env.ROUBO_TEST_RELOAD).toBe("from-shell");
    expect(readEnvValue("ROUBO_TEST_RELOAD")).toBe("from-shell");

    expect(await load("ROUBO_TEST_RELOAD=from-file")).toEqual(["ROUBO_TEST_RELOAD"]);
    expect(process.env.ROUBO_TEST_RELOAD).toBe("from-file");
  });

  it("HR-TC-024 explicit env still wins over both .env and the login shell", async () => {
    process.env.ROUBO_TEST_RELOAD = "explicit";
    await load("ROUBO_TEST_RELOAD=from-file");
    await importShell({ ROUBO_TEST_RELOAD: "from-shell" });
    expect(await load("ROUBO_TEST_RELOAD=edited")).toEqual([]);
    expect(await load("")).toEqual([]);
    expect(process.env.ROUBO_TEST_RELOAD).toBe("explicit");
  });

  it("HR-TC-025 a GITHUB_CLIENT_ID added to .env is read over the login shell's value", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const { readEnvValue } = await import("./env.js");
    await load("");
    await importShell({ GITHUB_CLIENT_ID: "shell-client-id" });
    expect(readEnvValue("GITHUB_CLIENT_ID")).toBe("shell-client-id");
    // Seen at the next call, before the watch has reloaded the file.
    vi.mocked(fs.readFileSync).mockReturnValue("GITHUB_CLIENT_ID=file-client-id");
    expect(readEnvValue("GITHUB_CLIENT_ID")).toBe("file-client-id");
  });

  it("keeps the plugin roots as boot set them, since plugin discovery reads them once", async () => {
    delete process.env.ROUBO_USER_PLUGINS_DIR;
    delete process.env.ROUBO_BUNDLED_PLUGINS_DIR;
    await load("ROUBO_USER_PLUGINS_DIR=/boot/user\nROUBO_BUNDLED_PLUGINS_DIR=/boot/bundled");
    expect(
      await load("ROUBO_USER_PLUGINS_DIR=/edited/user\nROUBO_BUNDLED_PLUGINS_DIR=/edited/bundled"),
    ).toEqual([]);
    expect(await load("")).toEqual([]);
    expect(process.env.ROUBO_USER_PLUGINS_DIR).toBe("/boot/user");
    expect(process.env.ROUBO_BUNDLED_PLUGINS_DIR).toBe("/boot/bundled");
  });

  it("keeps the app log dir as boot set it, since the app log creates its folder once", async () => {
    delete process.env.ROUBO_APP_LOG_DIR;
    await load("ROUBO_APP_LOG_DIR=/x/a");
    expect(process.env.ROUBO_APP_LOG_DIR).toBe("/x/a");
    expect(await load("ROUBO_APP_LOG_DIR=/x/b")).toEqual([]);
    expect(await load("")).toEqual([]);
    expect(process.env.ROUBO_APP_LOG_DIR).toBe("/x/a");
  });

  it("keeps NODE_ENV as boot set it, since plugin discovery picks its mode once", async () => {
    delete process.env.NODE_ENV;
    await load("NODE_ENV=production");
    expect(process.env.NODE_ENV).toBe("production");
    expect(await load("NODE_ENV=test")).toEqual([]);
    expect(await load("")).toEqual([]);
    expect(process.env.NODE_ENV).toBe("production");
  });

  async function report(contents: string) {
    vi.mocked(fs.readFileSync).mockReturnValue(contents);
    const { loadEnvFileReport } = await import("./env.js");
    return loadEnvFileReport();
  }

  describe("a boot-only key a save changes", () => {
    const BOOT_KEYS = ["ROUBO_APP_LOG_DIR", "ROUBO_USER_PLUGINS_DIR", "NODE_ENV"];

    beforeEach(() => {
      for (const key of BOOT_KEYS) Reflect.deleteProperty(process.env, key);
    });

    it("HR-TC-024 names ROUBO_APP_LOG_DIR changed alone as needing a relaunch and leaves process.env", async () => {
      expect(await report("ROUBO_APP_LOG_DIR=/x/a")).toEqual({
        changed: ["ROUBO_APP_LOG_DIR"],
        needsRelaunch: [],
      });
      expect(await report("ROUBO_APP_LOG_DIR=/x/b")).toEqual({
        changed: [],
        needsRelaunch: ["ROUBO_APP_LOG_DIR"],
      });
      expect(process.env.ROUBO_APP_LOG_DIR).toBe("/x/a");
    });

    it("HR-TC-024 names NODE_ENV and applies an ordinary key changed in the same save", async () => {
      await load("NODE_ENV=production");
      expect(await report("NODE_ENV=test\nROUBO_TEST_RELOAD=1")).toEqual({
        changed: ["ROUBO_TEST_RELOAD"],
        needsRelaunch: ["NODE_ENV"],
      });
      expect(process.env.NODE_ENV).toBe("production");
      expect(process.env.ROUBO_TEST_RELOAD).toBe("1");
    });

    it("HR-TC-024 names ROUBO_USER_PLUGINS_DIR when a save drops its line", async () => {
      await load("ROUBO_USER_PLUGINS_DIR=/boot/user");
      expect(await report("")).toEqual({ changed: [], needsRelaunch: ["ROUBO_USER_PLUGINS_DIR"] });
      expect(process.env.ROUBO_USER_PLUGINS_DIR).toBe("/boot/user");
    });

    it("HR-TC-024 does not name a dropped line whose login shell value is the one in effect", async () => {
      await load("ROUBO_APP_LOG_DIR=/x/a");
      await importShell({ ROUBO_APP_LOG_DIR: "/x/a" });
      expect(await report("")).toEqual({ changed: [], needsRelaunch: [] });
    });

    it("HR-TC-024 does not name a boot-only key that is explicit env", async () => {
      process.env.ROUBO_APP_LOG_DIR = "/from-launch";
      await load("ROUBO_APP_LOG_DIR=/x/a");
      expect(await report("ROUBO_APP_LOG_DIR=/x/b")).toEqual({ changed: [], needsRelaunch: [] });
      expect(await report("")).toEqual({ changed: [], needsRelaunch: [] });
      expect(process.env.ROUBO_APP_LOG_DIR).toBe("/from-launch");
    });

    it("HR-TC-024 names ROUBO_PORT although the server published its bound port after boot", async () => {
      await load("");
      process.env.ROUBO_PORT = "3335";
      expect(await report("ROUBO_PORT=4000")).toEqual({
        changed: [],
        needsRelaunch: ["ROUBO_PORT"],
      });
      expect(process.env.ROUBO_PORT).toBe("3335");
    });

    it("HR-TC-024 does not name ROUBO_PORT when a save drops a line boot never read", async () => {
      await load("");
      process.env.ROUBO_PORT = "3335";
      expect(await report("ROUBO_PORT=4000")).toEqual({
        changed: [],
        needsRelaunch: ["ROUBO_PORT"],
      });
      // The file is back to what boot read, so a relaunch would change nothing.
      expect(await report("")).toEqual({ changed: [], needsRelaunch: [] });
      expect(process.env.ROUBO_PORT).toBe("3335");
    });

    it("HR-TC-024 does not name a ROUBO_PORT line that matches the port the server bound", async () => {
      await load("");
      process.env.ROUBO_PORT = "3335";
      expect(await report("ROUBO_PORT=3335")).toEqual({ changed: [], needsRelaunch: [] });
      expect(process.env.ROUBO_PORT).toBe("3335");
    });

    it("HR-TC-024 names ROUBO_APP_LOG_DIR moved away from its boot line, not moved back to it", async () => {
      await load("ROUBO_APP_LOG_DIR=/x/a");
      expect(await report("ROUBO_APP_LOG_DIR=/x/b")).toEqual({
        changed: [],
        needsRelaunch: ["ROUBO_APP_LOG_DIR"],
      });
      expect(await report("ROUBO_APP_LOG_DIR=/x/a")).toEqual({ changed: [], needsRelaunch: [] });
      expect(process.env.ROUBO_APP_LOG_DIR).toBe("/x/a");
    });

    it("HR-TC-024 names a key once, not again on a later save that leaves its line", async () => {
      await load("");
      expect((await report("ROUBO_APP_LOG_DIR=/x/b")).needsRelaunch).toEqual(["ROUBO_APP_LOG_DIR"]);
      expect(await report("ROUBO_APP_LOG_DIR=/x/b\nROUBO_TEST_RELOAD=1")).toEqual({
        changed: ["ROUBO_TEST_RELOAD"],
        needsRelaunch: [],
      });
      expect(await report("ROUBO_APP_LOG_DIR=/x/b\nROUBO_TEST_RELOAD=1\n# a comment")).toEqual({
        changed: [],
        needsRelaunch: [],
      });
      // Dropping the line puts back the value in effect, so no relaunch is needed.
      expect(await report("ROUBO_TEST_RELOAD=1")).toEqual({ changed: [], needsRelaunch: [] });
      expect(process.env.ROUBO_APP_LOG_DIR).toBeUndefined();
    });
  });
});

describe("importLoginShellEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("merges login shell paths with existing PATH, prepending new entries", async () => {
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/local/bin:/usr/bin:/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    // /usr/local/bin is new: prepended; /usr/bin and /bin already present: not duplicated
    expect(process.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });

  it("preserves launch-environment paths not in the login shell PATH", async () => {
    process.env.PATH = "/launch/shim:/usr/bin";
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/local/bin:/usr/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    // /usr/local/bin prepended; /launch/shim kept at end
    expect(process.env.PATH).toBe("/usr/local/bin:/launch/shim:/usr/bin");
  });

  it("merges PATH by the bespoke rule rather than gap-filling it", async () => {
    // PATH is always already set, so the gap-fill rule the other variables use
    // would skip it outright: it must keep its own merge.
    process.env.PATH = "/usr/bin";
    vi.mocked(execFileSync).mockReturnValue(
      envOutput({ PATH: "/opt/homebrew/bin:/usr/bin", EDITOR: "vim" }),
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("imports a variable present only in the login shell environment", async () => {
    delete process.env.ROUBO_TEST_SHELL_ONLY;
    vi.mocked(execFileSync).mockReturnValue(
      envOutput({ PATH: "/usr/bin", ROUBO_TEST_SHELL_ONLY: "from-profile" }),
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.ROUBO_TEST_SHELL_ONLY).toBe("from-profile");
  });

  it("does not overwrite a variable already set in process.env", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(execFileSync).mockReturnValue(
      envOutput({ PATH: "/usr/bin", ROUBO_E2E: "from-profile" }),
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.ROUBO_E2E).toBe("1");
  });

  it("keeps a value containing a newline intact", async () => {
    delete process.env.ROUBO_TEST_MULTILINE;
    vi.mocked(execFileSync).mockReturnValue(
      envOutput({ ROUBO_TEST_MULTILINE: "line one\nline two", PATH: "/usr/bin" }),
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.ROUBO_TEST_MULTILINE).toBe("line one\nline two");
    expect(process.env.PATH).toContain("/usr/bin");
  });

  it("ignores output that is not a KEY=VALUE record", async () => {
    delete process.env.ROUBO_TEST_SWALLOWED;
    delete process.env.ROUBO_TEST_AFTER_NOISE;
    // A profile that prints to stdout has no NUL after its banner, so the banner
    // runs into the FIRST record and takes it down: that record's key is no
    // longer a plain variable name, so it is dropped. Every later record, having
    // its own NUL boundary, still imports.
    vi.mocked(execFileSync).mockReturnValue(
      `welcome to your shell\n${envOutput({
        ROUBO_TEST_SWALLOWED: "lost",
        ROUBO_TEST_AFTER_NOISE: "ok",
      })}`,
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    // The mangled key is what the reject branch actually drops. Asserting on
    // ROUBO_TEST_SWALLOWED alone would pass even with the guard removed, since
    // the banner renames the variable either way.
    expect(process.env["welcome to your shell\nROUBO_TEST_SWALLOWED"]).toBeUndefined();
    expect(process.env.ROUBO_TEST_SWALLOWED).toBeUndefined();
    expect(process.env.ROUBO_TEST_AFTER_NOISE).toBe("ok");
  });

  it("uses SHELL env var to determine the shell", async () => {
    process.env.SHELL = "/bin/bash";
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/local/bin:/usr/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/bash",
      ["-lc", "env -0"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("runs zsh interactively so ~/.zshrc exports are seen", async () => {
    process.env.SHELL = "/bin/zsh";
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", "env -0"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("falls back to /bin/sh when SHELL is not set", async () => {
    delete process.env.SHELL;
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/bin:/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledWith("/bin/sh", expect.any(Array), expect.any(Object));
  });

  it("imports through fish too, since `env -0` output is NUL-separated for every shell", async () => {
    process.env.SHELL = "/usr/local/bin/fish";
    process.env.PATH = "/usr/bin";
    delete process.env.ROUBO_TEST_FISH_ONLY;
    vi.mocked(execFileSync).mockReturnValue(
      envOutput({ PATH: "/opt/fish/bin:/usr/bin", ROUBO_TEST_FISH_ONLY: "yes" }),
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/fish",
      ["-lc", "env -0"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(process.env.PATH).toBe("/opt/fish/bin:/usr/bin");
    expect(process.env.ROUBO_TEST_FISH_ONLY).toBe("yes");
  });

  it("sets PATH from shell when PATH is initially undefined", async () => {
    delete process.env.PATH;
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/local/bin:/usr/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  it("preserves existing PATH when the shell command throws", async () => {
    process.env.PATH = "/original/path";
    process.env.ROUBO_QUIET = "1";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe("/original/path");
  });

  it("imports nothing when the shell command throws", async () => {
    process.env.ROUBO_QUIET = "1";
    delete process.env.ROUBO_TEST_SHELL_ONLY;
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.ROUBO_TEST_SHELL_ONLY).toBeUndefined();
  });

  it("logs a warn message when the import fails and ROUBO_QUIET is not set", async () => {
    delete process.env.ROUBO_QUIET;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(warnSpy).toHaveBeenCalledWith(
      "importLoginShellEnv: could not import the login-shell environment:",
      expect.any(Error),
    );
  });

  it("does not log when the import fails and ROUBO_QUIET is set", async () => {
    process.env.ROUBO_QUIET = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not throw and leaves PATH undefined when PATH is unset and shell throws", async () => {
    delete process.env.PATH;
    process.env.ROUBO_QUIET = "1";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { importLoginShellEnv } = await import("./env.js");
    expect(() => importLoginShellEnv()).not.toThrow();
    expect(process.env.PATH).toBeUndefined();
  });

  it("does not update PATH when the shell returns no output", async () => {
    process.env.PATH = "/original/path";
    vi.mocked(execFileSync).mockReturnValue("");
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe("/original/path");
  });
});

describe("importLoginShellEnv on a slow login shell (#1487)", () => {
  const originalEnv = { ...process.env };

  /** The error execFileSync throws when the child outlives its timeout. */
  function timedOut(): Error {
    return Object.assign(new Error("spawnSync /bin/zsh ETIMEDOUT"), { code: "ETIMEDOUT" });
  }

  beforeEach(() => {
    process.env = { ...originalEnv, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    delete process.env.ROUBO_QUIET;
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("gives the login shell 15 s to start", async () => {
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", "env -0"],
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it("kills the shell with SIGKILL on timeout, since an interactive zsh ignores SIGTERM", async () => {
    vi.mocked(execFileSync).mockReturnValue(envOutput({ PATH: "/usr/bin" }));
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", "env -0"],
      expect.objectContaining({ killSignal: "SIGKILL" }),
    );
  });

  it("retries once after a timed-out first attempt and merges the login-shell PATH", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => {
        throw timedOut();
      })
      .mockReturnValueOnce(envOutput({ PATH: "/opt/homebrew/bin:/usr/bin:/bin" }));
    const { importLoginShellEnv, getLoginShellImportStatus } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(process.env.PATH?.split(":").slice(0, 3)).toEqual([
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
    ]);
    expect(getLoginShellImportStatus()).toEqual({ state: "ok" });
    // A failure that the retry recovered from is not worth a warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reports a final timeout through the system status, after exactly two attempts", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw timedOut();
    });
    const { importLoginShellEnv, getLoginShellImportStatus } = await import("./env.js");
    importLoginShellEnv();
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(process.env.PATH?.split(":").slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(getLoginShellImportStatus()).toEqual({
      state: "failed",
      reason: "timeout",
      shell: "/bin/zsh",
      timeoutMs: 15_000,
      detail: "spawnSync /bin/zsh ETIMEDOUT",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a shell that cannot be run as an error, not a timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("spawnSync /bin/zsh ENOENT"), { code: "ENOENT" });
    });
    const { importLoginShellEnv, getLoginShellImportStatus } = await import("./env.js");
    importLoginShellEnv();
    // Running the profile again would not change a failure that is not a timeout.
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(getLoginShellImportStatus()).toMatchObject({
      state: "failed",
      reason: "error",
      shell: "/bin/zsh",
      detail: "spawnSync /bin/zsh ENOENT",
    });
  });

  it("clears an earlier failure once an import succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw timedOut();
    });
    const { importLoginShellEnv, getLoginShellImportStatus } = await import("./env.js");
    importLoginShellEnv();
    vi.mocked(execFileSync)
      .mockReset()
      .mockReturnValue(envOutput({ PATH: "/usr/bin" }));
    importLoginShellEnv();
    expect(getLoginShellImportStatus()).toEqual({ state: "ok" });
  });
});

describe("importLoginShellEnv well-known CLI dirs", () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  beforeEach(() => {
    process.env = { ...originalEnv, SHELL: "/bin/zsh", ROUBO_QUIET: "1" };
    vi.resetAllMocks();
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("skip");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("appends VS Code CLI dir on darwin when it exists and is not in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(
      "/usr/bin:/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
  });

  it("does not append VS Code CLI dir when it does not exist", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("does not append VS Code CLI dir when it is already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin";
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(
      "/usr/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
  });

  it("does not append macOS well-known CLI dirs on non-darwin platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("prepends ~/.local/bin on darwin when it exists and is not already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin:/usr/bin:/bin`);
  });

  it("prepends ~/.local/bin on linux when it exists and is not already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin:/usr/bin:/bin`);
  });

  it("does not prepend ~/.local/bin when it is already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = `${os.homedir()}/.local/bin:/usr/bin:/bin`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(
      `${os.homedir()}/.local/bin:/usr/bin:/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin`,
    );
  });

  it("does not prepend ~/.local/bin when the directory does not exist", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("sets PATH to ~/.local/bin when PATH is undefined", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    delete process.env.PATH;
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin`);
  });

  it("prepends ~/.local/bin for fish shell users (import failed, user-local-bin still runs)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.SHELL = "/usr/local/bin/fish";
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin:/usr/bin:/bin`);
  });

  it("appends VS Code CLI dir for fish shell users on darwin (import failed, fallback still runs)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.SHELL = "/usr/local/bin/fish";
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
    const { importLoginShellEnv } = await import("./env.js");
    importLoginShellEnv();
    expect(process.env.PATH).toBe(
      "/usr/bin:/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
  });
});

describe("getContextWindow", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ROUBO_CONTEXT_WINDOW;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns DEFAULT_CONTEXT_WINDOW when env var is not set", async () => {
    const { getContextWindow } = await import("./env.js");
    const { DEFAULT_CONTEXT_WINDOW } = await import("@roubo/shared");
    expect(getContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("returns the parsed integer when set to a valid positive integer", async () => {
    process.env.ROUBO_CONTEXT_WINDOW = "1000000";
    const { getContextWindow } = await import("./env.js");
    expect(getContextWindow()).toBe(1000000);
  });

  it("falls back to default and warns for a non-numeric value", async () => {
    process.env.ROUBO_CONTEXT_WINDOW = "abc";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getContextWindow } = await import("./env.js");
    const { DEFAULT_CONTEXT_WINDOW } = await import("@roubo/shared");
    expect(getContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("abc"));
    warnSpy.mockRestore();
  });

  it("falls back to default and warns for zero", async () => {
    process.env.ROUBO_CONTEXT_WINDOW = "0";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getContextWindow } = await import("./env.js");
    const { DEFAULT_CONTEXT_WINDOW } = await import("@roubo/shared");
    expect(getContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to default and warns for a negative integer", async () => {
    process.env.ROUBO_CONTEXT_WINDOW = "-5";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getContextWindow } = await import("./env.js");
    const { DEFAULT_CONTEXT_WINDOW } = await import("@roubo/shared");
    expect(getContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("parses float string as integer (parseInt truncates): no warning expected", async () => {
    process.env.ROUBO_CONTEXT_WINDOW = "1.5";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getContextWindow } = await import("./env.js");
    // parseInt('1.5') === 1 which is a positive integer: treated as valid
    expect(getContextWindow()).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("resolveAgentCommand (#1056)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, PATH: "/usr/bin:/bin" };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns an absolute command unchanged without probing the filesystem", async () => {
    const { resolveAgentCommand } = await import("./env.js");
    expect(resolveAgentCommand("/opt/acme/bin/acme")).toBe("/opt/acme/bin/acme");
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  it("returns a relative command containing a separator unchanged", async () => {
    const { resolveAgentCommand } = await import("./env.js");
    expect(resolveAgentCommand("./bin/acme")).toBe("./bin/acme");
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  it("returns the bare name when the command is found on PATH", async () => {
    mockFs({ files: ["/usr/bin/acme"] });
    const { resolveAgentCommand } = await import("./env.js");
    // The bare name is deliberate: PATH resolution stays the exec call's job.
    expect(resolveAgentCommand("acme")).toBe("acme");
  });

  it("searches the supplied PATH rather than the server's when one is given", async () => {
    mockFs({ files: ["/child/bin/acme"] });
    const { resolveAgentCommand } = await import("./env.js");
    expect(resolveAgentCommand("acme", "/child/bin")).toBe("acme");
  });

  it("skips a PATH entry that is not an executable file (#1060)", async () => {
    // /usr/bin/claude is a directory and /bin/claude lacks the execute bit, so
    // neither may be spawned: resolution must fall through to the well-known list.
    mockFs({
      dirs: ["/usr/bin/claude"],
      files: ["/bin/claude", "/opt/homebrew/bin/claude"],
      executable: ["/opt/homebrew/bin/claude"],
    });
    const { resolveAgentCommand } = await import("./env.js");
    expect(resolveAgentCommand("claude")).toBe("/opt/homebrew/bin/claude");
  });

  it.each([
    ["~/.local/bin/claude", () => `${process.env.HOME}/.local/bin/claude`],
    ["~/.claude/local/claude", () => `${process.env.HOME}/.claude/local/claude`],
    ["/opt/homebrew/bin/claude", () => "/opt/homebrew/bin/claude"],
    ["/usr/local/bin/claude", () => "/usr/local/bin/claude"],
  ])("falls back to %s when claude is not on PATH", async (_label, expected) => {
    mockFs({ files: [expected()] });
    const { resolveAgentCommand } = await import("./env.js");
    expect(resolveAgentCommand("claude")).toBe(expected());
  });

  it("skips a well-known candidate that exists but is not executable (#1060)", async () => {
    // The shadowing case from #1060: a broken ~/.local/bin/claude must not win
    // over a working /opt/homebrew/bin/claude further down the list.
    mockFs({
      files: [
        `${process.env.HOME}/.local/bin/claude`,
        `${process.env.HOME}/.claude/local/claude`,
        "/opt/homebrew/bin/claude",
      ],
      executable: ["/opt/homebrew/bin/claude"],
    });
    const { resolveAgentCommand } = await import("./env.js");
    expect(resolveAgentCommand("claude")).toBe("/opt/homebrew/bin/claude");
  });

  it("throws when every candidate exists but none is executable (#1060)", async () => {
    const candidates = [
      "/usr/bin/claude",
      "/bin/claude",
      `${process.env.HOME}/.local/bin/claude`,
      `${process.env.HOME}/.claude/local/claude`,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
    mockFs({ files: candidates, executable: [] });
    const { resolveAgentCommand, AgentCommandNotFoundError } = await import("./env.js");
    let thrown: unknown;
    try {
      resolveAgentCommand("claude");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentCommandNotFoundError);
    expect((thrown as InstanceType<typeof AgentCommandNotFoundError>).tried).toEqual(candidates);
  });

  it("throws an error naming every location tried when nothing resolves", async () => {
    mockFs({});
    const { resolveAgentCommand, AgentCommandNotFoundError } = await import("./env.js");
    let thrown: unknown;
    try {
      resolveAgentCommand("claude");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentCommandNotFoundError);
    const err = thrown as InstanceType<typeof AgentCommandNotFoundError>;
    expect(err.command).toBe("claude");
    expect(err.tried).toEqual([
      "/usr/bin/claude",
      "/bin/claude",
      `${process.env.HOME}/.local/bin/claude`,
      `${process.env.HOME}/.claude/local/claude`,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    for (const location of err.tried) expect(err.message).toContain(location);
    expect(err.message).toContain('"claude"');
  });

  it("reports only the PATH candidates for an agent with no well-known locations", async () => {
    mockFs({});
    const { resolveAgentCommand, AgentCommandNotFoundError } = await import("./env.js");
    expect(() => resolveAgentCommand("acme")).toThrow(AgentCommandNotFoundError);
    try {
      resolveAgentCommand("acme");
    } catch (err) {
      expect((err as InstanceType<typeof AgentCommandNotFoundError>).tried).toEqual([
        "/usr/bin/acme",
        "/bin/acme",
      ]);
    }
  });
});

describe("resolveAgentCommand well-known install locations (#1056, #1060)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, SHELL: "/usr/local/bin/fish", PATH: "/usr/bin:/bin" };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves an agent CLI from every well-known location its basename declares", async () => {
    const { wellKnownPathsFor, resolveAgentCommand } = await import("./env.js");
    const candidates = wellKnownPathsFor("claude");
    expect(candidates.length).toBeGreaterThan(0);

    for (const installed of candidates) {
      mockFs({ files: [installed] });
      expect(resolveAgentCommand("claude")).toBe(installed);
    }
  });

  it("falls through past a non-executable candidate to the next one (#1060)", async () => {
    const { wellKnownPathsFor, resolveAgentCommand } = await import("./env.js");
    const candidates = wellKnownPathsFor("claude");
    expect(candidates.length).toBeGreaterThan(1);

    for (let i = 0; i < candidates.length - 1; i++) {
      mockFs({
        files: [candidates[i], candidates[i + 1]],
        executable: [candidates[i + 1]],
      });
      expect(resolveAgentCommand("claude")).toBe(candidates[i + 1]);
    }
  });
});

// The per-agent half of the same fallback (#1115): the candidate list comes from
// the launching agent plugin's manifest (`agentInstallLocations`), so a CLI
// other than `claude` resolves on an install whose PATH the server never
// inherits. The host keeps doing the probing throughout, so nothing here lets a
// plugin name a path and have it spawned unconditionally.
describe("resolveAgentCommand manifest-declared install locations (#1115)", () => {
  const originalEnv = { ...process.env };
  const CODEX_LOCATIONS = ["~/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
  const expandedCodexLocations = (): string[] => [
    `${process.env.HOME}/.local/bin/codex`,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];

  beforeEach(() => {
    process.env = { ...originalEnv, SHELL: "/usr/local/bin/fish", PATH: "/usr/bin:/bin" };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("expands ~/ against the home directory and keeps the declared order", async () => {
    const { wellKnownPathsFor } = await import("./env.js");
    expect(wellKnownPathsFor("codex", CODEX_LOCATIONS)).toEqual(expandedCodexLocations());
  });

  it("resolves a non-claude CLI from every location its manifest declares", async () => {
    const { resolveAgentCommand } = await import("./env.js");

    for (const installed of expandedCodexLocations()) {
      mockFs({ files: [installed] });
      expect(resolveAgentCommand("codex", process.env.PATH, CODEX_LOCATIONS)).toBe(installed);
    }
  });

  it("prefers the PATH hit over a declared location, as it does for the host table", async () => {
    mockFs({ files: ["/usr/bin/codex", "/opt/homebrew/bin/codex"] });
    const { resolveAgentCommand } = await import("./env.js");
    // The bare name is deliberate: PATH resolution stays the exec call's job.
    expect(resolveAgentCommand("codex", process.env.PATH, CODEX_LOCATIONS)).toBe("codex");
  });

  it("falls through a declared candidate that is not an executable file (#1060)", async () => {
    const declared = expandedCodexLocations();
    mockFs({
      dirs: [declared[0]],
      files: [declared[1], declared[2]],
      executable: [declared[2]],
    });
    const { resolveAgentCommand } = await import("./env.js");
    // A directory, then a real-but-unchmodded file: neither may shadow the
    // working install further down the declared list.
    expect(resolveAgentCommand("codex", process.env.PATH, CODEX_LOCATIONS)).toBe(declared[2]);
  });

  it("throws naming every PATH entry and every declared location on a total miss", async () => {
    mockFs({});
    const { resolveAgentCommand, AgentCommandNotFoundError } = await import("./env.js");
    let thrown: unknown;
    try {
      resolveAgentCommand("codex", process.env.PATH, CODEX_LOCATIONS);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentCommandNotFoundError);
    const err = thrown as InstanceType<typeof AgentCommandNotFoundError>;
    expect(err.tried).toEqual(["/usr/bin/codex", "/bin/codex", ...expandedCodexLocations()]);
    for (const location of err.tried) expect(err.message).toContain(location);
  });

  it("replaces the host table rather than merging with it", async () => {
    const { wellKnownPathsFor } = await import("./env.js");
    // A plugin that says where its own claude installs has given the whole
    // answer for it, so the legacy table contributes nothing alongside it.
    expect(wellKnownPathsFor("claude", ["/opt/acme/bin/claude"])).toEqual(["/opt/acme/bin/claude"]);
  });

  it("keeps the host table for an agent that declares nothing", async () => {
    const { wellKnownPathsFor } = await import("./env.js");
    expect(wellKnownPathsFor("claude")).toEqual([
      `${process.env.HOME}/.local/bin/claude`,
      `${process.env.HOME}/.claude/local/claude`,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(wellKnownPathsFor("claude", [])).toEqual(wellKnownPathsFor("claude"));
  });

  // AC4: a declared location is data, not a spawn instruction. The schema
  // rejects these shapes at manifest load; the resolver drops them again here,
  // so the guarantee does not rest on a caller having validated first.
  it.each([
    ["a relative path", "bin/codex"],
    ["a bare name", "codex"],
    ["a parent-directory escape", "/opt/homebrew/bin/../../../etc/codex"],
    ["a ~/ parent-directory escape", "~/../../etc/codex"],
    ["an unresolved template", "{{workspace}}/codex"],
  ])("never probes %s a plugin declared", async (_label, location) => {
    const { wellKnownPathsFor, resolveAgentCommand, AgentCommandNotFoundError } =
      await import("./env.js");
    expect(wellKnownPathsFor("codex", [location])).toEqual([]);

    mockFs({ files: ["/etc/codex", "bin/codex", "codex"] });
    expect(() => resolveAgentCommand("codex", process.env.PATH, [location])).toThrow(
      AgentCommandNotFoundError,
    );
  });
});

describe("getLoginShell", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns $SHELL when it is a valid absolute path", async () => {
    process.env.SHELL = "/bin/zsh";
    const { getLoginShell } = await import("./env.js");
    expect(getLoginShell()).toBe("/bin/zsh");
  });

  it("accepts absolute paths with dots and hyphens (e.g. homebrew fish)", async () => {
    process.env.SHELL = "/opt/homebrew/bin/fish";
    const { getLoginShell } = await import("./env.js");
    expect(getLoginShell()).toBe("/opt/homebrew/bin/fish");
  });

  it("falls back to /bin/sh when $SHELL is unset", async () => {
    delete process.env.SHELL;
    const { getLoginShell } = await import("./env.js");
    expect(getLoginShell()).toBe("/bin/sh");
  });

  it("falls back to /bin/sh for a relative value", async () => {
    process.env.SHELL = "bash";
    const { getLoginShell } = await import("./env.js");
    expect(getLoginShell()).toBe("/bin/sh");
  });

  it("falls back to /bin/sh for values containing shell metacharacters", async () => {
    const { getLoginShell } = await import("./env.js");
    for (const malicious of ["/bin/sh; rm -rf /", "/bin/sh$(touch x)", "/bin/sh | cat", ""]) {
      process.env.SHELL = malicious;
      expect(getLoginShell()).toBe("/bin/sh");
    }
  });
});

describe("loginShellScriptArgs", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("adds -i for zsh so rc-defined tools such as nvm resolve", async () => {
    // zsh reads ~/.zshrc only for interactive shells, and that is where the
    // stock nvm/fnm/asdf snippets live, so `-lc` alone cannot see them (#996).
    process.env.SHELL = "/bin/zsh";
    const { loginShellScriptArgs } = await import("./env.js");
    expect(loginShellScriptArgs("nvm use && npm i")).toEqual(["-ilc", "nvm use && npm i"]);
  });

  it("uses -lc for non-zsh shells", async () => {
    // bash reads ~/.bashrc only for interactive NON-login shells, so -i would
    // not load it anyway, and it emits a job-control warning without a tty.
    for (const shell of ["/bin/bash", "/bin/sh", "/opt/homebrew/bin/fish"]) {
      process.env.SHELL = shell;
      const { loginShellScriptArgs } = await import("./env.js");
      expect(loginShellScriptArgs("npm ci")).toEqual(["-lc", "npm ci"]);
    }
  });

  it("uses -lc when $SHELL is unset, matching the /bin/sh fallback", async () => {
    delete process.env.SHELL;
    const { loginShellScriptArgs } = await import("./env.js");
    expect(loginShellScriptArgs("npm ci")).toEqual(["-lc", "npm ci"]);
  });

  it("passes the script through as a single argument, never split", async () => {
    process.env.SHELL = "/bin/zsh";
    const { loginShellScriptArgs } = await import("./env.js");
    const script = "cd roubo && nvm use && npm i";
    const [, passed] = loginShellScriptArgs(script);
    expect(passed).toBe(script);
  });

  it("detects zsh from any absolute path, not just /bin/zsh", async () => {
    process.env.SHELL = "/opt/homebrew/bin/zsh";
    const { loginShellScriptArgs } = await import("./env.js");
    expect(loginShellScriptArgs("npm ci")[0]).toBe("-ilc");
  });
});
