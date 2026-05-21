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

export const PluginCapabilitiesSchema = z
  .object({
    prSync: z.boolean().optional(),
  })
  .strict();
export type PluginCapabilities = z.infer<typeof PluginCapabilitiesSchema>;

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
    configSchema: z.record(z.string(), z.unknown()).optional(),
    capabilities: PluginCapabilitiesSchema.optional(),
    permissions: PluginPermissionsSchema,
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
