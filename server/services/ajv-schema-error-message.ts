import type { ErrorObject } from "ajv/dist/2020.js";

/**
 * Reads a `configSchema` property's own `errorMessage` string back off the
 * root schema for one Ajv `ErrorObject`, so a plugin author can say what a
 * field actually wants (e.g. next to a `pattern`) instead of a reviewer
 * seeing Ajv's default message for the keyword that failed.
 *
 * Deliberately walks the plain `rootSchema` by the error's own
 * `instancePath` rather than compiling Ajv with `verbose: true` and reading
 * `parentSchema` off the error object. Ajv's `verbose` mode attaches the
 * failing *value* to every error too (`data`), which for a credential-shaped
 * config value is exactly the sort of thing this validator exists to keep out
 * of view; nothing here needs that field, so nothing turns it on.
 *
 * Returns `undefined` (never overriding the keyword's own message) for
 * `required` and `additionalProperties`: both report at the *container*
 * schema's instancePath, not the specific property's, so reading an
 * `errorMessage` there would surface the container's unrelated message
 * instead of (or worse, silently swallowing) the specific missing- or
 * unexpected-property detail `errorPath`/the caller already derives.
 */
export function ownSchemaErrorMessage(
  issue: Pick<ErrorObject, "keyword" | "instancePath">,
  rootSchema: unknown,
): string | undefined {
  if (issue.keyword === "required" || issue.keyword === "additionalProperties") return undefined;

  const ownSchema = schemaAtPointer(rootSchema, issue.instancePath);
  if (!isRecord(ownSchema)) return undefined;

  const message = ownSchema.errorMessage;
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}

/** Walks a JSON Schema's `properties`/`items` by a JSON Pointer instancePath. */
function schemaAtPointer(rootSchema: unknown, instancePath: string): unknown {
  const segments = instancePath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current = rootSchema;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    if (isRecord(current.properties) && segment in current.properties) {
      current = current.properties[segment];
    } else if ("items" in current) {
      // Approximates tuple-form `items` as "every index shares one schema",
      // which is all either validator's manifests declare today.
      current = current.items;
    } else {
      return undefined;
    }
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
