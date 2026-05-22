/**
 * Tells whether a configSchema field is a credential (rendered as a password
 * input and persisted to the OS keyring). The convention is JSON Schema's
 * `format: "password"`. Lives outside `ConfigSchemaForm.tsx` so React fast-
 * refresh doesn't choke on a mixed default + named export.
 */
export function isPasswordProperty(prop: unknown): boolean {
  return (
    prop !== null &&
    typeof prop === "object" &&
    (prop as { type?: unknown }).type === "string" &&
    (prop as { format?: unknown }).format === "password"
  );
}

export function passwordFieldKeys(schema: Record<string, unknown> | undefined): string[] {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props) return [];
  return Object.entries(props)
    .filter(([, def]) => isPasswordProperty(def))
    .map(([key]) => key);
}
