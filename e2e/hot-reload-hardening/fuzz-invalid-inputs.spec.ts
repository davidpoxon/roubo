import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  INSTALLED_VERSION,
  PROJECT_ID,
  UPDATED_PLUGIN_ID,
  applyLog,
  getPlugin,
  installDatabase,
  listBenches,
  pollUntil,
  registerLantern,
  removeDatabase,
  resetHarness,
  serverProcess,
  stateDir,
} from "../hot-reload/_support/reload-env.js";
import { restoreStateFiles, snapshotStateFiles } from "../hot-reload/_support/surfaces.js";
import {
  HARDENING_ENABLED,
  HARDENING_SKIP_REASON,
  positiveIntFromEnv,
} from "./_support/budgets.js";

// HR-TC-051 (HR-NFR-005): fuzzed invalid inputs never crash the server. 200
// random byte strings go to roubo.yaml, settings.json, projects.json,
// state.json and a plugin manifest in turn. Every write must produce an
// outcome=rejected apply line, the server process must be the same one at the
// end, and the server must still serve the last good state of each input.
//
// The bytes come from a seeded generator, so a failing run can be repeated:
// the seed is fixed, and ROUBO_E2E_FUZZ_SEED overrides it. The write count is
// the case's 200; ROUBO_E2E_FUZZ_WRITES lowers it for a local look. It takes
// minutes, so it runs only with ROUBO_E2E_HARDENING=1 (the nightly perf
// workflow).

const DEFAULT_SEED = 0x5eed_0051;
const SEED = positiveIntFromEnv("ROUBO_E2E_FUZZ_SEED", DEFAULT_SEED);
const WRITES = positiveIntFromEnv("ROUBO_E2E_FUZZ_WRITES", 200);
const MAX_BYTES = 512;
// A plugin directory waits out its completeness gate before it is read.
const LINE_WAIT_MS = 10_000;

/** mulberry32: a small seeded generator, enough to make the bytes repeatable. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomBytes(next: () => number): Buffer {
  const length = 1 + Math.floor(next() * MAX_BYTES);
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(next() * 256);
  return bytes;
}

interface Target {
  name: string;
  /** The file the bytes go to. */
  file: string;
  /** The input the watch names on its apply lines: the file, or a plugin's folder. */
  unit: string;
}

interface LastGood {
  config: string;
  theme: unknown;
  projects: string[];
  branches: string;
  plugin: string;
}

async function lastGood(request: APIRequestContext): Promise<LastGood> {
  const config = await request.get(`/api/projects/${PROJECT_ID}/config`);
  const components = config.ok()
    ? Object.keys(
        ((await config.json()) as { config?: { components?: Record<string, unknown> } }).config
          ?.components ?? {},
      )
    : [];
  const settings = await request.get("/api/settings");
  const projects = await request.get("/api/projects");
  const plugin = await getPlugin(request, UPDATED_PLUGIN_ID);
  return {
    config: components.sort().join(","),
    theme: settings.ok() ? ((await settings.json()) as { theme?: unknown }).theme : "unreadable",
    projects: projects.ok()
      ? ((await projects.json()) as { id: string }[]).map((p) => p.id).sort()
      : [],
    branches: (await listBenches(request))
      .map((b) => `${b.id}:${b.branch ?? ""}`)
      .sort()
      .join(","),
    plugin: `${plugin?.manifest?.version ?? "none"}`,
  };
}

let snapshot: Map<string, string | null> | null = null;
const restores: { file: string; content: Buffer }[] = [];

test.skip(!HARDENING_ENABLED, HARDENING_SKIP_REASON);

test.beforeEach(async ({ request }) => {
  await resetHarness(request);
});

test.afterEach(async ({ request }) => {
  for (const { file, content } of restores.splice(0)) fs.writeFileSync(file, content);
  if (snapshot !== null) restoreStateFiles(snapshot);
  snapshot = null;
  await removeDatabase(request);
  await resetHarness(request);
});

test("HR-TC-051: fuzzed invalid inputs never crash the server", async ({ request }) => {
  test.setTimeout(30 * 60_000);
  const rouboDir = await stateDir(request);
  snapshot = snapshotStateFiles(rouboDir);
  const project = await registerLantern(request);
  await installDatabase(request);
  const plugin = (await getPlugin(request, UPDATED_PLUGIN_ID)) as { manifestPath: string };
  // Bench records exist only once the project's benches are seeded.
  const targets: Target[] = [
    { name: "roubo.yaml", file: project.configFile, unit: project.configFile },
    ...["settings.json", "projects.json", "state.json"].map((name) => {
      const file = path.join(rouboDir, name);
      return { name, file, unit: file };
    }),
    {
      name: "plugin manifest",
      file: plugin.manifestPath,
      unit: path.dirname(plugin.manifestPath),
    },
  ];
  for (const target of targets) {
    if (!fs.existsSync(target.file)) fs.writeFileSync(target.file, "{}\n");
  }

  const startPid = (await serverProcess(request)).pid;
  const good = await lastGood(request);
  expect(good.config, "precondition: lantern serves its 'web' component").toContain("web");
  expect(good.plugin, `precondition: ${UPDATED_PLUGIN_ID} ${INSTALLED_VERSION} is installed`).toBe(
    INSTALLED_VERSION,
  );

  const next = generator(SEED);
  const missing: string[] = [];
  for (const target of targets) {
    await test.step(`S001: write ${WRITES} random byte strings to ${target.name}`, async () => {
      const original = fs.readFileSync(target.file);
      restores.push({ file: target.file, content: original });
      // The watch names an input by its real path.
      const unit = fs.realpathSync(target.unit);
      let missed = 0;
      for (let i = 0; i < WRITES; i += 1) {
        const before = (await applyLog(request)).total;
        fs.writeFileSync(target.file, randomBytes(next));
        const log = await pollUntil(
          () => applyLog(request),
          (l) => newLines(l, before).some((line) => isRejectedLineOf(line, unit)),
          LINE_WAIT_MS,
          25,
        );
        if (!newLines(log, before).some((line) => isRejectedLineOf(line, unit))) missed += 1;
      }
      if (missed > 0)
        missing.push(`${target.name}: ${missed} of ${WRITES} writes had no rejected line`);

      const served = await lastGood(request);
      expect(served, `the last good state is still served after the ${target.name} fuzz`).toEqual(
        good,
      );
      // Put the input back, so the next target starts from a valid state.
      fs.writeFileSync(target.file, original);
      restores.pop();
      await pollUntil(
        () => lastGood(request),
        (now) => JSON.stringify(now) === JSON.stringify(good),
        LINE_WAIT_MS,
        200,
      );
    });
  }

  expect((await serverProcess(request)).pid, "the server process id is unchanged").toBe(startPid);
  expect(missing, `every write produced an outcome=rejected line (seed ${SEED})`).toEqual([]);
});

/** The lines the tap took after it had taken `before`, of what it still holds. */
function newLines(log: { lines: string[]; total: number }, before: number): string[] {
  const added = log.total - before;
  return added <= 0 ? [] : log.lines.slice(Math.max(0, log.lines.length - added));
}

function isRejectedLineOf(line: string, unit: string): boolean {
  return line.includes(` path=${unit} `) && line.includes(" outcome=rejected ");
}
