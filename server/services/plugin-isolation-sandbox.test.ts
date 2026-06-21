import os from "node:os";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { IsolationCapabilities, PluginManifest } from "@roubo/shared";
import {
  buildSandboxedSpawn,
  defaultIsolationProbes,
  detectIsolationCapabilities,
  deriveEgressPolicy,
  selectTier,
  type IsolationProbes,
} from "./plugin-isolation-sandbox.js";

// dockerode is lazy-imported inside the docker probe; mock it so the probe can
// be exercised without a live daemon. pingMock is reassigned per test.
let pingMock: () => Promise<unknown> = () => Promise.resolve("OK");
vi.mock("dockerode", () => ({
  default: class {
    ping() {
      return pingMock();
    }
  },
}));

function manifest(hosts: string[] = []): PluginManifest {
  return {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    description: "demo component plugin",
    kind: "component",
    roubo: "1.x",
    entry: "index.js",
    permissions: {
      network: { hosts },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
  } as PluginManifest;
}

const allOff: IsolationCapabilities = { vzVm: false, appleContainer: false, docker: false };

describe("plugin-isolation-sandbox: selectTier (highest-first, broker-only floor)", () => {
  it("falls back to broker-only when no runtime is available", () => {
    expect(selectTier(allOff)).toBe("broker-only");
  });

  it("selects docker when only docker is available (FR-018: one rung among several)", () => {
    expect(selectTier({ ...allOff, docker: true })).toBe("docker");
  });

  it("prefers apple-container over docker", () => {
    expect(selectTier({ vzVm: false, appleContainer: true, docker: true })).toBe("apple-container");
  });

  it("prefers vz-vm over all lower rungs (highest-isolation-first)", () => {
    expect(selectTier({ vzVm: true, appleContainer: true, docker: true })).toBe("vz-vm");
  });
});

describe("plugin-isolation-sandbox: detectIsolationCapabilities (NFR-005, never assume)", () => {
  it("reports each runtime independently from its probe", async () => {
    const probes: IsolationProbes = {
      vzVm: () => false,
      appleContainer: () => true,
      docker: () => Promise.resolve(true),
    };
    expect(await detectIsolationCapabilities(probes)).toEqual({
      vzVm: false,
      appleContainer: true,
      docker: true,
    });
  });

  it("treats a throwing or rejecting probe as not-available (degrades one rung)", async () => {
    const probes: IsolationProbes = {
      vzVm: () => {
        throw new Error("vz probe blew up");
      },
      appleContainer: () => Promise.reject(new Error("not reachable")),
      docker: () => true,
    };
    expect(await detectIsolationCapabilities(probes)).toEqual({
      vzVm: false,
      appleContainer: false,
      docker: true,
    });
  });

  it("with all probes false, selectTier resolves to the broker-only floor", async () => {
    const caps = await detectIsolationCapabilities({
      vzVm: () => false,
      appleContainer: () => false,
      docker: () => false,
    });
    expect(selectTier(caps)).toBe("broker-only");
  });
});

describe("plugin-isolation-sandbox: deriveEgressPolicy (CP-TC-094 policy derivation)", () => {
  it("denies all egress when no network hosts are declared", () => {
    expect(deriveEgressPolicy(manifest([]))).toEqual({ mode: "deny-all", allowedHosts: [] });
  });

  it("carries the declared allowlist forward when hosts are declared", () => {
    const policy = deriveEgressPolicy(manifest(["api.example.com", "*.internal"]));
    expect(policy).toEqual({
      mode: "allow-listed",
      allowedHosts: ["api.example.com", "*.internal"],
    });
  });
});

describe("plugin-isolation-sandbox: buildSandboxedSpawn", () => {
  const opts = { execPath: "/usr/bin/node", entryPath: "/plugins/demo/index.js" };

  it("returns null for the broker-only floor (host spawns directly, unchanged path)", () => {
    expect(buildSandboxedSpawn(manifest([]), "broker-only", opts)).toBeNull();
  });

  it("wraps a deny-all plugin in `docker run --network none` (CP-TC-094: undeclared egress blocked)", () => {
    const spawn = buildSandboxedSpawn(manifest([]), "docker", opts);
    expect(spawn).not.toBeNull();
    expect(spawn?.command).toBe("docker");
    expect(spawn?.args.slice(0, 5)).toEqual(["run", "--rm", "-i", "--network", "none"]);
    expect(spawn?.args).toContain(opts.execPath);
    expect(spawn?.args).toContain(opts.entryPath);
    expect(spawn?.egress).toEqual({ mode: "deny-all", allowedHosts: [] });
  });

  it("does NOT pass --network none when the plugin declared hosts (allow-listed)", () => {
    const spawn = buildSandboxedSpawn(manifest(["api.example.com"]), "docker", opts);
    expect(spawn?.args).not.toContain("none");
    expect(spawn?.egress).toEqual({ mode: "allow-listed", allowedHosts: ["api.example.com"] });
  });

  it("forwards base env into the docker run command", () => {
    const spawn = buildSandboxedSpawn(manifest([]), "docker", {
      ...opts,
      baseEnv: { ROUBO_PLUGIN_ID: "demo" },
    });
    expect(spawn?.args).toContain("ROUBO_PLUGIN_ID=demo");
    expect(spawn?.env).toEqual({ ROUBO_PLUGIN_ID: "demo" });
  });

  it("degrades vz-vm / apple-container to null (no VM backend ships in this slice)", () => {
    expect(buildSandboxedSpawn(manifest([]), "vz-vm", opts)).toBeNull();
    expect(buildSandboxedSpawn(manifest([]), "apple-container", opts)).toBeNull();
  });
});

describe("plugin-isolation-sandbox: defaultIsolationProbes (#675 real runtime detection)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pingMock = () => Promise.resolve("OK");
  });

  it("vzVm is conservatively false (no VM backend ships in this slice)", async () => {
    expect(await defaultIsolationProbes().vzVm()).toBe(false);
  });

  it("docker probe is true when the daemon ping resolves", async () => {
    pingMock = () => Promise.resolve("OK");
    expect(await defaultIsolationProbes().docker()).toBe(true);
  });

  it("docker probe rejects (treated as unavailable) when the daemon ping fails", async () => {
    pingMock = () => Promise.reject(new Error("daemon unreachable"));
    // The probe propagates the rejection; detectIsolationCapabilities swallows
    // it into a false capability (degrade one rung, NFR-005).
    await expect(defaultIsolationProbes().docker()).rejects.toThrow("daemon unreachable");
    const caps = await detectIsolationCapabilities({
      vzVm: () => false,
      appleContainer: () => false,
      docker: defaultIsolationProbes().docker,
    });
    expect(caps.docker).toBe(false);
  });

  it("appleContainer is false off macOS regardless of the container CLI", async () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    expect(await defaultIsolationProbes().appleContainer()).toBe(false);
  });

  it("appleContainer is false on macOS but non-arm64 (Intel) hosts", async () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "arch").mockReturnValue("x64");
    expect(await defaultIsolationProbes().appleContainer()).toBe(false);
  });

  it("appleContainer falls through to the PATH check on macOS arm64 (absent CLI -> false)", async () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    // The `container` CLI is not installed in the test environment, so the PATH
    // lookup resolves false. This exercises the platform+arch guard passing and
    // the executable check returning the conservative answer.
    expect(await defaultIsolationProbes().appleContainer()).toBe(false);
  });
});
