import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRecord } from "@roubo/shared";
import type { WorkspaceWriteSpec } from "@roubo/shared/agent-launch-descriptor-schema";
import {
  AgentDescriptorError,
  collectWorkspaceWrites,
  executeWorkspaceWrites,
  joinShellCommand,
  resolveWriteTemplates,
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

  // Issue #661: a `v`-prefixed floor used to validate here and then classify every
  // detected version as `below-floor`, hard blocking the agent with a misleading
  // message. It is an authoring mistake, so it is named as one at validation.
  it("rejects a version-probe bound that is not exact semver, naming the field", () => {
    const attempt = () =>
      validateDescriptor({
        ...minimalDescriptor,
        capabilities: {
          versionProbe: { args: ["--version"], parse: "semver", minVersion: "v2.1.111" },
        },
      });
    expect(attempt).toThrow(AgentDescriptorError);
    expect(attempt).toThrow(/minVersion/);
    expect(attempt).toThrow(/exact semver/);
  });
});

describe("collectWorkspaceWrites", () => {
  it("returns nothing when the descriptor declares no capabilities", () => {
    expect(collectWorkspaceWrites(validateDescriptor(minimalDescriptor))).toEqual([]);
  });

  // Both notification arms that register their hook in a workspace file put the
  // carrier write through this one collection, so it reaches the same
  // path-validated executeWorkspaceWrites route (issue #854).
  const CARRIER_WRITE = {
    relPath: "c.json",
    format: "json",
    ops: [{ op: "set", path: "hooks", value: "{{notifierCommand}}" }],
  } as const;

  it.each([
    {
      name: "http-hook",
      notification: {
        kind: "http-hook",
        event: "waiting",
        carrier: { workspaceWrite: CARRIER_WRITE },
        correlation: { field: "session_id", source: "agent-native" },
      },
    },
    {
      name: "file-notifier",
      notification: {
        kind: "file-notifier",
        event: "turn-complete",
        carrier: { workspaceWrite: CARRIER_WRITE, args: ["{{notifier}}", "{{sessionId}}"] },
        payload: "json-stdin",
        correlation: { source: "template", template: "{{sessionId}}" },
      },
    },
  ])(
    "orders plain writes, then the selected posture's writes, then the $name carrier",
    ({ notification }) => {
      const descriptor = validateDescriptor({
        ...minimalDescriptor,
        capabilities: {
          workspaceWrites: [
            { relPath: "a.json", format: "json", ops: [{ op: "delete", path: "x" }] },
          ],
          notification,
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
    },
  );

  it("adds no write for a spawned-notifier, whose carrier rides argv", () => {
    const descriptor = validateDescriptor({
      ...minimalDescriptor,
      capabilities: {
        notification: {
          kind: "spawned-notifier",
          event: "turn-complete",
          carrier: { args: ["--notify", "{{notifier}}"] },
          payload: "json-arg",
          correlation: { source: "template", template: "{{sessionId}}" },
        },
      },
    });
    expect(collectWorkspaceWrites(descriptor)).toEqual([]);
  });

  it("rejects a file-notifier carrier write that escapes the workspace, writing nothing", () => {
    const descriptor = validateDescriptor({
      ...minimalDescriptor,
      capabilities: {
        workspaceWrites: [
          { relPath: "a.json", format: "json", ops: [{ op: "delete", path: "x" }] },
        ],
        notification: {
          kind: "file-notifier",
          event: "turn-complete",
          carrier: {
            workspaceWrite: { ...CARRIER_WRITE, relPath: "../escape.json" },
            args: ["{{notifier}}"],
          },
          payload: "json-stdin",
          correlation: { source: "template", template: "{{sessionId}}" },
        },
      },
    });
    expect(() => executeWorkspaceWrites(workspace, collectWorkspaceWrites(descriptor))).toThrow(
      /escapes the bench workspace/,
    );
    expect(fs.existsSync(path.join(workspace, "a.json"))).toBe(false);
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

  it("rejects the AP-TC-082 traversal target, writing nothing outside the workspace", () => {
    // The test case names ../../.ssh/config specifically: a multi-segment
    // traversal reaching a real, sensitive file outside the bench workspace.
    const outside = path.resolve(workspace, "../../.ssh/config");
    const existedBefore = fs.existsSync(outside);
    expect(() =>
      executeWorkspaceWrites(workspace, [
        {
          relPath: "../../.ssh/config",
          format: "text",
          ops: [{ op: "set", path: ".", value: "Host evil\n  User root\n" }],
        },
      ]),
    ).toThrow(/escapes the bench workspace/);
    expect(fs.existsSync(outside)).toBe(existedBefore);
  });

  it("rejects a relPath traversing a symlinked directory out of the workspace", () => {
    // The lexical resolveWithin check cannot see an on-disk symlink, so a
    // symlinked directory component under the workspace would otherwise let a
    // descriptor write anywhere the link points (AP-NFR-001: writes stay
    // confined to the bench workspace).
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-outside-"));
    try {
      fs.symlinkSync(outside, path.join(workspace, "link"), "dir");
      expect(() =>
        executeWorkspaceWrites(workspace, [
          {
            relPath: "link/settings.json",
            format: "json",
            ops: [{ op: "set", path: "a", value: 1 }],
          },
        ]),
      ).toThrow(/escapes the bench workspace/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
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

/**
 * The Cursor hook registration (issue #890, APCC-TC-048). `.cursor/hooks.json`
 * holds arrays of `{ command }` objects, so `unionArray` cannot merge them and
 * `set` replaced the whole array, taking a `stop` hook of the user's with it.
 *
 * The registered command carries a per-launch session id, so the match needles
 * on the part that does not change between launches: the notifier path.
 */
describe("upsertArray (issue #890)", () => {
  const NOTIFIER = "/home/u/.roubo/bin/roubo-notify";

  function hooksWrite(sessionId: string): WorkspaceWriteSpec {
    return {
      relPath: ".cursor/hooks.json",
      format: "json",
      ops: [
        { op: "set", path: "version", value: 1 },
        {
          op: "upsertArray",
          path: "hooks.stop",
          value: { command: `${NOTIFIER} ${sessionId}` },
          match: { key: "command", contains: NOTIFIER },
        },
      ],
    };
  }

  function seedHooks(contents: Record<string, unknown>): void {
    fs.mkdirSync(path.join(workspace, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".cursor/hooks.json"), JSON.stringify(contents));
  }

  it("keeps the user's own stop hook and registers the notifier alongside it", () => {
    seedHooks({
      version: 1,
      hooks: {
        stop: [{ command: "my-own-stop-hook" }],
        beforeShellExecution: [{ command: "my-own-guard" }],
      },
      userKey: "keep",
    });

    executeWorkspaceWrites(workspace, [hooksWrite("sid-1")]);

    expect(readJson(".cursor/hooks.json")).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "my-own-stop-hook" }, { command: `${NOTIFIER} sid-1` }],
        beforeShellExecution: [{ command: "my-own-guard" }],
      },
      userKey: "keep",
    });
  });

  it("replaces its own earlier entry rather than adding a second one", () => {
    seedHooks({ version: 1, hooks: { stop: [{ command: "my-own-stop-hook" }] } });

    executeWorkspaceWrites(workspace, [hooksWrite("sid-1")]);
    executeWorkspaceWrites(workspace, [hooksWrite("sid-2")]);

    expect(readJson(".cursor/hooks.json")).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "my-own-stop-hook" }, { command: `${NOTIFIER} sid-2` }],
      },
    });
  });

  it("matches the notifier inside a shell-quoted command", () => {
    const spaced = "/Users/a b/.roubo/bin/roubo-notify";
    const write: WorkspaceWriteSpec = {
      relPath: ".cursor/hooks.json",
      format: "json",
      ops: [
        {
          op: "upsertArray",
          path: "hooks.stop",
          value: { command: joinShellCommand([spaced, "sid-1"]) },
          match: { key: "command", contains: spaced },
        },
      ],
    };
    seedHooks({ hooks: { stop: [{ command: joinShellCommand([spaced, "sid-0"]) }] } });

    executeWorkspaceWrites(workspace, [write]);

    expect(readJson(".cursor/hooks.json")).toEqual({
      hooks: { stop: [{ command: `'/Users/a b/.roubo/bin/roubo-notify' sid-1` }] },
    });
  });

  it("leaves entries the match does not select, whatever their shape", () => {
    seedHooks({
      hooks: {
        stop: ["a bare string", 7, null, ["nested"], { note: "no command key" }],
      },
    });

    executeWorkspaceWrites(workspace, [hooksWrite("sid-1")]);

    expect(readJson(".cursor/hooks.json")).toEqual({
      version: 1,
      hooks: {
        stop: [
          "a bare string",
          7,
          null,
          ["nested"],
          { note: "no command key" },
          { command: `${NOTIFIER} sid-1` },
        ],
      },
    });
  });

  it("matches a needle the carrier shell-quoted around a single quote", () => {
    // `quoteShellWord` wraps most values, leaving the raw needle a substring,
    // which is why the spaced path above matches. A single quote is the one
    // character it rewrites (`'` becomes `'\''`), so the raw path is absent
    // from the command and only the quoted spelling finds the earlier entry.
    // Miss it and every launch appends another Roubo entry.
    const quoted = "/Users/o'brien/.roubo/bin/roubo-notify";
    function write(sessionId: string): WorkspaceWriteSpec {
      return {
        relPath: ".cursor/hooks.json",
        format: "json",
        ops: [
          {
            op: "upsertArray",
            path: "hooks.stop",
            value: { command: joinShellCommand([quoted, sessionId]) },
            match: { key: "command", contains: quoted },
          },
        ],
      };
    }
    seedHooks({ hooks: { stop: [{ command: "my-own-stop-hook" }] } });

    executeWorkspaceWrites(workspace, [write("sid-1")]);
    executeWorkspaceWrites(workspace, [write("sid-2")]);

    const stop = (readJson(".cursor/hooks.json").hooks as { stop: unknown[] }).stop;
    expect(stop).toEqual([
      { command: "my-own-stop-hook" },
      { command: joinShellCommand([quoted, "sid-2"]) },
    ]);
  });

  it("replaces a value that is not an array, as unionArray does", () => {
    seedHooks({ hooks: { stop: "not an array" } });

    executeWorkspaceWrites(workspace, [hooksWrite("sid-1")]);

    expect(readJson(".cursor/hooks.json")).toEqual({
      version: 1,
      hooks: { stop: [{ command: `${NOTIFIER} sid-1` }] },
    });
  });

  it("resolves templates in both the entry and the match needle", () => {
    const [resolved] = resolveWriteTemplates(
      [
        {
          relPath: ".cursor/hooks.json",
          format: "json",
          ops: [
            {
              op: "upsertArray",
              path: "hooks.stop",
              value: { command: "{{notifierCommand}}" },
              match: { key: "command", contains: "{{notifier}}" },
            },
          ],
        },
      ],
      {
        ports: {},
        portHttps: {},
        workspace,
        components: {},
        notifier: NOTIFIER,
        notifierCommand: `${NOTIFIER} sid-1`,
      },
    );

    expect(resolved.ops[0]).toEqual({
      op: "upsertArray",
      path: "hooks.stop",
      value: { command: `${NOTIFIER} sid-1` },
      match: { key: "command", contains: NOTIFIER },
    });
  });

  it("rejects upsertArray on a text-format write", () => {
    expect(() =>
      executeWorkspaceWrites(workspace, [
        {
          relPath: "notes.txt",
          format: "text",
          ops: [
            {
              op: "upsertArray",
              path: ".",
              value: { command: "x" },
              match: { key: "command", contains: "x" },
            },
          ],
        },
      ]),
    ).toThrow(/not supported for a text-format/);
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

describe("joinShellCommand (issue #854)", () => {
  it("leaves plain words bare and joins them with single spaces", () => {
    expect(joinShellCommand(["/home/u/.roubo/bin/roubo-notify", "abc-123", "--x=1"])).toBe(
      "/home/u/.roubo/bin/roubo-notify abc-123 --x=1",
    );
  });

  it("single-quotes a word carrying whitespace or shell metacharacters", () => {
    expect(joinShellCommand(["/Users/a b/roubo-notify", "x;rm -rf /", "$HOME", "`id`"])).toBe(
      "'/Users/a b/roubo-notify' 'x;rm -rf /' '$HOME' '`id`'",
    );
  });

  it("escapes an embedded single quote so the word stays one word", () => {
    expect(joinShellCommand(["it's"])).toBe("'it'\\''s'");
  });

  it("keeps an empty element as an explicit empty word", () => {
    expect(joinShellCommand(["a", ""])).toBe("a ''");
  });

  it("round-trips through a real POSIX shell as the original argv", () => {
    const words = ["plain", "with space", "it's", "$HOME", "a;b", "", 'dq"x', "back\\slash"];
    const out = execFileSync(
      "/bin/sh",
      ["-c", `for a in ${joinShellCommand(words)}; do printf '%s\\0' "$a"; done`],
      { encoding: "utf-8" },
    );
    expect(out.split("\0").slice(0, -1)).toEqual(words);
  });
});
