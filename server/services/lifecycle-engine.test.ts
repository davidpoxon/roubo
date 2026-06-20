import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import type { ComponentStatus } from "@roubo/shared";
import {
  runDescriptor,
  type DockerLike,
  type LedgerLike,
  type LifecycleContext,
  type ProcessManagerLike,
} from "./lifecycle-engine.js";

function makeProcessManager(): ProcessManagerLike {
  return {
    startProcess: vi.fn(async () => ({ pid: 4242 })),
    runProcess: vi.fn(async () => ({ exitCode: 0 })),
  };
}

function makeDocker(): DockerLike {
  return {
    composeUp: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    waitForHealthy: vi.fn(async () => true),
    composeRunInit: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    getContainerId: vi.fn(async () => "container-abc123"),
    getComposeProjectName: vi.fn(
      (projectId: string, benchId: number) => `roubo-${projectId}-bench-${benchId}`,
    ),
  };
}

function makeLedger(): LedgerLike {
  return {
    recordProcess: vi.fn(),
    recordComposeProject: vi.fn(),
  };
}

interface Harness {
  pm: ProcessManagerLike;
  docker: DockerLike;
  led: LedgerLike;
  ctx: LifecycleContext;
  reportStatus: ReturnType<typeof vi.fn>;
  statuses: ComponentStatus[];
}

function setup(overrides: Partial<LifecycleContext> = {}): Harness {
  const pm = makeProcessManager();
  const docker = makeDocker();
  const led = makeLedger();
  const statuses: ComponentStatus[] = [];
  const reportStatus = vi.fn((s: ComponentStatus) => {
    statuses.push(s);
  });
  const ctx: LifecycleContext = {
    pluginId: "db-plugin",
    projectId: "proj1",
    benchId: 3,
    componentName: "db",
    workspacePath: "/tmp/ws",
    ports: { db: 5433 },
    reportStatus,
    ...overrides,
  };
  return { pm, docker, led, ctx, reportStatus, statuses };
}

describe("lifecycle-engine runDescriptor", () => {
  // CP-TC-037: docker phase machine.
  describe("docker descriptor (AC1)", () => {
    it("runs composeUp -> waitForHealthy -> initService -> migration and resolves the connection template with the allocated port", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "docker-compose.yml",
        service: "postgres",
        initService: "init",
        portEnvVar: "DB_PORT",
        migration: { command: "npm run migrate", args: ["--latest"] },
        connection: { template: "postgres://localhost:{{port}}/app" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      expect(result.connection).toBe("postgres://localhost:5433/app");

      expect(h.docker.composeUp).toHaveBeenCalledWith({
        composeFile: "docker-compose.yml",
        service: "postgres",
        projectName: "roubo-proj1-bench-3",
        portOverrides: { DB_PORT: "5433" },
        cwd: "/tmp/ws",
      });
      expect(h.docker.waitForHealthy).toHaveBeenCalledWith("roubo-proj1-bench-3", "postgres");
      expect(h.docker.composeRunInit).toHaveBeenCalledTimes(1);
      // migration runs through the injected process-manager.
      expect(h.pm.runProcess).toHaveBeenCalledWith(
        "db-plugin:3:db:migration",
        "npm",
        ["run", "migrate", "--latest"],
        { DB_PORT: "5433" },
        "/tmp/ws",
        300_000,
      );

      const final = h.statuses.at(-1);
      expect(final?.status).toBe("running");
    });

    it("defaults to HOST_PORT and skips optional init/migration when absent (CP-TC-051)", async () => {
      const h = setup({ componentName: "cache", ports: { cache: 6400 } });
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "redis",
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      expect(h.docker.composeUp).toHaveBeenCalledWith(
        expect.objectContaining({ portOverrides: { HOST_PORT: "6400" } }),
      );
      expect(h.docker.composeRunInit).not.toHaveBeenCalled();
      expect(h.pm.runProcess).not.toHaveBeenCalled();
    });

    it("drives to error when the container does not become healthy", async () => {
      const h = setup();
      (h.docker.waitForHealthy as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      const final = h.statuses.at(-1);
      expect(final?.status).toBe("error");
      expect(final?.error).toMatch(/did not become healthy/);
    });
  });

  // CP-TC-038: process phase machine + one-time setup.
  describe("process descriptor (AC2)", () => {
    it("runs one-time setup then starts the process", async () => {
      const h = setup({ componentName: "api", ports: {} });
      const descriptor = {
        schemaVersion: 1,
        kind: "process",
        command: "node server.js",
        setup: "npm install",
        env: { NODE_ENV: "test" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      // setup runs to completion first.
      expect(h.pm.runProcess).toHaveBeenCalledWith(
        "db-plugin:3:api:setup",
        "npm",
        ["install"],
        { NODE_ENV: "test" },
        "/tmp/ws",
        0,
      );
      // then the long-running process starts.
      expect(h.pm.startProcess).toHaveBeenCalledWith(
        "db-plugin:3:api",
        "node",
        ["server.js"],
        { NODE_ENV: "test" },
        "/tmp/ws",
      );
      const final = h.statuses.at(-1);
      expect(final?.status).toBe("running");
      expect(final?.pid).toBe(4242);
    });

    it("skips setup when setupComplete is already true (CP-TC-052)", async () => {
      const h = setup({ componentName: "api", ports: {}, setupComplete: true });
      const descriptor = {
        schemaVersion: 1,
        kind: "process",
        command: "node server.js",
        setup: "npm install",
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      // only the start call, no setup run.
      expect(h.pm.runProcess).not.toHaveBeenCalled();
      expect(h.pm.startProcess).toHaveBeenCalledTimes(1);
    });
  });

  // CP-TC-022 / CP-TC-039: oneshot -> completed terminal state.
  describe("oneshot descriptor (AC2, AC3)", () => {
    it("runs to completion with timeoutMs and reaches the completed terminal state on exit 0", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "./deploy.sh prod",
        timeoutMs: 60_000,
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("completed");
      expect(h.pm.runProcess).toHaveBeenCalledWith(
        "db-plugin:3:deploy",
        "./deploy.sh",
        ["prod"],
        {},
        "/tmp/ws",
        60_000,
      );
      const final = h.statuses.at(-1);
      expect(final?.status).toBe("completed");
    });

    it("drives to error on a non-zero exit (including a timeoutMs breach)", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      (h.pm.runProcess as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 124 });
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "./deploy.sh",
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      const final = h.statuses.at(-1);
      expect(final?.status).toBe("error");
      expect(final?.error).toMatch(/exited with code 124/);
    });
  });

  // CP-TC-047: schemaVersion gate before any host call or ledger write.
  describe("schemaVersion validation (AC4)", () => {
    it("rejects an unsupported schemaVersion before any host-service call or ledger write, and reaches error", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 2,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      // no host-service call, no ledger write.
      expect(h.docker.composeUp).not.toHaveBeenCalled();
      expect(h.pm.startProcess).not.toHaveBeenCalled();
      expect(h.pm.runProcess).not.toHaveBeenCalled();
      expect(h.led.recordComposeProject).not.toHaveBeenCalled();
      expect(h.led.recordProcess).not.toHaveBeenCalled();

      const final = h.statuses.at(-1);
      expect(final?.status).toBe("error");
      expect(final?.error).toMatch(/schemaVersion 2/);
      expect(final?.error).toMatch(/supports schemaVersion 1/);
    });

    it("rejects a structurally invalid descriptor with a clear message", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        // missing required composeFile + service
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      expect(h.docker.composeUp).not.toHaveBeenCalled();
      const final = h.statuses.at(-1);
      expect(final?.error).toMatch(/Invalid ProvisionDescriptor/);
    });
  });

  // CP-TC-056: ledger records each started process and compose project.
  describe("ownership recording (AC5)", () => {
    it("records the compose project for a docker descriptor", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.led.recordComposeProject).toHaveBeenCalledWith(
        "db-plugin",
        3,
        "roubo-proj1-bench-3",
      );
    });

    it("records the started process for a process descriptor", async () => {
      const h = setup({ componentName: "api", ports: {} });
      const descriptor = {
        schemaVersion: 1,
        kind: "process",
        command: "node server.js",
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.led.recordProcess).toHaveBeenCalledWith("db-plugin", 3, "db-plugin:3:api");
    });

    it("records the process for a oneshot descriptor", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "./deploy.sh",
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.led.recordProcess).toHaveBeenCalledWith("db-plugin", 3, "db-plugin:3:deploy");
    });
  });

  // CP-TC-059: env/envFile injection parity (the engine merges envFile).
  describe("envFile merge (FR-007 parity)", () => {
    let readSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      readSpy?.mockRestore();
    });

    it("reads envFile and merges it under explicit env, which wins on conflict", async () => {
      const h = setup({ componentName: "api", ports: {} });
      readSpy = vi
        .spyOn(fs, "readFileSync")
        .mockReturnValue('FOO=from_file\nSHARED="quoted_file"\n# comment\n');
      const descriptor = {
        schemaVersion: 1,
        kind: "process",
        command: "node server.js",
        env: { SHARED: "from_env" },
        envFile: ".env.local",
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.pm.startProcess).toHaveBeenCalledWith(
        "db-plugin:3:api",
        "node",
        ["server.js"],
        { FOO: "from_file", SHARED: "from_env" },
        "/tmp/ws",
      );
    });

    it("ignores a missing envFile without erroring", async () => {
      const h = setup({ componentName: "api", ports: {} });
      readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const descriptor = {
        schemaVersion: 1,
        kind: "process",
        command: "node server.js",
        env: { A: "1" },
        envFile: ".env.missing",
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      expect(h.pm.startProcess).toHaveBeenCalledWith(
        "db-plugin:3:api",
        "node",
        ["server.js"],
        { A: "1" },
        "/tmp/ws",
      );
    });
  });
});
