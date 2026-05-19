import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  // Inject CJS compatibility shims so bundled CJS packages work correctly in ESM context
  banner: {
    js: "import { createRequire as __cjsRequire } from 'module';\nimport { fileURLToPath as __cjsFileURLToPath } from 'url';\nimport { dirname as __cjsDirname } from 'path';\nconst require = __cjsRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);",
  },
  // node-pty and mssql have native .node binaries (handled by AutoUnpackNativesPlugin); bundle everything else
  noExternal: [
    "@roubo/shared",
    "ajv",
    "cors",
    "dockerode",
    "express",
    "yaml",
    "octokit",
    "tree-kill",
    "ws",
  ],
});
