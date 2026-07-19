import { z } from "zod";

// ── Sub-schemas ──

export const JigSettingsSchema = z.object({
  autoInject: z.boolean(),
  autoExecute: z.boolean(),
  defaultJigId: z.string().optional(),
  issueTypeMappings: z.record(z.string(), z.string()).optional(),
});
export type JigSettings = z.infer<typeof JigSettingsSchema>;

export const ProjectConfigSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/, "Must contain only lowercase letters, numbers, and hyphens"),
    displayName: z.string().min(1, "Required"),
    // FR-070 (WU-057): repo and github.project moved to the plugin Configure
    // modal. Optional here so a fresh project saves cleanly with name +
    // displayName only; the user fills these in from the active plugin's tab
    // afterwards.
    repo: z.string().min(1, "Required").optional(),
    github: z.object({ project: z.int() }).strict().optional(),
    jigSettings: JigSettingsSchema.optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const LayoutConfigSchema = z
  .object({
    type: z.enum(["meta-repo", "monorepo", "single-repo"]),
    submodules: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>;

export const DockerComponentConfigSchema = z
  .object({
    composeFile: z.string(),
    service: z.string(),
    initService: z.string().optional(),
    portEnvVar: z.string().optional(),
  })
  .strict();
export type DockerComponentConfig = z.infer<typeof DockerComponentConfigSchema>;

export const MigrationConfigSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
  })
  .strict();
export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;

export const ConnectionConfigSchema = z
  .object({
    template: z.string(),
  })
  .strict();
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

// Component-to-plugin binding reference (issue #608, FR-010). This is the
// plugin REFERENCE: a component points at a `component`-kind plugin by `id`
// (with an optional `source`). The host's ComponentPluginRegistry reads
// `plugin.id` off the parsed component to resolve the live JSON-RPC connection.
// This is the reference shape; the full components-map ENTRY (the opaque
// per-plugin `config` block + `dependsOn`) is `ComponentConfigSchema` below.
export const ComponentBindingSchema = z
  .object({
    id: z.string().min(1, "Required"),
    source: z.string().min(1).optional(),
  })
  .strict();
export type ComponentBinding = z.infer<typeof ComponentBindingSchema>;

// ── Components-map entry (FR-003 / #609): the canonical component binding ──
//
// A component binds to a component plugin (`plugin: { id, source? }`) plus an
// opaque `config` block the plugin's own manifest `configSchema` validates
// (host-side, see `validateComponentBindings`). `config` is opaque to core,
// exactly like the integration `advanced` block above. `dependsOn` stays at the
// entry level so start/stop ordering (FR-003) is preserved without reaching
// into the plugin-owned config. The two-value `type: database|process` enum and
// the inline docker/process fields are intentionally gone from this schema
// (NFR-005: no config back-compat). The legacy inline fields survive only on
// the TS `ComponentConfig` type as a transition shim (see below): core
// consumers (bench-manager, config-parser) and the setup wizard still read
// `.type` / `.docker` / `.command` etc. off a parsed component until that
// behavioural dispatch moves onto the plugin contract in #612 (F1.11) and the
// live-config migration of #614 (F1.13); both are out of scope for #609. Do NOT
// grow new behaviour onto this shim: new component behaviour rides the plugin
// contract.
export const ComponentConfigSchema = z
  .object({
    plugin: ComponentBindingSchema,
    // Opaque to roubo-core; validated against the bound plugin's configSchema
    // by `validateComponentBindings` once the component plugin manifests load.
    config: z.record(z.string(), z.unknown()).default({}),
    dependsOn: z.array(z.string()).optional(),
  })
  .strict();

// The legacy two-value component discriminator. The `type` enum is GONE from
// the zod schema (#609); this type is retained ONLY for the transition shim so
// the setup wizard and repo-scanner keep type-checking while their legacy
// inline-component editing/scanning is ported to the plugin contract (#612 /
// #614, out of scope here).
export type ComponentType = "database" | "process";

// The optional legacy inline component descriptor. These fields are NOT in the
// zod schema (it is `.strict()` to the new binding shape) and are never
// populated at parse time once configs migrate; they exist purely as a TS
// transition shim for core consumers (bench-manager, config-parser) and the
// setup wizard, which still read `.type` / `.docker` / `.command` etc. off a
// parsed component until #612 (F1.11) moves that dispatch onto the plugin
// contract and #614 (F1.13) migrates the live configs.
export interface LegacyComponentInline {
  type?: ComponentType;
  command?: string;
  setup?: string;
  docker?: DockerComponentConfig;
  migration?: MigrationConfig;
  connection?: ConnectionConfig;
  env?: Record<string, string>;
  directory?: string;
  envFile?: string;
  envVars?: Record<string, string>;
  image?: string;
}

// The components-map entry TS type. `plugin` + `config` + `dependsOn` are the
// canonical binding fields the zod `ComponentConfigSchema` validates; they are
// typed loosely here (plugin/config optional) so the #609-deferred consumers
// and the live-config migration (#614, F1.13) keep type-checking against
// pre-migration fixtures and in-progress wizard drafts during the transition.
// The legacy inline fields ride alongside as the transition shim described
// above. The zod schema never populates the legacy keys, so they are
// `undefined` at runtime once configs migrate.
export type ComponentConfig = {
  plugin?: ComponentBinding;
  config?: Record<string, unknown>;
  dependsOn?: string[];
} & LegacyComponentInline;

export const PortConfigSchema = z
  .object({
    base: z.int().min(1).max(65535),
    https: z.boolean().optional(),
  })
  .strict();
export type PortConfig = z.infer<typeof PortConfigSchema>;

const LoginStepFillSchema = z
  .object({
    selector: z.string(),
    action: z.literal("fill"),
    value: z.string().min(1),
  })
  .strict();

const LoginStepClickSchema = z
  .object({
    selector: z.string(),
    action: z.literal("click"),
    value: z.string().min(1).optional(),
  })
  .strict();

export const LoginStepSchema = z.discriminatedUnion("action", [
  LoginStepFillSchema,
  LoginStepClickSchema,
]);
export type LoginStep = z.infer<typeof LoginStepSchema>;

export const LoginConfigSchema = z
  .object({
    steps: z.array(LoginStepSchema).min(1),
  })
  .strict();
export type LoginConfig = z.infer<typeof LoginConfigSchema>;

const BrowserToolConfigSchema = z
  .object({
    type: z.literal("browser"),
    name: z.string(),
    icon: z.string(),
    url: z.string().optional(),
    requires: z.string().optional(),
    login: LoginConfigSchema.optional(),
  })
  .strict();

const ShellToolConfigSchema = z
  .object({
    type: z.literal("shell"),
    name: z.string(),
    icon: z.string(),
    command: z.string().optional(),
    requires: z.string().optional(),
  })
  .strict();

export const ToolConfigSchema = z.discriminatedUnion("type", [
  BrowserToolConfigSchema,
  ShellToolConfigSchema,
]);
// Flat type for backward compat: Zod validates using the strict discriminated union above.
export type ToolConfig = {
  type: "browser" | "shell";
  name: string;
  icon: string;
  url?: string;
  command?: string;
  requires?: string;
  login?: LoginConfig;
};

export const InspectionConfigSchema = z
  .object({
    framework: z.string(),
    directory: z.string(),
    command: z.string(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type InspectionConfig = z.infer<typeof InspectionConfigSchema>;

export const BenchesConfigSchema = z
  .object({
    max: z.int().min(1).max(99),
    /**
     * Command run once at the workspace root before components start.
     * Executed through the user's login shell, so shell syntax is supported:
     * `&&` chaining, redirection, and pipes. On zsh the shell is also started
     * interactively so that `~/.zshrc` loads, which is what makes version
     * managers such as `nvm`, `fnm`, and `asdf` resolve. On bash and other
     * shells only the login profile files load (`~/.bash_profile`,
     * `~/.profile`, not `~/.bashrc`), so a version-manager snippet installed
     * into `~/.bashrc` must be moved into the profile file to resolve here.
     */
    setup: z.string().optional(),
    enforceIssueDependencies: z.boolean().optional(),
  })
  .strict();
export type BenchesConfig = z.infer<typeof BenchesConfigSchema>;

export const JigsConfigSchema = z
  .object({
    defaultJig: z.string().optional(),
    issueTypeMappings: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type JigsConfig = z.infer<typeof JigsConfigSchema>;

export const UserConfigSchema = z
  .object({
    name: z.string().min(1),
    properties: z.record(z.string(), z.string()),
  })
  .strict();
export type UserConfig = z.infer<typeof UserConfigSchema>;

// Plugin-defined, opaque-to-roubo sub-block (e.g. `allowSelfSignedTls`, Jira
// link-type names). Validated against the plugin's manifest configSchema once
// the active plugin is loaded, mirroring how Roubo treats jig
// frontmatter.
export const IntegrationAdvancedSchema = z.record(z.string(), z.unknown());
export type IntegrationAdvanced = z.infer<typeof IntegrationAdvancedSchema>;

// Identity captured from `plugin.getCurrentUser` at the last successful
// `validateConfig` round-trip (FR-035). Persisted per-project so subsequent
// `assignIssue` calls targeting "me" use the resolved external id.
export const CapturedUserIdSchema = z
  .object({
    externalId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();
export type CapturedUserId = z.infer<typeof CapturedUserIdSchema>;

// Per-source entries accept either the legacy primitive form (`"owner/repo"`
// or `42`) or an object form that carries Roubo-core-reserved per-source
// fields like `excludedStatuses` (FR-062, FR-063) and the bundled
// github.com / GHE alert-category booleans (FR-074). Plugins MUST NOT use
// any of these reserved keys in their own configSchema.
export const SourceEntrySchema = z.union([
  z.string(),
  z.number(),
  z
    .object({
      externalId: z.union([z.string(), z.number()]),
      // Human-readable display name + secondary line, captured at pick time so
      // the UI can show the source's name on reload without re-fetching. Display
      // only; the plugin ignores them.
      label: z.string().optional(),
      sublabel: z.string().optional(),
      // Jira project key the source is scoped to (project-first model). Also
      // present on the synthetic `mine` source when its scope is in-project.
      project: z.string().optional(),
      // Board sources: active sprint only vs the whole board's backing filter.
      boardMode: z.enum(["active-sprint", "whole-board"]).optional(),
      // "Assigned to me" synthetic source: scoped to the project or instance-wide.
      mineScope: z.enum(["in-project", "anywhere"]).optional(),
      excludedStatuses: z.array(z.string().min(1)).optional(),
      includeCodeQLAlerts: z.boolean().optional(),
      includeSecretScanningAlerts: z.boolean().optional(),
      includeDependabotAlerts: z.boolean().optional(),
    })
    .strict(),
]);
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export const IntegrationConfigSchema = z
  .object({
    plugin: z.string().optional(),
    instance: z.string().optional(),
    sources: z.record(z.string(), z.array(SourceEntrySchema)).optional(),
    advanced: IntegrationAdvancedSchema.optional(),
    pluginSource: z.string().optional(),
    // Page size forwarded to the plugin's listIssues call. Default 50 (FR-022, NFR-005).
    pageSize: z.number().int().positive().optional(),
    capturedUserId: CapturedUserIdSchema.optional(),
    // Per-project layer of the three-layer excludedStatuses merge (FR-062).
    // Plugin-global defaults live in plugin manifests; per-source overrides
    // ride alongside `sources[<cat>][<i>]` object entries and are resolved
    // by `applyPerSourceExcludedStatuses`.
    excludedStatuses: z.array(z.string().min(1)).optional(),
    // Category-first default exclusion (FR-010): a user-editable list of Jira
    // status *categories* (e.g. "Done") applied in the query so excluded issues
    // never reach a result page. Plugin-global default is seeded in the manifest
    // and resolved at the root level by `resolveRootExclusion`; the jira plugin
    // emits `statusCategory not in (...)` and falls back to `excludedStatuses`
    // names when the instance does not support `statusCategory` in JQL.
    excludedStatusCategories: z.array(z.string().min(1)).optional(),
    // Cut-list sort selection (CLI-FR-009/CLI-FR-013/CLI-FR-017). `sortBy` is a
    // field id the active plugin declared via `getSortFields`; `sortDir` is the
    // direction. Persisted at the project level and overridable per user (the
    // override file rides the same IntegrationConfigSchema), resolved at query
    // time and forwarded into `listIssues` so the plugin orders source-side.
    // Absent means the plugin's natural order (key-ascending fallback).
    sortBy: z.string().min(1).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
  })
  .strict();
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

// Per-user override file at `~/.roubo/integrations/<projectId>.yaml`. The
// envelope versions the file so a future shape change fails loudly on the
// `schemaVersion` literal rather than silently mis-merging.
export const IntegrationOverrideSchema = z
  .object({
    schemaVersion: z.literal(1),
    integration: IntegrationConfigSchema,
  })
  .strict();
export type IntegrationOverride = z.infer<typeof IntegrationOverrideSchema>;

// Third-party marketplace declaration (CPHMTP-FR-007, issue #556). A project may
// declare one or more plugin marketplaces in roubo.yaml so the project-open flow
// can offer to register them. Each entry carries a URL ONLY: it is a source
// pointer the host later fetches a signed catalog from, never a credential.
// Credentials are never stored in roubo.yaml. The object is `.strict()`, so an
// unknown extra key (in particular any attempt to smuggle a secret alongside the
// url) is rejected. The url must be a well-formed http(s) URL; any other scheme
// (or a non-URL value) is rejected. An older app that predates this field
// rejects the whole declaring config on the top-level `.strict()`, an accepted
// parse break (PRD out-of-scope).
export const MarketplaceDeclarationSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
  })
  .strict();
export type MarketplaceDeclaration = z.infer<typeof MarketplaceDeclarationSchema>;

// components and ports are optional: a project may be just a worktree with jigs
// and tools and no long-running services. Both default to {} so downstream
// consumers always see a real (possibly empty) object.
const ComponentsMapSchema = z.record(z.string(), ComponentConfigSchema);

const PortsMapSchema = z.record(z.string(), PortConfigSchema);

const UsersArraySchema = z.array(UserConfigSchema).superRefine((users, ctx) => {
  const seen = new Set<string>();
  for (let i = 0; i < users.length; i++) {
    const key =
      users[i].name +
      "\0" +
      JSON.stringify(Object.fromEntries(Object.entries(users[i].properties).sort()));
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i],
        message: "Duplicate user entries are not allowed",
      });
      return;
    }
    seen.add(key);
  }
});

export const RouboConfigSchema = z
  .object({
    project: ProjectConfigSchema,
    layout: LayoutConfigSchema,
    components: ComponentsMapSchema.default({}),
    ports: PortsMapSchema.default({}),
    tools: z.array(ToolConfigSchema).optional(),
    inspection: InspectionConfigSchema.optional(),
    benches: BenchesConfigSchema,
    jigs: JigsConfigSchema.optional(),
    integration: IntegrationConfigSchema.optional(),
    users: UsersArraySchema.optional(),
    marketplaces: z.array(MarketplaceDeclarationSchema).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const submodules = val.layout?.submodules;
    if (submodules && "." in submodules) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layout", "submodules"],
        message:
          'submodule key "." is reserved for the meta-repo root work unit and cannot be declared in roubo.yaml',
      });
    }
  });
// Use the flat ToolConfig type for the tools field so callers don't need to
// narrow the discriminated union. `components` is widened to `ComponentConfig`
// (the binding fields + the legacy inline-descriptor shim) so #609-deferred
// consumers (#612 / #614) keep type-checking against `.docker` / `.type` etc.
export type RouboConfig = Omit<z.infer<typeof RouboConfigSchema>, "tools" | "components"> & {
  tools?: ToolConfig[];
  components: Record<string, ComponentConfig>;
};

// ── Helpers ──

export interface ConfigFieldError {
  path: string;
  message: string;
}

export function zodIssuesToValidationErrors(issues: z.ZodIssue[]): ConfigFieldError[] {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function zodIssuesToFieldMap(issues: z.ZodIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.join(".");
    if (key && !(key in map)) {
      map[key] = issue.message;
    }
  }
  return map;
}
