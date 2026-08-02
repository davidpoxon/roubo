import { parse as parseYaml, YAMLParseError } from "yaml";
import { PluginManifestSchema, type PluginManifest } from "./plugin-manifest-schema.js";

export type ParseManifestResult =
  | { ok: true; manifest: PluginManifest }
  | {
      ok: false;
      error: {
        code: "invalid-yaml" | "schema";
        message: string;
        path?: string;
        /**
         * The `roubo` compatibility range as literally declared in the manifest,
         * surfaced only when the strict schema parse failed (issue #719).
         *
         * `PluginManifestSchema` is `.strict()`, so a host that predates a
         * manifest field fails on the unrecognized key before anything compares
         * the manifest's declared range against the host API version. That makes
         * the range unreachable for exactly the case it exists to describe. The
         * raw range is already in hand here, so it is handed back on the failure
         * for the caller to interpret; the comparison itself stays in the server
         * (`shared` depends only on `yaml` + `zod`, not on node-semver).
         *
         * Absent when the YAML never parsed, when the document has no top-level
         * `roubo`, or when that key is not a non-empty string.
         */
        declaredRoubo?: string;
      };
    };

/**
 * Reads the top-level `roubo` scalar out of the raw parsed YAML document, before
 * (and independently of) schema validation. Returns undefined for anything that
 * is not a non-empty string, so a malformed declaration is simply not surfaced
 * rather than being reported as a range.
 */
function readDeclaredRoubo(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>).roubo;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

export function parseManifest(yamlText: string, sourcePath: string): ParseManifestResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const message = err instanceof YAMLParseError ? err.message : (err as Error).message;
    return {
      ok: false,
      error: {
        code: "invalid-yaml",
        message: `Failed to parse ${sourcePath}: ${message}`,
      },
    };
  }

  if (raw === null || raw === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid-yaml",
        message: `${sourcePath} is empty`,
      },
    };
  }

  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
    const declaredRoubo = readDeclaredRoubo(raw);
    return {
      ok: false,
      error: {
        code: "schema",
        message: path ? `${path}: ${issue.message}` : issue.message,
        path,
        ...(declaredRoubo === undefined ? {} : { declaredRoubo }),
      },
    };
  }

  return { ok: true, manifest: parsed.data };
}
