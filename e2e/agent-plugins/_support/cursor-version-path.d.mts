// Types for `cursor-version-path.mjs`. That module is plain ESM rather than
// TypeScript because the extensionless stub binary loads it off disk with no
// build step, so its exports need declarations for the TypeScript side.
export declare const CURSOR_VERSION_PATH: string;
export declare const CURSOR_BUILDS: { readonly below: string; readonly within: string };
