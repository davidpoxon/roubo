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
  // Force a single-file bundle (no shared chunks). The banner below declares a
  // top-level `__dirname`/`__filename`/`require`, and index.ts also derives its
  // own `__dirname` from import.meta.url. In single-file output esbuild renames
  // the entry's `__dirname` to avoid the clash; once a lazy `import()` (the
  // dockerode probe in plugin-isolation-sandbox.ts) splits the banner into a
  // separate chunk, that rename no longer happens and the bundle crashes at boot
  // with "Identifier '__dirname' has already been declared". Keeping splitting
  // off preserves the single index.js the Electron app already ships.
  splitting: false,
  // Inject CJS compatibility shims so bundled CJS packages work correctly in ESM context
  banner: {
    js: "import { createRequire as __cjsRequire } from 'module';\nimport { fileURLToPath as __cjsFileURLToPath } from 'url';\nimport { dirname as __cjsDirname } from 'path';\nconst require = __cjsRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);",
  },
  // node-pty has native .node binaries (handled by AutoUnpackNativesPlugin); bundle everything else.
  // The packaged Electron app ships no server-side node_modules, so any dep omitted here becomes an
  // ERR_MODULE_NOT_FOUND at boot. Keep this list in sync with server/package.json dependencies.
  noExternal: [
    "@roubo/shared",
    "ajv",
    "cors",
    "dockerode",
    "express",
    "express-rate-limit",
    "yaml",
    "semver",
    "tar",
    "tree-kill",
    "undici",
    "vscode-jsonrpc",
    "ws",
  ],
  // ssh2 (bundled through dockerode) requires two optional native bindings inside
  // try/catch. Their install scripts exit 0 when node-gyp fails, so either may be
  // absent, and tsup's native-node-modules plugin fails the whole bundle on a
  // missing `.node` file (#1471). Leave both unbundled: ssh2 falls back to pure
  // JavaScript, which is what it already does in Electron, where a binding built
  // against Node's ABI cannot load.
  external: [/[\\/]sshcrypto\.node$/, "cpu-features"],
});
