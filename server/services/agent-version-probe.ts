import os from "node:os";
import path from "node:path";
import type {
  AgentCompatibility,
  AgentCompatibilityState,
  AgentVersionProbeFailureCause,
  AgentVersionStatus,
} from "@roubo/shared";
import type { VersionProbeSpec } from "@roubo/shared/agent-launch-descriptor-schema";
import { runCommand } from "./exec.js";
import { AgentCommandNotFoundError, resolveAgentCommand } from "./env.js";

// Agent version probe (issue #519, AP-FR-014, AP-NFR-006).
//
// The per-agent generalisation of claude-version.ts: instead of one hardcoded
// `claude --version` with one hardcoded floor, an agent plugin declares a
// `capabilities.versionProbe` on its launch descriptor (args, `parse: "semver"`,
// an optional inclusive floor and an optional tested ceiling) and core executes
// it. The semver regex, the comparison and the 5s timeout are ported unchanged
// from claude-version.ts, which spike #504 AC3 validated against both Claude Code
// and Codex CLI output formats.
//
// claude-version.ts itself stays where it is: it serves auto-mode detection via
// routes/settings.ts, which is a different concern from launch gating.
//
// Caching is keyed by RESOLVED BINARY plus probe argv, not by plugin, so two
// plugins pointing at the same CLI probe it once and `GET /api/agents` can render
// a detected version without spawning anything per request. When the resolution
// lands on a bare name, the key also carries the search path it was resolved
// against (#660): a bare name is only fully identified together with its PATH, so
// two launches whose PATH differs name two different binaries under one name.

const PROBE_TIMEOUT_MS = 5000;

/**
 * How long a detection is reused before a launch re-probes.
 *
 * An agent CLI is updated in place, so the resolved binary path does not change
 * and a cache with no expiry would keep reporting the pre-update version for the
 * life of the server process. That directly defeats the below-floor guidance
 * ("update the agent CLI, then launch again") and strands a transient probe
 * failure permanently. A minute is long enough that a burst of launches still
 * costs one ~50ms spawn, and short enough that "update, then retry" works.
 */
const DETECTION_TTL_MS = 60_000;

/** The outcome of one probe against one binary, before any range is applied. */
interface Detection {
  version?: string;
  /** Why no version could be read. Present exactly when `version` is absent. */
  reason?: string;
  /**
   * WHICH kind of failure this was, present exactly when `version` is absent
   * (AP-TC-122, issue #522). `probe-failed` alone conflates two states a surface
   * must not describe with one sentence: a CLI that could not be found at all,
   * and a CLI that was found, ran, and could not be read. Only the first is
   * fixed by installing the agent's command-line tool.
   */
  cause?: AgentVersionProbeFailureCause;
  /** When this detection was taken, for TTL expiry. */
  at: number;
}

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

/**
 * Detections keyed by the resolved binary, the probe argv and (for a bare-name
 * resolution) the search path, joined with control characters (NUL between
 * fields, SOH between argv elements) so no command, argument or PATH value can
 * forge a key collision. Written as `\u0000` /
 * `\u0001` escapes rather than literal bytes: literal control characters make git
 * classify this file as binary, which suppresses its diff and blame entirely.
 */
const detections = new Map<string, Detection>();
/** The binary + spec each agent plugin last probed with, so a cached read can reclassify. */
const lastProbe = new Map<string, { key: string; spec: VersionProbeSpec }>();

/** Parse the first semver anywhere in arbitrary command output (claude-version.ts regex). */
export function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

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
 * Where a detected version sits in a declared window (spike #504 AC3).
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

/** True when `binary` names a location rather than something PATH has to find. */
function isPathShaped(binary: string): boolean {
  return binary.includes(path.sep) || binary.includes("/");
}

function cacheKey(binary: string, spec: VersionProbeSpec, searchPath: string | undefined): string {
  // A path-shaped binary is already fully identified, so it keeps sharing one
  // detection across every caller: that is what lets two plugins pointing at the
  // same CLI probe it once. A bare name is not, because `resolveAgentCommand`
  // returns it unchanged once it finds it on the search path, so that path is
  // part of which binary the detection is actually about (#660).
  const scope = isPathShaped(binary) ? "" : (searchPath ?? "");
  return `${binary}\u0000${spec.args.join("\u0001")}\u0000${scope}`;
}

/**
 * Run one agent's declared version probe and classify the result against its
 * window. Cached per resolved binary (and, for a bare name, per search path), so
 * repeated launches (and the AI Agents screen) reuse one spawn.
 *
 * `searchPath` is the PATH the launch will spawn the agent with, which a launch
 * descriptor's `env.PATH` can replace outright. Passing it is what keeps the
 * promise `docs/plugin-sdk.md` makes to plugin authors true: the probe resolves,
 * runs and caches under the same binary the launch will spawn (#660). It defaults
 * to the server's own PATH for callers with no launch environment to speak of,
 * such as the manifest-declared warm probe.
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
): Promise<AgentVersionProbeResult> {
  // A templated command cannot be resolved before the launch context exists, so
  // there is nothing to probe. Reported honestly rather than probed blind.
  if (command.includes("{{")) {
    return probeFailed(
      spec,
      `Command "${command}" is templated and cannot be probed before launch`,
    );
  }

  // A descriptor's `env` values are templates too, resolved only once the launch
  // context exists. Probing against an unresolved PATH would resolve, run and
  // cache the wrong binary just as silently as ignoring it did, so it gets the
  // same honest treatment as a templated command.
  if (searchPath?.includes("{{") === true) {
    return probeFailed(
      spec,
      "The launch environment's PATH is templated and cannot be probed before launch",
    );
  }

  let binary: string;
  try {
    // The same resolution the spawn uses (#645): PATH, then the well-known
    // install locations. That chain already covers what claude-version.ts hedged
    // with an `sh -lc` retry, and resolving here means the probe and the spawn
    // agree on which binary they are talking about.
    binary = resolveAgentCommand(command, searchPath);
  } catch (err) {
    if (err instanceof AgentCommandNotFoundError) {
      // Cache the miss before returning (AP-TC-122, issue #522). This branch used
      // to return without touching `lastProbe` / `detections`, so an agent whose
      // CLI is simply not installed left NOTHING for `getCachedAgentVersion` to
      // read: the AI Agents screen fell back to `unknown` and rendered "Ready"
      // for an agent that cannot launch. The declared `command` keys the entry
      // (there is no resolved binary to key it by), which is the same shape a
      // bare-name resolution would have produced anyway.
      const missKey = cacheKey(command, spec, searchPath);
      lastProbe.set(pluginId, { key: missKey, spec });
      detections.set(missKey, { at: Date.now(), reason: err.message, cause: "command-not-found" });
      return probeFailed(spec, err.message, "command-not-found");
    }
    throw err;
  }

  const key = cacheKey(binary, spec, searchPath);
  lastProbe.set(pluginId, { key, spec });

  // Expiry is applied HERE and not in `getCachedAgentVersion`: a launch is worth
  // one fresh spawn, whereas the AI Agents card is a display and is better served
  // a stale-but-known version than nothing at all.
  let detection = detections.get(key);
  // A cached `command-not-found` miss is discarded on sight rather than waited
  // out: resolution just SUCCEEDED, so that entry is provably stale (the user
  // installed the CLI). Without this, a bare name that resolves to itself reuses
  // its own miss under the same key and keeps reporting "not detected" for up to
  // a TTL after the fix (issue #522).
  if (detection?.cause === "command-not-found") detection = undefined;
  if (detection === undefined || Date.now() - detection.at > DETECTION_TTL_MS) {
    detection = await detect(binary, spec, searchPath);
    detections.set(key, detection);
  }

  if (detection.version === undefined) {
    return probeFailed(
      spec,
      detection.reason ?? "The version probe did not report a version",
      detection.cause,
    );
  }
  return classifyVersion(detection.version, spec);
}

async function detect(
  binary: string,
  spec: VersionProbeSpec,
  searchPath: string | undefined,
): Promise<Detection> {
  // Resolution alone does not pin the binary down: `resolveAgentCommand` returns
  // a bare name unchanged when it finds it on the search path, and `runCommand`
  // otherwise spawns with the SERVER's environment. PATH is overridden here so
  // the exec's own lookup lands on the same file the resolution just found (#660).
  const { code, stdout, stderr } = await runCommand(
    binary,
    spec.args,
    os.homedir(),
    searchPath !== undefined ? { PATH: searchPath } : undefined,
    PROBE_TIMEOUT_MS,
  );

  // Merged, because agents split version output across the two streams
  // inconsistently and the semver scan is lenient by design.
  const output = `${stdout}\n${stderr}`;
  const version = parseVersion(output);
  const at = Date.now();

  // Both failure shapes below are `probe-error`, never `command-not-found`: this
  // function only runs once `resolveAgentCommand` found the binary, so the CLI
  // demonstrably exists and was executed. What failed is reading its output.
  if (version !== null) return { version, at };
  if (code !== 0) {
    const detail = output.trim().split("\n")[0] ?? "";
    return {
      at,
      cause: "probe-error",
      reason:
        `\`${binary} ${spec.args.join(" ")}\` exited with code ${code}` +
        (detail ? `: ${detail}` : ""),
    };
  }
  return {
    at,
    cause: "probe-error",
    reason: `\`${binary} ${spec.args.join(" ")}\` produced no recognisable version number`,
  };
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
  if (last) detections.delete(last.key);
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
 * It passes no search path, so it probes against the server's own PATH. That is
 * the only PATH available without a launch descriptor, and this probe gates
 * nothing, so it is the honest choice. The PATH-scoped cache key then correctly
 * keeps a launch that overrides `env.PATH` from reusing this detection (#660).
 *
 * Resolves to `undefined` when the manifest declares no probe, which is the
 * honest answer for a plugin that opted out: the card then shows the declared
 * bounds alone.
 */
export async function probeDeclaredAgentVersion(
  pluginId: string,
  declared: AgentCompatibility | undefined,
): Promise<AgentVersionProbeResult | undefined> {
  if (!declared?.probe) return undefined;
  return probeAgentVersion(pluginId, declared.probe.command, {
    args: declared.probe.args,
    parse: declared.probe.parse,
    ...(declared.minVersion !== undefined && { minVersion: declared.minVersion }),
    ...(declared.testedCeiling !== undefined && { testedCeiling: declared.testedCeiling }),
  });
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
 * warming (issue #522). It is the only outcome the user is told to go and fix
 * ("install the agent's command-line tool, then reopen this screen"), so warming
 * has to keep asking or that instruction is false: nothing else re-probes for
 * this screen, and the card would sit on "CLI not detected" until the app was
 * restarted. Re-asking is cheap, because the not-found path throws inside
 * `resolveAgentCommand` and never reaches a spawn.
 *
 * The rejection is caught HERE rather than left to the caller. `probeAgentVersion`
 * reports an unresolvable command and a failed probe as `probe-failed` results,
 * but it deliberately rethrows anything else, and this call is `void`ed from
 * server boot and from a polled route, where an unhandled rejection would take the
 * process down. `.finally()` alone would re-propagate it.
 */
export function warmAgentVersion(pluginId: string, declared: AgentCompatibility | undefined): void {
  if (!declared?.probe) return;
  const cached = getCachedAgentVersion(pluginId);
  if (cached !== undefined && cached.cause !== "command-not-found") return;
  if (warming.has(pluginId)) return;
  warming.add(pluginId);
  void probeDeclaredAgentVersion(pluginId, declared)
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
  const detection = detections.get(last.key);
  if (!detection) return undefined;
  if (detection.version === undefined) {
    return probeFailed(
      last.spec,
      detection.reason ?? "The version probe did not report a version",
      detection.cause,
    );
  }
  return classifyVersion(detection.version, last.spec);
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
  detections.clear();
  lastProbe.clear();
}
