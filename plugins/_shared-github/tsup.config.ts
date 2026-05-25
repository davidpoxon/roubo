import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // The bundled plugins consume this as a workspace package; their `tsc --noEmit`
  // run resolves types from `dist/index.d.ts`. tsup hands the DTS generation
  // off to `rollup-plugin-dts`, which is fine because the public surface is
  // small and self-contained.
  dts: true,
  noExternal: ["@roubo/plugin-sdk"],
});
