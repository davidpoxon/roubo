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
      };
    };

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
    return {
      ok: false,
      error: {
        code: "schema",
        message: path ? `${path}: ${issue.message}` : issue.message,
        path,
      },
    };
  }

  return { ok: true, manifest: parsed.data };
}
