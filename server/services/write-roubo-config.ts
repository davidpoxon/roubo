import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import type { RouboConfig } from "@roubo/shared";
import { atomicWrite } from "./state.js";
import { resolveWithin } from "../lib/safe-path.js";

/**
 * Serialize a RouboConfig to the project's `.roubo/roubo.yaml` using the
 * canonical formatting Roubo writes everywhere (double-quoted string values,
 * plain keys, no line wrapping). Returns the absolute path written.
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
  const yamlContent = YAML.stringify(config, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
  atomicWrite(configPath, yamlContent);
  return configPath;
}
