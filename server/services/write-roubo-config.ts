import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import type { RouboConfig } from "@roubo/shared";
import { atomicWrite } from "./state.js";
import { resolveWithin } from "../lib/safe-path.js";

/**
 * Serialize a RouboConfig to the project's `.roubo/roubo.yaml`. This is the
 * single canonical writer for that file; every code path that persists config
 * (project registration, the jigs and bench-settings routes, source
 * derivation, integration promotion) routes through here so the on-disk format
 * never diverges. Returns the absolute path written.
 *
 * Formatting deliberately uses the `yaml` library's own defaults rather than a
 * bespoke profile. Those defaults are a well-known, spec-aligned configuration
 * (YAML 1.2 core schema, 2-space indent, minimal quoting: plain scalars stay
 * plain and a value is only quoted when it would otherwise misparse). An
 * earlier version forced `defaultStringType: "QUOTE_DOUBLE"`, which wrapped
 * every string in double quotes and rewrote hand-authored configs on each save;
 * that is the kind of invented rule we are avoiding. Do not reintroduce custom
 * quote or line-width overrides here without a concrete reason.
 *
 * The target is laundered through `resolveWithin`, the `path.relative`-based
 * containment shape CodeQL's js/path-injection sanitizer recognises and the
 * helper every other `roubo.yaml` read/write in the server already uses
 * (config-parser, the projects routes, jig-manager). `repoPath` comes from the
 * operator-controlled project registry, not request input, but the surrounding
 * handlers are reached via a user-controlled projectId, so the sanitizer
 * defends against a malformed registry entry escaping the project root via
 * traversal.
 */
export function writeRouboConfig(repoPath: string, config: RouboConfig): string {
  const configPath = resolveWithin(repoPath, ".roubo", "roubo.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const yamlContent = YAML.stringify(config);
  atomicWrite(configPath, yamlContent);
  return configPath;
}
