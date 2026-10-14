import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComponentStatus } from "@roubo/shared";
import {
  DockerProvisionDescriptorSchema,
  ProcessProvisionDescriptorSchema,
  type DockerProvisionDescriptor,
  type ProcessProvisionDescriptor,
} from "@roubo/shared/provision-descriptor-schema";
import {
  runDescriptor,
  type DockerLike,
  type LedgerLike,
  type LifecycleContext,
  type ProcessManagerLike,
} from "./lifecycle-engine.js";

// CP-US-002: a bench component backed by the first-party `process` or
// `database` plugin must start, run, stop, and reconcile identically to the
// built-in component. Each descriptor below is the exact output of that
// plugin's `translate()` for the config named beside it. The plugin sources
// live in the roubo-plugins repository (`plugins/process/src/translate.ts`,
// `plugins/database/src/translate.ts`), and their own tests cover the
// translation. These tests drive those descriptors through the real host
// LifecycleEngine and assert the resulting broker calls, the merged env, and
// the canonical process id that stop and reconcile key off. The engine is the
// single execution path, so identical descriptors yield identical lifecycles.

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
  deps: { processManager: ProcessManagerLike; docker: DockerLike; ledger: LedgerLike };
  ctx: LifecycleContext;
  statuses: ComponentStatus[];
  workspacePath: string;
}

let tmpDirs: string[] = [];

function setup(
  pluginId: "process" | "database",
  overrides: Partial<LifecycleContext> = {},
): Harness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), `roubo-${pluginId}-parity-`));
  tmpDirs.push(workspacePath);
  const statuses: ComponentStatus[] = [];
  const ctx: LifecycleContext = {
    pluginId,
    projectId: "proj1",
    benchId: 3,
    componentName: pluginId === "process" ? "api" : "db",
    workspacePath,
    ports: pluginId === "process" ? {} : { db: 5433 },
    reportStatus: (s: ComponentStatus) => {
      statuses.push(s);
    },
    ...overrides,
  };
  return {
    deps: { processManager: makeProcessManager(), docker: makeDocker(), ledger: makeLedger() },
    ctx,
    statuses,
    workspacePath,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("process plugin parity (CP-US-002)", () => {
  // config: { command: "node server.js", env: { NODE_ENV: "test" } }
  const basic: ProcessProvisionDescriptor = {
    schemaVersion: 1,
    kind: "process",
    command: "node server.js",
    env: { NODE_ENV: "test" },
  };

  it("emits descriptors that validate against the host ProcessProvisionDescriptorSchema", () => {
    expect(() => ProcessProvisionDescriptorSchema.parse(basic)).not.toThrow();
  });

  it("starts a long-running process under the canonical process id", async () => {
    const h = setup("process");

    const result = await runDescriptor(basic, h.ctx, h.deps);

    expect(result.status).toBe("running");
    // Canonical process id `${pluginId}:${benchId}:${componentName}`: stop and
    // reconcile key off this same id, so identical to the built-in component.
    expect(h.deps.processManager.startProcess).toHaveBeenCalledWith(
      "process:3:api",
      "node",
      ["server.js"],
      { NODE_ENV: "test" },
      h.workspacePath,
    );
    expect(h.deps.ledger.recordProcess).toHaveBeenCalledWith("process", 3, "process:3:api");
    const final = h.statuses.at(-1);
    expect(final?.status).toBe("running");
    expect(final?.pid).toBe(4242);
  });

  it("runs one-time setup before starting, and skips it on a Stop -> Start cycle", async () => {
    // config: { command: "node server.js", setup: "npm install" }
    const descriptor: ProcessProvisionDescriptor = {
      schemaVersion: 1,
      kind: "process",
      command: "node server.js",
      setup: "npm install",
    };

    const first = setup("process");
    await runDescriptor(descriptor, first.ctx, first.deps);
    expect(first.deps.processManager.runProcess).toHaveBeenCalledWith(
      "process:3:api:setup",
      "npm",
      ["install"],
      {},
      first.workspacePath,
      0,
    );
    expect(first.deps.processManager.startProcess).toHaveBeenCalledTimes(1);

    const second = setup("process", { setupComplete: true });
    await runDescriptor(descriptor, second.ctx, second.deps);
    expect(second.deps.processManager.runProcess).not.toHaveBeenCalled();
    expect(second.deps.processManager.startProcess).toHaveBeenCalledTimes(1);
  });

  it("merges envFile into the process env, with explicit env winning", async () => {
    // config: { command: "node app.js", env: {...}, envFile: ".env" }
    const descriptor: ProcessProvisionDescriptor = {
      schemaVersion: 1,
      kind: "process",
      command: "node app.js",
      env: { FROM_ENV: "env-value", SHARED: "from-env" },
      envFile: ".env",
    };
    const h = setup("process");
    fs.writeFileSync(
      path.join(h.workspacePath, ".env"),
      "FROM_FILE=file-value\nSHARED=from-file\n",
      "utf8",
    );

    await runDescriptor(descriptor, h.ctx, h.deps);

    expect(h.deps.processManager.startProcess).toHaveBeenCalledWith(
      "process:3:api",
      "node",
      ["app.js"],
      { FROM_FILE: "file-value", FROM_ENV: "env-value", SHARED: "from-env" },
      h.workspacePath,
    );
  });

  it("resolves the directory key (descriptor cwd) against the workspace", async () => {
    // config: { command: "node app.js", directory: "services/api" }
    const descriptor: ProcessProvisionDescriptor = {
      schemaVersion: 1,
      kind: "process",
      command: "node app.js",
      cwd: "services/api",
    };
    const h = setup("process");
    const subdir = path.join(h.workspacePath, "services", "api");
    fs.mkdirSync(subdir, { recursive: true });

    await runDescriptor(descriptor, h.ctx, h.deps);

    expect(h.deps.processManager.startProcess).toHaveBeenCalledWith(
      "process:3:api",
      "node",
      ["app.js"],
      {},
      subdir,
    );
  });
});

describe("database plugin parity (CP-US-002)", () => {
  // config: { composeFile, service, initService, portEnvVar, migration,
  //           connection, env } as below
  const full: DockerProvisionDescriptor = {
    schemaVersion: 1,
    kind: "docker",
    composeFile: "docker-compose.yml",
    service: "postgres",
    initService: "init",
    portEnvVar: "DB_PORT",
    migration: { command: "npm run migrate", args: ["--latest"] },
    connection: { template: "postgres://localhost:{{port}}/app" },
    env: { POSTGRES_PASSWORD: "secret" },
  };

  it("emits descriptors that validate against the host DockerProvisionDescriptorSchema", () => {
    expect(() => DockerProvisionDescriptorSchema.parse(full)).not.toThrow();
  });

  it("runs the full docker phase machine and fills the connection string with the allocated port", async () => {
    const h = setup("database");

    const result = await runDescriptor(full, h.ctx, h.deps);

    expect(result.status).toBe("running");
    expect(result.connection).toBe("postgres://localhost:5433/app");
    expect(h.deps.docker.composeUp).toHaveBeenCalledWith({
      composeFile: "docker-compose.yml",
      service: "postgres",
      projectName: "roubo-proj1-bench-3",
      portOverrides: { POSTGRES_PASSWORD: "secret", DB_PORT: "5433" },
      cwd: h.workspacePath,
    });
    expect(h.deps.docker.waitForHealthy).toHaveBeenCalledWith("roubo-proj1-bench-3", "postgres");
    expect(h.deps.docker.composeRunInit).toHaveBeenCalledTimes(1);
    expect(h.deps.processManager.runProcess).toHaveBeenCalledWith(
      "database:3:db:migration",
      "npm",
      ["run", "migrate", "--latest"],
      { POSTGRES_PASSWORD: "secret", DB_PORT: "5433" },
      h.workspacePath,
      300_000,
    );
    expect(h.deps.ledger.recordComposeProject).toHaveBeenCalledWith(
      "database",
      3,
      "roubo-proj1-bench-3",
    );
    expect(h.statuses.at(-1)?.status).toBe("running");
  });

  it("starts a database with no migration or initService (CP-TC-051)", async () => {
    // config: { composeFile: "compose.yml", service: "redis" }
    const descriptor: DockerProvisionDescriptor = {
      schemaVersion: 1,
      kind: "docker",
      composeFile: "compose.yml",
      service: "redis",
    };
    const h = setup("database", { componentName: "cache", ports: { cache: 6400 } });

    const result = await runDescriptor(descriptor, h.ctx, h.deps);

    expect(result.status).toBe("running");
    expect(h.deps.docker.composeUp).toHaveBeenCalledWith(
      expect.objectContaining({ portOverrides: { HOST_PORT: "6400" } }),
    );
    expect(h.deps.docker.composeRunInit).not.toHaveBeenCalled();
    expect(h.deps.processManager.runProcess).not.toHaveBeenCalled();
  });

  it("uses an external assigned container: skips compose, only verifies it is running", async () => {
    // config: { composeFile, service, assignedContainerId, connection } as below
    const descriptor: DockerProvisionDescriptor = {
      schemaVersion: 1,
      kind: "docker",
      composeFile: "compose.yml",
      service: "postgres",
      connection: { template: "postgres://localhost:{{port}}/app" },
      assignedContainerId: "ext-container-123",
    };
    const h = setup("database");

    const result = await runDescriptor(descriptor, h.ctx, h.deps);

    expect(result.status).toBe("running");
    expect(result.connection).toBe("postgres://localhost:5433/app");
    expect(h.deps.docker.getContainerStatusById).toHaveBeenCalledWith("ext-container-123");
    expect(h.deps.docker.composeUp).not.toHaveBeenCalled();
    expect(h.deps.docker.waitForHealthy).not.toHaveBeenCalled();
  });
});
