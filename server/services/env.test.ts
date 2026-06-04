import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

vi.mock("node:fs");
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

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

describe("resolveShellPath", () => {
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
    vi.mocked(execFileSync).mockReturnValue("/usr/local/bin:/usr/bin:/bin\n");
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    // /usr/local/bin is new: prepended; /usr/bin and /bin already present: not duplicated
    expect(process.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });

  it("preserves launch-environment paths not in the login shell PATH", async () => {
    process.env.PATH = "/launch/shim:/usr/bin";
    vi.mocked(execFileSync).mockReturnValue("/usr/local/bin:/usr/bin\n");
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    // /usr/local/bin prepended; /launch/shim kept at end
    expect(process.env.PATH).toBe("/usr/local/bin:/launch/shim:/usr/bin");
  });

  it("uses SHELL env var to determine the shell", async () => {
    process.env.SHELL = "/bin/bash";
    vi.mocked(execFileSync).mockReturnValue("/usr/local/bin:/usr/bin\n");
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/bash",
      ["-lc", 'echo "$PATH"'],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("falls back to /bin/sh when SHELL is not set", async () => {
    delete process.env.SHELL;
    vi.mocked(execFileSync).mockReturnValue("/usr/bin:/bin\n");
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(execFileSync).toHaveBeenCalledWith("/bin/sh", expect.any(Array), expect.any(Object));
  });

  it("skips resolution when SHELL points to fish", async () => {
    process.env.SHELL = "/usr/local/bin/fish";
    process.env.PATH = "/original/path";
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe("/original/path");
  });

  it("sets PATH from shell when PATH is initially undefined", async () => {
    delete process.env.PATH;
    vi.mocked(execFileSync).mockReturnValue("/usr/local/bin:/usr/bin\n");
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  it("preserves existing PATH when the shell command throws", async () => {
    process.env.PATH = "/original/path";
    process.env.ROUBO_QUIET = "1";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe("/original/path");
  });

  it("logs a warn message when shell resolution fails and ROUBO_QUIET is not set", async () => {
    delete process.env.ROUBO_QUIET;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(warnSpy).toHaveBeenCalledWith(
      "resolveShellPath: could not resolve login-shell PATH:",
      expect.any(Error),
    );
  });

  it("does not log when shell resolution fails and ROUBO_QUIET is set", async () => {
    process.env.ROUBO_QUIET = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not throw and leaves PATH undefined when PATH is unset and shell throws", async () => {
    delete process.env.PATH;
    process.env.ROUBO_QUIET = "1";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { resolveShellPath } = await import("./env.js");
    expect(() => resolveShellPath()).not.toThrow();
    expect(process.env.PATH).toBeUndefined();
  });

  it("does not update PATH when the shell returns an empty string", async () => {
    process.env.PATH = "/original/path";
    vi.mocked(execFileSync).mockReturnValue("   \n");
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe("/original/path");
  });
});

describe("resolveShellPath well-known CLI dirs", () => {
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
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe(
      "/usr/bin:/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
  });

  it("does not append VS Code CLI dir when it does not exist", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("does not append VS Code CLI dir when it is already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin";
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
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
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("prepends ~/.local/bin on darwin when it exists and is not already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin:/usr/bin:/bin`);
  });

  it("prepends ~/.local/bin on linux when it exists and is not already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin:/usr/bin:/bin`);
  });

  it("does not prepend ~/.local/bin when it is already in PATH", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = `${os.homedir()}/.local/bin:/usr/bin:/bin`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe(
      `${os.homedir()}/.local/bin:/usr/bin:/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin`,
    );
  });

  it("does not prepend ~/.local/bin when the directory does not exist", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("sets PATH to ~/.local/bin when PATH is undefined", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    delete process.env.PATH;
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin`);
  });

  it("prepends ~/.local/bin for fish shell users (exec skipped, user-local-bin still runs)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.SHELL = "/usr/local/bin/fish";
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation((p) => p === `${os.homedir()}/.local/bin`);
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe(`${os.homedir()}/.local/bin:/usr/bin:/bin`);
  });

  it("appends VS Code CLI dir for fish shell users on darwin (exec skipped, fallback still runs)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.SHELL = "/usr/local/bin/fish";
    process.env.PATH = "/usr/bin:/bin";
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
    );
    const { resolveShellPath } = await import("./env.js");
    resolveShellPath();
    expect(execFileSync).not.toHaveBeenCalled();
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

describe("resolveClaudeBinary / getClaudeBinary", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, SHELL: "/bin/zsh" };
    delete process.env.ROUBO_CLAUDE_BINARY;
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves claude path via login shell and stores it in ROUBO_CLAUDE_BINARY", async () => {
    vi.mocked(execFileSync).mockReturnValue("/usr/local/bin/claude\n");
    const { resolveClaudeBinary, getClaudeBinary } = await import("./env.js");
    resolveClaudeBinary();
    expect(execFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lc", "command -v claude"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(process.env.ROUBO_CLAUDE_BINARY).toBe("/usr/local/bin/claude");
    expect(getClaudeBinary()).toBe("/usr/local/bin/claude");
  });

  it("falls back to ~/.local/bin/claude (native installer) when shell resolution fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === `${process.env.HOME}/.local/bin/claude`,
    );
    const { resolveClaudeBinary, getClaudeBinary } = await import("./env.js");
    resolveClaudeBinary();
    expect(process.env.ROUBO_CLAUDE_BINARY).toBe(`${process.env.HOME}/.local/bin/claude`);
    expect(getClaudeBinary()).toBe(`${process.env.HOME}/.local/bin/claude`);
  });

  it("falls back to ~/.claude/local/claude when shell resolution fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === `${process.env.HOME}/.claude/local/claude`,
    );
    const { resolveClaudeBinary, getClaudeBinary } = await import("./env.js");
    resolveClaudeBinary();
    expect(process.env.ROUBO_CLAUDE_BINARY).toBe(`${process.env.HOME}/.claude/local/claude`);
    expect(getClaudeBinary()).toBe(`${process.env.HOME}/.claude/local/claude`);
  });

  it("falls back to /opt/homebrew/bin/claude when earlier options are unavailable", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/opt/homebrew/bin/claude");
    const { resolveClaudeBinary, getClaudeBinary } = await import("./env.js");
    resolveClaudeBinary();
    expect(process.env.ROUBO_CLAUDE_BINARY).toBe("/opt/homebrew/bin/claude");
    expect(getClaudeBinary()).toBe("/opt/homebrew/bin/claude");
  });

  it('leaves ROUBO_CLAUDE_BINARY unset and returns "claude" when no path is found', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { resolveClaudeBinary, getClaudeBinary } = await import("./env.js");
    resolveClaudeBinary();
    expect(process.env.ROUBO_CLAUDE_BINARY).toBeUndefined();
    expect(getClaudeBinary()).toBe("claude");
  });

  it("skips login shell for fish and goes straight to well-known paths", async () => {
    process.env.SHELL = "/usr/local/bin/fish";
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/usr/local/bin/claude");
    const { resolveClaudeBinary, getClaudeBinary } = await import("./env.js");
    resolveClaudeBinary();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(getClaudeBinary()).toBe("/usr/local/bin/claude");
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
