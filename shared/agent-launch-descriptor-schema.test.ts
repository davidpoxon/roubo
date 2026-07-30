import { describe, expect, it } from "vitest";
import {
  AgentLaunchDescriptorSchema,
  AgentPermissionsModelSchema,
  NotificationWiringSchema,
  PermissionsCapabilitySchema,
  SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION,
  VersionProbeSpecSchema,
  WaitingDetectionSpecSchema,
  WorkspaceWriteSpecSchema,
  WriteOpSchema,
  type AgentLaunchDescriptor,
} from "./agent-launch-descriptor-schema";

const V = SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION;

function minimal(): AgentLaunchDescriptor {
  return { schemaVersion: V, kind: "agent-launch", command: "claude", args: [] };
}

describe("AgentLaunchDescriptor schema version", () => {
  it("exports a supported version constant of 1", () => {
    expect(SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION).toBe(1);
  });

  it("rejects a mismatched schemaVersion", () => {
    const result = AgentLaunchDescriptorSchema.safeParse({ ...minimal(), schemaVersion: 2 });
    expect(result.success).toBe(false);
  });
});

describe("mandatory launch surface", () => {
  it("parses a descriptor carrying only command and args", () => {
    expect(AgentLaunchDescriptorSchema.parse(minimal())).toEqual(minimal());
  });

  it("parses the full Claude-shaped launch from spike 502", () => {
    const full: AgentLaunchDescriptor = {
      schemaVersion: V,
      kind: "agent-launch",
      command: "claude",
      args: ["--model", "haiku", "--permission-mode", "plan", "--session-id", "{{sessionId}}"],
      env: { ROUBO_AGENT: "claude" },
      cwd: "{{workspace}}",
      initialPrompt: { mode: "argv-positional", maxLength: 100000 },
      capabilities: {
        workspaceWrites: [
          {
            relPath: ".claude/settings.local.json",
            format: "json",
            ops: [
              { op: "unionArray", path: "permissions.allow", values: ["Bash(ls:*)"] },
              { op: "set", path: "permissions.defaultMode", value: "plan" },
              { op: "delete", path: "permissions.legacy" },
            ],
          },
        ],
        notification: {
          kind: "http-hook",
          event: "waiting",
          carrier: {
            workspaceWrite: {
              relPath: ".claude/settings.local.json",
              format: "json",
              ops: [
                {
                  op: "set",
                  path: "hooks.Notification",
                  value: [
                    {
                      hooks: [{ type: "http", url: "http://localhost:{{port}}/api/hooks/agent" }],
                    },
                  ],
                },
              ],
            },
          },
          correlation: { field: "session_id", source: "agent-native" },
        },
        versionProbe: {
          args: ["--version"],
          parse: "semver",
          minVersion: "2.1.83",
          testedCeiling: "2.1.207",
        },
        waitingDetection: { kind: "hook-driven", quiescenceFallbackMs: 8000 },
        permissions: {
          postures: {
            "read-only": { args: ["--permission-mode", "plan"] },
            guarded: { args: ["--permission-mode", "default"] },
          },
          rules: { carrier: "workspace-write", resync: true },
        },
      },
    };
    expect(AgentLaunchDescriptorSchema.parse(full)).toEqual(full);
  });

  it("parses the Codex-shaped launch, which declares no workspaceWrites", () => {
    const codex: AgentLaunchDescriptor = {
      schemaVersion: V,
      kind: "agent-launch",
      command: "codex",
      args: ["-m", "gpt-5.1-codex", "-c", 'approval_policy="never"'],
      initialPrompt: { mode: "argv-positional" },
      capabilities: {
        notification: {
          kind: "spawned-notifier",
          event: "turn-complete",
          carrier: { args: ["-c", 'notify=["roubo-notify","{{sessionId}}"]'] },
          payload: "json-arg",
          correlation: { source: "template", template: "{{sessionId}}" },
        },
        versionProbe: { args: ["--version"], parse: "semver", testedCeiling: "0.144.1" },
        waitingDetection: { kind: "quiescence-only", debounceMs: 8000 },
        permissions: { postures: { "full-auto": { args: ["-c", 'approval_policy="never"'] } } },
      },
    };
    const parsed = AgentLaunchDescriptorSchema.parse(codex);
    expect(parsed.capabilities?.workspaceWrites).toBeUndefined();
  });

  it("rejects an empty command", () => {
    expect(AgentLaunchDescriptorSchema.safeParse({ ...minimal(), command: "" }).success).toBe(
      false,
    );
  });

  it("rejects a non-array args", () => {
    expect(AgentLaunchDescriptorSchema.safeParse({ ...minimal(), args: "--print" }).success).toBe(
      false,
    );
  });

  it("rejects unknown top-level fields", () => {
    expect(AgentLaunchDescriptorSchema.safeParse({ ...minimal(), shell: true }).success).toBe(
      false,
    );
  });

  it("rejects an unknown capability key", () => {
    expect(
      AgentLaunchDescriptorSchema.safeParse({
        ...minimal(),
        capabilities: { networkEgress: {} },
      }).success,
    ).toBe(false);
  });
});

describe("capability absence is first-class", () => {
  it("accepts an empty capabilities object", () => {
    const parsed = AgentLaunchDescriptorSchema.parse({ ...minimal(), capabilities: {} });
    expect(parsed.capabilities).toEqual({});
  });

  it("accepts a descriptor with no capabilities key at all", () => {
    expect(AgentLaunchDescriptorSchema.parse(minimal()).capabilities).toBeUndefined();
  });
});

describe("WriteOp", () => {
  it("parses each of the three ops", () => {
    expect(WriteOpSchema.parse({ op: "unionArray", path: "a.b", values: ["x"] })).toEqual({
      op: "unionArray",
      path: "a.b",
      values: ["x"],
    });
    expect(WriteOpSchema.parse({ op: "set", path: "a.b", value: { c: 1 } })).toEqual({
      op: "set",
      path: "a.b",
      value: { c: 1 },
    });
    expect(WriteOpSchema.parse({ op: "delete", path: "a.b" })).toEqual({
      op: "delete",
      path: "a.b",
    });
  });

  it("rejects an unknown op", () => {
    expect(WriteOpSchema.safeParse({ op: "append", path: "a", value: 1 }).success).toBe(false);
  });

  it("rejects a set op with no value", () => {
    expect(WriteOpSchema.safeParse({ op: "set", path: "a" }).success).toBe(false);
  });

  it("rejects a unionArray op carrying non-string values", () => {
    expect(WriteOpSchema.safeParse({ op: "unionArray", path: "a", values: [1] }).success).toBe(
      false,
    );
  });
});

describe("WorkspaceWriteSpec", () => {
  it("requires at least one op", () => {
    expect(
      WorkspaceWriteSpecSchema.safeParse({ relPath: "a.json", format: "json", ops: [] }).success,
    ).toBe(false);
  });

  it("accepts a relative path with traversal, leaving containment to the host", () => {
    // The schema is a shape gate, not a path gate: `resolveWithin` is the
    // containment barrier and it lives in the executor, so the schema must not
    // be mistaken for the security boundary.
    const parsed = WorkspaceWriteSpecSchema.parse({
      relPath: "../escape.json",
      format: "json",
      ops: [{ op: "delete", path: "a" }],
    });
    expect(parsed.relPath).toBe("../escape.json");
  });
});

describe("NotificationWiring", () => {
  it("rejects mixing the two carrier shapes", () => {
    expect(
      NotificationWiringSchema.safeParse({
        kind: "http-hook",
        event: "waiting",
        carrier: { args: ["-c", "notify=[]"] },
        correlation: { field: "session_id", source: "agent-native" },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown wiring kind", () => {
    expect(NotificationWiringSchema.safeParse({ kind: "websocket" }).success).toBe(false);
  });
});

describe("VersionProbeSpec", () => {
  it("accepts a ceiling-only probe", () => {
    expect(
      VersionProbeSpecSchema.parse({
        args: ["--version"],
        parse: "semver",
        testedCeiling: "1.2.3",
      }),
    ).toEqual({ args: ["--version"], parse: "semver", testedCeiling: "1.2.3" });
  });

  it("rejects an unsupported parse strategy", () => {
    expect(VersionProbeSpecSchema.safeParse({ args: ["--version"], parse: "regex" }).success).toBe(
      false,
    );
  });

  // Issue #661: a bound the semver comparison cannot parse used to be accepted
  // here and then classified `below-floor` for every detected version, hard
  // blocking the agent with a misleading message. Both bounds now refine against
  // what `compareVersions` can actually turn into three numbers.
  //
  // The prerelease and build-metadata cases matter for the same reason:
  // `"2.1.111-beta.1".split(".")` yields a `"111-beta"` segment that `Number`
  // reads as NaN, so such a bound is just as uncomparable as `v2.1.111` even
  // though it is valid semver. The manifest side rejects them too since #669, so
  // both schemas now share the one `isExactSemverVersion` predicate.
  const UNCOMPARABLE_BOUNDS = [
    "v2.1.111",
    "2.1",
    "2",
    ">=2.1.0",
    "^2.1.0",
    "2.1.x",
    "latest",
    "2.1.111-beta.1",
    "2.1.111+build.5",
  ];

  it.each(UNCOMPARABLE_BOUNDS)("rejects an uncomparable minVersion (%s)", (minVersion) => {
    const result = VersionProbeSpecSchema.safeParse({
      args: ["--version"],
      parse: "semver",
      minVersion,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["minVersion"]);
  });

  it.each(UNCOMPARABLE_BOUNDS)("rejects an uncomparable testedCeiling (%s)", (testedCeiling) => {
    const result = VersionProbeSpecSchema.safeParse({
      args: ["--version"],
      parse: "semver",
      testedCeiling,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["testedCeiling"]);
  });

  it("accepts a bare major.minor.patch window on both bounds", () => {
    const spec = {
      args: ["--version"],
      parse: "semver" as const,
      minVersion: "2.1.111",
      testedCeiling: "2.1.207",
    };
    expect(VersionProbeSpecSchema.parse(spec)).toEqual(spec);
  });
});

describe("WaitingDetectionSpec", () => {
  it("requires debounceMs on the quiescence-only variant", () => {
    expect(WaitingDetectionSpecSchema.safeParse({ kind: "quiescence-only" }).success).toBe(false);
  });

  it("allows hook-driven with no fallback", () => {
    expect(WaitingDetectionSpecSchema.parse({ kind: "hook-driven" })).toEqual({
      kind: "hook-driven",
    });
  });
});

describe("PermissionsCapability", () => {
  it("allows a partial posture map", () => {
    expect(PermissionsCapabilitySchema.parse({ postures: { guarded: {} } })).toEqual({
      postures: { guarded: {} },
    });
  });

  it("rejects an unknown posture name", () => {
    expect(
      PermissionsCapabilitySchema.safeParse({ postures: { yolo: { args: [] } } }).success,
    ).toBe(false);
  });
});

describe("AgentPermissionsModel", () => {
  it("accepts a payload with no posture, the shape core sends when the project chose none", () => {
    const rules = { allow: [], ask: [], deny: [] };
    expect(AgentPermissionsModelSchema.parse({ rules })).toEqual({ rules });
  });

  it("rejects a payload without rules, which core always sends", () => {
    expect(AgentPermissionsModelSchema.safeParse({ posture: "guarded" }).success).toBe(false);
  });
});
