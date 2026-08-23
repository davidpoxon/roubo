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
    runProcess: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
    getProcessLogLines: vi.fn(() => []),
  };
}

function makeDocker(): DockerLike {
  return {
    composeUp: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    waitForHealthy: vi.fn(async () => true),
    composeRunInit: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
    getContainerId: vi.fn(async () => "container-abc123"),
    getContainerStatusById: vi.fn(async () => "running" as const),
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
      // The running push carries the container id resolved from the same seam the
      // broker uses after composeUp, so the integrated ComponentStatus reports it
      // while the container is up (davidpoxon/roubo-development#410).
      expect(h.docker.getContainerId).toHaveBeenCalledWith("roubo-proj1-bench-3", "postgres");
      expect(final?.containerId).toBe("container-abc123");
    });

    it("omits the container id on the running push when none can be resolved (davidpoxon/roubo-development#410)", async () => {
      const h = setup();
      (h.docker.getContainerId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

      expect(result.status).toBe("running");
      expect(h.statuses.at(-1)?.containerId).toBeUndefined();
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

    it("drives to error and surfaces the message when composeUp fails", async () => {
      const h = setup();
      (h.docker.composeUp as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "compose boom",
        stdout: "",
        stderr: "",
      });
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
      // composeUp failed before the project was up, so nothing healthy-checks.
      expect(h.docker.waitForHealthy).not.toHaveBeenCalled();
      expect(h.statuses.at(-1)?.error).toMatch(/compose boom/);
    });

    it("drives to error when the optional init service fails", async () => {
      const h = setup();
      (h.docker.composeRunInit as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "init boom",
        stdout: "",
        stderr: "",
      });
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        initService: "seed",
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      expect(h.statuses.at(-1)?.error).toMatch(/init boom/);
    });

    // #397 AC1: the engine forwards the compose / init / migration output it
    // drives into the component log store (via ctx.reportLog), so a plugin-backed
    // docker component surfaces logs even though the declarative plugin never
    // calls host.component.reportLog itself.
    it("forwards composeUp, init and migration output through reportLog (AC1, #397)", async () => {
      const reportLog = vi.fn();
      const h = setup({ reportLog });
      (h.docker.composeUp as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        stdout: "Creating postgres ... done",
        stderr: "compose-warn",
      });
      (h.docker.composeRunInit as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        stdout: "db-init: schema bootstrap complete",
        stderr: "",
      });
      (h.pm.getProcessLogLines as ReturnType<typeof vi.fn>).mockReturnValue([
        { source: "stdout", text: "migrate: applied 3 migrations", ts: "2026-06-21T00:00:00.000Z" },
      ]);
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        initService: "seed",
        migration: { command: "npm run migrate" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      const forwarded = reportLog.mock.calls.map((c) => [c[0], c[1].source, c[1].text]);
      expect(forwarded).toContainEqual(["db", "stdout", "Creating postgres ... done"]);
      expect(forwarded).toContainEqual(["db", "stderr", "compose-warn"]);
      expect(forwarded).toContainEqual(["db", "stdout", "db-init: schema bootstrap complete"]);
      expect(forwarded).toContainEqual(["db", "stdout", "migrate: applied 3 migrations"]);
      // The migration buffer is read back from process-manager under the side id.
      expect(h.pm.getProcessLogLines).toHaveBeenCalledWith("db-plugin:3:db:migration");
    });

    it("forwards failing-compose output before erroring, so diagnostics surface (AC1, #397)", async () => {
      const reportLog = vi.fn();
      const h = setup({ reportLog });
      (h.docker.composeUp as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "compose boom",
        stdout: "",
        stderr: "port already allocated",
      });
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
      const forwarded = reportLog.mock.calls.map((c) => [c[1].source, c[1].text]);
      expect(forwarded).toContainEqual(["stderr", "port already allocated"]);
    });

    it("does not fail when no reportLog sink is wired (engine stays pure)", async () => {
      const h = setup(); // no reportLog
      (h.docker.composeUp as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        stdout: "line",
        stderr: "",
      });
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

      expect(result.status).toBe("running");
    });

    it("merges descriptor env into the compose port overrides, with the port override applied last (AC1, CP-TC-035, CP-TC-060)", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        portEnvVar: "DB_PORT",
        env: { POSTGRES_PASSWORD: "secret", DB_PORT: "ignored-by-port-override" },
        migration: { command: "npm run migrate" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      // env entries are present; the allocated port wins on the portEnvVar key.
      expect(h.docker.composeUp).toHaveBeenCalledWith(
        expect.objectContaining({
          portOverrides: { POSTGRES_PASSWORD: "secret", DB_PORT: "5433" },
        }),
      );
      // the migration process env carries the merged env + port override too.
      expect(h.pm.runProcess).toHaveBeenCalledWith(
        "db-plugin:3:db:migration",
        "npm",
        ["run", "migrate"],
        { POSTGRES_PASSWORD: "secret", DB_PORT: "5433" },
        "/tmp/ws",
        300_000,
      );
    });

    it("skips composeUp and only verifies the running container when assignedContainerId is set (AC3, CP-TC-034)", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        assignedContainerId: "ext-container-123",
        connection: { template: "postgres://localhost:{{port}}/app" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      // the connection template still resolves with the allocated port.
      expect(result.connection).toBe("postgres://localhost:5433/app");
      // the assigned container's running state is verified.
      expect(h.docker.getContainerStatusById).toHaveBeenCalledWith("ext-container-123");
      // compose is skipped entirely: the user owns the container's lifecycle.
      expect(h.docker.composeUp).not.toHaveBeenCalled();
      expect(h.docker.waitForHealthy).not.toHaveBeenCalled();
      expect(h.led.recordComposeProject).not.toHaveBeenCalled();
      // The running push carries the externally-assigned container id (resolved
      // from the descriptor, not a compose lookup) so the integrated
      // ComponentStatus reports it (davidpoxon/roubo-development#410).
      expect(h.statuses.at(-1)?.containerId).toBe("ext-container-123");
      expect(h.docker.getContainerId).not.toHaveBeenCalled();
    });

    it("drives to error when the assigned container is not running (AC3)", async () => {
      const h = setup();
      (h.docker.getContainerStatusById as ReturnType<typeof vi.fn>).mockResolvedValue("stopped");
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        assignedContainerId: "ext-container-123",
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      expect(h.docker.composeUp).not.toHaveBeenCalled();
      expect(h.statuses.at(-1)?.error).toMatch(
        /Assigned container 'ext-container-123' is not running/,
      );
    });

    it("drives to error when a migration exits non-zero", async () => {
      const h = setup();
      (h.pm.runProcess as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 1 });
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        migration: { command: "npm run migrate" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      expect(h.statuses.at(-1)?.error).toMatch(/migration failed with exit code 1/);
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

    it("drives to error on a plain non-zero exit without naming a timeout", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      (h.pm.runProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        exitCode: 2,
        timedOut: false,
      });
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
      expect(final?.error).toMatch(/exited with code 2/);
      // A plain failure carries no timeout statusDetail.
      expect(final?.statusDetail).toBeUndefined();
    });

    it("names the timeout in both error and statusDetail on a timeoutMs breach (CP-TC-068)", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      // process-manager force-kills a hung run and reports timedOut with exit 124.
      (h.pm.runProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        exitCode: 124,
        timedOut: true,
      });
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "./deploy.sh",
        timeoutMs: 5_000,
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("error");
      const final = h.statuses.at(-1);
      expect(final?.status).toBe("error");
      // Both surfaces name the timeout and the configured budget (#411).
      expect(final?.error).toMatch(/timed out after 5000ms/);
      expect(final?.statusDetail).toBe("Timed out after 5000ms");
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

    it("records the docker migration process so a crash mid-migration is reapable", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        migration: { command: "npm run migrate" },
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.led.recordProcess).toHaveBeenCalledWith("db-plugin", 3, "db-plugin:3:db:migration");
    });

    it("records the process one-time setup so a crash mid-setup is reapable", async () => {
      const h = setup({ componentName: "api", ports: {} });
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

      expect(h.led.recordProcess).toHaveBeenCalledWith("db-plugin", 3, "db-plugin:3:api:setup");
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
  // #834: the declarative route to ComponentStatus.url. A `translate`-only
  // plugin never holds the reportStatus sink, so the descriptor declares the
  // URL and the engine carries it into its own terminal push.
  describe("descriptor-declared url (#834)", () => {
    it("resolves a docker url.template against the allocated port on the running push", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        url: { template: "http://localhost:{{port}}/admin" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      expect(h.statuses.at(-1)?.url).toBe("http://localhost:5433/admin");
    });

    it("resolves a docker url.fromOutput against the captured compose output", async () => {
      const h = setup();
      (h.docker.composeUp as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        stdout: "Creating network\nListening on https://db.internal.test:8443\n",
        stderr: "",
      });
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        url: { fromOutput: "Listening on (https://\\S+)" },
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.statuses.at(-1)?.url).toBe("https://db.internal.test:8443");
    });

    it("resolves a url.template on the assigned-container branch alongside the container id", async () => {
      const h = setup();
      const descriptor = {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "compose.yml",
        service: "postgres",
        assignedContainerId: "user-owned-1",
        url: { template: "http://localhost:{{port}}" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      const final = h.statuses.at(-1);
      expect(final?.containerId).toBe("user-owned-1");
      expect(final?.url).toBe("http://localhost:5433");
      expect(h.docker.composeUp).not.toHaveBeenCalled();
    });

    it("resolves a process url.template on the running push", async () => {
      const h = setup({ componentName: "api", ports: { api: 4100 } });
      const descriptor = {
        schemaVersion: 1,
        kind: "process",
        command: "node server.js",
        url: { template: "http://localhost:{{port}}/health" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("running");
      const final = h.statuses.at(-1);
      expect(final?.pid).toBe(4242);
      expect(final?.url).toBe("http://localhost:4100/health");
    });

    it("pulls a oneshot url out of the command output via url.fromOutput", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      (h.pm.getProcessLogLines as ReturnType<typeof vi.fn>).mockReturnValue([
        { source: "stdout", text: "Building...", ts: "2026-01-01T00:00:00.000Z" },
        {
          source: "stdout",
          text: "Service URL: https://svc-abc.a.run.app",
          ts: "2026-01-01T00:00:01.000Z",
        },
      ]);
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "deploy.sh",
        url: { fromOutput: "Service URL: (https://\\S+)" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("completed");
      const final = h.statuses.at(-1);
      expect(final?.status).toBe("completed");
      expect(final?.url).toBe("https://svc-abc.a.run.app");
      expect(h.pm.getProcessLogLines).toHaveBeenCalledWith("db-plugin:3:deploy");
    });

    it("returns the whole match when the fromOutput pattern defines no capture group", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      (h.pm.getProcessLogLines as ReturnType<typeof vi.fn>).mockReturnValue([
        { source: "stdout", text: "done https://svc.example.test", ts: "2026-01-01T00:00:00.000Z" },
      ]);
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "deploy.sh",
        url: { fromOutput: "https://\\S+" },
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.statuses.at(-1)?.url).toBe("https://svc.example.test");
    });

    it("reports no url when the fromOutput pattern does not match, without failing the run", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      (h.pm.getProcessLogLines as ReturnType<typeof vi.fn>).mockReturnValue([
        { source: "stdout", text: "nothing to see", ts: "2026-01-01T00:00:00.000Z" },
      ]);
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "deploy.sh",
        url: { fromOutput: "Service URL: (https://\\S+)" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("completed");
      const final = h.statuses.at(-1);
      expect(final?.status).toBe("completed");
      expect(final?.url).toBeUndefined();
    });

    it("survives a fromOutput pattern that will not compile", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = setup({ componentName: "deploy", ports: {} });
      (h.pm.getProcessLogLines as ReturnType<typeof vi.fn>).mockReturnValue([
        { source: "stdout", text: "https://svc.example.test", ts: "2026-01-01T00:00:00.000Z" },
      ]);
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "deploy.sh",
        url: { fromOutput: "([unterminated" },
      };

      const result = await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(result.status).toBe("completed");
      expect(h.statuses.at(-1)?.url).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("does not read the process log buffer when no fromOutput pattern is declared", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      const descriptor = {
        schemaVersion: 1,
        kind: "oneshot",
        command: "deploy.sh",
        url: { template: "https://static.example.test" },
      };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      expect(h.pm.getProcessLogLines).not.toHaveBeenCalled();
      expect(h.statuses.at(-1)?.url).toBe("https://static.example.test");
    });

    it("omits url entirely when the descriptor declares none", async () => {
      const h = setup({ componentName: "deploy", ports: {} });
      const descriptor = { schemaVersion: 1, kind: "oneshot", command: "deploy.sh" };

      await runDescriptor(descriptor, h.ctx, {
        processManager: h.pm,
        docker: h.docker,
        ledger: h.led,
      });

      const final = h.statuses.at(-1) as Record<string, unknown>;
      expect("url" in final).toBe(false);
    });
  });
});

// #836: `shell` is honoured at every descriptor spawn site, and omitting it
// leaves the argv behaviour above byte-identical.
describe("lifecycle-engine shell option (#836)", () => {
  it("spawns a process command as argv when shell is omitted", async () => {
    const h = setup({ componentName: "web", ports: { web: 3000 } });

    await runDescriptor({ schemaVersion: 1, kind: "process", command: "npm run dev" }, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(h.pm.startProcess).toHaveBeenCalledWith(
      "db-plugin:3:web",
      "npm",
      ["run", "dev"],
      {},
      "/tmp/ws",
    );
  });

  it("runs a process command through /bin/sh -c when shell is true", async () => {
    const h = setup({ componentName: "web", ports: { web: 3000 } });

    await runDescriptor(
      { schemaVersion: 1, kind: "process", command: "cd web && npm run dev", shell: true },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    expect(h.pm.startProcess).toHaveBeenCalledWith(
      "db-plugin:3:web",
      "/bin/sh",
      ["-c", "cd web && npm run dev"],
      {},
      "/tmp/ws",
    );
  });

  it("runs a process command through the named shell when shell is a string", async () => {
    const h = setup({ componentName: "web", ports: { web: 3000 } });

    await runDescriptor(
      { schemaVersion: 1, kind: "process", command: "nvm use && npm run dev", shell: "zsh -i" },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    expect(h.pm.startProcess).toHaveBeenCalledWith(
      "db-plugin:3:web",
      "zsh",
      ["-i", "-c", "nvm use && npm run dev"],
      {},
      "/tmp/ws",
    );
  });

  it("applies the same shell to the one-time setup command", async () => {
    const h = setup({ componentName: "web", ports: { web: 3000 } });

    await runDescriptor(
      {
        schemaVersion: 1,
        kind: "process",
        command: "npm run dev",
        setup: "nvm use && npm ci",
        shell: "zsh -i",
      },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    expect(h.pm.runProcess).toHaveBeenCalledWith(
      "db-plugin:3:web:setup",
      "zsh",
      ["-i", "-c", "nvm use && npm ci"],
      {},
      "/tmp/ws",
      0,
    );
  });

  it("runs a oneshot command through the named shell", async () => {
    const h = setup({ componentName: "deploy", ports: {} });

    await runDescriptor(
      { schemaVersion: 1, kind: "oneshot", command: "deploy.sh && echo done", shell: true },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    expect(h.pm.runProcess).toHaveBeenCalledWith(
      "db-plugin:3:deploy",
      "/bin/sh",
      ["-c", "deploy.sh && echo done"],
      {},
      "/tmp/ws",
      0,
    );
  });

  it("runs a docker migration through the named shell, folding args into the shell command line", async () => {
    const h = setup();

    await runDescriptor(
      {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "docker-compose.yml",
        service: "postgres",
        migration: { command: "nvm use && npm run migrate", args: ["--latest"], shell: "zsh -i" },
      },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    expect(h.pm.runProcess).toHaveBeenCalledWith(
      "db-plugin:3:db:migration",
      "zsh",
      ["-i", "-c", "nvm use && npm run migrate --latest"],
      { HOST_PORT: "5433" },
      "/tmp/ws",
      300_000,
    );
  });

  it("leaves migration argv behaviour unchanged when migration.shell is omitted", async () => {
    const h = setup();

    await runDescriptor(
      {
        schemaVersion: 1,
        kind: "docker",
        composeFile: "docker-compose.yml",
        service: "postgres",
        migration: { command: "npm run migrate", args: ["--latest"] },
      },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    expect(h.pm.runProcess).toHaveBeenCalledWith(
      "db-plugin:3:db:migration",
      "npm",
      ["run", "migrate", "--latest"],
      { HOST_PORT: "5433" },
      "/tmp/ws",
      300_000,
    );
  });

  // AC7: an argv-mode failure on a command carrying shell syntax names the
  // missing shell rather than the binary the tokenizer happened to pick.
  it("enriches an argv-mode spawn failure with a shell suggestion", async () => {
    const h = setup({ componentName: "web", ports: { web: 3000 } });
    h.pm.startProcess = vi.fn(async () => {
      throw new Error("spawn nvm ENOENT");
    });

    await runDescriptor(
      { schemaVersion: 1, kind: "process", command: "nvm use && npm run dev" },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    const final = h.statuses.at(-1);
    expect(final?.status).toBe("error");
    expect(final?.error).toContain("spawn nvm ENOENT");
    expect(final?.error).toContain("shell syntax");
    expect(final?.error).toContain("shell: zsh -i");
  });

  it("leaves a spawn failure untouched when the command carries no shell syntax", async () => {
    const h = setup({ componentName: "web", ports: { web: 3000 } });
    h.pm.startProcess = vi.fn(async () => {
      throw new Error("spawn npmm ENOENT");
    });

    await runDescriptor({ schemaVersion: 1, kind: "process", command: "npmm run dev" }, h.ctx, {
      processManager: h.pm,
      docker: h.docker,
      ledger: h.led,
    });

    expect(h.statuses.at(-1)?.error).toBe("spawn npmm ENOENT");
  });

  it("leaves a spawn failure untouched when shell was already requested", async () => {
    const h = setup({ componentName: "web", ports: { web: 3000 } });
    h.pm.startProcess = vi.fn(async () => {
      throw new Error("spawn zsh ENOENT");
    });

    await runDescriptor(
      { schemaVersion: 1, kind: "process", command: "nvm use && npm run dev", shell: "zsh -i" },
      h.ctx,
      { processManager: h.pm, docker: h.docker, ledger: h.led },
    );

    expect(h.statuses.at(-1)?.error).toBe("spawn zsh ENOENT");
  });
});
