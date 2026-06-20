import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { ConfigFieldError, PluginManifest, RouboConfig } from "@roubo/shared";

/**
 * Plugin-aware validation of the roubo.yaml components map (FR-003, #609).
 *
 * The structural shape of each binding (`plugin` reference + opaque `config`
 * block + optional `dependsOn`) is already enforced by the zod
 * `ComponentBindingSchema` at parse time. This second pass is the part zod
 * cannot do on its own because it needs plugin context: for every component
 * binding it
 *
 *   1. rejects a binding whose `plugin.id` does not match any loaded
 *      component-kind plugin manifest, and
 *   2. validates the binding's opaque `config` block against that plugin's
 *      manifest `configSchema` (a JSON Schema), rejecting any config the plugin
 *      would not accept.
 *
 * Errors are returned as path-keyed `ConfigFieldError`s (the same shape the zod
 * pass produces) so callers can surface them uniformly. An empty array means
 * every binding is valid.
 *
 * This is a standalone, side-effect-free function. Wiring it into bench-start /
 * a component-plugin registry is the consuming surface's responsibility (that
 * registry does not exist yet); see #612 (F1.11).
 */
export function validateComponentBindings(
  config: Pick<RouboConfig, "components">,
  componentManifests: PluginManifest[],
): ConfigFieldError[] {
  const errors: ConfigFieldError[] = [];

  const manifestsById = new Map<string, PluginManifest>();
  for (const manifest of componentManifests) {
    manifestsById.set(manifest.id, manifest);
  }

  // One Ajv instance for the whole pass; configSchemas are compiled lazily and
  // memoised per plugin id so a config map with many bindings to the same
  // plugin compiles each schema once.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validatorCache = new Map<string, ValidateFunction | null>();

  for (const [name, binding] of Object.entries(config.components)) {
    const pluginId = binding.plugin?.id;
    if (!pluginId) {
      // Structurally impossible after the zod pass, but guard defensively so a
      // raw (unparsed) config object cannot crash the validator.
      errors.push({
        path: `components.${name}.plugin.id`,
        message: "A component binding must reference a plugin by id",
      });
      continue;
    }

    const manifest = manifestsById.get(pluginId);
    if (!manifest) {
      errors.push({
        path: `components.${name}.plugin.id`,
        message: `Unknown component plugin '${pluginId}'. No loaded component plugin declares this id.`,
      });
      continue;
    }

    const validate = compileConfigSchema(ajv, validatorCache, manifest);
    if (!validate) continue; // plugin declares no configSchema: any config is accepted

    const configBlock = binding.config ?? {};
    if (!validate(configBlock)) {
      for (const issue of validate.errors ?? []) {
        errors.push({
          path: configErrorPath(name, issue),
          message: ajvMessage(issue),
        });
      }
    }
  }

  return errors;
}

/**
 * Compiles (and memoises) a plugin manifest's `configSchema` into an Ajv
 * validator. Returns `null` when the plugin declares no configSchema (so any
 * config block is accepted). A configSchema that fails to compile (malformed
 * JSON Schema) is treated as "no validator"; manifest schema validity is the
 * plugin-manager's responsibility, not this binding validator's.
 */
function compileConfigSchema(
  ajv: Ajv2020,
  cache: Map<string, ValidateFunction | null>,
  manifest: PluginManifest,
): ValidateFunction | null {
  const cached = cache.get(manifest.id);
  if (cached !== undefined) return cached;

  const schema = manifest.configSchema;
  if (!schema) {
    cache.set(manifest.id, null);
    return null;
  }

  let validate: ValidateFunction | null;
  try {
    validate = ajv.compile(schema);
  } catch {
    validate = null;
  }
  cache.set(manifest.id, validate);
  return validate;
}

/**
 * Maps an Ajv error to a dotted `components.<name>.config...` path. Ajv's
 * `instancePath` is a JSON Pointer relative to the validated `config` block
 * (e.g. `/port`), which we splice onto the binding's config path. A missing
 * required property reports at the parent object, so we append the property
 * name from `params` for a precise path.
 */
function configErrorPath(name: string, issue: ErrorObject): string {
  const pointerSegments = issue.instancePath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  if (issue.keyword === "required" && typeof issue.params?.missingProperty === "string") {
    pointerSegments.push(issue.params.missingProperty);
  }

  return ["components", name, "config", ...pointerSegments].join(".");
}

function ajvMessage(issue: ErrorObject): string {
  if (
    issue.keyword === "additionalProperties" &&
    typeof issue.params?.additionalProperty === "string"
  ) {
    return `Unexpected property '${issue.params.additionalProperty}'`;
  }
  return issue.message ?? "Invalid value";
}
