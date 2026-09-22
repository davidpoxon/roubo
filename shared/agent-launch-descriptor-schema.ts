import { z } from "zod";
import { isExactSemverVersion } from "./plugin-manifest-schema.js";

// #1026 / AP-FR-001: the typed AgentLaunchDescriptor an agent plugin emits
// from `translateLaunch` and the host executes. See:
//   .specifications/agent-plugins/prd.md (AP-FR-001, AP-NFR-001, AP-US-001)
//   .specifications/agent-plugins/spikes/spike-502-agent-contract-shape.md
//
// The shape is frozen by the agent-contract spike, which validated it against real Claude Code
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
 * it (the preserve-unknown-keys precedent the removed built-in writer set).
 *
 * - `unionArray`: union-merge string values into the array at `path`.
 * - `upsertArray`: merge one object into the array at `path`, keeping every
 *   entry the declared `match` does not select and appending `value` last.
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
      op: z.literal("upsertArray"),
      path: z.string().min(1),
      // An object rather than any JSON value: `match.key` is read off each
      // entry, so a scalar could never be matched and never be replaced on the
      // next write. Narrowing it here makes that an authoring error a plugin
      // sees at validation rather than a duplicate entry a user sees on disk.
      value: z.record(z.string(), z.json()),
      // How the host recognises an entry it wrote before. `contains` rather
      // than equality because the value a carrier writes can carry a per-launch
      // id, while the part that identifies the writer stays fixed.
      match: z
        .object({
          key: z.string().min(1),
          contains: z.string().min(1),
        })
        .strict(),
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
// Discriminated on `kind`, covering the two real shapes the agent-contract spike validated: an
// agent that POSTs to core itself (Claude Code's Notification hook) and an agent
// that spawns a notifier program per event (Codex `notify`). A third shape
// (#1264, APCC-FR-004) pairs the first one's registration carrier with the
// second one's execution model: the hook is registered by a workspace file, the
// agent spawns core's notifier, and the payload arrives on the notifier's stdin.
// The `event` field tells core what the signal means, so waiting semantics never
// leak into plugins.

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
      // {{sessionId}} / {{port}} / {{workspace}} / {{notifier}} for core to
      // resolve. {{notifier}} is the absolute path of the notifier program core
      // installs for this launch, and is exclusive to the two notifier arms; the
      // program's directory also leads the agent's PATH, so a bare
      // `roubo-notify` resolves without it (#1113).
      carrier: z.object({ args: z.array(z.string()) }).strict(),
      payload: z.literal("json-arg"),
      // Resolved through the same substitution, in the same context, as the
      // carrier argv above, so the token the notifier is invoked with is the one
      // the host later looks up. Declare something session-derived: a constant
      // is guessable, and the host refuses a token another live session already
      // owns rather than let two agents share one.
      correlation: z
        .object({
          source: z.literal("template"),
          template: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-notifier"),
      event: z.literal("turn-complete"),
      // Two halves, and both are needed. `workspaceWrite` registers the hook in
      // a workspace file, executed core-side through the same path-validated
      // route as the http-hook carrier. `args` is the notifier invocation: core
      // resolves each element through the same substitution as the spawned-
      // notifier carrier ({{notifier}} included), shell-quotes it, and joins the
      // result into one command string. That string is what {{notifierCommand}}
      // resolves to inside the write, because an agent that reads its hook
      // command from a file runs it through a shell and has no argv array.
      carrier: z
        .object({
          workspaceWrite: WorkspaceWriteSpecSchema,
          args: z.array(z.string()).min(1),
        })
        .strict(),
      // The agent writes the event JSON to the notifier's stdin rather than
      // appending it to argv.
      payload: z.literal("json-stdin"),
      // Reused verbatim from the spawned-notifier arm: resolved in the same
      // context as `carrier.args`, so the token the notifier is invoked with is
      // the one the host later looks up.
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
//
// Both bounds must be a bare `major.minor.patch` version, because this schema is
// the only guarantee `classifyVersion` has. `compareVersions` does
// `split(".").map(Number)`, so anything it cannot turn into three numbers yields
// NaN, every comparison reads false, and the agent is hard blocked as
// `below-floor` for every detected version with a message naming a floor the user
// cannot act on. Rejecting the bound here turns that silent misclassification
// into a legible authoring error (#1076, #1082).
//
// The refinement is `isExactSemverVersion`, the single predicate this schema now
// shares with `AgentCompatibilitySchema` on the manifest side. Prerelease and
// build metadata are uncomparable for the same reason a `v` prefix is, so both
// schemas refuse them and agree on one rule, which is what docs/plugin-sdk.md
// tells authors: declare the same window in both places.

export const VersionProbeSpecSchema = z
  .object({
    args: z.array(z.string()).min(1),
    parse: z.literal("semver"),
    minVersion: z
      .string()
      .min(1)
      .refine(
        isExactSemverVersion,
        "Must be an exact semver version (major.minor.patch, no prerelease or build metadata)",
      )
      .optional(),
    testedCeiling: z
      .string()
      .min(1)
      .refine(
        isExactSemverVersion,
        "Must be an exact semver version (major.minor.patch, no prerelease or build metadata)",
      )
      .optional(),
  })
  .strict();
export type VersionProbeSpec = z.infer<typeof VersionProbeSpecSchema>;

// ── Waiting detection ──
//
// Absent, core picks the debounce from the notification wiring: an `http-hook`
// agent gets the 8000ms hook fallback, anything else the generic terminal
// debounce. Nothing in core requires this capability to exist.

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
// One user-facing model with two axes (AP-FR-016, narrowed by the agent-contract spike): the
// fine-grained rules core always sends, honored only by plugins declaring the
// rules capability, plus an optional universal `posture` every agent plugin
// maps to its native mechanism, absent whenever the project has never chosen
// one. Core stores, unions, and injects rule strings; it never parses them, so
// no agent-specific vocabulary reaches core's types.

export const AgentPostureSchema = z.enum(["read-only", "guarded", "auto-edit", "full-auto"]);
export type AgentPosture = z.infer<typeof AgentPostureSchema>;

export const AgentPermissionsModelSchema = z
  .object({
    posture: AgentPostureSchema.optional(),
    rules: z
      .object({
        allow: z.array(z.string()),
        ask: z.array(z.string()),
        deny: z.array(z.string()),
      })
      .strict(),
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
// is wired, no `versionProbe` means no gate, no `permissions` means core
// injects nothing. No `waitingDetection` means core picks the debounce from the
// notification wiring: an `http-hook` agent gets the 8000ms hook fallback, and
// anything else the generic terminal debounce. An agent declaring zero
// capabilities launches as a plain terminal session.

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
// {{notifier}} resolves too, but only for a spawned-notifier or file-notifier
// wiring: it names a program core installs for that wiring and nothing else.
// {{notifierCommand}} resolves only for a file-notifier wiring, to the shell-
// quoted, space-joined `carrier.args` its registration write embeds.

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
