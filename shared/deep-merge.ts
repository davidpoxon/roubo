// Hand-rolled deep-merge for the per-user integration override (FR-023).
//
// Semantics:
//   - Plain object + plain object: recurse, merging keys per-field.
//   - Array on either side: REPLACE wholesale. An empty array in the override
//     is a valid replacement, not "unset" (TC-065).
//   - Primitive in override: REPLACE.
//   - `undefined` in override: treated as "not present", base wins.
//   - `null` in override: treated as present, override wins.
//
// Intentionally not a general-purpose library — the integration block has a
// tiny, known shape, so a 25-line walker beats pulling in `lodash.merge`
// (which concats arrays, the opposite of what we need).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export function deepMergeIntegration<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) continue;

    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMergeIntegration(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result as T;
}
