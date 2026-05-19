import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaudeCodeSettings, ProjectPermissions } from "@roubo/shared";

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

let writeClaudeSettingsLocal: (
  workspacePath: string,
  claudeCodeSettings?: ClaudeCodeSettings,
  projectPermissions?: ProjectPermissions,
) => void;
let injectPermissions: (workspacePath: string, permissions: ProjectPermissions) => void;

const WORKSPACE = "/workspaces/my-project/bench-1";
const CLAUDE_DIR = `${WORKSPACE}/.claude`;
const SETTINGS_FILE = `${CLAUDE_DIR}/settings.local.json`;

const ROUBO_PORT = process.env.ROUBO_PORT || "3335";

const EXPECTED_HOOKS = {
  Notification: [
    {
      hooks: [
        {
          type: "http",
          url: `http://localhost:${ROUBO_PORT}/api/hooks/claude-notification`,
        },
      ],
    },
  ],
};

beforeEach(async () => {
  fsMocks.mkdirSync = vi.fn();
  fsMocks.existsSync = vi.fn();
  fsMocks.readFileSync = vi.fn();
  fsMocks.writeFileSync = vi.fn();
  fsMocks.renameSync = vi.fn();
  fsMocks.unlinkSync = vi.fn();

  vi.resetModules();
  const mod = await import("./claude-settings-local.js");
  writeClaudeSettingsLocal = mod.writeClaudeSettingsLocal;
  injectPermissions = mod.injectPermissions;
});

describe("writeClaudeSettingsLocal", () => {
  describe("when enableAutoMode is true", () => {
    it("creates .claude directory and writes settings file with permissions and hooks", () => {
      fsMocks.existsSync.mockReturnValue(false);

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: false,
      });

      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(CLAUDE_DIR, {
        recursive: true,
      });
      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto" },
        hooks: EXPECTED_HOOKS,
      });
      expect(fsMocks.renameSync).toHaveBeenCalledWith(SETTINGS_FILE + ".tmp", SETTINGS_FILE);
    });

    it("merges permissions and hooks into existing file preserving other keys", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify({ someUserKey: "value" }));

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        someUserKey: "value",
        permissions: { defaultMode: "auto" },
        hooks: EXPECTED_HOOKS,
      });
    });

    it("overwrites existing permissions block and hooks", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
      );

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto" },
        hooks: EXPECTED_HOOKS,
      });
    });
  });

  describe("when enableAutoMode is false", () => {
    it("removes permissions block but writes hooks and preserves other keys", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({
          permissions: { defaultMode: "auto" },
          someUserKey: "value",
        }),
      );

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: false,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({ someUserKey: "value", hooks: EXPECTED_HOOKS });
    });

    it("writes hooks-only file when no other keys remain", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({ permissions: { defaultMode: "auto" } }),
      );

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: false,
        startInPlanMode: false,
      });

      expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({ hooks: EXPECTED_HOOKS });
    });

    it("writes hooks file even when file does not exist", () => {
      fsMocks.existsSync.mockReturnValue(false);

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: false,
        startInPlanMode: false,
      });

      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(CLAUDE_DIR, {
        recursive: true,
      });
      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({ hooks: EXPECTED_HOOKS });
    });
  });

  describe("when both enableAutoMode and startInPlanMode are true", () => {
    it("writes defaultMode auto and hooks when file does not exist", () => {
      fsMocks.existsSync.mockReturnValue(false);

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: true,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto" },
        hooks: EXPECTED_HOOKS,
      });
    });

    it("preserves existing allow list and writes defaultMode auto when both are true", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: true,
      });

      expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto", allow: ["Bash(*)"] },
        hooks: EXPECTED_HOOKS,
      });
    });
  });

  describe("when claudeCodeSettings is undefined", () => {
    it("writes hooks file even when file does not exist", () => {
      fsMocks.existsSync.mockReturnValue(false);

      writeClaudeSettingsLocal(WORKSPACE, undefined);

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({ hooks: EXPECTED_HOOKS });
    });

    it("preserves other keys, removes permissions, and writes hooks", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({
          permissions: { defaultMode: "auto" },
          otherKey: true,
        }),
      );

      writeClaudeSettingsLocal(WORKSPACE, undefined);

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({ otherKey: true, hooks: EXPECTED_HOOKS });
    });
  });

  describe("when existing file has malformed JSON", () => {
    it("treats as empty and writes fresh settings with hooks", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue("not valid json {{{");

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto" },
        hooks: EXPECTED_HOOKS,
      });
    });

    it("treats valid-but-non-object JSON as empty and writes fresh settings with hooks", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify([{ permissions: "some-array" }]));

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto" },
        hooks: EXPECTED_HOOKS,
      });
    });
  });

  describe("preserving permissions.allow across session writes", () => {
    it("preserves allow list when enableAutoMode is true", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({ permissions: { allow: ["Bash(*)", "Read(*)"] } }),
      );

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto", allow: ["Bash(*)", "Read(*)"] },
        hooks: EXPECTED_HOOKS,
      });
    });

    it("preserves allow list when enableAutoMode is false", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({
          permissions: { defaultMode: "auto", allow: ["Bash(*)"] },
        }),
      );

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: false,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { allow: ["Bash(*)"] },
        hooks: EXPECTED_HOOKS,
      });
    });

    it("preserves allow list and writes defaultMode auto when both flags are true", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));

      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: true,
        startInPlanMode: true,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { defaultMode: "auto", allow: ["Bash(*)"] },
        hooks: EXPECTED_HOOKS,
      });
    });

    it("preserves allow list when claudeCodeSettings is undefined", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));

      writeClaudeSettingsLocal(WORKSPACE, undefined);

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      expect(written).toEqual({
        permissions: { allow: ["Bash(*)"] },
        hooks: EXPECTED_HOOKS,
      });
    });
  });

  describe("hook URL uses ROUBO_PORT env var", () => {
    it("uses custom port from ROUBO_PORT when set", async () => {
      const originalPort = process.env.ROUBO_PORT;
      process.env.ROUBO_PORT = "4000";
      vi.resetModules();
      const mod = await import("./claude-settings-local.js");
      writeClaudeSettingsLocal = mod.writeClaudeSettingsLocal;

      fsMocks.existsSync.mockReturnValue(false);
      writeClaudeSettingsLocal(WORKSPACE, {
        enableAutoMode: false,
        startInPlanMode: false,
      });

      const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
      const hookUrl = (written.hooks as typeof EXPECTED_HOOKS).Notification[0].hooks[0].url;
      expect(hookUrl).toContain(":4000/");
      if (originalPort !== undefined) {
        process.env.ROUBO_PORT = originalPort;
      } else {
        delete process.env.ROUBO_PORT;
      }
    });
  });
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

describe("writeClaudeSettingsLocal with projectPermissions", () => {
  it("applies project allow and deny when no existing permissions", () => {
    fsMocks.existsSync.mockReturnValue(false);

    writeClaudeSettingsLocal(
      WORKSPACE,
      { enableAutoMode: false, startInPlanMode: false },
      { allow: ["Bash(*)", "Read(*)"], deny: ["Bash(rm:*)"] },
    );

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({
      permissions: { allow: ["Bash(*)", "Read(*)"], deny: ["Bash(rm:*)"] },
      hooks: EXPECTED_HOOKS,
    });
  });

  it("merges and deduplicates project allow with existing allow list", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ permissions: { allow: ["Bash(*)", "Write(*)"] } }),
    );

    writeClaudeSettingsLocal(
      WORKSPACE,
      { enableAutoMode: false, startInPlanMode: false },
      { allow: ["Bash(*)", "Read(*)"], deny: [] },
    );

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written.permissions.allow).toEqual(
      expect.arrayContaining(["Bash(*)", "Write(*)", "Read(*)"]),
    );
    expect(written.permissions.allow).toHaveLength(3);
  });

  it("merges and deduplicates project deny with existing deny list", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));

    writeClaudeSettingsLocal(
      WORKSPACE,
      { enableAutoMode: false, startInPlanMode: false },
      { allow: [], deny: ["Bash(rm:*)", "Write(/)"] },
    );

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written.permissions.deny).toEqual(expect.arrayContaining(["Bash(rm:*)", "Write(/)"]));
    expect(written.permissions.deny).toHaveLength(2);
  });

  it("includes project allow alongside defaultMode when enableAutoMode is true", () => {
    fsMocks.existsSync.mockReturnValue(false);

    writeClaudeSettingsLocal(
      WORKSPACE,
      { enableAutoMode: true, startInPlanMode: false },
      { allow: ["Bash(npm test:*)"], deny: [] },
    );

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({
      permissions: { defaultMode: "auto", allow: ["Bash(npm test:*)"] },
      hooks: EXPECTED_HOOKS,
    });
  });

  it("applies project permissions even when claudeCodeSettings is undefined", () => {
    fsMocks.existsSync.mockReturnValue(false);

    writeClaudeSettingsLocal(WORKSPACE, undefined, {
      allow: ["Bash(*)"],
      deny: [],
    });

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({
      permissions: { allow: ["Bash(*)"] },
      hooks: EXPECTED_HOOKS,
    });
  });

  it("writes hooks-only when project permissions are empty and no existing permissions", () => {
    fsMocks.existsSync.mockReturnValue(false);

    writeClaudeSettingsLocal(
      WORKSPACE,
      { enableAutoMode: false, startInPlanMode: false },
      { allow: [], deny: [] },
    );

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written).toEqual({ hooks: EXPECTED_HOOKS });
  });

  it("preserves existing deny from file when writing updated allow", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: { allow: ["Bash(*)"], deny: ["Write(/)"] },
      }),
    );

    writeClaudeSettingsLocal(
      WORKSPACE,
      { enableAutoMode: false, startInPlanMode: false },
      { allow: ["Read(*)"], deny: [] },
    );

    const written = JSON.parse(fsMocks.writeFileSync.mock.calls[0][1]);
    expect(written.permissions).toEqual({
      allow: ["Bash(*)", "Read(*)"],
      deny: ["Write(/)"],
    });
  });
});
