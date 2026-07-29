import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./state.js", async () => {
  const actual = await vi.importActual<typeof import("./state.js")>("./state.js");
  return { ...actual, loadSettings: vi.fn() };
});
vi.mock("./agent-launch-pipeline.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-launch-pipeline.js")>(
    "./agent-launch-pipeline.js",
  );
  return { ...actual, prepareAgentLaunch: vi.fn(), resolveLaunchAgentId: vi.fn() };
});
vi.mock("./claude-settings-local.js", () => ({ injectPermissions: vi.fn() }));

import {
  applyProjectPermissions,
  describeAgentPermissions,
  toLaunchPermissions,
} from "./agent-permissions.js";
import * as state from "./state.js";
import * as pipeline from "./agent-launch-pipeline.js";
import * as claudeSettingsLocal from "./claude-settings-local.js";

// The dispatch seam (issue #514, AP-FR-016, AP-FR-018): one stored model, mapped
// by whichever agent plugin the project resolves to, or by the built-in carrier
// when none does.

const SETTINGS_WRITE = {
  relPath: ".claude/settings.local.json",
  format: "json" as const,
  ops: [
    { op: "unionArray" as const, path: "permissions.allow", values: ["Bash(npm run *)"] },
    { op: "unionArray" as const, path: "permissions.deny", values: ["Bash(rm -rf *)"] },
  ],
};

const NOTIFICATION = {
  kind: "http-hook" as const,
  event: "waiting" as const,
  carrier: {
    workspaceWrite: {
      relPath: ".claude/settings.local.json",
      format: "json" as const,
      ops: [
        {
          op: "set" as const,
          path: "hooks.Notification",
          value: [
            {
              hooks: [
                { type: "http", url: "http://localhost:{{port}}/api/hooks/claude-notification" },
              ],
            },
          ],
        },
      ],
    },
  },
  correlation: { field: "session_id" as const, source: "agent-native" as const },
};

function preparedWith(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "claude-code",
    manifest: { id: "claude-code", name: "Claude Code" },
    effectiveConfig: {},
    descriptor: {
      schemaVersion: 1,
      kind: "agent-launch",
      command: "claude",
      args: [],
      capabilities: {
        workspaceWrites: [SETTINGS_WRITE],
        notification: NOTIFICATION,
        permissions: {
          postures: {
            "read-only": { args: ["--permission-mode", "plan"] },
            "full-auto": { args: ["--permission-mode", "auto"] },
          },
          rules: { carrier: "workspace-write", resync: true },
        },
      },
      ...overrides,
    },
  } as never;
}

let workspace: string;

beforeEach(() => {
  vi.clearAllMocks();
  workspace = mkdtempSync(join(tmpdir(), "agent-perms-"));
  vi.mocked(state.loadSettings).mockReturnValue({ jigs: {} } as never);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("toLaunchPermissions", () => {
  it("splits the stored model into the two axes the plugin sees", () => {
    expect(
      toLaunchPermissions({
        allow: ["Bash(*)"],
        deny: [],
        ask: ["Edit(.env*)"],
        posture: "auto-edit",
      }),
    ).toEqual({
      posture: "auto-edit",
      rules: { allow: ["Bash(*)"], ask: ["Edit(.env*)"], deny: [] },
    });
  });

  it("omits the posture when the project has chosen none", () => {
    expect(toLaunchPermissions({ allow: [], deny: [] })).toEqual({
      rules: { allow: [], ask: [], deny: [] },
    });
  });

  it("drops a path-escaping rule stored before the guard existed (AP-TC-081 S002)", () => {
    expect(
      toLaunchPermissions({ allow: ["Bash(*)", "Read(../../etc/**)"], deny: [] }).rules.allow,
    ).toEqual(["Bash(*)"]);
  });
});

describe("applyProjectPermissions", () => {
  it("falls back to the built-in carrier when no agent plugin resolves", async () => {
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue(undefined);

    const result = await applyProjectPermissions({
      projectId: "p1",
      benchId: 1,
      workspacePath: workspace,
      permissions: { allow: ["Bash(*)"], deny: [], ask: [] },
    });

    expect(result.carrier).toBe("built-in");
    expect(claudeSettingsLocal.injectPermissions).toHaveBeenCalledWith(workspace, {
      allow: ["Bash(*)"],
      deny: [],
      ask: [],
    });
    expect(pipeline.prepareAgentLaunch).not.toHaveBeenCalled();
  });

  it("executes the plugin's declared writes into the bench workspace (AP-TC-101)", async () => {
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue("claude-code");
    vi.mocked(pipeline.prepareAgentLaunch).mockResolvedValue(preparedWith());

    const result = await applyProjectPermissions({
      projectId: "p1",
      benchId: 1,
      workspacePath: workspace,
      permissions: { allow: ["Bash(npm run *)"], deny: ["Bash(rm -rf *)"], ask: [] },
    });

    expect(result.carrier).toBe("agent-plugin");
    const written = JSON.parse(
      readFileSync(join(workspace, ".claude/settings.local.json"), "utf-8"),
    );
    expect(written.permissions.allow).toEqual(["Bash(npm run *)"]);
    expect(written.permissions.deny).toEqual(["Bash(rm -rf *)"]);
    expect(claudeSettingsLocal.injectPermissions).not.toHaveBeenCalled();
  });

  it("hands the plugin the permissions model rather than parsing rules itself", async () => {
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue("claude-code");
    vi.mocked(pipeline.prepareAgentLaunch).mockResolvedValue(preparedWith());

    await applyProjectPermissions({
      projectId: "p1",
      benchId: 3,
      workspacePath: workspace,
      permissions: { allow: ["Bash(*)"], deny: [], ask: [], posture: "full-auto" },
    });

    expect(vi.mocked(pipeline.prepareAgentLaunch).mock.calls[0][0]).toMatchObject({
      pluginId: "claude-code",
      benchId: 3,
      permissions: { posture: "full-auto", rules: { allow: ["Bash(*)"], ask: [], deny: [] } },
    });
  });

  it("preserves user-authored keys in an existing settings file (AP-TC-098)", async () => {
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude/settings.local.json"),
      JSON.stringify({
        env: { MY_VAR: "1" },
        editor: { theme: "solarized" },
        permissions: { allow: ["Read(mine/**)"], defaultMode: "auto" },
      }),
    );
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue("claude-code");
    vi.mocked(pipeline.prepareAgentLaunch).mockResolvedValue(preparedWith());

    await applyProjectPermissions({
      projectId: "p1",
      benchId: 1,
      workspacePath: workspace,
      permissions: { allow: ["Bash(npm run *)"], deny: ["Bash(rm -rf *)"], ask: [] },
    });

    const written = JSON.parse(
      readFileSync(join(workspace, ".claude/settings.local.json"), "utf-8"),
    );
    expect(written.env).toEqual({ MY_VAR: "1" });
    expect(written.editor).toEqual({ theme: "solarized" });
    expect(written.permissions.defaultMode).toBe("auto");
    // Existing entries first, then the project's: a union, never a replacement.
    expect(written.permissions.allow).toEqual(["Read(mine/**)", "Bash(npm run *)"]);
  });

  it("writes nothing for an agent that declares no rules capability", async () => {
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue("codex");
    vi.mocked(pipeline.prepareAgentLaunch).mockResolvedValue(
      preparedWith({
        capabilities: { permissions: { postures: { guarded: { args: ["--ask"] } } } },
      }),
    );

    const result = await applyProjectPermissions({
      projectId: "p1",
      benchId: 1,
      workspacePath: workspace,
      permissions: { allow: ["Bash(*)"], deny: [], ask: [] },
    });

    expect(result.carrier).toBe("none");
    expect(result.written).toEqual([]);
  });
});

describe("describeAgentPermissions", () => {
  it("reports the built-in carrier when no agent plugin resolves", async () => {
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue(undefined);

    expect(await describeAgentPermissions("p1", workspace)).toEqual({
      agentPluginId: null,
      agentName: null,
      postures: [],
      rules: true,
      resync: true,
    });
  });

  it("reports the declared postures and the rules capability", async () => {
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue("claude-code");
    vi.mocked(pipeline.prepareAgentLaunch).mockResolvedValue(preparedWith());

    expect(await describeAgentPermissions("p1", workspace)).toEqual({
      agentPluginId: "claude-code",
      agentName: "Claude Code",
      postures: ["read-only", "full-auto"],
      rules: true,
      resync: true,
    });
  });

  it("reports no rules for an agent that declares none, so the editor is hidden", async () => {
    vi.mocked(pipeline.resolveLaunchAgentId).mockReturnValue("codex");
    vi.mocked(pipeline.prepareAgentLaunch).mockResolvedValue(
      preparedWith({
        capabilities: { permissions: { postures: { guarded: { args: ["--ask"] } } } },
      }),
    );

    const described = await describeAgentPermissions("p1", workspace);
    expect(described.rules).toBe(false);
    expect(described.resync).toBe(false);
    expect(described.postures).toEqual(["guarded"]);
  });
});
