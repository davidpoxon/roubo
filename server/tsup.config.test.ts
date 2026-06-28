import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tsupConfig from "./tsup.config.js";

// Native modules are intentionally kept EXTERNAL: they ship as unpacked .node
// binaries via Electron Forge (AutoUnpackNativesPlugin + the asar unpack glob in
// electron/forge.config.ts), so tsup must not try to bundle them. Every other
// server dependency MUST be bundled (listed in noExternal), because the packaged
// Electron app ships no server-side node_modules, so any non-native dependency
// left external becomes an ERR_MODULE_NOT_FOUND at boot (the `tar` regression
// that crashed v0.2.0-rc.fd62927).
const NATIVE_EXTERNAL = new Set<string>(["node-pty"]);

describe("server tsup bundle dependency coverage", () => {
  it("bundles every non-native server dependency (noExternal stays in sync with package.json)", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const resolved = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig;
    if (typeof resolved === "function") {
      throw new Error(
        "tsup.config default export is a function; expected a static options object.",
      );
    }
    const noExternal = new Set((resolved.noExternal as string[] | undefined) ?? []);

    const missing = deps.filter((d) => !noExternal.has(d) && !NATIVE_EXTERNAL.has(d));
    expect(missing).toEqual([]);
  });
});
