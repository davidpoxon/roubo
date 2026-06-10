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

// `permissions` is intentionally `.passthrough()` (not `.strict()`) so future
// permission categories (e.g. `ports`, `docker`) can be added in a 1.x minor
// without breaking older hosts. See decisions-log.md AF-002.
export const PluginPermissionsSchema = z
  .object({
    network: NetworkPermissionsSchema,
    credentials: CredentialsPermissionsSchema,
    filesystem: FilesystemPermissionsSchema,
    processes: ProcessesPermissionSchema,
  })
  .passthrough();
export type PluginPermissions = z.infer<typeof PluginPermissionsSchema>;

export const PluginCapabilitiesSchema = z.object({}).strict();
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

// ── Root manifest ──

export const PluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "Must be kebab-case (lowercase letters, digits, hyphens)"),
    name: z.string().min(1, "Required"),
    version: z.string().min(1, "Required"),
    description: z.string().min(1, "Required"),
    kind: z.literal("integration"),
    roubo: z.string().min(1, "Required"),
    entry: z.string().min(1, "Required"),
    icon: PluginIconSchema.optional(),
    configSchema: z.record(z.string(), z.unknown()).optional(),
    capabilities: PluginCapabilitiesSchema.optional(),
    defaultIntegrationConfig: PluginDefaultIntegrationConfigSchema.optional(),
    permissions: PluginPermissionsSchema,
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
