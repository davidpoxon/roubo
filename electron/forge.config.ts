import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";

// Signing requires both the base64-encoded .p12 cert and its password to be present.
// Local dev builds without a certificate produce an unsigned app.
const shouldSign = Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);

if (shouldSign && !process.env.APPLE_IDENTITY) {
  throw new Error("APPLE_IDENTITY is required when CSC_LINK and CSC_KEY_PASSWORD are set");
}

// Guaranteed to be a non-empty string when shouldSign is true (guard above throws otherwise)
const appleIdentity = process.env.APPLE_IDENTITY as string;
const entitlementsPlist = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "build/entitlements.mac.plist",
);

export function buildOsxNotarize(env: NodeJS.ProcessEnv) {
  const appleId = env.APPLE_ID;
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) return undefined;
  return { appleId, appleIdPassword, teamId };
}

const notarize = shouldSign ? buildOsxNotarize(process.env) : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: "dev.roubo.desktop",
    name: "Roubo",
    executableName: "roubo",
    icon: "./build/icon",
    asar: { unpack: "**/node_modules/node-pty/**" },
    prune: false, // npm-workspaces hoisting breaks flora-colossus's Walker; see electron/package.json `prepackage:deps`
    protocols: [{ name: "Roubo", schemes: ["roubo"] }],
    ...(shouldSign
      ? {
          osxSign: {
            identity: appleIdentity,
            // osx-sign v1 expresses entitlements and hardened-runtime per-file
            optionsForFile: () => ({
              hardenedRuntime: true,
              entitlements: entitlementsPlist,
            }),
          },
          ...(notarize ? { osxNotarize: notarize } : {}),
        }
      : {}),
  },
  plugins: [new AutoUnpackNativesPlugin({})],
  makers: [
    { name: "@electron-forge/maker-dmg", config: {}, platforms: ["darwin"] },
    { name: "@electron-forge/maker-zip", config: {}, platforms: ["darwin"] },
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          name: "roubo",
          productName: "Roubo",
          bin: "roubo",
          category: "Development",
          mimeType: ["x-scheme-handler/roubo"],
        },
      },
      platforms: ["linux"],
    },
    {
      name: "@reforged/maker-appimage",
      config: {
        options: {
          name: "roubo",
          productName: "Roubo",
          bin: "roubo",
          icon: "./build/icon.png",
          categories: ["Development"],
          mimeType: ["x-scheme-handler/roubo"],
        },
      },
      platforms: ["linux"],
    },
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: { owner: "davidpoxon", name: "roubo" },
        prerelease: false,
        draft: true,
      },
    },
  ],
};

export default config;
