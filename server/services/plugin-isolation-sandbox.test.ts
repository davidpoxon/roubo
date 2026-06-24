import os from "node:os";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { IsolationCapabilities, PluginManifest } from "@roubo/shared";
import {
  buildSandboxedSpawn,
  defaultIsolationProbes,
  detectIsolationCapabilities,
  deriveEgressPolicy,
  ensureImage,
  selectTier,
  DOCKER_CONTAINER_DIR,
  DOCKER_IMAGE,
  type IsolationProbes,
} from "./plugin-isolation-sandbox.js";

// dockerode is lazy-imported inside the docker probe and ensureImage; mock it so
// the probe and image-pull helpers can be exercised without a live daemon.
// inspectMock, pullMock, and pingMock are reassigned per test.
let pingMock: () => Promise<unknown> = () => Promise.resolve("OK");
let inspectMock: () => Promise<unknown> = () =>
  Promise.reject(Object.assign(new Error("No such image"), { statusCode: 404 }));
let pullMock: (
  image: string,
  cb: (err: Error | null, stream: { pipe: () => void } | null) => void,
) => void = (_image, cb) => cb(null, { pipe: () => {} });
let followProgressMock: (stream: unknown, cb: (err: Error | null) => void) => void = (
  _stream,
  cb,
) => cb(null);

vi.mock("dockerode", () => ({
  default: class {
    ping() {
      return pingMock();
    }
    getImage(_name: string) {
      return {
        inspect: () => inspectMock(),
      };
    }
    pull(image: string, cb: (err: Error | null, stream: unknown) => void) {
      return pullMock(image, cb as Parameters<typeof pullMock>[1]);
    }
    modem = {
      followProgress: (stream: unknown, cb: (err: Error | null) => void) => {
        return followProgressMock(stream, cb);
      },
    };
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
  const pluginDir = "/plugins/demo";
  const entryPath = "/plugins/demo/index.js";
  const opts = { pluginDir, entryPath };

  it("returns null for the broker-only floor (host spawns directly, unchanged path)", () => {
    expect(buildSandboxedSpawn(manifest([]), "broker-only", opts)).toBeNull();
  });

  it("wraps a deny-all plugin in `docker run --network none` (CP-TC-094: undeclared egress blocked)", () => {
    const result = buildSandboxedSpawn(manifest([]), "docker", opts);
    expect(result).not.toBeNull();
    expect(result?.command).toBe("docker");
    expect(result?.args.slice(0, 5)).toEqual(["run", "--rm", "-i", "--network", "none"]);
    expect(result?.egress).toEqual({ mode: "deny-all", allowedHosts: [] });
  });

  it("mounts the plugin directory into the container (bind-mount -v)", () => {
    const result = buildSandboxedSpawn(manifest([]), "docker", opts);
    // The -v arg binds <pluginDir>:<DOCKER_CONTAINER_DIR>:ro.
    expect(result?.args).toContain("-v");
    const vIdx = result?.args.indexOf("-v") ?? -1;
    expect(result?.args[vIdx + 1]).toBe(`${pluginDir}:${DOCKER_CONTAINER_DIR}:ro`);
  });

  it("sets the container working directory to DOCKER_CONTAINER_DIR (-w)", () => {
    const result = buildSandboxedSpawn(manifest([]), "docker", opts);
    expect(result?.args).toContain("-w");
    const wIdx = result?.args.indexOf("-w") ?? -1;
    expect(result?.args[wIdx + 1]).toBe(DOCKER_CONTAINER_DIR);
  });

  it("runs `node <containerEntry>` inside the image, NOT the host execPath (#740)", () => {
    const result = buildSandboxedSpawn(manifest([]), "docker", opts);
    // Image, then node, then the container-relative entry path.
    const imageIdx = result?.args.indexOf(DOCKER_IMAGE) ?? -1;
    expect(imageIdx).toBeGreaterThan(0);
    expect(result?.args[imageIdx + 1]).toBe("node");
    expect(result?.args[imageIdx + 2]).toBe(`${DOCKER_CONTAINER_DIR}/index.js`);
  });

  it("does NOT include the host absolute entry path in the docker args (#740)", () => {
    const result = buildSandboxedSpawn(manifest([]), "docker", opts);
    // The absolute host entry path must never appear in the container command
    // because it does not exist inside the container.
    expect(result?.args).not.toContain(entryPath);
  });

  it("does NOT include a host node binary or Electron execPath in the docker args (#740)", () => {
    // The host process.execPath (which may be the Electron binary) must not
    // appear anywhere in the docker command.
    const hostExecPath = process.execPath;
    const result = buildSandboxedSpawn(manifest([]), "docker", opts);
    expect(result?.args).not.toContain(hostExecPath);
  });

  it("does NOT pass --network none when the plugin declared hosts (allow-listed egress, #741)", () => {
    const result = buildSandboxedSpawn(manifest(["api.example.com"]), "docker", opts);
    expect(result?.args).not.toContain("none");
    expect(result?.egress).toEqual({ mode: "allow-listed", allowedHosts: ["api.example.com"] });
  });

  it("forwards base env into the docker run command as -e flags", () => {
    const result = buildSandboxedSpawn(manifest([]), "docker", {
      ...opts,
      baseEnv: { ROUBO_PLUGIN_ID: "demo" },
    });
    expect(result?.args).toContain("-e");
    expect(result?.args).toContain("ROUBO_PLUGIN_ID=demo");
    expect(result?.env).toEqual({ ROUBO_PLUGIN_ID: "demo" });
  });

  it("resolves a nested entry relative to pluginDir for the container path", () => {
    const nestedEntry = "/plugins/demo/dist/index.js";
    const result = buildSandboxedSpawn(manifest([]), "docker", {
      pluginDir,
      entryPath: nestedEntry,
    });
    const imageIdx = result?.args.indexOf(DOCKER_IMAGE) ?? -1;
    // entryRel = "dist/index.js", so container path is DOCKER_CONTAINER_DIR/dist/index.js.
    expect(result?.args[imageIdx + 2]).toBe(`${DOCKER_CONTAINER_DIR}/dist/index.js`);
    // The absolute host path must not appear.
    expect(result?.args).not.toContain(nestedEntry);
  });

  it("degrades vz-vm / apple-container to null (no VM backend ships in this slice)", () => {
    expect(buildSandboxedSpawn(manifest([]), "vz-vm", opts)).toBeNull();
    expect(buildSandboxedSpawn(manifest([]), "apple-container", opts)).toBeNull();
  });
});

describe("plugin-isolation-sandbox: ensureImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pingMock = () => Promise.resolve("OK");
    inspectMock = () =>
      Promise.reject(Object.assign(new Error("No such image"), { statusCode: 404 }));
    pullMock = (_image, cb) => cb(null, { pipe: () => {} });
    followProgressMock = (_stream, cb) => cb(null);
  });

  it("skips the pull when the image is already present locally", async () => {
    // inspect resolves -> image present -> no pull needed.
    inspectMock = () => Promise.resolve({ Id: "sha256:abc" });
    const pullSpy = vi.fn();
    pullMock = (_image, cb) => {
      pullSpy();
      cb(null, { pipe: () => {} });
    };
    await expect(ensureImage(DOCKER_IMAGE)).resolves.toBeUndefined();
    expect(pullSpy).not.toHaveBeenCalled();
  });

  it("pulls the image when it is absent from the local store", async () => {
    // inspect rejects (image absent) -> triggers pull.
    inspectMock = () =>
      Promise.reject(Object.assign(new Error("No such image"), { statusCode: 404 }));
    const pulledImages: string[] = [];
    pullMock = (image, cb) => {
      pulledImages.push(image);
      cb(null, { pipe: () => {} });
    };
    followProgressMock = (_stream, cb) => cb(null);
    await expect(ensureImage(DOCKER_IMAGE)).resolves.toBeUndefined();
    expect(pulledImages).toContain(DOCKER_IMAGE);
  });

  it("rejects when the pull stream errors", async () => {
    inspectMock = () =>
      Promise.reject(Object.assign(new Error("No such image"), { statusCode: 404 }));
    pullMock = (_image, cb) => cb(null, { pipe: () => {} });
    followProgressMock = (_stream, cb) => cb(new Error("registry unreachable"));
    await expect(ensureImage(DOCKER_IMAGE)).rejects.toThrow("registry unreachable");
  });

  it("rejects when docker.pull itself errors", async () => {
    inspectMock = () =>
      Promise.reject(Object.assign(new Error("No such image"), { statusCode: 404 }));
    pullMock = (_image, cb) => cb(new Error("pull failed"), null);
    await expect(ensureImage(DOCKER_IMAGE)).rejects.toThrow("pull failed");
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
