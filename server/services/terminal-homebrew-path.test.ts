import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A bench session whose login-shell import failed started without Homebrew's
// bin, so `gh` was not found. This drives the real chain end to end: the boot
// import in env.ts fails, its macOS fallback runs, and a bench terminal spawns
// with the env terminal.ts builds for it. Only the filesystem, the login shell
// and the PTY are faked.

/** The directories and executable files the synthetic filesystem holds. */
const tree = { dirs: new Set<string>(), files: new Set<string>() };

const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fake = {
    existsSync: (p: unknown) => tree.dirs.has(String(p)) || tree.files.has(String(p)),
    statSync: (p: unknown) => {
      const target = String(p);
      if (tree.files.has(target)) return { isFile: () => true };
      if (tree.dirs.has(target)) return { isFile: () => false };
      throw enoent(target);
    },
    accessSync: (p: unknown) => {
      if (!tree.files.has(String(p)) && !tree.dirs.has(String(p))) throw enoent(String(p));
    },
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => "{}"),
  };
  return { ...actual, ...fake, default: { ...actual, ...fake } };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error("login shell failed");
    }),
  };
});

vi.mock("./state.js", () => ({
  atomicWrite: vi.fn(),
  getRouboDir: () => "/tmp/roubo-test",
}));

vi.mock("./notification.js", () => ({
  dismissBySession: vi.fn(),
  createNotification: vi.fn(),
  dismissWaitingForSession: vi.fn(() => false),
  WAITING_NOTIFICATION_TYPES: new Set(["terminal-waiting", "agent-waiting"]),
}));

vi.mock("./bench-manager.js", () => ({ getBench: vi.fn() }));

const mockSpawn = vi.fn();
vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createMockPty() {
  return {
    cols: 80,
    rows: 24,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
}

describe("bench terminal PATH after a failed login-shell import", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    mockSpawn.mockReset().mockReturnValue(createMockPty());
    tree.dirs.clear();
    tree.files.clear();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("SHELL", "/bin/zsh");
    vi.stubEnv("ROUBO_QUIET", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it.each(["/opt/homebrew/bin", "/usr/local/bin"])(
    "resolves gh when it is installed under %s",
    async (prefix) => {
      tree.dirs.add(prefix);
      tree.files.add(`${prefix}/gh`);
      const { importLoginShellEnv, getLoginShellImportStatus, resolveAgentCommand } =
        await import("./env.js");
      const { createSession } = await import("./terminal.js");

      importLoginShellEnv();
      expect(getLoginShellImportStatus().state).toBe("failed");
      createSession("project1", 1, "/workspace", "My Project");

      const spawnEnv = (mockSpawn.mock.calls[0][2] as { env: Record<string, string> }).env;
      expect(spawnEnv.PATH).toBe(`/usr/bin:/bin:${prefix}`);
      expect(resolveAgentCommand("gh", spawnEnv.PATH)).toBe("gh");
    },
  );

  it("does not add a Homebrew prefix that is not on disk", async () => {
    const { importLoginShellEnv, resolveAgentCommand, AgentCommandNotFoundError } =
      await import("./env.js");
    const { createSession } = await import("./terminal.js");

    importLoginShellEnv();
    createSession("project1", 1, "/workspace", "My Project");

    const spawnEnv = (mockSpawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(spawnEnv.PATH).toBe("/usr/bin:/bin");
    expect(() => resolveAgentCommand("gh", spawnEnv.PATH)).toThrow(AgentCommandNotFoundError);
  });
});
