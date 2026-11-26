import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  getPlugin,
  MAX_SLEEP_MS,
  openWithStream,
  pollUntil,
  resetHarness,
  serverProcess,
  sleep,
} from "../hot-reload/_support/reload-env.js";
import {
  HARDENING_ENABLED,
  HARDENING_SKIP_REASON,
  positiveIntFromEnv,
} from "./_support/budgets.js";

// HR-TC-049 (HR-NFR-005): idle CPU overhead stays below 1 percent with 20
// projects and 20 plugins. With the app open, the server under test is first
// left idle as the harness leaves it, then registers 20 projects, each with
// its roubo.yaml watched, and finds 20 plugins put in its user plugins root,
// and is left idle for the same window again. Its CPU time over each window
// (process.cpuUsage, read through GET /test/__process) is taken as a share of
// one core; the overhead is what the second window adds to the first, and it
// must stay below 1 percent. The same read counts the watchers the input
// watch holds and the paths they watch.
//
// The numbers are taken against a baseline because the e2e server is not a
// bare install: its user plugins root is e2e/fixtures, whose fixture folders
// it watches too, and the harness runs plugins and polls of its own. That
// idle cost is why the case cannot hold the server's absolute average to 1
// percent: on the e2e server the empty window alone costs about 1.1 percent,
// before any project or plugin is added. So the budget is held on what the
// projects and plugins add, and the absolute average is held to a ceiling
// that a busy-polling watcher would break, with both reported in the
// evidence line.
//
// The design watches each registered project's roubo.yaml with its own
// watcher and the plugins root with the one watcher it already had, so 20
// projects add 20 watcher instances and 20 plugins add none. The paths they
// add are about 70 here; the PRD's figure of about 110 for one chokidar
// instance does not match that design, and the case holds the design's.
//
// The window is the case's 10 minutes; ROUBO_E2E_IDLE_MS shortens it for a
// local look. A wall-clock budget, so it runs only with ROUBO_E2E_HARDENING=1
// (the nightly perf workflow), and a breach fails that workflow.

const PROJECTS = 20;
const PLUGINS = 20;
const IDLE_MS = positiveIntFromEnv("ROUBO_E2E_IDLE_MS", 10 * 60_000, MAX_SLEEP_MS);
// Lets the start-up work of the new projects and plugins end before the window.
const SETTLE_MS = 30_000;
const BUDGET_PERCENT = 1;
// The absolute average of the e2e server, idle baseline included. About 1.6
// percent is measured with the 20 projects and 20 plugins; a watcher that
// polls busily lands far above this.
const ABSOLUTE_CEILING_PERCENT = 3;
// Each project's roubo.yaml has a watcher of its own; the plugins root keeps its one.
const EXPECTED_ADDED_INSTANCES = PROJECTS;
// The paths the 20 projects and 20 plugins add: about 70 are measured. Within a
// quarter of that either way.
const EXPECTED_ADDED_ENTRIES = 70;
const ENTRIES_TOLERANCE = 0.25;
const PORT_BASE = 41_000;
// The fixture plugin every copy is made from: an integration plugin that runs
// the e2e stub runtime.
const TEMPLATE_PLUGIN_ID = "e2e-stub-5";

const pluginId = (i: number) => `hr-idle-${String(i).padStart(2, "0")}`;
let pluginDirs: string[] = [];

async function pluginsRoot(request: APIRequestContext): Promise<string> {
  const template = (await getPlugin(request, TEMPLATE_PLUGIN_ID)) as
    { manifestPath?: string } | undefined;
  if (!template?.manifestPath)
    throw new Error(`the fixture plugin ${TEMPLATE_PLUGIN_ID} is missing`);
  return path.dirname(path.dirname(template.manifestPath));
}

/** Put 20 copies of the template plugin in the plugins root, as an install leaves them. */
async function addPlugins(request: APIRequestContext): Promise<void> {
  const template = (await getPlugin(request, TEMPLATE_PLUGIN_ID)) as { manifestPath: string };
  const templateDir = path.dirname(template.manifestPath);
  const root = await pluginsRoot(request);
  const manifest = fs.readFileSync(template.manifestPath, "utf-8");
  const entry = fs.readFileSync(path.join(templateDir, "index.mjs"), "utf-8");
  for (let i = 1; i <= PLUGINS; i += 1) {
    const dir = path.join(root, pluginId(i));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    pluginDirs.push(dir);
    fs.writeFileSync(path.join(dir, "index.mjs"), entry);
    fs.writeFileSync(
      path.join(dir, "roubo-plugin.yaml"),
      manifest
        .replace(/^id: .*$/m, `id: ${pluginId(i)}`)
        .replace(/^name: .*$/m, `name: Hot-reload idle ${i}`),
    );
  }
}

test.skip(!HARDENING_ENABLED, HARDENING_SKIP_REASON);

test.beforeEach(async ({ request }) => {
  await resetHarness(request);
});

test.afterEach(async ({ request }) => {
  for (const dir of pluginDirs) fs.rmSync(dir, { recursive: true, force: true });
  pluginDirs = [];
  await resetHarness(request);
});

test("HR-TC-049: idle CPU overhead stays below 1 percent with 20 projects and 20 plugins", async ({
  page,
  request,
}) => {
  test.setTimeout(2 * IDLE_MS + 5 * 60_000);

  await openWithStream(page, "/");
  await sleep(SETTLE_MS);
  const baseline = await idleWindow(request);

  await test.step("S001: register 20 projects and install 20 plugins", async () => {
    for (let i = 1; i <= PROJECTS; i += 1) {
      const res = await request.post("/test/__register-fixture-project", {
        data: { projectId: `lantern-${i}`, portBase: PORT_BASE + i * 50 },
      });
      expect(res.status(), `register lantern-${i}`).toBe(200);
    }
    await addPlugins(request);
    const registered = await pollUntil(
      async () => {
        const res = await request.get("/api/plugins");
        const { plugins } = (await res.json()) as { plugins: { id: string }[] };
        return plugins.filter((p) => p.id.startsWith("hr-idle-")).length;
      },
      (count) => count === PLUGINS,
      60_000,
      500,
    );
    expect(registered, `the ${PLUGINS} plugins register`).toBe(PLUGINS);
    await sleep(SETTLE_MS);
  });

  await test.step("S001: leave the app idle and read the server's CPU time", async () => {
    const loaded = await idleWindow(request);
    const overhead = loaded.percent - baseline.percent;
    const addedEntries = loaded.watch.entries - baseline.watch.entries;
    console.log(
      `perf-evidence ${JSON.stringify({
        case: "HR-TC-049",
        idleMs: IDLE_MS,
        baseline: { percent: round(baseline.percent), watch: baseline.watch },
        loaded: { percent: round(loaded.percent), watch: loaded.watch },
        overheadPercent: round(overhead),
        budgetPercent: BUDGET_PERCENT,
        absoluteCeilingPercent: ABSOLUTE_CEILING_PERCENT,
        addedInstances: loaded.watch.instances - baseline.watch.instances,
        addedEntries,
      })}`,
    );

    expect(loaded.pid, "the server stayed up over both windows").toBe(baseline.pid);
    expect(
      loaded.percent,
      `the server averages below ${ABSOLUTE_CEILING_PERCENT}% of one core with the 20 projects and 20 plugins (the budget is ${BUDGET_PERCENT}% on top of an idle baseline of ${round(baseline.percent)}%)`,
    ).toBeLessThan(ABSOLUTE_CEILING_PERCENT);
    expect(
      loaded.watch.instances - baseline.watch.instances,
      "the 20 projects add one watcher each and the 20 plugins add none",
    ).toBe(EXPECTED_ADDED_INSTANCES);
    expect(
      overhead,
      `20 projects and 20 plugins add below ${BUDGET_PERCENT}% of one core`,
    ).toBeLessThan(BUDGET_PERCENT);
    const low = EXPECTED_ADDED_ENTRIES * (1 - ENTRIES_TOLERANCE);
    const high = EXPECTED_ADDED_ENTRIES * (1 + ENTRIES_TOLERANCE);
    expect(
      addedEntries >= low && addedEntries <= high,
      `the 20 projects and 20 plugins add about ${EXPECTED_ADDED_ENTRIES} watched paths: ${addedEntries}`,
    ).toBe(true);
  });
});

interface IdleWindow {
  pid: number;
  percent: number;
  watch: { instances: number; entries: number };
}

/** Leave the server idle for IDLE_MS and take its CPU time as a share of one core. */
async function idleWindow(request: APIRequestContext): Promise<IdleWindow> {
  const start = await serverProcess(request);
  const startedAt = Date.now();
  await sleep(IDLE_MS);
  const end = await serverProcess(request);
  const wallMs = Date.now() - startedAt;
  const cpuMs =
    (end.cpu.userMicros - start.cpu.userMicros + end.cpu.systemMicros - start.cpu.systemMicros) /
    1000;
  expect(end.pid, "the server stayed up over the window").toBe(start.pid);
  return { pid: end.pid, percent: (cpuMs / wallMs) * 100, watch: end.watch };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
