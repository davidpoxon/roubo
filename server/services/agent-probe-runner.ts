import os from "node:os";
import path from "node:path";
import type { ChoiceProbes } from "@roubo/shared";
import { AgentCommandNotFoundError, resolveAgentCommand } from "./env.js";
import {
  readProbeOutput,
  type ProbeChoice,
  type ProbeParseMode,
  type ProbeValueByMode,
} from "./probe-parse-registry.js";
import { PROBE_MAX_OUTPUT_BYTES, PROBE_TIMEOUT_MS, spawnProbe } from "./probe-spawn.js";

// The one host-executed probe runner (#851, APCC-FR-001, APCC-NFR-001).
//
// Every probe the host runs against an agent CLI goes through here: the version
// probe (agent-version-probe.ts) and the configuration choice probe. The runner
// resolves the binary the way a launch resolves it, spawns only the declared
// argv through the bounded spawn in probe-spawn.ts, reads the output with the
// reader its `parse` literal names, and caches the result. It never throws: every
// way a probe can fail comes back as a result with a distinct cause.
//
// Caching is keyed by RESOLVED BINARY plus probe argv plus parse mode, not by
// plugin, so two plugins pointing at the same CLI probe it once. When the
// resolution lands on a bare name, the key also carries the search path it was
// resolved against (#660): a bare name is only fully identified together with its
// PATH, so two launches whose PATH differs name two different binaries under one
// name.

/**
 * How long a successful result is reused before the next run re-probes.
 *
 * An agent CLI is updated in place, so the resolved binary path does not change
 * and a cache with no expiry would keep reporting the pre-update answer for the
 * life of the server process. A minute is long enough that a burst of reads
 * still costs one spawn, and short enough that "update, then retry" works.
 */
export const DETECTION_TTL_MS = 60_000;

/**
 * Why a probe produced no value.
 *
 * - `command-not-found`: the command resolved nowhere, so nothing ran. The only
 *   cause that installing the CLI fixes.
 * - `probe-error`: the CLI ran and failed, or the probe was refused before it
 *   could run (a templated command or search path).
 * - `parse-error`: the CLI ran and succeeded, and its output did not read.
 * - `timeout`: the CLI was killed at the time bound.
 */
export type ProbeFailureCause = "command-not-found" | "probe-error" | "parse-error" | "timeout";

export interface ProbeResult<T> {
  status: "ok" | "failed";
  /** Present exactly when `status` is `ok`. */
  value?: T;
  /** Present exactly when `status` is `failed`. */
  reason?: string;
  /** Present exactly when `status` is `failed`. */
  cause?: ProbeFailureCause;
  /** When this result was taken, for TTL expiry. */
  at: number;
}

/**
 * Whether a failed result is kept.
 *
 * - `keep-for-ttl`: kept for the TTL like a success. The version probe uses it,
 *   so a CLI that cannot be read is not re-spawned on every launch.
 * - `discard`: never kept, and it also discards any earlier success under the
 *   same key, so a later read can never answer with a stale list (APCC-TC-024).
 */
export type ProbeFailurePolicy = "keep-for-ttl" | "discard";

export interface ProbeRequest<M extends ProbeParseMode> {
  command: string;
  args: readonly string[];
  parse: M;
  failurePolicy: ProbeFailurePolicy;
  /** The PATH the probe resolves and spawns against. Defaults to the server's own. */
  searchPath?: string;
  /** The plugin's manifest-declared `agentInstallLocations` (#712). */
  installLocations?: readonly string[];
}

export interface ProbeRun<M extends ProbeParseMode> {
  /**
   * The cache key the result lives (or would live) under, for `readProbe` and
   * `invalidateProbe`. Absent when the probe was refused before any key existed.
   */
  key?: string;
  result: ProbeResult<ProbeValueByMode[M]>;
}

/**
 * Results keyed by the resolved binary, the probe argv, the parse mode and (for
 * a bare-name resolution) the search path, joined with control characters (NUL
 * between fields, SOH between argv elements) so no command, argument or PATH value
 * can forge a key collision. Written as `\u0000` / `\u0001` escapes rather than
 * literal bytes: literal control characters make git classify this file as
 * binary, which suppresses its diff and blame entirely.
 */
const results = new Map<string, ProbeResult<unknown>>();

/** Runs currently spawned, so a second caller for the same key joins the first. */
const inFlight = new Map<string, Promise<ProbeResult<unknown>>>();

/** True when `binary` names a location rather than something PATH has to find. */
function isPathShaped(binary: string): boolean {
  return binary.includes(path.sep) || binary.includes("/");
}

function cacheKey(
  binary: string,
  args: readonly string[],
  parse: ProbeParseMode,
  searchPath: string | undefined,
): string {
  // A path-shaped binary is already fully identified, so it keeps sharing one
  // result across every caller: that is what lets two plugins pointing at the
  // same CLI probe it once. A bare name is not, because `resolveAgentCommand`
  // returns it unchanged once it finds it on the search path, so that path is
  // part of which binary the result is actually about (#660).
  const scope = isPathShaped(binary) ? "" : (searchPath ?? "");
  return `${binary}\u0000${args.join("\u0001")}\u0000${parse}\u0000${scope}`;
}

function failed(reason: string, cause: ProbeFailureCause): ProbeResult<never> {
  return { status: "failed", reason, cause, at: Date.now() };
}

/**
 * Run one declared probe, or answer it from the cache.
 *
 * Refusals come first and are never cached: a templated command or a templated
 * search path cannot be resolved before the launch context exists, and probing
 * against the unresolved text would resolve, run and cache the wrong binary.
 *
 * A command that resolves nowhere is reported as `command-not-found` and kept
 * under a key built from the declared command, but only for a `keep-for-ttl`
 * probe. That entry is discarded on sight once resolution succeeds, because the
 * success proves it stale (the user installed the CLI).
 *
 * Never throws. An error `resolveAgentCommand` raises for any reason other than a
 * missing command is reported as a probe error rather than rethrown.
 */
export async function runProbe<M extends ProbeParseMode>(
  request: ProbeRequest<M>,
): Promise<ProbeRun<M>> {
  type Value = ProbeValueByMode[M];
  const { command, args, parse, failurePolicy } = request;
  const searchPath = request.searchPath ?? process.env.PATH;

  if (command.includes("{{")) {
    return {
      result: failed(
        `Command "${command}" is templated and cannot be probed before launch`,
        "probe-error",
      ),
    };
  }
  if (searchPath?.includes("{{") === true) {
    return {
      result: failed(
        "The launch environment's PATH is templated and cannot be probed before launch",
        "probe-error",
      ),
    };
  }

  let binary: string;
  try {
    // The same resolution the spawn uses (#645): PATH, then the declared and
    // well-known install locations, so the probe and the launch agree on which
    // binary they are talking about.
    binary = resolveAgentCommand(command, searchPath, request.installLocations);
  } catch (err) {
    const missKey = cacheKey(command, args, parse, searchPath);
    if (err instanceof AgentCommandNotFoundError) {
      const miss = failed(err.message, "command-not-found");
      if (failurePolicy === "keep-for-ttl") results.set(missKey, miss);
      else results.delete(missKey);
      return { key: missKey, result: miss };
    }
    return {
      key: missKey,
      result: failed(err instanceof Error ? err.message : String(err), "probe-error"),
    };
  }

  const key = cacheKey(binary, args, parse, searchPath);
  let cached = results.get(key);
  if (cached?.cause === "command-not-found") {
    results.delete(key);
    cached = undefined;
  }
  if (cached !== undefined && Date.now() - cached.at <= DETECTION_TTL_MS) {
    return { key, result: cached as ProbeResult<Value> };
  }

  let pending = inFlight.get(key) as Promise<ProbeResult<Value>> | undefined;
  if (pending === undefined) {
    pending = execute(binary, args, parse, searchPath).then((result) => {
      if (result.status === "ok" || failurePolicy === "keep-for-ttl") results.set(key, result);
      else results.delete(key);
      return result;
    });
    const tracked = pending.finally(() => inFlight.delete(key));
    inFlight.set(key, tracked);
    pending = tracked;
  }
  return { key, result: await pending };
}

async function execute<M extends ProbeParseMode>(
  binary: string,
  args: readonly string[],
  parse: M,
  searchPath: string | undefined,
): Promise<ProbeResult<ProbeValueByMode[M]>> {
  const commandLine = `\`${binary} ${args.join(" ")}\``;
  try {
    // Resolution alone does not pin the binary down: `resolveAgentCommand`
    // returns a bare name unchanged when it finds it on the search path, and the
    // spawn otherwise inherits the SERVER's environment. PATH is overridden so
    // the spawn's own lookup lands on the file the resolution found (#660).
    const output = await spawnProbe(
      binary,
      args,
      os.homedir(),
      searchPath !== undefined ? { PATH: searchPath } : undefined,
      { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_MAX_OUTPUT_BYTES },
    );
    if (output.timedOut === true) {
      return failed(`${commandLine} did not finish within ${PROBE_TIMEOUT_MS}ms`, "timeout");
    }
    const reading = readProbeOutput(parse, output);
    if (reading.ok) return { status: "ok", value: reading.value, at: Date.now() };
    return failed(`${commandLine} ${reading.detail}`, reading.cause);
  } catch (err) {
    return failed(
      `${commandLine} could not be run: ${err instanceof Error ? err.message : String(err)}`,
      "probe-error",
    );
  }
}

/** The cached result under `key`, WITHOUT spawning and without applying the TTL. */
export function readProbe<T>(key: string): ProbeResult<T> | undefined {
  return results.get(key) as ProbeResult<T> | undefined;
}

/** Drop the cached result under `key`, so the next run spawns. */
export function invalidateProbe(key: string): void {
  results.delete(key);
}

// ── Choice probes ──

/** The last outcome of each plugin's choice probe, by plugin id and field name. */
const choiceOutcomes = new Map<string, ProbeResult<ProbeChoice[]>>();

function choiceKey(pluginId: string, field: string): string {
  return `${pluginId}\u0000${field}`;
}

/**
 * Run every choice probe a plugin's manifest declares, in the background.
 *
 * Returns at once and blocks nothing, so a settings read never waits on a spawn
 * (APCC-NFR-002). A field whose success is still inside the TTL is answered from
 * the cache without a spawn, and a field whose probe is already running joins it.
 * A failure is never kept (APCC-TC-024): the next warm spawns again.
 */
export function warmChoiceProbes(
  pluginId: string,
  probes: ChoiceProbes | undefined,
  installLocations?: readonly string[],
): void {
  if (!probes) return;
  for (const [field, directive] of Object.entries(probes)) {
    void runProbe({
      command: directive.command,
      args: directive.args,
      parse: directive.parse,
      failurePolicy: "discard",
      installLocations,
    })
      .then(({ result }) => {
        choiceOutcomes.set(choiceKey(pluginId, field), result);
      })
      .catch(() => undefined);
  }
}

/**
 * The last outcome of one field's choice probe, WITHOUT spawning.
 *
 * A failure is reported as the failure, never as the list an earlier run
 * resolved, so the field can say what went wrong instead of offering choices that
 * may no longer exist. Resolves to `undefined` until a warm has finished.
 */
export function readChoiceProbe(
  pluginId: string,
  field: string,
): ProbeResult<ProbeChoice[]> | undefined {
  return choiceOutcomes.get(choiceKey(pluginId, field));
}

/** Drops every cached result and every choice outcome. Tests, and any future re-probe trigger. */
export function resetProbeRunnerCache(): void {
  results.clear();
  inFlight.clear();
  choiceOutcomes.clear();
}
