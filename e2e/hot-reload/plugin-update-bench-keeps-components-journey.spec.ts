import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { registerFixtureProject } from "../e2e-flow/_support/scenario.js";

// HR-TC-012 (HR-US-005): the integration-level drift guard for the hot-reload
// journey "update a plugin while a bench uses it: containers and processes stay
// up". It runs against the BUILT app, with the server that Playwright started
// and never restarts.
//
// The assertions follow the authoritative e2e_flow steps of the case, one
// observation per expectation, and never a slice's implementation. Each
// observation routes through the FR-020 failure-output contract
// (../component-plugins/_support/step-runner.ts): a failure names the diverged
// step, the expected versus actual at that step, and the owning slice(s).
//
// Where the two versions of 'database' come from: the e2e fixture catalog
// serves a fixture package in place of its 'database' entry
// (POST /test/__serve-catalog-package, packages under
// e2e/fixtures/catalog-packages/database/). The precondition installs 1.0.0
// through the marketplace, then the catalog serves 1.1.0, so Marketplace offers
// Update. Install and update both take the real path: the installer downloads
// the package as a release asset, unpacks it and checks its digest.
//
// The database is a Redis service in a compose file the fixture project
// commits, so the bench's container is a real one. The test reads it through
// the docker CLI (is the same id still running, and since when) and queries it
// on the port Roubo allocated to the bench's 'database' component. A runner
// with no Docker skips the test and says why.
//
// One reconciliation: the case names "bench 2". The fixture project has a
// single bench, and the bench number is not what the journey observes: the
// notice counts the benches that kept their components, and that count is 1.

const observe = makeObserve("HR-TC-012");

const PROJECT_ID = "lantern";
const PLUGIN_ID = "database";
const INSTALLED_VERSION = "1.0.0";
const NEWER_VERSION = "1.1.0";
const UPDATE_NOTICE_TEXT = `Plugin ${PLUGIN_ID} updated to ${NEWER_VERSION}. 1 bench kept its components.`;
const COMPONENT = "database";
const COMPOSE_FILE = "docker-compose.yml";
const SERVICE = "db";
// The query of S003: write a key, then read it back.
const QUERY_KEY = "hr-tc-012";
const QUERY_VALUE = "kept";

// A Redis service on the port Roubo allocates, healthy once it answers PING, so
// the bench reports it running only when it can take a query.
const COMPOSE_YAML = `services:
  ${SERVICE}:
    image: redis:7.4-alpine
    ports:
      - "\${HOST_PORT}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 3s
      retries: 30
`;

// The slices of this journey, named by title: they are filed in a tracker this
// public repository does not link to (see step-runner.ts).
const SLICE = {
  inputWatcher: {
    title:
      "InputWatcher module: allowlisted chokidar watches with settle, hash dedupe, self-write tokens, and one log line per outcome",
  },
  benchSnapshot: {
    title:
      "Bench keeps its component definitions: snapshot at set-up, stale marker, restart with new config",
  },
  pluginSwap: {
    title: "Plugin swap keeps bench resources and re-binds them on the new process",
  },
  events: {
    title:
      "input-changed event on the server stream and a non-blocking client notice with targeted refresh",
  },
  pluginsWatch: {
    title: "Watch ~/.roubo/plugins: register, swap and unregister plugins live",
  },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "With bench 2 active and its database container running, note the container id",
    owners: [SLICE.pluginSwap, SLICE.benchSnapshot],
  },
  S002: {
    id: "S002",
    instruction: "Open Marketplace and click Update on 'database'",
    owners: [SLICE.pluginSwap, SLICE.pluginsWatch, SLICE.events, SLICE.inputWatcher],
  },
  S003: {
    id: "S003",
    instruction: "Run a query through the bench's database component",
    owners: [SLICE.pluginSwap, SLICE.benchSnapshot],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Docker, read from the test's side --------------------------------------

/** Whether the docker CLI reaches a daemon, and why not when it does not. */
function dockerAvailability(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    const first = (stderr || (err as Error).message).split("\n")[0];
    return { ok: false, reason: first };
  }
}

interface ContainerState {
  running: boolean;
  startedAt: string;
  composeProject: string;
}

/** The state of one container, or null when docker does not know the id. */
function inspectContainer(id: string): ContainerState | null {
  try {
    const out = execFileSync(
      "docker",
      [
        "inspect",
        "--format",
        '{{json .State.Running}}|{{.State.StartedAt}}|{{index .Config.Labels "com.docker.compose.project"}}',
        id,
      ],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 },
    )
      .toString()
      .trim();
    const [running, startedAt, composeProject] = out.split("|");
    return { running: running === "true", startedAt, composeProject };
  } catch {
    return null;
  }
}

function describeContainer(id: string | undefined, state: ContainerState | null): string {
  if (id === undefined) return "no container id";
  if (state === null) return `container ${id} not found`;
  return `container ${id} running=${String(state.running)}, started at ${state.startedAt}`;
}

/** Remove the bench's compose project, containers and network included. */
function composeDown(composeProject: string): void {
  try {
    execFileSync("docker", ["compose", "-p", composeProject, "down", "--volumes"], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    // Best effort: a project that is already gone needs no teardown.
  }
}

// --- The query of S003: a minimal Redis client ------------------------------

function encodeCommand(args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`;
}

/** One RESP reply at the head of `buf`, or null when it has not all arrived. */
function parseReply(buf: string): { value: string; length: number } | null {
  const eol = buf.indexOf("\r\n");
  if (eol < 0) return null;
  const type = buf[0];
  const line = buf.slice(1, eol);
  if (type === "+" || type === ":") return { value: line, length: eol + 2 };
  if (type === "-") return { value: `error: ${line}`, length: eol + 2 };
  if (type === "$") {
    const size = Number(line);
    if (size < 0) return { value: "(nil)", length: eol + 2 };
    if (buf.length < eol + 2 + size + 2) return null;
    return { value: buf.slice(eol + 2, eol + 2 + size), length: eol + 2 + size + 2 };
  }
  return { value: `unexpected reply ${JSON.stringify(buf)}`, length: buf.length };
}

/** Send each command to Redis on `port` and return one reply per command. */
function redisQuery(port: number, commands: string[][]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const replies: string[] = [];
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no full reply within 5000 ms (got ${JSON.stringify(replies)})`));
    }, 5_000);
    socket.on("connect", () => socket.write(commands.map(encodeCommand).join("")));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (let reply = parseReply(buf); reply !== null; reply = parseReply(buf)) {
        replies.push(reply.value);
        buf = buf.slice(reply.length);
      }
      if (replies.length >= commands.length) {
        clearTimeout(timer);
        socket.end();
        resolve(replies);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- The server, read through its API ---------------------------------------

interface ComponentWire {
  status: string;
  containerId?: string;
  error?: string;
}

interface BenchWire {
  id: number;
  status: string;
  ports: Record<string, number>;
  components: Record<string, ComponentWire>;
}

interface PluginWire {
  id: string;
  source: string;
  status: string;
  manifest: { version?: string } | null;
}

async function listBenches(request: APIRequestContext): Promise<BenchWire[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches`);
  if (!res.ok()) return [];
  return (await res.json()) as BenchWire[];
}

async function getBench(
  request: APIRequestContext,
  benchId: number,
): Promise<BenchWire | undefined> {
  return (await listBenches(request)).find((b) => b.id === benchId);
}

/** Poll until `done` holds for the bench, or the deadline passes. */
async function waitForBench(
  request: APIRequestContext,
  benchId: number,
  done: (bench: BenchWire) => boolean,
  timeoutMs: number,
): Promise<BenchWire | undefined> {
  let bench: BenchWire | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    bench = await getBench(request, benchId);
    if (bench !== undefined && done(bench)) return bench;
    await sleep(500);
  }
  return bench;
}

function describeDatabase(bench: BenchWire | undefined): string {
  if (bench === undefined) return "no bench";
  const db = bench.components[COMPONENT];
  if (db === undefined) return `bench ${bench.status}, no '${COMPONENT}' component`;
  return `bench ${bench.status}, '${COMPONENT}' ${db.status}, container ${db.containerId ?? "none"}${db.error ? ` (${db.error})` : ""}`;
}

async function getPlugin(request: APIRequestContext): Promise<PluginWire | undefined> {
  const res = await request.get("/api/plugins");
  if (!res.ok()) return undefined;
  const body = (await res.json()) as { plugins: PluginWire[] };
  return body.plugins.find((p) => p.id === PLUGIN_ID);
}

async function serveCatalogPackage(
  request: APIRequestContext,
  version: string | null,
): Promise<void> {
  const res = await request.post("/test/__serve-catalog-package", {
    data: { id: PLUGIN_ID, version },
  });
  expect(res.status(), `POST /test/__serve-catalog-package ${PLUGIN_ID}@${version}`).toBe(200);
}

/** Uninstall a 'database' plugin a user install left behind. */
async function removeInstalledPlugin(request: APIRequestContext): Promise<void> {
  const plugin = await getPlugin(request);
  if (plugin?.source === "user") await request.delete(`/api/plugins/${PLUGIN_ID}`);
}

/**
 * Precondition: "'database' is installed, consented". The marketplace install
 * of the served 1.0.0 package; its confirm records the consent.
 */
async function installDatabase(request: APIRequestContext): Promise<void> {
  await serveCatalogPackage(request, INSTALLED_VERSION);
  const preview = await request.post(`/api/marketplace/plugins/${PLUGIN_ID}/install`, {
    data: {},
  });
  expect(preview.status(), `precondition: POST install ${PLUGIN_ID}`).toBe(200);
  const { stagingToken } = (await preview.json()) as { stagingToken: string };
  const confirm = await request.post(`/api/plugins/install/${stagingToken}/confirm`, {
    data: {},
  });
  expect(confirm.status(), `precondition: confirm the install of ${PLUGIN_ID}`).toBe(201);
  let plugin = await getPlugin(request);
  if (plugin?.status === "disabled") {
    const enable = await request.post(`/api/plugins/${PLUGIN_ID}/enable`);
    expect(enable.status(), `precondition: POST enable ${PLUGIN_ID}`).toBe(204);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && plugin?.status !== "enabled") {
    await sleep(250);
    plugin = await getPlugin(request);
  }
  expect(
    `${plugin?.status}@${plugin?.manifest?.version}`,
    `precondition: ${PLUGIN_ID} ${INSTALLED_VERSION} is installed and enabled`,
  ).toBe(`enabled@${INSTALLED_VERSION}`);
}

// --- The page ---------------------------------------------------------------

/** A wait whose miss is reported by the observation after it, not by a timeout. */
async function shows(locator: Locator, timeout = 15_000): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
}

/** The text of each notice on screen, for the actual side of a divergence. */
async function noticeTexts(page: Page): Promise<string> {
  const texts = await page.getByTestId("input-change-notices").getByRole("status").allInnerTexts();
  return texts.length === 0 ? "no notice" : texts.map((t) => JSON.stringify(t)).join(", ");
}

/**
 * Sample the bench status until `stop` is called, so "the bench status stays
 * active throughout" is read across the whole update, not at its two ends.
 */
function sampleBenchStatus(
  request: APIRequestContext,
  benchId: number,
): { stop: () => Promise<string[]> } {
  const samples: string[] = [];
  let sampling = true;
  const loop = (async () => {
    while (sampling) {
      const bench = await getBench(request, benchId);
      samples.push(bench?.status ?? "gone");
      await sleep(100);
    }
  })();
  return {
    stop: async () => {
      sampling = false;
      await loop;
      return samples;
    },
  };
}

let composeProject: string | null = null;

test.beforeEach(async ({ request }) => {
  const res = await request.post("/test/__reset", { data: {} });
  expect(res.status(), "POST /test/__reset").toBe(200);
  await removeInstalledPlugin(request);
});

test.afterEach(async ({ request }) => {
  // Stop the bench, so the plugin is no longer in use and its container stops,
  // then remove the container, the user install and the served package.
  for (const bench of await listBenches(request)) {
    await request.post(`/api/projects/${PROJECT_ID}/benches/${bench.id}/stop`, { data: {} });
  }
  if (composeProject !== null) {
    composeDown(composeProject);
    composeProject = null;
  }
  await removeInstalledPlugin(request);
  await request.post("/test/__serve-catalog-package", { data: { id: PLUGIN_ID, version: null } });
});

test("HR-TC-012: updating a plugin while a bench uses it keeps the bench's container running and its database reachable (S001-S003)", async ({
  page,
  request,
}) => {
  const docker = dockerAvailability();
  test.skip(!docker.ok, `HR-TC-012 needs Docker: ${docker.ok ? "" : docker.reason}`);
  // Room for a first pull of the Redis image.
  test.setTimeout(300_000);

  await installDatabase(request);

  // Precondition: "A project 'lantern' is registered" with a 'database'
  // component bound to the plugin. The bench's worktree is provisioned from the
  // fixture repo's HEAD, so the compose file is committed there.
  const { repoPath } = await registerFixtureProject(request, {
    projectId: PROJECT_ID,
    gitInit: true,
  });
  const configFile = path.join(repoPath, ".roubo", "roubo.yaml");
  const original = fs.readFileSync(configFile, "utf-8");
  const app = /^ {2}app:\n {4}plugin:\n {6}id: process\n {4}config:\n {6}command: "true"\n/m;
  const database =
    `  ${COMPONENT}:\n` +
    "    plugin:\n" +
    `      id: ${PLUGIN_ID}\n` +
    "    config:\n" +
    `      composeFile: ${COMPOSE_FILE}\n` +
    `      service: ${SERVICE}\n`;
  const withDatabase = original
    .replace(app, database)
    .replace(/^ports:\n {2}app:\n/m, `ports:\n  ${COMPONENT}:\n`);
  expect(
    withDatabase,
    `precondition: the fixture roubo.yaml declares a '${COMPONENT}' component`,
  ).toContain(`  ${COMPONENT}:\n    plugin:\n      id: ${PLUGIN_ID}\n`);
  fs.writeFileSync(path.join(repoPath, COMPOSE_FILE), COMPOSE_YAML);
  fs.writeFileSync(configFile, withDatabase);
  execFileSync("git", ["add", COMPOSE_FILE, ".roubo/roubo.yaml"], {
    cwd: repoPath,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "test: add the database component"], {
    cwd: repoPath,
    stdio: "ignore",
  });
  let configHasDatabase = false;
  const configDeadline = Date.now() + 10_000;
  while (Date.now() < configDeadline && !configHasDatabase) {
    const res = await request.get(`/api/projects/${PROJECT_ID}/config`);
    if (res.ok()) {
      const body = (await res.json()) as { config?: { components?: Record<string, unknown> } };
      configHasDatabase = body.config?.components?.[COMPONENT] !== undefined;
    }
    if (!configHasDatabase) await sleep(200);
  }
  expect(
    configHasDatabase,
    `precondition: the project config lists the '${COMPONENT}' component`,
  ).toBe(true);

  // Precondition: "Bench 2 is active with a database component", its
  // container running.
  const create = await request.post(`/api/projects/${PROJECT_ID}/benches`, { data: {} });
  expect(create.status(), `precondition: POST /api/projects/${PROJECT_ID}/benches`).toBe(201);
  const benchId = ((await create.json()) as { id: number }).id;
  const prepared = await waitForBench(request, benchId, (b) => b.status !== "preparing", 60_000);
  expect(prepared?.status, "precondition: the bench finishes setting up").not.toBe("preparing");
  // A bench set up with auto-start on is already starting its components.
  if ((prepared?.components[COMPONENT]?.status ?? "stopped") === "stopped") {
    const start = await request.post(`/api/projects/${PROJECT_ID}/benches/${benchId}/start`, {
      data: {},
    });
    expect(start.status(), "precondition: POST start the bench").toBe(200);
  }
  const running = await waitForBench(
    request,
    benchId,
    (b) =>
      b.status === "error" ||
      b.components[COMPONENT]?.status === "error" ||
      (b.status === "active" &&
        b.components[COMPONENT]?.status === "running" &&
        b.components[COMPONENT]?.containerId !== undefined),
    240_000,
  );
  expect(
    `${running?.status}/${running?.components[COMPONENT]?.status}`,
    `precondition: the bench is active with '${COMPONENT}' running (${describeDatabase(running)})`,
  ).toBe("active/running");

  // Precondition: "a newer catalog version exists".
  await serveCatalogPackage(request, NEWER_VERSION);

  let containerId: string | undefined;
  let before: ContainerState | null = null;

  await test.step("S001: with the bench active and its database container running, note the container id", async () => {
    const bench = await getBench(request, benchId);
    containerId = bench?.components[COMPONENT]?.containerId;
    before = containerId === undefined ? null : inspectContainer(containerId);
    if (before !== null) composeProject = before.composeProject;
    observe(
      STEPS.S001,
      "S001-O01",
      bench?.status === "active" && before?.running === true,
      `bench ${benchId} is active and the '${COMPONENT}' container it reports is running`,
      `${describeDatabase(bench)}; ${describeContainer(containerId, before)}`,
    );
  });

  await test.step("S002: open Marketplace and click Update on 'database'", async () => {
    const stream = page.waitForResponse((r) => r.url().includes("/api/notifications/stream"));
    const res = await page.goto("/settings");
    expect(res?.status(), "GET /settings").toBe(200);
    await stream;
    // `exact` matters, because a "Marketplaces" (source registry) tab sits
    // beside it.
    const tab = page.getByRole("tab", { name: "Marketplace", exact: true });
    await expect(tab, "the Marketplace settings tab renders").toBeVisible();
    await tab.click();

    const card = page.locator(`[data-testid="marketplace-card"][data-plugin-id="${PLUGIN_ID}"]`);
    const update = card.getByTestId("marketplace-card-update");
    const updateShown = await shows(update);
    expect(
      updateShown,
      `the Marketplace card of '${PLUGIN_ID}' offers Update (${INSTALLED_VERSION} -> ${NEWER_VERSION})`,
    ).toBe(true);

    const sampler = sampleBenchStatus(request, benchId);
    await update.click();
    const consent = page.getByTestId("marketplace-consent-modal");
    await expect(consent, "the update asks for consent before it commits").toBeVisible({
      timeout: 30_000,
    });
    await consent.getByTestId("marketplace-consent-ack").click();
    await consent.getByTestId("marketplace-consent-confirm").click();

    const notice = page
      .getByTestId("input-change-notices")
      .getByRole("status")
      .filter({ hasText: UPDATE_NOTICE_TEXT });
    const noticeShown = await shows(notice, 30_000);
    // Long enough for a wrongly stopped container or a re-run setup to show.
    await sleep(3_000);
    const statuses = await sampler.stop();
    observe(
      STEPS.S002,
      "S002-O01",
      noticeShown,
      `a notice reads '${UPDATE_NOTICE_TEXT}'`,
      noticeShown ? "shown" : `after 30000 ms: ${await noticeTexts(page)}`,
    );

    const bench = await getBench(request, benchId);
    const after = containerId === undefined ? null : inspectContainer(containerId);
    const plugin = await getPlugin(request);
    observe(
      STEPS.S002,
      "S002-O02",
      containerId !== undefined &&
        after?.running === true &&
        after.startedAt === before?.startedAt &&
        bench?.components[COMPONENT]?.containerId === containerId &&
        plugin?.manifest?.version === NEWER_VERSION,
      `the same container id is still running (${describeContainer(containerId, before)}), and the bench still reports it, under ${PLUGIN_ID} ${NEWER_VERSION}`,
      `${describeContainer(containerId, after)}; ${describeDatabase(bench)}; ${PLUGIN_ID} ${plugin?.manifest?.version ?? "not installed"}`,
    );

    const notActive = statuses.filter((s) => s !== "active");
    observe(
      STEPS.S002,
      "S002-O03",
      statuses.length > 0 && notActive.length === 0,
      `the bench status stays active throughout the update (every one of ${statuses.length} samples)`,
      notActive.length === 0
        ? `${statuses.length} samples`
        : `${notActive.length} of ${statuses.length} samples were not active: ${JSON.stringify([...new Set(notActive)])}`,
    );
  });

  await test.step("S003: run a query through the bench's database component", async () => {
    const bench = await getBench(request, benchId);
    const port = bench?.ports[COMPONENT];
    let replies: string[] = [];
    let failure = "";
    if (port === undefined) {
      failure = `no port allocated to '${COMPONENT}'`;
    } else {
      try {
        replies = await redisQuery(port, [
          ["SET", QUERY_KEY, QUERY_VALUE],
          ["GET", QUERY_KEY],
        ]);
      } catch (err) {
        failure = (err as Error).message;
      }
    }
    observe(
      STEPS.S003,
      "S003-O01",
      replies[0] === "OK" && replies[1] === QUERY_VALUE,
      `the query succeeds: on port ${port ?? "none"}, SET ${QUERY_KEY} replies OK and GET ${QUERY_KEY} replies '${QUERY_VALUE}'`,
      failure === "" ? `replies ${JSON.stringify(replies)}` : failure,
    );
  });
});
