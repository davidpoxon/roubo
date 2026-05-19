import path from "node:path";
import { existsSync } from "node:fs";

/**
 * Resolve the client dist directory relative to this package's location.
 * Works in dev mode (tsx, __dirname = server/) and compiled mode (__dirname = server/dist/).
 */
export function resolveClientDist(dirname: string): string {
  const serverRoot = existsSync(path.join(dirname, "package.json"))
    ? dirname
    : path.join(dirname, "..");
  return path.join(serverRoot, "..", "client", "dist");
}
