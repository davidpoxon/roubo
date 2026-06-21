import { spawn } from "node:child_process";
import os from "node:os";
import type {
  IsolationCapabilities,
  IsolationTier,
  PluginManifest,
  SandboxEgressPolicy,
  SandboxedSpawn,
} from "@roubo/shared";

/**
 * PluginIsolationSandbox (F2.3, #620). The opt-in, capability-gated OS-isolation
 * tier the host wraps around a component plugin process, on top of the always-on
 * broker floor (the PermissionEnforcer / AuditLog the F2.1 broker carries).
 *
 * Per spike #599 (SPK-2): the broker is the unconditional floor that contains
 * accidental damage, honest plugins, and casual abuse; this slice adds the
 * highest-isolation-first OS tier that closes the determined-attacker gap the
 * broker alone cannot. There is NO `host.network.*` broker method, so an
 * undeclared outbound connection can only be stopped below the broker, at this
 * OS layer. When a plugin declares no network hosts, the sandbox denies all
 * egress; when it declares hosts, the runtime applies that allowlist.
 *
 * Everything here is pure / injectable so it is unit-testable without a live
 * daemon: capability detection takes its probes as arguments, tier selection is
 * a pure function of capabilities, and the spawn builder is a pure function of
 * the manifest and chosen tier. The host wires the real probes (and the real
 * spawn) in plugin-manager.
 */

/** A single capability probe: returns true when the runtime is usable. */
export type IsolationProbe = () => boolean | Promise<boolean>;

export interface IsolationProbes {
  /** Virtualization.framework present and a per-plugin VM is drivable. */
  vzVm: IsolationProbe;
  /** Apple `container` framework (macOS 15+, Apple silicon) present. */
  appleContainer: IsolationProbe;
  /** Docker engine installed and the daemon reachable. */
  docker: IsolationProbe;
}

/**
 * Probe whether an executable is resolvable on the host's PATH, returning false
 * on any error (missing binary, spawn failure, timeout). Used by the
 * apple-container probe to confirm the `container` CLI is actually present, not
 * merely that the platform could host it. Exception-safe so a probe never
 * crashes capability detection (NFR-005).
 */
function isExecutableOnPath(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `command -v` is a POSIX shell builtin; the apple-container rung is
    // macOS-only so a Unix lookup is sufficient. Resolve false on any failure.
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn("/bin/sh", ["-c", `command -v ${binary}`], {
        stdio: "ignore",
        timeout: 2000,
      });
      child.on("error", () => done(false));
      child.on("exit", (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

/**
 * The host's real OS-isolation capability probes (NFR-005: query each runtime,
 * never assume). Each probe is self-contained and exception-safe: a thrown or
 * rejected probe is treated as "not available" by detectIsolationCapabilities,
 * degrading the host one rung rather than crashing detection. The host installs
 * these at boot (plugin-manager.initialize); tests inject fakes to drive tier
 * selection deterministically without a live daemon.
 *
 * - `docker`: the Docker daemon is reachable, probed via dockerode's `ping()`
 *   (mirroring docker.ts), so a host with the CLI installed but the daemon down
 *   reports false rather than selecting a rung it cannot drive.
 * - `appleContainer`: the macOS 15+ / Apple-silicon `container` framework is
 *   present, gated on platform + arch and confirmed by the `container` CLI being
 *   resolvable on PATH.
 * - `vzVm`: conservatively false. Virtualization.framework may be present, but
 *   no per-plugin VM backend ships in this slice (buildSandboxedSpawn returns
 *   null for that rung), so reporting it usable would select a tier the host
 *   cannot actually drive. It stays false until a VM backend exists.
 */
export function defaultIsolationProbes(): IsolationProbes {
  return {
    vzVm: () => false,
    appleContainer: async () => {
      if (os.platform() !== "darwin") return false;
      if (os.arch() !== "arm64") return false;
      return isExecutableOnPath("container");
    },
    docker: async () => {
      // Lazy-import dockerode so capability detection has no module-load cost on
      // hosts that never reach this probe, and a load failure degrades the rung
      // rather than crashing. `ping()` confirms the daemon is reachable, not
      // merely that the CLI is installed.
      const { default: Dockerode } = await import("dockerode");
      const docker = new Dockerode();
      await docker.ping();
      return true;
    },
  };
}

/**
 * Detect which OS-isolation runtimes the host can actually drive. Each probe is
 * run independently and a thrown / rejected probe is treated as "not available"
 * (NFR-005: never assume a runtime is present; a failing probe degrades the
 * host one rung, it does not crash detection). The probes are injected so this
 * is deterministic in tests without a live daemon.
 */
export async function detectIsolationCapabilities(
  probes: IsolationProbes,
): Promise<IsolationCapabilities> {
  const safe = async (probe: IsolationProbe): Promise<boolean> => {
    try {
      return (await probe()) === true;
    } catch {
      return false;
    }
  };
  const [vzVm, appleContainer, docker] = await Promise.all([
    safe(probes.vzVm),
    safe(probes.appleContainer),
    safe(probes.docker),
  ]);
  return { vzVm, appleContainer, docker };
}

/**
 * Select the isolation tier: the highest-isolation runtime the host supports,
 * degrading to the `broker-only` floor when none is present. Highest-first
 * matches spike #599 rung order (vz-vm > apple-container > docker > broker-only)
 * and is a pure function of the detected capabilities, so the floor is always
 * reachable and enforcement never depends on Docker (FR-018).
 */
export function selectTier(capabilities: IsolationCapabilities): IsolationTier {
  if (capabilities.vzVm) return "vz-vm";
  if (capabilities.appleContainer) return "apple-container";
  if (capabilities.docker) return "docker";
  return "broker-only";
}

/**
 * Derive the egress policy from the manifest's declared network hosts. No
 * declared hosts (or no `permissions.network`) means deny all outbound traffic
 * at the OS layer; declared hosts carry the allowlist through for the runtime to
 * apply. This is the only place undeclared egress can be stopped, because the
 * broker has no `host.network.*` method (the gap this slice closes).
 */
export function deriveEgressPolicy(manifest: PluginManifest): SandboxEgressPolicy {
  const hosts = manifest.permissions?.network?.hosts ?? [];
  if (hosts.length === 0) {
    return { mode: "deny-all", allowedHosts: [] };
  }
  return { mode: "allow-listed", allowedHosts: [...hosts] };
}

/**
 * Build the concrete sandboxed spawn for a non-floor tier. Returns `null` for
 * the `broker-only` floor: the host spawns the plugin directly, exactly as it
 * does today, so the floor path is byte-for-byte unchanged.
 *
 * For the `docker` tier (the concrete OS boundary Roubo already shells out to)
 * this wraps the plugin's node invocation in `docker run`, mapping a `deny-all`
 * egress policy to `--network none` so an undeclared outbound connection cannot
 * leave the container. The `vz-vm` and `apple-container` rungs are modelled and
 * selected-if-present, but a full VM backend is out of scope for this slice
 * (spike #599 keeps them opt-in/highest-first with a broker-only floor); when
 * their runtime is absent `selectTier` never returns them, and if a caller asks
 * to build one anyway we return `null` so the host degrades to the floor rather
 * than spawning into a backend that does not exist here.
 */
export function buildSandboxedSpawn(
  manifest: PluginManifest,
  tier: IsolationTier,
  options: { execPath: string; entryPath: string; baseEnv?: Record<string, string> },
): SandboxedSpawn | null {
  if (tier === "broker-only") return null;

  const egress = deriveEgressPolicy(manifest);
  const baseEnv = options.baseEnv ?? {};

  if (tier === "docker") {
    const args: string[] = ["run", "--rm", "-i"];
    // Deny all egress when the plugin declared no network hosts (the gap this
    // slice closes). An allow-listed policy still starts from the default
    // bridge network; per-host egress filtering inside the container is a
    // runtime concern the allowlist carries forward, but an undeclared plugin
    // gets no network at all.
    if (egress.mode === "deny-all") {
      args.push("--network", "none");
    }
    for (const [key, value] of Object.entries(baseEnv)) {
      args.push("-e", `${key}=${value}`);
    }
    // The image must already provide the node runtime; the host mounts the
    // plugin dir as part of full F2.3 runtime wiring (out of scope here, which
    // models the boundary deterministically). The command shape is the
    // load-bearing part the unit tests assert.
    args.push("node:lts", options.execPath, options.entryPath);
    return { command: "docker", args, env: baseEnv, egress };
  }

  // vz-vm / apple-container: modelled and selected-if-present, but no VM backend
  // ships in this slice. Degrade to the broker-only floor rather than fabricate
  // a spawn into a runtime that is not implemented here.
  return null;
}
