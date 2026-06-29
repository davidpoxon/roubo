import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { seedBundle } from "./seed-bundle.js";

export interface CopyResourcesOptions {
  repoRoot: string;
  electronRoot: string;
  /**
   * The seed step (CPHM-FR-004 / FR-005, issue davidpoxon/roubo-development#309).
   * Injectable so the offline unit test can stub the package-time download;
   * defaults to the real `seedBundle`, which fetches the pinned built artifacts +
   * signed catalog over the network. The packaged app ships NO plugin source: the
   * old `BUNDLED_PLUGIN_IDS` source-copy path is replaced by this verified seed
   * download.
   */
  seed?: (opts: { electronRoot: string }) => Promise<void>;
}

export async function copyResources({
  repoRoot,
  electronRoot,
  seed = seedBundle,
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
  // Defensive: never carry a stale plugin-source dir from a pre-seed build into
  // the packaged app. The app ships built seed artifacts only, never plugin source.
  await rm(path.join(resourcesDir, "plugins"), { recursive: true, force: true });

  await cp(serverDist, destServer, { recursive: true, dereference: true });
  await cp(clientDist, destClient, { recursive: true, dereference: true });
  await cp(schemaDir, destSchema, { recursive: true, dereference: true });

  // Download the pinned, verified seed artifacts (and signed catalog) into
  // resources/seed/. Replaces the removed BUNDLED_PLUGIN_IDS plugin-source copy.
  await seed({ electronRoot });
}

async function assertDir(dir: string, message: string): Promise<void> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new Error();
  } catch {
    throw new Error(message);
  }
}
