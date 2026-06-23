import { z } from "zod";

// ── Sub-schemas ──

export const CredentialSlotSchema = z
  .object({
    slot: z.string().min(1, "Required"),
    scope: z.enum(["read", "read-write"]),
    description: z.string().min(1, "Required"),
  })
  .strict();
export type CredentialSlot = z.infer<typeof CredentialSlotSchema>;

export const NetworkPermissionsSchema = z
  .object({
    hosts: z.array(z.string()),
  })
  .strict();
export type NetworkPermissions = z.infer<typeof NetworkPermissionsSchema>;

export const CredentialsPermissionsSchema = z
  .object({
    slots: z.array(CredentialSlotSchema),
  })
  .strict();
export type CredentialsPermissions = z.infer<typeof CredentialsPermissionsSchema>;

export const FilesystemPermissionsSchema = z
  .object({
    paths: z.array(z.string()),
  })
  .strict();
export type FilesystemPermissions = z.infer<typeof FilesystemPermissionsSchema>;

export const ProcessesPermissionSchema = z.union([
  z.literal(false),
  z.object({ executables: z.array(z.string()) }).strict(),
]);
export type ProcessesPermission = z.infer<typeof ProcessesPermissionSchema>;

// `ports` lets a component plugin declare the bench ports it needs allocated.
// Either false (no port allocation) or an object naming the port keys the host
// resolves into BenchContext.ports (architecture.md, FR-001/FR-011).
export const PortsPermissionSchema = z.union([
  z.literal(false),
  z.object({ names: z.array(z.string()) }).strict(),
]);
export type PortsPermission = z.infer<typeof PortsPermissionSchema>;

// `docker` gates a component plugin's access to the host docker broker
// (composeUp / waitForHealthy / assignContainer, etc.). Either false (no docker
// access) or an object (reserved for future scoping fields).
export const DockerPermissionSchema = z.union([z.literal(false), z.object({}).strict()]);
export type DockerPermission = z.infer<typeof DockerPermissionSchema>;

// `permissions` is intentionally `.passthrough()` (not `.strict()`) so future
// permission categories can be added in a 1.x minor without breaking older
// hosts. See decisions-log.md AF-002. `ports` and `docker` are the component
// categories (optional, so existing integration manifests validate unchanged).
export const PluginPermissionsSchema = z
  .object({
    network: NetworkPermissionsSchema,
    credentials: CredentialsPermissionsSchema,
    filesystem: FilesystemPermissionsSchema,
    processes: ProcessesPermissionSchema,
    ports: PortsPermissionSchema.optional(),
    docker: DockerPermissionSchema.optional(),
  })
  .passthrough();
export type PluginPermissions = z.infer<typeof PluginPermissionsSchema>;

// Per-capability flags a tracker plugin declares for the privileged tracker-action
// ops the TrackerActionGateway gates (verify-gate FR-011, NFR-005; spike #704).
// A flag is true only when the plugin implements the op for the connected
// instance. The gateway reads these up front and degrades with a legible error
// (never a silent no-op) when a flag is absent or false. close-gate is not a new
// flag: it reuses the existing applyTransition capability (architecture.md:133-134).
export const PluginCapabilitiesSchema = z
  .object({
    /** The plugin implements `createIssue` for the connected instance (FR-011). */
    supportsCreateIssue: z.boolean().optional(),
    /**
     * The plugin implements `addBlockedBy` AND the connected instance exposes the
     * blocking-link write (the GitHub GA / GHE version / Jira link-type condition
     * from spike #704). May be resolved at runtime, not just statically.
     */
    supportsBlockingLinks: z.boolean().optional(),
  })
  .strict();
export type PluginCapabilities = z.infer<typeof PluginCapabilitiesSchema>;

// Plugin-global defaults seeded into the three-layer effective-config merge
// (FR-064). Per-project and per-source layers override these. The host reads
// this section at manifest parse time; plugins do not see it via host-RPC.
export const PluginDefaultIntegrationConfigSchema = z
  .object({
    excludedStatuses: z.array(z.string().min(1)).optional(),
    // Plugin-global default for the category-first status exclusion (FR-010).
    // Seeded by the plugin manifest (e.g. jira-self-hosted ships ["Done"]).
    excludedStatusCategories: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PluginDefaultIntegrationConfig = z.infer<typeof PluginDefaultIntegrationConfigSchema>;

// Per FR-057 / mockups §22, plugins may ship an icon rendered in the
// Plugins-page tile header (32×32) and the Configure modal header (24×24).
// Accepted forms:
//   - `data:image/svg+xml;...` or `data:image/png;base64,...` data URI
//   - relative POSIX path inside the plugin directory (e.g. `assets/icon.svg`)
// Loose validation here: the client renders this as an <img src>; manifest
// authors are trusted to ship something sensible. 16 KB ceiling guards
// against accidentally shipping a megabyte of base64.
export const PluginIconSchema = z
  .string()
  .min(1, "Required")
  .max(16 * 1024, "Icon must be at most 16 KB");
export type PluginIcon = z.infer<typeof PluginIconSchema>;

// The set of plugin kinds the host understands. `component` lands with the
// component-plugin work (FR-001); `integration` is the original kind. The
// discriminator widens here without breaking existing integration manifests.
export const PluginKindSchema = z.enum(["integration", "component"]);
export type PluginKind = z.infer<typeof PluginKindSchema>;

// A node-semver-compatible range, used to validate the manifest `roubo` field
// at schema time so a malformed range is rejected with a clear error (FR-001),
// rather than only at host-compatibility time. Kept dependency-free (the
// `shared` workspace depends only on `yaml` + `zod`): this validates each
// space- or `||`-separated comparator against the comparator grammar
// node-semver accepts (operators, hyphen ranges, x-ranges, caret/tilde,
// wildcards). It is intentionally permissive on the comparator side and strict
// only about rejecting obvious garbage (the host re-checks with node-semver).
const SEMVER_COMPARATOR =
  /^(?:[<>]=?|=|\^|~)?\s*v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidRouboRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed.length === 0) return false;
  // `*` / `x` on their own is the match-anything range.
  if (/^[*xX]$/.test(trimmed)) return true;
  const orClauses = trimmed.split("||");
  return orClauses.every((clause) => {
    const comparators = clause.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    // A hyphen range ("1.2.3 - 2.3.4") parses as [lo, "-", hi].
    if (comparators.length === 3 && comparators[1] === "-") {
      return SEMVER_COMPARATOR.test(comparators[0]) && SEMVER_COMPARATOR.test(comparators[2]);
    }
    return comparators.every((c) => SEMVER_COMPARATOR.test(c));
  });
}

// ── Root manifest ──

export const PluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "Must be kebab-case (lowercase letters, digits, hyphens)"),
    name: z.string().min(1, "Required"),
    version: z.string().min(1, "Required"),
    description: z.string().min(1, "Required"),
    kind: PluginKindSchema,
    roubo: z.string().min(1, "Required").refine(isValidRouboRange, "Must be a valid semver range"),
    entry: z.string().min(1, "Required"),
    icon: PluginIconSchema.optional(),
    configSchema: z.record(z.string(), z.unknown()).optional(),
    capabilities: PluginCapabilitiesSchema.optional(),
    defaultIntegrationConfig: PluginDefaultIntegrationConfigSchema.optional(),
    permissions: PluginPermissionsSchema,
    // Component plugins declare the SDK component-contract version they target
    // (FR-001/FR-002); the host validates the registered-method set against it.
    contractVersion: z.number().int().positive().optional(),
    // Optional ProvisionDescriptor schema version a declarative component plugin
    // emits, so the host can reject a descriptor-schema mismatch (FR-017).
    descriptorSchemaVersion: z.number().int().positive().optional(),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
