import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectPermissions } from "@roubo/shared";

const fsMocks = {
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock("node:fs", () => ({ default: fsMocks }));
vi.mock("./state.js", () => ({
  atomicWrite: vi.fn((filePath: string, data: string) => {
    fsMocks.writeFileSync(filePath + ".tmp", data, {
      encoding: "utf-8",
      mode: 0o666,
    });
    fsMocks.renameSync(filePath + ".tmp", filePath);
  }),
}));

let injectPermissions: (workspacePath: string, permissions: ProjectPermissions) => void;

const WORKSPACE = "/workspaces/my-project/bench-1";
const CLAUDE_DIR = `${WORKSPACE}/.claude`;
const SETTINGS_FILE = `${CLAUDE_DIR}/settings.local.json`;

beforeEach(async () => {
  fsMocks.mkdirSync = vi.fn();
  fsMocks.existsSync = vi.fn();
  fsMocks.readFileSync = vi.fn();
  fsMocks.writeFileSync = vi.fn();
  fsMocks.renameSync = vi.fn();
  fsMocks.unlinkSync = vi.fn();

  vi.resetModules();
  const mod = await import("./claude-settings-local.js");
  injectPermissions = mod.injectPermissions;
});

describe("injectPermissions", () => {
  it("writes permissions.allow when file does not exist and allow is non-empty", () => {
    fsMocks.existsSync.mockReturnValue(false);

    injectPermissions(WORKSPACE, { allow: ["Bash(*)", "Read(*)"], deny: [] });

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(CLAUDE_DIR, {
      recursive: true,
    });
    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({ permissions: { allow: ["Bash(*)", "Read(*)"] } });
    expect(fsMocks.renameSync).toHaveBeenCalledWith(SETTINGS_FILE + ".tmp", SETTINGS_FILE);
  });

  it("writes permissions.deny when file does not exist and deny is non-empty", () => {
    fsMocks.existsSync.mockReturnValue(false);

    injectPermissions(WORKSPACE, { allow: [], deny: ["Bash(rm:*)"] });

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({ permissions: { deny: ["Bash(rm:*)"] } });
  });

  it("merges allow and deny into existing file", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));

    injectPermissions(WORKSPACE, {
      allow: ["Read(*)", "Bash(*)"],
      deny: ["Bash(rm:*)"],
    });

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({
      permissions: { allow: ["Bash(*)", "Read(*)"], deny: ["Bash(rm:*)"] },
    });
  });

  it("merges permissions into existing file preserving other top-level keys", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ someKey: true, permissions: { allow: ["Bash(*)"] } }),
    );

    injectPermissions(WORKSPACE, { allow: ["Read(*)"], deny: [] });

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({
      someKey: true,
      permissions: { allow: ["Bash(*)", "Read(*)"] },
    });
  });

  it("writes permissions into existing file that has no permissions block", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ someKey: true }));

    injectPermissions(WORKSPACE, { allow: ["Bash(*)"], deny: [] });

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({
      someKey: true,
      permissions: { allow: ["Bash(*)"] },
    });
  });

  it("preserves existing deny from file alongside merged allow from input", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: { allow: ["Bash(*)"], deny: ["Write(/)"] },
      }),
    );

    injectPermissions(WORKSPACE, { allow: ["Read(*)"], deny: [] });

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({
      permissions: { allow: ["Bash(*)", "Read(*)"], deny: ["Write(/)"] },
    });
  });

  it("skips when both allow and deny are empty", () => {
    fsMocks.existsSync.mockReturnValue(false);

    injectPermissions(WORKSPACE, { allow: [], deny: [] });

    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.mkdirSync).not.toHaveBeenCalled();
  });

  it("creates .claude directory when it does not exist", () => {
    fsMocks.existsSync.mockReturnValue(false);

    injectPermissions(WORKSPACE, { allow: ["Bash(*)"], deny: [] });

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(CLAUDE_DIR, {
      recursive: true,
    });
  });
});
