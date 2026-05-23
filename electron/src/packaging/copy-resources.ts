import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface CopyResourcesOptions {
  repoRoot: string;
  electronRoot: string;
}

export const BUNDLED_PLUGIN_IDS = ["github-com", "ghe", "jira-self-hosted"] as const;

export async function copyResources({
  repoRoot,
  electronRoot,
}: CopyResourcesOptions): Promise<void> {
  const serverDist = path.join(repoRoot, "server", "dist");
  const clientDist = path.join(repoRoot, "client", "dist");
  const schemaDir = path.join(repoRoot, "schema");

  await assertDir(serverDist, "server/dist not found — run `npm run build` from repo root first");
  await assertDir(clientDist, "client/dist not found — run `npm run build` from repo root first");
  await assertDir(schemaDir, "schema/ not found — expected at repo root");

  for (const id of BUNDLED_PLUGIN_IDS) {
    await assertDir(
      path.join(repoRoot, "plugins", id, "dist"),
      `plugins/${id}/dist not found — run \`npm run build\` from repo root first`,
    );
  }

  const resourcesDir = path.join(electronRoot, "resources");
  const destServer = path.join(resourcesDir, "server", "dist");
  const destClient = path.join(resourcesDir, "client", "dist");
  const destSchema = path.join(resourcesDir, "schema");
  const destPlugins = path.join(resourcesDir, "plugins");

  await rm(path.join(resourcesDir, "server"), { recursive: true, force: true });
  await rm(path.join(resourcesDir, "client"), { recursive: true, force: true });
  await rm(destSchema, { recursive: true, force: true });
  await rm(destPlugins, { recursive: true, force: true });

  await cp(serverDist, destServer, { recursive: true, dereference: true });
  await cp(clientDist, destClient, { recursive: true, dereference: true });
  await cp(schemaDir, destSchema, { recursive: true, dereference: true });

  for (const id of BUNDLED_PLUGIN_IDS) {
    const src = path.join(repoRoot, "plugins", id);
    const dest = path.join(destPlugins, id);
    await cp(src, dest, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const rel = path.relative(src, source);
        if (rel === "") return true;
        const first = rel.split(path.sep)[0];
        // Ship only the runtime artifacts: manifest, package.json, README, and the built dist/.
        // Exclude src/, tsconfig.json, node_modules, and any incidental build tooling.
        return (
          first === "dist" ||
          first === "roubo-plugin.yaml" ||
          first === "roubo-plugin.yml" ||
          first === "package.json" ||
          first === "README.md"
        );
      },
    });
  }
}

async function assertDir(dir: string, message: string): Promise<void> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new Error();
  } catch {
    throw new Error(message);
  }
}
