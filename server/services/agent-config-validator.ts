import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { ConfigFieldError, PluginManifest } from "@roubo/shared";

/**
 * Validates one agent plugin's app-level config record against that plugin's
 * manifest `configSchema` (AP-FR-003, AP-TC-011, issue #508).
 *
 * The server is the primary rejection path: the AI Agents form renders enum
 * fields as selects, but a client that posts an out-of-enum value directly must
 * still be refused. Errors name the field and, for an enum violation, the
 * allowed values, so the form can point at the offending control rather than
 * showing "invalid config".
 *
 * Modelled on `component-binding-validator.ts`: one lazily-compiled, memoised
 * Ajv validator per manifest. A plugin that declares no `configSchema` accepts
 * any config (there is nothing to check it against), and a `configSchema` that
 * fails to compile is treated the same way. Manifest schema validity is the
 * plugin manager's concern, not this validator's.
 */

// One validator cache for the whole process, keyed by manifest id AND version
// so a plugin update recompiles rather than validating new config against the
// previous release's schema.
//
// Each compile gets its OWN Ajv instance rather than sharing a process-wide one.
// Ajv registers a schema's `$id` on the instance and throws `schema with key or
// id "..." already exists` on a second compile of that `$id`, which the catch
// below would swallow into "accept anything", silently disabling the AP-TC-011
// rejection gate for that plugin. Recompiling the same `$id` is reachable in
// production: the marketplace update path rebuilds the manifest with a bumped
// version, changing the cache key. `component-binding-validator.ts` avoids the
// same trap by constructing a fresh instance per validation pass.
const validatorCache = new Map<string, ValidateFunction | null>();

function cacheKey(manifest: PluginManifest): string {
  return `${manifest.id}@${manifest.version ?? "0.0.0"}`;
}

function compileConfigSchema(manifest: PluginManifest): ValidateFunction | null {
  const key = cacheKey(manifest);
  const cached = validatorCache.get(key);
  if (cached !== undefined) return cached;

  const schema = manifest.configSchema;
  if (!schema) {
    validatorCache.set(key, null);
    return null;
  }

  let validate: ValidateFunction | null;
  try {
    validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  } catch {
    validate = null;
  }
  validatorCache.set(key, validate);
  return validate;
}

/** Test seam: drop every memoised validator. */
export function resetAgentConfigValidatorCache(): void {
  validatorCache.clear();
}

/**
 * Returns the field errors for `config` against `manifest.configSchema`. An
 * empty array means the config is acceptable.
 */
export function validateAgentConfig(
  manifest: PluginManifest,
  config: Record<string, unknown>,
): ConfigFieldError[] {
  const validate = compileConfigSchema(manifest);
  if (!validate) return [];
  if (validate(config)) return [];
  return (validate.errors ?? []).map((issue) => ({
    path: errorPath(issue),
    message: ajvMessage(issue),
  }));
}

/**
 * Maps an Ajv error to a dotted field path. Ajv's `instancePath` is a JSON
 * Pointer relative to the validated config record (e.g. `/model`). A missing
 * required property reports at the parent object, so the property name from
 * `params` is appended for a precise path.
 *
 * An `additionalProperties` violation also reports at the parent, so its offending
 * key comes from `params` the same way. That key is never in `schema.properties`,
 * so the form renders no control to attach the error to; `AgentConfigForm` routes
 * such an error to its form-level banner instead of dropping it.
 */
function errorPath(issue: ErrorObject): string {
  const segments = issue.instancePath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  if (issue.keyword === "required" && typeof issue.params?.missingProperty === "string") {
    segments.push(issue.params.missingProperty);
  }

  if (
    issue.keyword === "additionalProperties" &&
    typeof issue.params?.additionalProperty === "string"
  ) {
    segments.push(issue.params.additionalProperty);
  }

  return segments.join(".");
}

/** The message an unexpected top-level config key reports, from either path. */
export function unexpectedPropertyMessage(key: string): string {
  return `Unexpected property '${key}'`;
}

// Root keywords that can widen a schema's accepted key set beyond its own
// `properties`, so a key missing from `properties` may still be legitimate.
// Any one of them present makes the "closed by omission" reading unsafe.
const KEY_SET_WIDENING_KEYWORDS = [
  "patternProperties",
  "$ref",
  "$dynamicRef",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
];

/**
 * The subset of `keys` that `manifest.configSchema` gives no way to accept
 * (issue #743).
 *
 * Ajv only errors on an unknown key when the schema sets
 * `additionalProperties: false`, but a manifest that simply lists its
 * `properties` and stops (which is what the bundled agent plugins do) is
 * equally definite about the keys it understands: anything else is dropped on
 * the floor by the plugin's own `translateLaunch`. Callers that must report a
 * key the agent will ignore need that second, weaker signal.
 *
 * Deliberately conservative, because a false positive here rejects config a
 * plugin would have honoured. It reports nothing unless the root schema lists
 * `properties`, says nothing about `additionalProperties`, and uses none of the
 * composition keywords that could declare the key elsewhere. When the schema
 * does set `additionalProperties`, this returns nothing either way: `false`
 * belongs to Ajv (`validateAgentConfig` already reports it, and reporting it
 * twice would double-count), and `true` or a subschema means the key is
 * accepted.
 */
export function unknownConfigKeys(manifest: PluginManifest, keys: string[]): string[] {
  const schema = manifest.configSchema;
  if (!schema) return [];
  if (schema.additionalProperties !== undefined) return [];

  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  if (KEY_SET_WIDENING_KEYWORDS.some((keyword) => keyword in schema)) return [];

  const declared = properties as Record<string, unknown>;
  return keys.filter((key) => !(key in declared));
}

function ajvMessage(issue: ErrorObject): string {
  // AP-TC-011: an out-of-enum value must name the field's allowed values, not
  // just say "must be equal to one of the allowed values".
  if (issue.keyword === "enum" && Array.isArray(issue.params?.allowedValues)) {
    const allowed = (issue.params.allowedValues as unknown[]).map((v) => String(v)).join(", ");
    return `Must be one of: ${allowed}`;
  }
  if (
    issue.keyword === "additionalProperties" &&
    typeof issue.params?.additionalProperty === "string"
  ) {
    return unexpectedPropertyMessage(issue.params.additionalProperty);
  }
  return issue.message ?? "Invalid value";
}
