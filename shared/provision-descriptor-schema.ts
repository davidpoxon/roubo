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

// ── url (#834) ──
// The declarative route to ComponentStatus.url, so a `translate`-only plugin
// can resolve `{{urls.<componentName>}}` the way an imperative plugin already
// does by pushing through host.component.reportStatus (#833). A declarative
// plugin never holds that sink (translate runs once, BEFORE the descriptor
// executes), so the descriptor declares the URL and the LifecycleEngine carries
// it into its own terminal reportStatus call.
//
// Exactly one form, mirroring the `connection.template` precedent:
//   - `template`: a static or `{{port}}` / `{{ports.<componentName>}}` templated
//     URL, resolved against the host-allocated port.
//   - `fromOutput`: a regular expression the engine runs over the output the
//     executed command already captured, taking capture group 1 when the
//     pattern defines one and the whole match otherwise. This is the case a
//     static template cannot cover: a URL minted only while the descriptor runs
//     (a `gcloud`-style deploy printing its endpoint on stdout).
//
// The host still vets whatever the engine reports at the reportStatus sink
// (http/https only, no shell-significant characters), so this adds no new
// trust surface.
const DescriptorUrlSchema = z
  .object({
    template: z.string().min(1).optional(),
    fromOutput: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => (value.template === undefined) !== (value.fromOutput === undefined), {
    message: "url must set exactly one of 'template' or 'fromOutput'",
  });

// `process` gets `template` only. A long-running process is started via
// startProcess, which returns as soon as the child is spawned, so there is no
// completed output to match a regex against at the point the engine pushes
// `running`. The strict object rejects a `fromOutput` on a process descriptor
// at the validation gate rather than silently ignoring it.
const ProcessDescriptorUrlSchema = z
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
    url: DescriptorUrlSchema.optional(),
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
    url: ProcessDescriptorUrlSchema.optional(),
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
    url: DescriptorUrlSchema.optional(),
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
