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

export interface EnumOption {
  /** Stable string key for the listbox. */
  key: string;
  /** The value written back into the config record, in its original JSON type. */
  value: unknown;
  label: string;
}

/**
 * The closed set of values a configSchema property accepts, or `null` when it
 * is not a closed set. Two JSON Schema spellings mean the same thing here: a
 * bare `enum: [...]`, and a `oneOf` whose every branch is a `{ const }` (the
 * spelling used when each choice needs its own `title`). Anything else (a
 * `oneOf` of real sub-schemas, an `anyOf`, an `allOf`) is not a choice list and
 * falls through to `ConfigSchemaForm`'s other branches.
 *
 * Lives here rather than in `ConfigSchemaForm.tsx` for the same fast-refresh
 * reason as `isPasswordProperty`.
 */
export function enumOptions(prop: unknown): EnumOption[] | null {
  if (prop === null || typeof prop !== "object") return null;
  const def = prop as { enum?: unknown; oneOf?: unknown };

  if (Array.isArray(def.enum) && def.enum.length > 0) {
    return def.enum.map((value) => ({ key: String(value), value, label: String(value) }));
  }

  if (Array.isArray(def.oneOf) && def.oneOf.length > 0) {
    const branches = def.oneOf as { const?: unknown; title?: string }[];
    if (branches.every((b) => b !== null && typeof b === "object" && "const" in b)) {
      return branches.map((b) => ({
        key: String(b.const),
        value: b.const,
        label: b.title ?? String(b.const),
      }));
    }
  }

  return null;
}

export function passwordFieldKeys(schema: Record<string, unknown> | undefined): string[] {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props) return [];
  return Object.entries(props)
    .filter(([, def]) => isPasswordProperty(def))
    .map(([key]) => key);
}
