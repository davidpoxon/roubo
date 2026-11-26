import fs from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// Shared set-up of the cross-surface hot-reload cases (HR-TC-036, HR-TC-039,
// HR-TC-048, HR-TC-049, HR-TC-051). Each case drives the server that
// Playwright started and never restarts, and changes its inputs on disk from
// outside the app, as a user would: the project's roubo.yaml, a plugin folder
// (through the marketplace), and the state files in the state dir that
// GET /test/__state-dir names.

export const PROJECT_ID = "lantern";
/** The plugin the plugin surface installs and updates through the marketplace. */
export const UPDATED_PLUGIN_ID = "database";
export const INSTALLED_VERSION = "1.0.0";
export const NEWER_VERSION = "1.1.0";
/** The plugin a plugins-state.json edit turns off: an integration nothing else uses. */
export const TOGGLED_PLUGIN_ID = "e2e-stub-5";

/** The longest single wait: no case waits longer than the 10 minute idle window plus a margin. */
const MAX_SLEEP_MS = 30 * 60_000;

/** Wait `ms`, held to 0 through MAX_SLEEP_MS so no value of the environment sets an unbounded timer. */
export function sleep(ms: number): Promise<void> {
  let bounded = Number.isFinite(ms) ? Math.trunc(ms) : 0;
  if (bounded < 0) bounded = 0;
  if (bounded > MAX_SLEEP_MS) bounded = MAX_SLEEP_MS;
  return new Promise((resolve) => setTimeout(resolve, bounded));
}

/** Poll `read` until `done` holds or the deadline passes, and answer the last read. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  let value = await read();
  const deadline = Date.now() + timeoutMs;
  while (!done(value) && Date.now() < deadline) {
    await sleep(intervalMs);
    value = await read();
  }
  return value;
}

/**
 * Wait until the server has logged no apply line for `quietMs`, so an apply
 * that an edit of the state files queued has finished before the next reset:
 * a late apply would otherwise land in the next case.
 */
export async function settleApplies(
  request: APIRequestContext,
  quietMs = 1_500,
  timeoutMs = 15_000,
): Promise<void> {
  let last = (await applyLog(request)).total;
  let quietSince = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && Date.now() - quietSince < quietMs) {
    await sleep(100);
    const total = (await applyLog(request)).total;
    if (total !== last) {
      last = total;
      quietSince = Date.now();
    }
  }
}

export async function resetHarness(request: APIRequestContext): Promise<void> {
  const res = await request.post("/test/__reset", { data: {} });
  expect(res.status(), "POST /test/__reset").toBe(200);
}

/** The Roubo state dir of the server under test. */
export async function stateDir(request: APIRequestContext): Promise<string> {
  const res = await request.get("/test/__state-dir");
  expect(res.status(), "GET /test/__state-dir").toBe(200);
  return ((await res.json()) as { rouboDir: string }).rouboDir;
}

export interface ApplyLog {
  lines: string[];
  /** Every line since the last reset, the ones the bounded tap trimmed included. */
  total: number;
}

export async function applyLog(request: APIRequestContext): Promise<ApplyLog> {
  const res = await request.get("/test/__input-watcher-log");
  expect(res.status(), "GET /test/__input-watcher-log").toBe(200);
  return (await res.json()) as ApplyLog;
}

export interface ServerProcess {
  pid: number;
  uptimeMs: number;
  cpu: { userMicros: number; systemMicros: number };
  watch: { instances: number; entries: number };
}

export async function serverProcess(request: APIRequestContext): Promise<ServerProcess> {
  const res = await request.get("/test/__process");
  expect(res.status(), "GET /test/__process").toBe(200);
  return (await res.json()) as ServerProcess;
}

// --- Plugins ------------------------------------------------------------------

/**
 * The `process` component overlay is installed but force-disabled by every
 * /test/__reset, so a case that runs a component opts in: it enables the
 * overlay and records the consent a user gives before a first start.
 */
export async function enableProcessPlugin(request: APIRequestContext): Promise<void> {
  const enable = await request.post("/api/plugins/process/enable");
  expect(enable.status(), "precondition: POST /api/plugins/process/enable").toBe(204);
  const res = await request.post("/api/plugins/process/consent", {
    data: { acknowledgedCategories: [] },
  });
  expect(res.status(), "precondition: POST /api/plugins/process/consent").toBe(200);
}

interface PluginWire {
  id: string;
  status: string;
  source?: string;
  manifest?: { version?: string };
}

export async function getPlugin(
  request: APIRequestContext,
  pluginId: string,
): Promise<PluginWire | undefined> {
  const res = await request.get("/api/plugins");
  if (!res.ok()) return undefined;
  const body = (await res.json()) as { plugins: PluginWire[] };
  return body.plugins.find((p) => p.id === pluginId);
}

async function serveCatalogPackage(
  request: APIRequestContext,
  version: string | null,
): Promise<void> {
  const res = await request.post("/test/__serve-catalog-package", {
    data: { id: UPDATED_PLUGIN_ID, version },
  });
  expect(res.status(), `POST /test/__serve-catalog-package ${UPDATED_PLUGIN_ID}@${version}`).toBe(
    200,
  );
}

/** Install the 1.0.0 package of 'database' through the marketplace. */
export async function installDatabase(request: APIRequestContext): Promise<void> {
  await serveCatalogPackage(request, INSTALLED_VERSION);
  const preview = await request.post(`/api/marketplace/plugins/${UPDATED_PLUGIN_ID}/install`, {
    data: {},
  });
  expect(preview.status(), `precondition: POST install ${UPDATED_PLUGIN_ID}`).toBe(200);
  const { stagingToken } = (await preview.json()) as { stagingToken: string };
  const confirm = await request.post(`/api/plugins/install/${stagingToken}/confirm`, {
    data: {},
  });
  expect(confirm.status(), `precondition: confirm the install of ${UPDATED_PLUGIN_ID}`).toBe(201);
  const installed = await pollUntil(
    () => getPlugin(request, UPDATED_PLUGIN_ID),
    (p) => p?.manifest?.version === INSTALLED_VERSION,
    15_000,
    250,
  );
  expect(installed?.manifest?.version, `precondition: ${UPDATED_PLUGIN_ID} is installed`).toBe(
    INSTALLED_VERSION,
  );
}

/** Update 'database' to 1.1.0 through the marketplace: one applied plugin change. */
export async function updateDatabase(request: APIRequestContext): Promise<void> {
  await serveCatalogPackage(request, NEWER_VERSION);
  const preview = await request.post(`/api/marketplace/plugins/${UPDATED_PLUGIN_ID}/update`, {
    data: {},
  });
  expect(preview.status(), `POST update ${UPDATED_PLUGIN_ID}`).toBe(200);
  const { stagingToken } = (await preview.json()) as { stagingToken: string };
  const confirm = await request.post(`/api/plugins/install/${stagingToken}/confirm`, {
    data: {},
  });
  expect([200, 201], `confirm the update of ${UPDATED_PLUGIN_ID}`).toContain(confirm.status());
}

/** Take back what the plugin surface installed and what the catalog serves. */
export async function removeDatabase(request: APIRequestContext): Promise<void> {
  const plugin = await getPlugin(request, UPDATED_PLUGIN_ID);
  if (plugin?.source === "user") await request.delete(`/api/plugins/${UPDATED_PLUGIN_ID}`);
  await request.post("/test/__serve-catalog-package", {
    data: { id: UPDATED_PLUGIN_ID, version: null },
  });
}

// --- The project and its benches ----------------------------------------------

export interface ComponentWire {
  status: string;
  pid?: number;
  error?: string;
}

export interface BenchWire {
  id: number;
  status: string;
  branch?: string;
  error?: string;
  components: Record<string, ComponentWire>;
}

export async function listBenches(request: APIRequestContext): Promise<BenchWire[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches`);
  expect(res.status(), `GET /api/projects/${PROJECT_ID}/benches`).toBe(200);
  return (await res.json()) as BenchWire[];
}

export async function getBench(
  request: APIRequestContext,
  benchId: number,
): Promise<BenchWire | undefined> {
  return (await listBenches(request)).find((b) => b.id === benchId);
}

/** The 'web' component command: stays up until it is stopped. */
const WEB_COMMAND = "exec sleep 600";

/**
 * The fixture roubo.yaml with its 'app' component replaced by a long-running
 * 'web' process component, so a started bench has a component process to
 * watch.
 */
export function withWeb(yaml: string): string {
  const app = /^ {2}app:\n {4}plugin:\n {6}id: process\n {4}config:\n {6}command: "true"\n/m;
  const web =
    "  web:\n" +
    "    plugin:\n" +
    "      id: process\n" +
    "    config:\n" +
    `      command: ${JSON.stringify(WEB_COMMAND)}\n` +
    "      shell: true\n";
  return yaml.replace(app, web).replace(/^ports:\n {2}app:\n/m, "ports:\n  web:\n");
}

export interface LanternProject {
  repoPath: string;
  configFile: string;
}

/**
 * Register 'lantern' with seeded benches (bench 1 and bench 2 by default),
 * each with a real tmpdir workspace, and give it the long-running 'web'
 * component. Answers once the project config lists 'web'. A seeded bench is a
 * record with no snapshot of its definitions, so it can be edited and listed
 * but not started on 'web'; `gitInit` makes the checkout a git repository, so
 * createActiveBench can set up a real bench on the edited file.
 */
export async function registerLantern(
  request: APIRequestContext,
  options: { seed?: number; gitInit?: boolean } = {},
): Promise<LanternProject> {
  const seed = options.seed ?? 2;
  const res = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      ...(options.gitInit ? { gitInit: true } : {}),
      seedBenches: Array.from({ length: seed }, (_, i) => i + 1).map((n) => ({
        assignedIssue: {
          number: 900 + n,
          integrationId: "github-com",
          externalId: String(900 + n),
          title: `Hot-reload hardening bench ${n}`,
        },
      })),
    },
  });
  expect(res.status(), "precondition: POST /test/__register-fixture-project").toBe(200);
  const { repoPath } = (await res.json()) as { repoPath: string };
  const configFile = path.join(repoPath, ".roubo", "roubo.yaml");
  const original = fs.readFileSync(configFile, "utf-8");
  const edited = withWeb(original);
  expect(edited, "precondition: the fixture roubo.yaml declares a 'web' component").toContain(
    "  web:\n",
  );
  fs.writeFileSync(configFile, edited);
  const listed = await pollUntil(
    async () => {
      const config = await request.get(`/api/projects/${PROJECT_ID}/config`);
      if (!config.ok()) return false;
      const body = (await config.json()) as { config?: { components?: Record<string, unknown> } };
      return body.config?.components?.web !== undefined;
    },
    (ok) => ok,
    10_000,
    200,
  );
  expect(listed, "precondition: the project config lists the 'web' component").toBe(true);
  return { repoPath, configFile };
}

/**
 * Set up a new bench of 'lantern' through the app, as the Create button does,
 * so it takes its snapshot of the current roubo.yaml. Answers its id once its
 * workspace is ready.
 */
export async function createActiveBench(request: APIRequestContext): Promise<number> {
  const res = await request.post(`/api/projects/${PROJECT_ID}/benches`, { data: {} });
  expect(res.status(), `precondition: create a bench: ${await res.text()}`).toBe(201);
  const { id } = (await res.json()) as { id: number };
  const ready = await pollUntil(
    () => getBench(request, id),
    (b) => b !== undefined && b.status !== "preparing",
    60_000,
    250,
  );
  expect(ready?.status, `precondition: bench ${id} is set up: ${ready?.error ?? ""}`).not.toBe(
    "error",
  );
  return id;
}

/** Start a bench and wait until its 'web' component runs with a process id. */
export async function startWeb(request: APIRequestContext, benchId: number): Promise<BenchWire> {
  const start = await request.post(`/api/projects/${PROJECT_ID}/benches/${benchId}/start`, {
    data: {},
  });
  expect(start.status(), `precondition: start bench ${benchId}: ${await start.text()}`).toBe(200);
  const bench = await pollUntil(
    () => getBench(request, benchId),
    (b) =>
      (b?.components.web?.status === "running" && b.components.web.pid !== undefined) ||
      b?.components.web?.status === "error",
    45_000,
    250,
  );
  expect(
    `${bench?.components.web?.status}:${bench?.components.web?.pid === undefined ? "no pid" : "pid"}`,
    `precondition: bench ${benchId} runs 'web': ${JSON.stringify(bench ?? null)}`,
  ).toBe("running:pid");
  return bench as BenchWire;
}

/** Stop every bench of the project and end its terminals, so nothing outlives a case. */
export async function stopEverything(request: APIRequestContext): Promise<void> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches`);
  if (!res.ok()) return;
  for (const bench of (await res.json()) as BenchWire[]) {
    const sessions = await request.get(`/api/projects/${PROJECT_ID}/benches/${bench.id}/terminals`);
    if (sessions.ok()) {
      for (const session of (await sessions.json()) as { id: string }[]) {
        await request.delete(
          `/api/projects/${PROJECT_ID}/benches/${bench.id}/terminals/${session.id}`,
        );
      }
    }
    await request.post(`/api/projects/${PROJECT_ID}/benches/${bench.id}/stop`, { data: {} });
  }
}

// --- State files ----------------------------------------------------------------

export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

/** Write a state file the way an editor saves it: the whole file at once. */
export function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// --- The page ---------------------------------------------------------------------

/** Open a page of the app with its notification stream connected. */
export async function openWithStream(page: Page, url: string): Promise<void> {
  const stream = page.waitForResponse((r) => r.url().includes("/api/notifications/stream"));
  const res = await page.goto(url);
  expect(res?.status(), `GET ${url}`).toBe(200);
  await stream;
}

export function notices(page: Page): Locator {
  return page.getByTestId("input-change-notices").getByRole("status");
}

/** The text of each notice on screen. */
export async function noticeTexts(page: Page): Promise<string[]> {
  return (await notices(page).locator("p").allInnerTexts()).map((t) => t.trim());
}

/** Dismiss every notice on screen, so the next change's notice stands alone. */
export async function dismissNotices(page: Page): Promise<void> {
  for (;;) {
    const button = notices(page).getByRole("button", { name: "Dismiss" }).first();
    if ((await button.count()) === 0) return;
    await button.click();
  }
}

/** Wait for a notice whose text `matches`, and answer its text, or null. */
export async function waitForNotice(
  page: Page,
  matches: (text: string) => boolean,
  timeoutMs: number,
): Promise<string | null> {
  const texts = await pollUntil(
    () => noticeTexts(page),
    (all) => all.some(matches),
    timeoutMs,
    25,
  );
  return texts.find(matches) ?? null;
}
