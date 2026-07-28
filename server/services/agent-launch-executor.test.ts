import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRecord } from "@roubo/shared";
import {
  AgentDescriptorError,
  collectWorkspaceWrites,
  executeWorkspaceWrites,
  runLaunchDescriptor,
  validateDescriptor,
} from "./agent-launch-executor.js";
import { assertPathAllowed, resolveAllowedRoots } from "./plugin-fs.js";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-launch-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(workspace, relPath), "utf-8"));
}

const minimalDescriptor = {
  schemaVersion: 1,
  kind: "agent-launch",
  command: "my-agent",
  args: [],
} as const;

describe("validateDescriptor", () => {
  it("accepts the mandatory command/args surface", () => {
    expect(validateDescriptor(minimalDescriptor)).toEqual(minimalDescriptor);
  });

  it("names the supplied version on a schemaVersion mismatch", () => {
    expect(() => validateDescriptor({ ...minimalDescriptor, schemaVersion: 2 })).toThrow(
      /schemaVersion 2; this host supports schemaVersion 1/,
    );
  });

  it("rejects a structurally invalid descriptor", () => {
    expect(() => validateDescriptor({ schemaVersion: 1, kind: "agent-launch" })).toThrow(
      AgentDescriptorError,
    );
  });

  it("rejects a non-object entirely", () => {
    expect(() => validateDescriptor("claude --print")).toThrow(AgentDescriptorError);
  });
});

describe("collectWorkspaceWrites", () => {
  it("returns nothing when the descriptor declares no capabilities", () => {
    expect(collectWorkspaceWrites(validateDescriptor(minimalDescriptor))).toEqual([]);
  });

  it("orders plain writes, then the selected posture's writes, then the http-hook carrier", () => {
    const descriptor = validateDescriptor({
      ...minimalDescriptor,
      capabilities: {
        workspaceWrites: [
          { relPath: "a.json", format: "json", ops: [{ op: "delete", path: "x" }] },
        ],
        notification: {
          kind: "http-hook",
          event: "waiting",
          carrier: {
            workspaceWrite: {
              relPath: "c.json",
              format: "json",
              ops: [{ op: "set", path: "hooks", value: 1 }],
            },
          },
          correlation: { field: "session_id", source: "agent-native" },
        },
        permissions: {
          postures: {
            guarded: {
              workspaceWrites: [
                { relPath: "b.json", format: "json", ops: [{ op: "delete", path: "y" }] },
              ],
            },
          },
        },
      },
    });
    expect(
      collectWorkspaceWrites(descriptor, { posture: "guarded" }).map((w) => w.relPath),
    ).toEqual(["a.json", "b.json", "c.json"]);
  });

  it("omits a posture's writes when that posture is not selected", () => {
    const descriptor = validateDescriptor({
      ...minimalDescriptor,
      capabilities: {
        permissions: {
          postures: {
            guarded: {
              workspaceWrites: [
                { relPath: "b.json", format: "json", ops: [{ op: "delete", path: "y" }] },
              ],
            },
          },
        },
      },
    });
    expect(collectWorkspaceWrites(descriptor, { posture: "read-only" })).toEqual([]);
  });
});

describe("executeWorkspaceWrites", () => {
  it("creates a nested JSON file from a set op", () => {
    executeWorkspaceWrites(workspace, [
      {
        relPath: ".agent/settings.local.json",
        format: "json",
        ops: [{ op: "set", path: "permissions.defaultMode", value: "plan" }],
      },
    ]);
    expect(readJson(".agent/settings.local.json")).toEqual({
      permissions: { defaultMode: "plan" },
    });
  });

  it("union-merges arrays and preserves unknown keys in an existing file", () => {
    fs.mkdirSync(path.join(workspace, ".agent"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".agent/settings.local.json"),
      JSON.stringify({ userKey: "keep", permissions: { allow: ["Bash(ls:*)"], other: 1 } }),
    );

    executeWorkspaceWrites(workspace, [
      {
        relPath: ".agent/settings.local.json",
        format: "json",
        ops: [
          { op: "unionArray", path: "permissions.allow", values: ["Bash(ls:*)", "Bash(cat:*)"] },
        ],
      },
    ]);

    expect(readJson(".agent/settings.local.json")).toEqual({
      userKey: "keep",
      permissions: { allow: ["Bash(ls:*)", "Bash(cat:*)"], other: 1 },
    });
  });

  it("applies delete ops and leaves unrelated keys alone", () => {
    fs.writeFileSync(
      path.join(workspace, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "auto", allow: ["x"] } }),
    );
    executeWorkspaceWrites(workspace, [
      {
        relPath: "settings.json",
        format: "json",
        ops: [{ op: "delete", path: "permissions.defaultMode" }],
      },
    ]);
    expect(readJson("settings.json")).toEqual({ permissions: { allow: ["x"] } });
  });

  it("applies ops in declaration order", () => {
    executeWorkspaceWrites(workspace, [
      {
        relPath: "settings.json",
        format: "json",
        ops: [
          { op: "set", path: "a", value: 1 },
          { op: "set", path: "a", value: 2 },
          { op: "delete", path: "a" },
          { op: "set", path: "a", value: 3 },
        ],
      },
    ]);
    expect(readJson("settings.json")).toEqual({ a: 3 });
  });

  it("writes and then removes a text-format file", () => {
    executeWorkspaceWrites(workspace, [
      { relPath: "notes.txt", format: "text", ops: [{ op: "set", path: ".", value: "hello" }] },
    ]);
    expect(fs.readFileSync(path.join(workspace, "notes.txt"), "utf-8")).toBe("hello");

    executeWorkspaceWrites(workspace, [
      { relPath: "notes.txt", format: "text", ops: [{ op: "delete", path: "." }] },
    ]);
    expect(fs.existsSync(path.join(workspace, "notes.txt"))).toBe(false);
  });

  it("rejects unionArray on a text-format write", () => {
    expect(() =>
      executeWorkspaceWrites(workspace, [
        {
          relPath: "notes.txt",
          format: "text",
          ops: [{ op: "unionArray", path: ".", values: [] }],
        },
      ]),
    ).toThrow(/not supported for a text-format/);
  });

  it("rejects a relPath that escapes the workspace, writing nothing at all", () => {
    expect(() =>
      executeWorkspaceWrites(workspace, [
        { relPath: "ok.json", format: "json", ops: [{ op: "set", path: "a", value: 1 }] },
        {
          relPath: "../escaped.json",
          format: "json",
          ops: [{ op: "set", path: "a", value: 1 }],
        },
      ]),
    ).toThrow(/escapes the bench workspace/);
    // Containment is checked for the whole batch up front, so the first (legal)
    // write never lands either.
    expect(fs.existsSync(path.join(workspace, "ok.json"))).toBe(false);
  });

  it("rejects an absolute relPath", () => {
    expect(() =>
      executeWorkspaceWrites(workspace, [
        { relPath: "/etc/passwd", format: "json", ops: [{ op: "set", path: "a", value: 1 }] },
      ]),
    ).toThrow(/must be relative/);
  });

  it("rejects a prototype-polluting write-op path", () => {
    expect(() =>
      executeWorkspaceWrites(workspace, [
        {
          relPath: "settings.json",
          format: "json",
          ops: [{ op: "set", path: "__proto__.polluted", value: true }],
        },
      ]),
    ).toThrow(/unsafe segment/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("runLaunchDescriptor", () => {
  it("validates then applies, reporting the absolute paths written", () => {
    const { descriptor, written } = runLaunchDescriptor(
      {
        ...minimalDescriptor,
        capabilities: {
          workspaceWrites: [
            {
              relPath: ".agent/settings.json",
              format: "json",
              ops: [{ op: "set", path: "model", value: "haiku" }],
            },
          ],
        },
      },
      workspace,
    );
    expect(descriptor.command).toBe("my-agent");
    expect(written).toEqual([path.join(workspace, ".agent/settings.json")]);
  });

  it("touches nothing when the descriptor fails validation", () => {
    expect(() =>
      runLaunchDescriptor(
        {
          ...minimalDescriptor,
          schemaVersion: 99,
          capabilities: {
            workspaceWrites: [
              { relPath: "a.json", format: "json", ops: [{ op: "set", path: "a", value: 1 }] },
            ],
          },
        },
        workspace,
      ),
    ).toThrow(AgentDescriptorError);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});

describe("the plugin itself still cannot write the workspace (AP-TC-014 S003-O02)", () => {
  it("denies a plugin host.fs write into the bench workspace", async () => {
    // An agent plugin's broker allowlist is its own plugin dir plus statically
    // declared manifest paths. A bench workspace is neither, so the descriptor
    // route above is the ONLY way a plugin's requested write can land.
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-plugin-"));
    try {
      const record = {
        id: "claude-code",
        pluginDir,
        manifest: {
          permissions: { filesystem: { paths: [] } },
        },
      } as unknown as PluginRecord;

      const roots = await resolveAllowedRoots(record);
      await expect(
        assertPathAllowed(
          "claude-code",
          "fs/writeFile",
          path.join(workspace, ".agent/settings.json"),
          roots,
          () => {},
        ),
      ).rejects.toThrow(/Permission denied: path-not-in-allowlist/);

      // The same plugin can still write inside its own directory, so the denial
      // above is the workspace boundary rather than a blanket failure.
      await expect(
        assertPathAllowed(
          "claude-code",
          "fs/writeFile",
          path.join(pluginDir, "cache.json"),
          roots,
          () => {},
        ),
      ).resolves.toBeTruthy();
    } finally {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});
