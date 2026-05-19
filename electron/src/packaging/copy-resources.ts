import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface CopyResourcesOptions {
  repoRoot: string;
  electronRoot: string;
}

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

  const resourcesDir = path.join(electronRoot, "resources");
  const destServer = path.join(resourcesDir, "server", "dist");
  const destClient = path.join(resourcesDir, "client", "dist");
  const destSchema = path.join(resourcesDir, "schema");

  await rm(path.join(resourcesDir, "server"), { recursive: true, force: true });
  await rm(path.join(resourcesDir, "client"), { recursive: true, force: true });
  await rm(destSchema, { recursive: true, force: true });

  await cp(serverDist, destServer, { recursive: true, dereference: true });
  await cp(clientDist, destClient, { recursive: true, dereference: true });
  await cp(schemaDir, destSchema, { recursive: true, dereference: true });
}

async function assertDir(dir: string, message: string): Promise<void> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new Error();
  } catch {
    throw new Error(message);
  }
}
