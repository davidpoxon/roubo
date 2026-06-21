import { z } from "zod";

// Issue #603 / T1.2: the typed ProvisionDescriptor discriminated union that a
// component plugin emits and the host LifecycleEngine executes. See:
//   .specifications/component-plugins/prd.md (FR-002, FR-022, US-005, US-012)
//   .specifications/component-plugins/architecture.md ('Data model', line 54)
//
// The shape is frozen in architecture.md. It lives in shared/ so both the host
// LifecycleEngine and the plugin SDK import one contract without a circular
// dependency. Every variant carries a top-level schemaVersion so the host can
// validate a descriptor and reject a mismatched version (the z.literal gate
// below fails validation when the version does not match).

export const SUPPORTED_PROVISION_SCHEMA_VERSION = 1 as const;

// ── docker ──
// A compose-backed component: the host brings up `service` in `composeFile`,
// optionally running `initService` first, optionally running a `migration`
// command once the service is healthy, and optionally exposing a connection
// string via `connection.template`.

const DockerMigrationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  })
  .strict();

const DockerConnectionSchema = z
  .object({
    template: z.string().min(1),
  })
  .strict();

export const DockerProvisionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(SUPPORTED_PROVISION_SCHEMA_VERSION),
    kind: z.literal("docker"),
    composeFile: z.string().min(1),
    service: z.string().min(1),
    initService: z.string().min(1).optional(),
    portEnvVar: z.string().min(1).optional(),
    migration: DockerMigrationSchema.optional(),
    connection: DockerConnectionSchema.optional(),
    assignedContainerId: z.string().min(1).optional(),
    // Component-level env injected into the compose interpolation environment
    // (and the migration process env), merged alongside the allocated port. This
    // mirrors the built-in database path, which folds `componentConfig.env` into
    // the compose `portOverrides` (see bench-manager `startDockerComponent`), so a
    // plugin-backed database reaches env parity (CP-FR-004, CP-FR-007).
    env: z.record(z.string(), z.string()).optional(),
    healthcheck: z.boolean().optional(),
  })
  .strict();
export type DockerProvisionDescriptor = z.infer<typeof DockerProvisionDescriptorSchema>;

// ── process ──
// A long-running process the host owns: `command` is started in `cwd` with the
// merged `env` / `envFile`, optionally after running a one-time `setup`, once
// the named `dependsOn` components are up.

export const ProcessProvisionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(SUPPORTED_PROVISION_SCHEMA_VERSION),
    kind: z.literal("process"),
    command: z.string().min(1),
    env: z.record(z.string(), z.string()).optional(),
    envFile: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    setup: z.string().min(1).optional(),
    dependsOn: z.array(z.string()).optional(),
  })
  .strict();
export type ProcessProvisionDescriptor = z.infer<typeof ProcessProvisionDescriptorSchema>;

// ── oneshot ──
// A run-to-completion command (the FR-022 deploy stress-test shape): like a
// process but expected to exit, with an optional `timeoutMs` ceiling.

export const OneshotProvisionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(SUPPORTED_PROVISION_SCHEMA_VERSION),
    kind: z.literal("oneshot"),
    command: z.string().min(1),
    env: z.record(z.string(), z.string()).optional(),
    envFile: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    dependsOn: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type OneshotProvisionDescriptor = z.infer<typeof OneshotProvisionDescriptorSchema>;

// ── union ──
// Discriminated on `kind`; schemaVersion is a literal field on each member, so
// a mismatched version fails validation without any z.intersection wrapping.

export const ProvisionDescriptorSchema = z.discriminatedUnion("kind", [
  DockerProvisionDescriptorSchema,
  ProcessProvisionDescriptorSchema,
  OneshotProvisionDescriptorSchema,
]);
export type ProvisionDescriptor = z.infer<typeof ProvisionDescriptorSchema>;
