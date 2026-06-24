import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
 * The path inside every docker container where the plugin directory is
 * bind-mounted (read-only). Using a fixed, flat path keeps the docker run
 * command shape deterministic and makes the unit tests simple to assert.
 */
export const DOCKER_CONTAINER_DIR = "/roubo-plugin";

/**
 * The docker image used to run plugins in the docker isolation tier for
 * deny-all egress (no network hosts declared). Pinned to the same Node.js
 * major as the host runtime so the plugin's JS is always executed by a
 * compatible engine. `node:24-slim` is a minimal Debian image that ships only
 * the Node binary and the standard library, reducing the attack surface
 * compared to the full or Alpine variants. `--network none` makes tooling
 * unnecessary for this path.
 */
export const DOCKER_IMAGE = "node:24-slim";

/**
 * The docker image used for the allow-listed egress path. Built on demand from
 * an inline Dockerfile (see ensureEgressImage) so no external registry publish
 * is required. Extends `node:24-slim` with iptables so the in-container egress
 * filter can program a default-DROP OUTPUT policy and ACCEPT only the resolved
 * IPs of the declared hosts.
 */
export const DOCKER_EGRESS_IMAGE = "roubo-plugin-egress:node24";

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
 * degrading the host one rung rather than crashing detection. The probes are
 * injected so this is deterministic in tests without a live daemon.
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
 * Pull the docker image if it is not already present on the host. Uses
 * dockerode (lazy-imported, mirroring the docker probe) so that module load
 * never incurs a cost on non-docker hosts and a load failure degrades gracefully.
 *
 * Called by plugin-manager before spawning the container; if the pull fails the
 * caller falls back to the broker-only floor rather than attempting the container
 * with a missing image.
 */
export async function ensureImage(image: string = DOCKER_IMAGE): Promise<void> {
  const { default: Dockerode } = await import("dockerode");
  const docker = new Dockerode();

  // Check whether the image is already present to avoid a network round-trip on
  // the common case. getImage().inspect() throws when the image is absent.
  try {
    await docker.getImage(image).inspect();
    return; // already present
  } catch {
    // Not found locally; fall through to pull.
  }

  // Pull the image and wait for completion.
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream | null) => {
      if (err || !stream) {
        reject(err ?? new Error(`docker pull returned no stream for ${image}`));
        return;
      }
      docker.modem.followProgress(stream, (followErr: Error | null) => {
        if (followErr) {
          reject(followErr);
        } else {
          resolve();
        }
      });
    });
  });
}

/**
 * Build the inline sh -c egress-setup script that runs before `exec node
 * <entry>` inside the allow-listed container. The script programs an iptables
 * default-DROP OUTPUT policy, then re-allows loopback, established/related
 * connections, and DNS (udp/tcp port 53), resolves each declared host to its
 * IPs via `getent hosts`, and ACCEPTs those IPs before dropping all other
 * outbound traffic.
 *
 * The function is exported so it can be independently unit-tested (pure,
 * no I/O). The produced string is embedded verbatim inside a `sh -c '...'`
 * argument in the docker run command.
 *
 * hosts come from the manifest's `permissions.network.hosts` list. The manifest
 * schema only constrains them to `z.array(z.string())` (no character allowlist),
 * so this function does NOT trust them: each value is embedded inside an
 * in-container `sh -c` script, where shell metacharacters in a host string
 * (e.g. `api.example.com; iptables -F OUTPUT`) would otherwise inject arbitrary
 * commands and tear down the very egress filter being installed. Host values are
 * therefore both pattern-filtered (only safe hostname/wildcard characters admit
 * a rule) and quoted before interpolation. A value that fails the pattern is
 * dropped, emitting no ACCEPT rule for it, which is fail-closed (no
 * wider-than-declared egress is admitted), the same safe behaviour an
 * unresolvable wildcard already gets below.
 */
// A conservative hostname / wildcard allowlist: letters, digits, dot, hyphen,
// underscore, and `*` (for wildcard entries like `*.example.com`). It excludes
// every shell metacharacter (whitespace, `;`, `$`, backtick, quotes, `(`/`)`,
// `&`, `|`, `<`, `>`, etc.), so a value matching it cannot break out of the
// quoted interpolation below even if quoting were somehow bypassed.
const SAFE_EGRESS_HOST = /^[A-Za-z0-9*._-]+$/;

export function buildEgressSetupScript(hosts: string[]): string {
  // Build the per-host iptables ACCEPT block. For each declared host we run
  // `getent hosts "<host>"` (which resolves both A and AAAA records via the
  // container's resolver) and ACCEPT every returned IP. The host is quoted, and
  // only values matching SAFE_EGRESS_HOST are admitted at all, so an
  // attacker-declared host string cannot inject shell commands into this script.
  // Wildcard entries (*.example.com) pass the pattern but getent fails to
  // resolve them, so the for loop simply emits no rules for that entry, which is
  // the safe behaviour (no wider-than-declared egress admitted).
  const hostBlocks = hosts
    .filter((h) => SAFE_EGRESS_HOST.test(h))
    .map(
      (h) =>
        `for ip in $(getent hosts "${h}" | awk '{print $1}'); do iptables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true; done`,
    )
    .join("; ");

  const parts: string[] = [
    // Flush any existing rules and set the default OUTPUT policy to DROP.
    "iptables -F OUTPUT 2>/dev/null || true",
    "iptables -P OUTPUT DROP 2>/dev/null || true",
    // Allow loopback so the node process can communicate with itself.
    "iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true",
    // Allow packets belonging to established/related connections (responses to
    // inbound TCP/UDP that the broker opened via the host-side API).
    "iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true",
    // Allow DNS so host resolution works inside the container.
    "iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true",
    "iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true",
  ];
  if (hostBlocks) {
    parts.push(hostBlocks);
  }
  return parts.join("; ");
}

/**
 * Build the custom egress image on demand using an inline Dockerfile so no
 * external registry or publish step is required. The image extends
 * `node:24-slim` with iptables and is used only for the allow-listed egress
 * path; deny-all containers keep the plain `node:24-slim` image.
 *
 * If the image tag is already present locally, the build is skipped.
 * Throws on build failure so the caller can fall back to the broker-only
 * floor via the existing ensureImage error-handling path in plugin-manager.
 */
export async function ensureEgressImage(): Promise<void> {
  const { default: Dockerode } = await import("dockerode");
  const docker = new Dockerode();

  // Check local image presence first to avoid an unnecessary build.
  try {
    await docker.getImage(DOCKER_EGRESS_IMAGE).inspect();
    return; // already present
  } catch {
    // Not found locally; fall through to build.
  }

  const dockerfile = [
    `FROM ${DOCKER_IMAGE}`,
    "RUN apt-get update -qq && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*",
  ].join("\n");

  // dockerode's buildImage accepts a tar stream or a context path. To avoid a
  // tmp-file dependency we build from a tar stream containing only the
  // Dockerfile. The tar is assembled inline using Node's built-in Buffer APIs
  // so no external tar library is needed.
  //
  // Tar entry layout (POSIX ustar, 512-byte records):
  //   header (512 bytes) + content (padded to 512-byte boundary) + two null
  //   end-of-archive records (1024 bytes).
  const content = Buffer.from(dockerfile, "utf8");
  const nameBytes = Buffer.from("Dockerfile");
  // Header is 512 bytes; the name field occupies bytes 0-99.
  const header = Buffer.alloc(512);
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));
  // File mode (100644 octal = 0o100644).
  Buffer.from("0000644\0").copy(header, 100);
  // uid / gid both zero.
  Buffer.from("0000000\0").copy(header, 108);
  Buffer.from("0000000\0").copy(header, 116);
  // File size in octal, null-terminated (11 octal digits + NUL).
  const sizeOctal = content.length.toString(8).padStart(11, "0") + "\0";
  Buffer.from(sizeOctal).copy(header, 124);
  // mtime: 0 (epoch), type flag '0' (regular file), magic 'ustar  '.
  Buffer.from("00000000000\0").copy(header, 136);
  header[156] = 0x30; // '0'
  Buffer.from("ustar  \0").copy(header, 257);
  // Compute checksum over the header with checksum field set to spaces.
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);

  // Pad content to 512-byte boundary.
  const padded = Math.ceil(content.length / 512) * 512;
  const contentPadded = Buffer.alloc(padded);
  content.copy(contentPadded);

  // Two 512-byte null records mark end-of-archive.
  const tarBuffer = Buffer.concat([header, contentPadded, Buffer.alloc(1024)]);

  // Convert to a Node.js Readable for dockerode's buildImage.
  const { Readable } = await import("node:stream");
  const tarStream = Readable.from(tarBuffer);

  await new Promise<void>((resolve, reject) => {
    docker.buildImage(
      tarStream as unknown as Parameters<typeof docker.buildImage>[0],
      { t: DOCKER_EGRESS_IMAGE },
      (err: unknown, stream: NodeJS.ReadableStream | undefined) => {
        if (err || !stream) {
          reject(
            (err instanceof Error ? err : null) ??
              new Error(`docker build returned no stream for ${DOCKER_EGRESS_IMAGE}`),
          );
          return;
        }
        docker.modem.followProgress(stream, (followErr: Error | null) => {
          if (followErr) {
            reject(followErr);
          } else {
            resolve();
          }
        });
      },
    );
  });
}

/**
 * Build the concrete sandboxed spawn for a non-floor tier. Returns `null` for
 * the `broker-only` floor: the host spawns the plugin directly, exactly as it
 * does today, so the floor path is byte-for-byte unchanged.
 *
 * For the `docker` tier the plugin directory is bind-mounted read-only into the
 * container at DOCKER_CONTAINER_DIR and the working directory is set to that
 * mount. The entry script is resolved relative to the plugin directory so it is
 * addressable inside the container. Transport is JSON-RPC over `docker run -i`
 * raw stdio (no socket bridge).
 *
 * Egress policy shapes:
 * - `deny-all`: uses `node:24-slim` with `--network none`. No tooling needed.
 * - `allow-listed`: uses `roubo-plugin-egress:node24` (node:24-slim + iptables,
 *   built on demand by ensureEgressImage). Adds `--cap-add NET_ADMIN` so the
 *   init script can program iptables rules, passes the declared hosts via
 *   `-e ROUBO_ALLOWED_HOSTS=<comma-separated list>`, and wraps the node
 *   invocation in an inline `sh -c '<egress-setup>; exec node <entry>'` that
 *   sets a default-DROP OUTPUT policy and ACCEPTs only the resolved IPs of the
 *   declared hosts before handing off to node.
 *
 * The `vz-vm` and `apple-container` rungs are modelled and selected-if-present,
 * but a full VM backend is out of scope for this slice (spike #599 keeps them
 * opt-in/highest-first with a broker-only floor); when their runtime is absent
 * `selectTier` never returns them, and if a caller asks to build one anyway we
 * return `null` so the host degrades to the floor rather than spawning into a
 * backend that does not exist here.
 */
export function buildSandboxedSpawn(
  manifest: PluginManifest,
  tier: IsolationTier,
  options: {
    pluginDir: string;
    entryPath: string;
    baseEnv?: Record<string, string>;
  },
): SandboxedSpawn | null {
  if (tier === "broker-only") return null;

  const egress = deriveEgressPolicy(manifest);
  const baseEnv = options.baseEnv ?? {};

  if (tier === "docker") {
    // Compute the entry path relative to the plugin directory so it is
    // addressable at DOCKER_CONTAINER_DIR/<entryRel> inside the container.
    const entryRel = path.relative(options.pluginDir, options.entryPath);

    const args: string[] = ["run", "--rm", "-i"];

    if (egress.mode === "deny-all") {
      // Deny all egress when the plugin declared no network hosts. --network
      // none prevents the container from reaching any external address at the
      // OS layer; no iptables tooling is needed for this path.
      args.push("--network", "none");
    } else {
      // Allow-listed egress: NET_ADMIN capability lets the in-container init
      // script program iptables rules. The declared host list is passed in via
      // the environment so buildEgressSetupScript can resolve and ACCEPT them.
      args.push("--cap-add", "NET_ADMIN");
    }

    for (const [key, value] of Object.entries(baseEnv)) {
      args.push("-e", `${key}=${value}`);
    }

    if (egress.mode === "allow-listed") {
      args.push("-e", `ROUBO_ALLOWED_HOSTS=${egress.allowedHosts.join(",")}`);
    }

    // Bind-mount the plugin directory read-only and set it as the working
    // directory so the plugin's relative imports resolve correctly.
    args.push("-v", `${options.pluginDir}:${DOCKER_CONTAINER_DIR}:ro`);
    args.push("-w", DOCKER_CONTAINER_DIR);

    const containerEntry = `${DOCKER_CONTAINER_DIR}/${entryRel}`;

    if (egress.mode === "allow-listed") {
      // Use the egress image (node:24-slim + iptables). Wrap the node invocation
      // in an inline sh -c that first programs the iptables filter, then execs
      // node on the entry path so the plugin process inherits the restricted
      // network environment.
      //
      // The container entry path is passed as a discrete `-e` env value rather
      // than interpolated into the shell string. `manifest.entry` is only
      // validated for traversal / absoluteness (not shell metacharacters), so a
      // crafted entry like `index.js; iptables -F` would otherwise inject into
      // this sh -c script and tear down the egress filter. As a `-e` value it is
      // a single literal argv element to `docker run` (the host spawn uses
      // shell:false), and `exec node "$ROUBO_PLUGIN_ENTRY"` expands it inside
      // double quotes, so the in-container shell treats it as one literal
      // argument with no word-splitting or re-interpretation.
      args.push("-e", `ROUBO_PLUGIN_ENTRY=${containerEntry}`);
      const egressSetup = buildEgressSetupScript(egress.allowedHosts);
      const shellCmd = `${egressSetup}; exec node "$ROUBO_PLUGIN_ENTRY"`;
      // The image already provides the node binary; the host execPath (the
      // Electron binary) is never passed into the container (#740).
      args.push(DOCKER_EGRESS_IMAGE, "sh", "-c", shellCmd);
    } else {
      // deny-all path: plain node invocation, no wrapper needed.
      // The image already provides the node binary; the host execPath (the
      // Electron binary) is never passed into the container (#740).
      args.push(DOCKER_IMAGE, "node", containerEntry);
    }

    return { command: "docker", args, env: baseEnv, egress };
  }

  // vz-vm / apple-container: modelled and selected-if-present, but no VM backend
  // ships in this slice. Degrade to the broker-only floor rather than fabricate
  // a spawn into a runtime that is not implemented here.
  return null;
}
