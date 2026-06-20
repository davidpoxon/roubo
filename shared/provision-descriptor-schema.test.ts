import { describe, expect, it } from "vitest";
import {
  DockerProvisionDescriptorSchema,
  OneshotProvisionDescriptorSchema,
  ProcessProvisionDescriptorSchema,
  ProvisionDescriptorSchema,
  SUPPORTED_PROVISION_SCHEMA_VERSION,
  type DockerProvisionDescriptor,
  type OneshotProvisionDescriptor,
  type ProcessProvisionDescriptor,
} from "./provision-descriptor-schema";

const V = SUPPORTED_PROVISION_SCHEMA_VERSION;

describe("ProvisionDescriptor schema version", () => {
  it("exports a supported version constant of 1", () => {
    expect(SUPPORTED_PROVISION_SCHEMA_VERSION).toBe(1);
  });
});

describe("docker variant", () => {
  it("parses a minimal docker descriptor", () => {
    const minimal: DockerProvisionDescriptor = {
      schemaVersion: V,
      kind: "docker",
      composeFile: "docker-compose.yml",
      service: "db",
    };
    expect(ProvisionDescriptorSchema.parse(minimal)).toEqual(minimal);
  });

  it("parses a full docker descriptor with nested migration and connection", () => {
    const full: DockerProvisionDescriptor = {
      schemaVersion: V,
      kind: "docker",
      composeFile: "docker-compose.yml",
      service: "db",
      initService: "db-init",
      portEnvVar: "DATABASE_PORT",
      migration: { command: "migrate", args: ["up", "--all"] },
      connection: { template: "postgres://localhost:${PORT}/app" },
      assignedContainerId: "abc123",
      healthcheck: true,
    };
    expect(ProvisionDescriptorSchema.parse(full)).toEqual(full);
  });

  it("allows migration without args", () => {
    const parsed = DockerProvisionDescriptorSchema.parse({
      schemaVersion: V,
      kind: "docker",
      composeFile: "c.yml",
      service: "db",
      migration: { command: "migrate" },
    });
    expect(parsed.migration).toEqual({ command: "migrate" });
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(() =>
      DockerProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "docker",
        composeFile: "c.yml",
        service: "db",
        bogus: true,
      }),
    ).toThrow();
  });

  it("rejects an unknown key in nested migration (.strict)", () => {
    expect(() =>
      DockerProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "docker",
        composeFile: "c.yml",
        service: "db",
        migration: { command: "migrate", extra: 1 },
      }),
    ).toThrow();
  });

  it("rejects an unknown key in nested connection (.strict)", () => {
    expect(() =>
      DockerProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "docker",
        composeFile: "c.yml",
        service: "db",
        connection: { template: "t", extra: 1 },
      }),
    ).toThrow();
  });

  it("rejects a missing required field", () => {
    expect(() =>
      DockerProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "docker",
        composeFile: "c.yml",
      }),
    ).toThrow();
  });
});

describe("process variant", () => {
  it("parses a minimal process descriptor", () => {
    const minimal: ProcessProvisionDescriptor = {
      schemaVersion: V,
      kind: "process",
      command: "npm run dev",
    };
    expect(ProvisionDescriptorSchema.parse(minimal)).toEqual(minimal);
  });

  it("parses a full process descriptor with env, envFile, cwd, setup, dependsOn", () => {
    const full: ProcessProvisionDescriptor = {
      schemaVersion: V,
      kind: "process",
      command: "npm run dev",
      env: { NODE_ENV: "development", PORT: "3000" },
      envFile: ".env.local",
      cwd: "client",
      setup: "npm ci",
      dependsOn: ["db"],
    };
    expect(ProvisionDescriptorSchema.parse(full)).toEqual(full);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(() =>
      ProcessProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "process",
        command: "x",
        bogus: 1,
      }),
    ).toThrow();
  });

  it("rejects a non-string env value", () => {
    expect(() =>
      ProcessProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "process",
        command: "x",
        env: { PORT: 3000 },
      }),
    ).toThrow();
  });
});

describe("oneshot variant", () => {
  it("parses a minimal oneshot descriptor", () => {
    const minimal: OneshotProvisionDescriptor = {
      schemaVersion: V,
      kind: "oneshot",
      command: "deploy.sh",
    };
    expect(ProvisionDescriptorSchema.parse(minimal)).toEqual(minimal);
  });

  it("parses a full oneshot descriptor with timeoutMs", () => {
    const full: OneshotProvisionDescriptor = {
      schemaVersion: V,
      kind: "oneshot",
      command: "deploy.sh",
      env: { STAGE: "ci" },
      envFile: ".env.ci",
      cwd: "ops",
      dependsOn: ["db", "api"],
      timeoutMs: 60000,
    };
    expect(ProvisionDescriptorSchema.parse(full)).toEqual(full);
  });

  it("rejects a non-positive timeoutMs", () => {
    expect(() =>
      OneshotProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "oneshot",
        command: "x",
        timeoutMs: 0,
      }),
    ).toThrow();
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(() =>
      OneshotProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "oneshot",
        command: "x",
        bogus: 1,
      }),
    ).toThrow();
  });
});

describe("discriminated union", () => {
  it("rejects an unknown kind", () => {
    expect(() =>
      ProvisionDescriptorSchema.parse({
        schemaVersion: V,
        kind: "lambda",
        command: "x",
      }),
    ).toThrow();
  });

  it("rejects an unsupported schemaVersion on every variant", () => {
    const bad = 2;
    expect(() =>
      ProvisionDescriptorSchema.parse({
        schemaVersion: bad,
        kind: "docker",
        composeFile: "c.yml",
        service: "db",
      }),
    ).toThrow();
    expect(() =>
      ProvisionDescriptorSchema.parse({
        schemaVersion: bad,
        kind: "process",
        command: "x",
      }),
    ).toThrow();
    expect(() =>
      ProvisionDescriptorSchema.parse({
        schemaVersion: bad,
        kind: "oneshot",
        command: "x",
      }),
    ).toThrow();
  });
});
