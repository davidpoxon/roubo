import type {
  AgentCompatibility,
  AgentCompatibilityState,
  AgentVersionProbeFailureCause,
  AgentVersionStatus,
} from "@roubo/shared";
import type { VersionProbeSpec } from "@roubo/shared/agent-launch-descriptor-schema";
import {
  readProbe,
  invalidateProbe,
  resetProbeRunnerCache,
  runProbe,
  type ProbeFailureCause,
  type ProbeResult,
} from "./agent-probe-runner.js";

export { parseVersion } from "./probe-parse-registry.js";

// Agent version probe (#1064, AP-FR-014, AP-NFR-006).
//
// The per-agent generalisation of claude-version.ts: instead of one hardcoded
// `claude --version` with one hardcoded floor, an agent plugin declares a
// `capabilities.versionProbe` on its launch descriptor (args, `parse: "semver"`,
// an optional inclusive floor and an optional tested ceiling) and core executes
// it. The semver regex, the comparison and the 5s timeout are ported unchanged
// from claude-version.ts, which the launch-failure spike AC3 validated against both Claude Code
// and Codex CLI output formats.
//
// That module is now gone: #1114 removed the built-in launch path along with the
// auto-mode detection it also served, so this probe is the only version gate
// left.
//
// Since #1266 this module no longer spawns anything itself. Resolution, the
// bounded spawn, the `semver` reader and the per-binary cache all live in the
// shared probe runner (agent-probe-runner.ts), which the configuration choice
// probe uses too. What stays here is what makes it a VERSION probe: the
// comparison, the floor and ceiling verdict, the per-plugin bookkeeping the AI
// Agents screen reads, and the policy that a failed detection is kept for the TTL
// like a successful one.

export interface AgentVersionProbeResult {
  status: AgentVersionStatus;
  detectedVersion?: string;
  minVersion?: string;
  testedCeiling?: string;
  /** Why the probe could not decide (probe-failed only). */
  reason?: string;
  /** Which kind of probe failure this was (probe-failed only). */
  cause?: AgentVersionProbeFailureCause;
}

/** The runner key + spec each agent plugin last probed with, so a cached read can reclassify. */
const lastProbe = new Map<string, { key: string; spec: VersionProbeSpec }>();

/** Negative, zero or positive as `a` sorts before, equal to, or after `b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True if `version` >= `minimum`. The floor is inclusive (AP-TC-073). */
export function isAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

/**
 * Where a detected version sits in a declared window (launch-failure spike AC3).
 *
 * Both bounds are inclusive and both are optional: a spec with no floor can
 * never block, and one with no ceiling can never warn. A spec declaring neither
 * still reports `within-tested-range`, which is the honest answer when nothing
 * was declared to be outside of.
 */
export function classifyVersion(detected: string, spec: VersionProbeSpec): AgentVersionProbeResult {
  const bounds = {
    ...(spec.minVersion !== undefined && { minVersion: spec.minVersion }),
    ...(spec.testedCeiling !== undefined && { testedCeiling: spec.testedCeiling }),
  };
  if (spec.minVersion !== undefined && !isAtLeast(detected, spec.minVersion)) {
    return { status: "below-floor", detectedVersion: detected, ...bounds };
  }
  if (spec.testedCeiling !== undefined && compareVersions(detected, spec.testedCeiling) > 0) {
    return { status: "above-tested-ceiling", detectedVersion: detected, ...bounds };
  }
  return { status: "within-tested-range", detectedVersion: detected, ...bounds };
}

function probeFailed(
  spec: VersionProbeSpec,
  reason: string,
  cause: AgentVersionProbeFailureCause = "probe-error",
): AgentVersionProbeResult {
  return {
    status: "probe-failed",
    reason,
    cause,
    ...(spec.minVersion !== undefined && { minVersion: spec.minVersion }),
    ...(spec.testedCeiling !== undefined && { testedCeiling: spec.testedCeiling }),
  };
}

/**
 * The runner's four causes folded onto the two a version surface distinguishes
 * (AP-TC-122, #1112). Only a missing command is fixed by installing the CLI;
 * a probe error, unreadable output and a timeout all mean the CLI was found and
 * could not be read, which is what `probe-error` has always meant here.
 */
function versionCause(cause: ProbeFailureCause | undefined): AgentVersionProbeFailureCause {
  return cause === "command-not-found" ? "command-not-found" : "probe-error";
}

/** Classify one runner result against the spec's window. */
function verdict(result: ProbeResult<string>, spec: VersionProbeSpec): AgentVersionProbeResult {
  if (result.value === undefined) {
    return probeFailed(
      spec,
      result.reason ?? "The version probe did not report a version",
      versionCause(result.cause),
    );
  }
  return classifyVersion(result.value, spec);
}

/**
 * Run one agent's declared version probe and classify the result against its
 * window. Cached per resolved binary (and, for a bare name, per search path), so
 * repeated launches (and the AI Agents screen) reuse one spawn.
 *
 * `searchPath` is the PATH the launch will spawn the agent with, which a launch
 * descriptor's `env.PATH` can replace outright. Passing it is what keeps the
 * promise `docs/plugin-sdk.md` makes to plugin authors true: the probe resolves,
 * runs and caches under the same binary the launch will spawn (#1075). It defaults
 * to the server's own PATH for callers with no launch environment to speak of,
 * such as the manifest-declared warm probe.
 *
 * `installLocations` is the launching plugin's manifest-declared
 * `agentInstallLocations` (#1115), passed for the same reason `searchPath` is:
 * the resolution below has to land on the binary the launch will spawn, and
 * `createAgentSession` passes the same list. Omitting it here would leave the
 * probe resolving through PATH and the legacy table alone, so a CLI found only
 * in a declared location would be reported "not detected" and then launch fine.
 *
 * Never throws: an unresolvable command, a nonzero probe exit and unparseable
 * output all report `probe-failed` with a reason, because a probe that cannot
 * decide must not block a launch on its own (AP-TC-074). The authoritative
 * binary resolution happens at spawn time in `createAgentSession`, which is what
 * turns a genuinely missing binary into the missing-binary failure class.
 */
export async function probeAgentVersion(
  pluginId: string,
  command: string,
  spec: VersionProbeSpec,
  searchPath: string | undefined = process.env.PATH,
  installLocations?: readonly string[],
): Promise<AgentVersionProbeResult> {
  // The runner owns the refusals (a templated command or search path is reported,
  // never probed blind), the resolution, the spawn and the cache. A failed
  // detection is kept for the TTL, so a CLI that cannot be read is not re-spawned
  // on every launch; a cached `command-not-found` miss is the exception, dropped
  // the moment resolution succeeds, because the user just installed the CLI.
  const { key, result } = await runProbe({
    command,
    args: spec.args,
    parse: spec.parse,
    failurePolicy: "keep-for-ttl",
    searchPath,
    installLocations,
  });

  // A refused probe has no key and leaves nothing to read back, as before. Every
  // other outcome, a missing CLI included (AP-TC-122), is recorded so the AI
  // Agents screen's cache-only read can see it.
  if (key !== undefined) lastProbe.set(pluginId, { key, spec });
  return verdict(result, spec);
}

/**
 * Drop the cached detection for one agent plugin so its next probe re-spawns.
 *
 * Called when a launch is refused below-floor: the guidance tells the user to
 * update the CLI and launch again, and the Retry action re-enters the same gate,
 * so waiting out the TTL would make the retry visibly fail for no reason.
 */
export function invalidateAgentVersionProbe(pluginId: string): void {
  const last = lastProbe.get(pluginId);
  if (last) invalidateProbe(last.key);
}

/**
 * Probe from the MANIFEST's declared window rather than from a launch descriptor
 * (AP-TC-113, AP-TC-114).
 *
 * The descriptor's `capabilities.versionProbe` only exists once a plugin has been
 * asked to translate a real launch, so it can never answer "what version is
 * installed?" for a screen the user opened without starting a bench. A manifest
 * that declares `agentCompatibility.probe` can, and it feeds the same per-binary
 * cache, so a launch that follows reuses this spawn instead of adding one.
 *
 * It probes against the server's own PATH. That is the only PATH available
 * without a launch descriptor, and this probe gates nothing, so it is the honest
 * choice. The PATH-scoped cache key then correctly keeps a launch that overrides
 * `env.PATH` from reusing this detection (#1075). `installLocations`, by
 * contrast, comes off the same manifest as `declared` and is available here, so
 * it is passed through: without it this screen would report "CLI not detected"
 * for an agent installed only where its manifest says it installs (#1115).
 *
 * Resolves to `undefined` when the manifest declares no probe, which is the
 * honest answer for a plugin that opted out: the card then shows the declared
 * bounds alone.
 */
export async function probeDeclaredAgentVersion(
  pluginId: string,
  declared: AgentCompatibility | undefined,
  installLocations?: readonly string[],
): Promise<AgentVersionProbeResult | undefined> {
  if (!declared?.probe) return undefined;
  return probeAgentVersion(
    pluginId,
    declared.probe.command,
    {
      args: declared.probe.args,
      parse: declared.probe.parse,
      ...(declared.minVersion !== undefined && { minVersion: declared.minVersion }),
      ...(declared.testedCeiling !== undefined && { testedCeiling: declared.testedCeiling }),
    },
    process.env.PATH,
    installLocations,
  );
}

/** Plugin ids with a manifest-declared warm probe currently in flight. */
const warming = new Set<string>();

/**
 * Kick off a manifest-declared probe in the background when nothing is cached
 * yet, so a polled read like `GET /api/agents` never blocks on a spawn.
 *
 * Fire-and-forget and self-limiting: it is a no-op once a detection exists (the
 * cached read has no TTL, so one success ends the warming for the process), and
 * the in-flight set keeps a slow or repeatedly-failing probe from stacking one
 * spawn per poll.
 *
 * A cached `command-not-found` miss is the ONE cached state that does not end
 * warming (#1112). It is the only outcome the user is told to go and fix
 * ("install the agent's command-line tool, then reopen this screen"), so warming
 * has to keep asking or that instruction is false: nothing else re-probes for
 * this screen, and the card would sit on "CLI not detected" until the app was
 * restarted. Re-asking is cheap, because the not-found path throws inside
 * `resolveAgentCommand` and never reaches a spawn.
 *
 * The rejection is caught HERE as well. The probe runner reports every failure
 * as a result rather than throwing, but this call is `void`ed from server boot and
 * from a polled route, where an unhandled rejection would take the process down,
 * so it does not rely on that alone. `.finally()` by itself would re-propagate it.
 */
export function warmAgentVersion(
  pluginId: string,
  declared: AgentCompatibility | undefined,
  installLocations?: readonly string[],
): void {
  if (!declared?.probe) return;
  const cached = getCachedAgentVersion(pluginId);
  if (cached !== undefined && cached.cause !== "command-not-found") return;
  if (warming.has(pluginId)) return;
  warming.add(pluginId);
  void probeDeclaredAgentVersion(pluginId, declared, installLocations)
    .catch(() => undefined)
    .finally(() => warming.delete(pluginId));
}

/**
 * The last probe result for an agent plugin, WITHOUT spawning anything.
 *
 * This is what keeps `GET /api/agents` cheap: the screen renders whatever the
 * most recent launch or background warm probe detected, and reports `unknown`
 * until one of those has happened rather than probing per request.
 */
export function getCachedAgentVersion(pluginId: string): AgentVersionProbeResult | undefined {
  const last = lastProbe.get(pluginId);
  if (!last) return undefined;
  const result = readProbe<string>(last.key);
  if (!result) return undefined;
  return verdict(result, last.spec);
}

/**
 * The compatibility block the AI Agents screen renders for one plugin: the
 * manifest's declared window (always available, no launch required) merged with
 * whatever the cached probe detected (AP-TC-113, AP-TC-114).
 */
export function buildCompatibilityState(
  pluginId: string,
  declared: { minVersion?: string; testedCeiling?: string } | undefined,
): AgentCompatibilityState | undefined {
  const probe = getCachedAgentVersion(pluginId);
  if (!declared && !probe) return undefined;
  return {
    // The descriptor's own bounds win when a probe has run, because they are what
    // the launch gate actually enforced; the manifest is the pre-launch stand-in.
    ...(declared?.minVersion !== undefined && { minVersion: declared.minVersion }),
    ...(declared?.testedCeiling !== undefined && { testedCeiling: declared.testedCeiling }),
    ...(probe?.minVersion !== undefined && { minVersion: probe.minVersion }),
    ...(probe?.testedCeiling !== undefined && { testedCeiling: probe.testedCeiling }),
    ...(probe?.detectedVersion !== undefined && { detectedVersion: probe.detectedVersion }),
    ...(probe?.reason !== undefined && { reason: probe.reason }),
    ...(probe?.cause !== undefined && { cause: probe.cause }),
    status: probe?.status ?? "unknown",
  };
}

/** Drops every cached detection. Tests, and any future re-probe trigger. */
export function resetAgentVersionProbeCache(): void {
  resetProbeRunnerCache();
  lastProbe.clear();
}
