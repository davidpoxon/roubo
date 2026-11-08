/**
 * Deterministically canonicalize a JSON value: object keys are sorted
 * recursively and there is no insignificant whitespace. Two values that differ
 * only in key order give the same string, so a hash or a signature computed
 * over these bytes is stable. The marketplace signing script and its verifier
 * must agree on this exact serialization, and the bench definition hash uses it
 * too.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
