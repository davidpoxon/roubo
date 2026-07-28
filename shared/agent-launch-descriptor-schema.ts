import { z } from "zod";

// Issue #507 / AP-FR-001: the typed AgentLaunchDescriptor an agent plugin emits
// from `translateLaunch` and the host executes. See:
//   .specifications/agent-plugins/prd.md (AP-FR-001, AP-NFR-001, AP-US-001)
//   .specifications/agent-plugins/spikes/spike-502-agent-contract-shape.md
//
// The shape is frozen by spike #502, which validated it against real Claude Code
// and Codex CLI invocations. It lives in shared/ so both the host and the plugin
// SDK reference one contract without a circular dependency (the SDK carries a
// structural restatement in plugin-sdk/src/types.ts; this Zod schema is the
// authority and the host validates every descriptor against it).
//
// The contract is declarative only: there is deliberately NO imperative escape
// hatch. PTY spawn, workspace writes, hook receipt, and quiescence stay
// core-owned, so an agent plugin gains no privilege the runtime sandbox does not
// already grant an integration plugin (AP-NFR-001).

export const SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION = 1 as const;

// ── Workspace writes ──
//
// A plugin can never reach a bench workspace itself: the plugin-fs broker
// allowlist grants only the plugin dir plus statically declared manifest paths
// (server/services/plugin-fs.ts). Every workspace write is therefore declared as
// data here and executed core-side under `resolveWithin(workspacePath, relPath)`,
// which is the mechanism AP-TC-014 S003-O02 asserts.

/**
 * One mutation applied to the parsed existing file, in declaration order.
 * Unknown keys survive because ops mutate the parsed file rather than replacing
 * it (the `writeClaudeSettingsLocal` preserve-unknown-keys precedent).
 *
 * - `unionArray`: union-merge string values into the array at `path`.
 * - `set`: overwrite the value at `path` (JSON-serializable values only).
 * - `delete`: remove the key at `path`.
 */
export const WriteOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("unionArray"),
      path: z.string().min(1),
      values: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      op: z.literal("set"),
      path: z.string().min(1),
      // z.json() rejects `undefined`, so a `set` op always carries a real value
      // rather than silently degrading into a delete.
      value: z.json(),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      path: z.string().min(1),
    })
    .strict(),
]);
export type WriteOp = z.infer<typeof WriteOpSchema>;

export const WorkspaceWriteSpecSchema = z
  .object({
    /** Resolved within the bench workspace; escapes are rejected by the host. */
    relPath: z.string().min(1),
    format: z.enum(["json", "text"]),
    ops: z.array(WriteOpSchema).min(1),
  })
  .strict();
export type WorkspaceWriteSpec = z.infer<typeof WorkspaceWriteSpecSchema>;

// ── Notification wiring ──
//
// Discriminated on `kind`, covering the two real shapes spike #502 validated: an
// agent that POSTs to core itself (Claude Code's Notification hook) and an agent
// that spawns a notifier program per event (Codex `notify`). The `event` field
// tells core what the signal means, so waiting semantics never leak into plugins.

export const NotificationWiringSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("http-hook"),
      event: z.literal("waiting"),
      // The hook registration itself lives in a workspace settings file, so the
      // carrier is an ordinary core-executed workspace write.
      carrier: z.object({ workspaceWrite: WorkspaceWriteSpecSchema }).strict(),
      correlation: z
        .object({
          field: z.literal("session_id"),
          source: z.literal("agent-native"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("spawned-notifier"),
      event: z.literal("turn-complete"),
      // Argv the host appends when spawning the agent; string elements may carry
      // {{sessionId}} / {{port}} / {{workspace}} for core to resolve.
      carrier: z.object({ args: z.array(z.string()) }).strict(),
      payload: z.literal("json-arg"),
      correlation: z
        .object({
          source: z.literal("template"),
          template: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);
export type NotificationWiring = z.infer<typeof NotificationWiringSchema>;

// ── Version probe ──
//
// Generalizes server/services/claude-version.ts: the probe args, the semver
// extraction, an optional floor a launch is blocked below, and an optional
// tested ceiling a launch warns above (AP-FR-014).

export const VersionProbeSpecSchema = z
  .object({
    args: z.array(z.string()).min(1),
    parse: z.literal("semver"),
    minVersion: z.string().min(1).optional(),
    testedCeiling: z.string().min(1).optional(),
  })
  .strict();
export type VersionProbeSpec = z.infer<typeof VersionProbeSpecSchema>;

// ── Waiting detection ──
//
// Absent, an agent gets the generic quiescence debounce every non-Claude
// terminal already receives; nothing in core requires this capability to exist.

export const WaitingDetectionSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("hook-driven"),
      quiescenceFallbackMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("quiescence-only"),
      debounceMs: z.number().int().positive(),
    })
    .strict(),
]);
export type WaitingDetectionSpec = z.infer<typeof WaitingDetectionSpecSchema>;

// ── Permissions ──
//
// One user-facing model with two axes (AP-FR-016, narrowed by spike #502): a
// universal `posture` every agent plugin maps to its native mechanism, plus
// optional fine-grained rules honored only by plugins declaring the rules
// capability. Core stores, unions, and injects rule strings; it never parses
// them, so no agent-specific vocabulary reaches core's types.

export const AgentPostureSchema = z.enum(["read-only", "guarded", "auto-edit", "full-auto"]);
export type AgentPosture = z.infer<typeof AgentPostureSchema>;

export const AgentPermissionsModelSchema = z
  .object({
    posture: AgentPostureSchema,
    rules: z
      .object({
        allow: z.array(z.string()),
        ask: z.array(z.string()),
        deny: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentPermissionsModel = z.infer<typeof AgentPermissionsModelSchema>;

const PostureBindingSchema = z
  .object({
    args: z.array(z.string()).optional(),
    workspaceWrites: z.array(WorkspaceWriteSpecSchema).optional(),
  })
  .strict();

// An explicit object rather than a record so an unknown posture name is a
// validation error, not a silently ignored key.
const PostureBindingsSchema = z
  .object({
    "read-only": PostureBindingSchema.optional(),
    guarded: PostureBindingSchema.optional(),
    "auto-edit": PostureBindingSchema.optional(),
    "full-auto": PostureBindingSchema.optional(),
  })
  .strict();

export const PermissionsCapabilitySchema = z
  .object({
    postures: PostureBindingsSchema,
    /** Absent means the fine-grained rules editor is hidden for this agent. */
    rules: z
      .object({
        carrier: z.literal("workspace-write"),
        resync: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PermissionsCapability = z.infer<typeof PermissionsCapabilitySchema>;

// ── Declared capabilities ──
//
// Every capability is optional and absence is first-class: no `workspaceWrites`
// means core writes nothing into the workspace, no `notification` means nothing
// is wired, no `versionProbe` means no gate, no `waitingDetection` means the
// generic quiescence debounce, no `permissions` means core injects nothing. An
// agent declaring zero capabilities launches as a plain terminal session.

export const AgentCapabilitiesSchema = z
  .object({
    workspaceWrites: z.array(WorkspaceWriteSpecSchema).optional(),
    notification: NotificationWiringSchema.optional(),
    versionProbe: VersionProbeSpecSchema.optional(),
    waitingDetection: WaitingDetectionSpecSchema.optional(),
    permissions: PermissionsCapabilitySchema.optional(),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

// ── Descriptor ──
//
// `command` + `args` are the entire mandatory surface. `args` is an argv array,
// never shell-interpreted (AP-NFR-001); string elements may carry
// {{sessionId}} / {{port}} / {{workspace}}, which core resolves so a plugin
// declares shape and never learns a real port or mints a session id.

export const AgentLaunchDescriptorSchema = z
  .object({
    schemaVersion: z.literal(SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION),
    kind: z.literal("agent-launch"),
    command: z.string().min(1),
    args: z.array(z.string()),
    /** Additive over the host env AFTER core strips its internal keys. */
    env: z.record(z.string(), z.string()).optional(),
    /** Defaults to the bench workspace path. */
    cwd: z.string().min(1).optional(),
    initialPrompt: z
      .object({
        mode: z.literal("argv-positional"),
        maxLength: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    capabilities: AgentCapabilitiesSchema.optional(),
  })
  .strict();
export type AgentLaunchDescriptor = z.infer<typeof AgentLaunchDescriptorSchema>;
