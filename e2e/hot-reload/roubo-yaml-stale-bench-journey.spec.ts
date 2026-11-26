import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { registerFixtureProject } from "../e2e-flow/_support/scenario.js";

// HR-TC-002 (HR-US-002): the integration-level drift guard for the hot-reload
// journey "save roubo.yaml under a running bench: the bench keeps its
// definition, is marked stale, and Restart with new config applies the save".
// It runs against the BUILT app, with the server that Playwright started and
// never restarts.
//
// The assertions follow the authoritative e2e_flow steps of the case, one
// observation per expectation, and never a slice's implementation. Each
// observation routes through the FR-020 failure-output contract
// (../component-plugins/_support/step-runner.ts): a failure names the diverged
// step, the expected versus actual at that step, and the owning slice(s).
//
// Which command a component runs is read from the process itself: the 'web'
// command appends its own tag to a run log outside the repository before it
// execs a long sleep. A line per start makes "keeps running with the old
// command" and "starts with the new command" observable without a log reader.

const observe = makeObserve("HR-TC-002");

const PROJECT_ID = "lantern";
const STALE_NOTICE_TEXT = "Project lantern: roubo.yaml applied. 1 bench is stale.";
const STALE_MARKER_TEXT = "stale · Set up with an older roubo.yaml";
const RESTART_LABEL = "Restart with new config";
const OLD_TAG = "web-v1";
const NEW_TAG = "web-v2";
// The output of the printf the terminal runs. The command line that the shell
// echoes reads `%s`, so only the output line carries the whole marker.
const SCROLLBACK_MARKER = "hr-tc-002-scrollback";
const SCROLLBACK_INPUT = "printf 'hr-tc-002-%s\\n' scrollback\r";

// The slices of this journey, named by title: they are filed in a tracker this
// public repository does not link to (see step-runner.ts).
const SLICE = {
  events: { title: "input-changed events and the non-blocking notice" },
  configWatch: {
    title:
      "Watch roubo.yaml per project: re-parse on save, keep last good, notify, mark running benches stale",
  },
  benchSnapshot: {
    title:
      "Bench keeps its component definitions: snapshot at set-up, stale marker, restart with new config",
  },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Note the running bench's components and open a terminal on it",
    owners: [SLICE.benchSnapshot],
  },
  S002: {
    id: "S002",
    instruction: "Edit lantern/.roubo/roubo.yaml to change the 'web' component command and save",
    owners: [SLICE.configWatch, SLICE.events, SLICE.benchSnapshot],
  },
  S003: {
    id: "S003",
    instruction: "Look at the bench card",
    owners: [SLICE.benchSnapshot, SLICE.configWatch],
  },
  S004: {
    id: "S004",
    instruction: "Click Restart with new config",
    owners: [SLICE.benchSnapshot],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The 'web' command: log its tag to the run log, then stay up. */
function webCommand(tag: string, runLog: string): string {
  return `echo ${tag} >> '${runLog}'; exec sleep 300`;
}

/**
 * Precondition: the fixture roubo.yaml with its 'app' component replaced by a
 * long-running 'web' process component. JSON quoting is valid YAML
 * double-quoted scalar syntax, so the path in the command needs no escaping.
 */
function withWeb(yaml: string, runLog: string): string {
  const app = /^ {2}app:\n {4}plugin:\n {6}id: process\n {4}config:\n {6}command: "true"\n/m;
  const web =
    "  web:\n" +
    "    plugin:\n" +
    "      id: process\n" +
    "    config:\n" +
    `      command: ${JSON.stringify(webCommand(OLD_TAG, runLog))}\n` +
    "      shell: true\n";
  return yaml.replace(app, web).replace(/^ports:\n {2}app:\n/m, "ports:\n  web:\n");
}

/** The tags the 'web' command wrote, one per start. */
function readRunLog(runLog: string): string[] {
  if (!fs.existsSync(runLog)) return [];
  return fs
    .readFileSync(runLog, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0);
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ComponentWire {
  status: string;
  pid?: number;
  error?: string;
}

interface BenchWire {
  id: number;
  status: string;
  stale?: boolean;
  error?: string;
  components: Record<string, ComponentWire>;
  componentSnapshot?: {
    components: Record<string, { config?: { command?: string } }>;
  };
}

async function listBenches(request: APIRequestContext): Promise<BenchWire[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches`);
  expect(res.status(), `GET /api/projects/${PROJECT_ID}/benches`).toBe(200);
  return (await res.json()) as BenchWire[];
}

async function getBench(
  request: APIRequestContext,
  benchId: number,
): Promise<BenchWire | undefined> {
  return (await listBenches(request)).find((b) => b.id === benchId);
}

function describeWeb(web: ComponentWire | undefined): string {
  if (web === undefined) return "no 'web' component";
  return `web status=${web.status}, pid=${web.pid ?? "none"}${web.error ? ` (${web.error})` : ""}`;
}

function snapshotCommand(bench: BenchWire | undefined): string {
  return bench?.componentSnapshot?.components.web?.config?.command ?? "none";
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
    await sleep(250);
  }
  return bench;
}

interface TerminalSessionWire {
  id: string;
  status: string;
}

async function listSessions(
  request: APIRequestContext,
  benchId: number,
): Promise<TerminalSessionWire[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${benchId}/terminals`);
  if (!res.ok()) return [];
  return (await res.json()) as TerminalSessionWire[];
}

/** Send keystrokes to a terminal session over the socket the pane itself uses. */
async function sendTerminalInput(page: Page, sessionId: string, data: string): Promise<void> {
  await page.evaluate(
    async ({ id, input }) => {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/ws/terminal/${id}`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "input", data: input }));
          // Give the frame a moment on the wire before the close drops it.
          setTimeout(() => {
            socket.close();
            resolve();
          }, 500);
        };
        socket.onerror = () => reject(new Error("the terminal socket could not be opened"));
      });
    },
    { id: sessionId, input: data },
  );
}

/** The scrollback a viewer that attaches now is replayed, joined. */
async function readScrollback(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (id) => {
    return new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://${location.host}/ws/terminal/${id}`);
      const timer = setTimeout(() => {
        socket.close();
        resolve("");
      }, 5_000);
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as { type?: string; lines?: string[] };
        if (frame.type !== "replay") return;
        clearTimeout(timer);
        socket.close();
        resolve((frame.lines ?? []).join(""));
      };
      socket.onerror = () => {
        clearTimeout(timer);
        resolve("");
      };
    });
  }, sessionId);
}

async function waitForScrollback(page: Page, sessionId: string, text: string): Promise<string> {
  let scrollback = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    scrollback = await readScrollback(page, sessionId);
    if (scrollback.includes(text)) return scrollback;
    await sleep(250);
  }
  return scrollback;
}

/** A wait whose miss is reported by the observation after it, not by a timeout. */
async function shows(locator: Locator, timeout = 10_000): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
}

async function hides(locator: Locator, timeout = 10_000): Promise<boolean> {
  return locator.waitFor({ state: "hidden", timeout }).then(
    () => true,
    () => false,
  );
}

/** The text of each notice on screen, for the actual side of a divergence. */
async function noticeTexts(page: Page): Promise<string> {
  const texts = await page.getByTestId("input-change-notices").getByRole("status").allInnerTexts();
  return texts.length === 0 ? "no notice" : texts.map((t) => JSON.stringify(t)).join(", ");
}

/** The card of one bench on the project's Benches view. */
function benchCard(page: Page, benchId: number): Locator {
  return page
    .getByTestId("bench-card-frame")
    .filter({ has: page.getByText(`Bench ${benchId}`, { exact: true }) });
}

async function cardText(card: Locator): Promise<string> {
  if ((await card.count()) === 0) return "no card for the bench";
  return ((await card.first().textContent()) ?? "").replace(/\s+/g, " ").trim();
}

// Precondition: the 'web' component is bound to the `process` component
// plugin. The e2e harness swaps the bundled plugins for its overlays, and the
// `process` overlay (e2e/fixtures/bundled-overlays/process/) is installed but
// forced disabled by every /test/__reset, so this test opts in: it enables the
// overlay and records the consent a user gives before a first start. The next
// reset disables it again.
async function enableProcessPlugin(request: APIRequestContext): Promise<void> {
  const enable = await request.post("/api/plugins/process/enable");
  expect(enable.status(), "precondition: POST /api/plugins/process/enable").toBe(204);
  const res = await request.post("/api/plugins/process/consent", {
    data: { acknowledgedCategories: [] },
  });
  expect(res.status(), "precondition: POST /api/plugins/process/consent").toBe(200);
}

let runLogDir: string | null = null;

test.beforeEach(async ({ request }) => {
  const res = await request.post("/test/__reset", { data: {} });
  expect(res.status(), "POST /test/__reset").toBe(200);
});

test.afterEach(async ({ request }) => {
  // End the terminal and stop the bench, so neither outlives the test.
  const benches = await request.get(`/api/projects/${PROJECT_ID}/benches`);
  if (benches.ok()) {
    for (const bench of (await benches.json()) as BenchWire[]) {
      for (const session of await listSessions(request, bench.id)) {
        await request.delete(
          `/api/projects/${PROJECT_ID}/benches/${bench.id}/terminals/${session.id}`,
        );
      }
      await request.post(`/api/projects/${PROJECT_ID}/benches/${bench.id}/stop`, { data: {} });
    }
  }
  if (runLogDir !== null) {
    fs.rmSync(runLogDir, { recursive: true, force: true });
    runLogDir = null;
  }
});

test("HR-TC-002: a roubo.yaml save leaves a running bench on its definition, marks it stale, and Restart with new config applies it (S001-S004)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await enableProcessPlugin(request);
  runLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-e2e-hr-tc-002-"));
  const runLog = path.join(runLogDir, "web-runs.log");

  // Precondition: "A project 'lantern' is registered" with a 'web' component.
  // A real worktree is provisioned for the bench, so the fixture repo is a git
  // repository pinned to its local HEAD.
  const { repoPath } = await registerFixtureProject(request, {
    projectId: PROJECT_ID,
    gitInit: true,
  });
  const configFile = path.join(repoPath, ".roubo", "roubo.yaml");
  const original = fs.readFileSync(configFile, "utf-8");
  const withWebYaml = withWeb(original, runLog);
  expect(withWebYaml, "precondition: the fixture roubo.yaml declares a 'web' component").toContain(
    "  web:\n",
  );
  fs.writeFileSync(configFile, withWebYaml);
  let configHasWeb = false;
  const configDeadline = Date.now() + 10_000;
  while (Date.now() < configDeadline && !configHasWeb) {
    const res = await request.get(`/api/projects/${PROJECT_ID}/config`);
    if (res.ok()) {
      const body = (await res.json()) as { config?: { components?: Record<string, unknown> } };
      configHasWeb = body.config?.components?.web !== undefined;
    }
    if (!configHasWeb) await sleep(200);
  }
  expect(configHasWeb, "precondition: the project config lists the 'web' component").toBe(true);

  // Precondition: "One bench on lantern is active", with 'web' running.
  const create = await request.post(`/api/projects/${PROJECT_ID}/benches`, { data: {} });
  expect(create.status(), `precondition: POST /api/projects/${PROJECT_ID}/benches`).toBe(201);
  const benchId = ((await create.json()) as { id: number }).id;
  const prepared = await waitForBench(request, benchId, (b) => b.status !== "preparing", 30_000);
  expect(prepared?.status, "precondition: the bench finishes setting up").not.toBe("preparing");
  // A bench set up with auto-start on is already starting its components.
  if ((prepared?.components.web?.status ?? "stopped") === "stopped") {
    const start = await request.post(`/api/projects/${PROJECT_ID}/benches/${benchId}/start`, {
      data: {},
    });
    expect(start.status(), "precondition: POST start the bench").toBe(200);
  }
  // Settled: 'web' is up and the bench is out of its start, so a restart is
  // accepted later.
  const running = await waitForBench(
    request,
    benchId,
    (b) =>
      b.status !== "preparing" &&
      (b.components.web?.status === "running" || b.components.web?.status === "error"),
    45_000,
  );
  expect(
    running?.components.web?.status,
    `precondition: the bench runs 'web' (${describeWeb(running?.components.web)})`,
  ).toBe("running");

  let before: ComponentWire | undefined;
  let sessionId = "";

  await test.step("S001: note the running bench's components and open a terminal on it", async () => {
    const bench = await getBench(request, benchId);
    before = bench?.components.web;
    const runs = readRunLog(runLog);
    observe(
      STEPS.S001,
      "S001-O01",
      before?.status === "running" && runs.length === 1 && runs[0] === OLD_TAG,
      `the bench's 'web' component runs the command it was set up with (one '${OLD_TAG}' start)`,
      `${describeWeb(before)}; run log: ${JSON.stringify(runs)}`,
    );

    const open = await request.post(`/api/projects/${PROJECT_ID}/benches/${benchId}/terminals`, {
      data: {},
    });
    expect(open.status(), "POST a terminal session on the bench").toBe(201);
    sessionId = ((await open.json()) as { sessionId: string }).sessionId;

    const stream = page.waitForResponse((r) => r.url().includes("/api/notifications/stream"));
    const res = await page.goto(`/projects/${PROJECT_ID}/benches/${benchId}`);
    expect(res?.status(), "GET the bench detail page").toBe(200);
    await stream;
    const tab = page.getByRole("tab", { name: "Terminal" });
    await expect(tab, "the bench detail view has a Terminal tab").toBeVisible();
    await tab.click();

    await sendTerminalInput(page, sessionId, SCROLLBACK_INPUT);
    const scrollback = await waitForScrollback(page, sessionId, SCROLLBACK_MARKER);
    const paneShows = await shows(page.getByText(SCROLLBACK_MARKER));
    observe(
      STEPS.S001,
      "S001-O02",
      scrollback.includes(SCROLLBACK_MARKER) && paneShows,
      `a terminal is open on the bench and its pane shows the output '${SCROLLBACK_MARKER}'`,
      `scrollback ${scrollback.includes(SCROLLBACK_MARKER) ? "holds" : "lacks"} the output; the pane ${paneShows ? "shows" : "does not show"} it`,
    );
  });

  await test.step("S002: edit roubo.yaml to change the 'web' component command and save", async () => {
    const current = fs.readFileSync(configFile, "utf-8");
    const edited = current.replace(
      JSON.stringify(webCommand(OLD_TAG, runLog)),
      JSON.stringify(webCommand(NEW_TAG, runLog)),
    );
    expect(edited, "the edit changes the 'web' command").not.toBe(current);
    fs.writeFileSync(configFile, edited);

    const notice = page
      .getByTestId("input-change-notices")
      .getByRole("status")
      .filter({ hasText: STALE_NOTICE_TEXT });
    const noticeShown = await shows(notice);
    observe(
      STEPS.S002,
      "S002-O01",
      noticeShown,
      `a notice reads '${STALE_NOTICE_TEXT}'`,
      noticeShown ? "shown" : `after 10000 ms: ${await noticeTexts(page)}`,
    );

    // Long enough for a wrongly applied definition to restart the component.
    await sleep(2_000);
    const after = (await getBench(request, benchId))?.components.web;
    const runs = readRunLog(runLog);
    observe(
      STEPS.S002,
      "S002-O02",
      after?.status === "running" &&
        after.pid === before?.pid &&
        processAlive(after.pid) &&
        runs.length === 1 &&
        runs[0] === OLD_TAG,
      `the bench's 'web' component keeps running the old command: same process (${describeWeb(before)}), no '${NEW_TAG}' start`,
      `${describeWeb(after)}, alive=${String(processAlive(after?.pid))}; run log: ${JSON.stringify(runs)}`,
    );

    const session = (await listSessions(request, benchId)).find((s) => s.id === sessionId);
    const scrollback = await readScrollback(page, sessionId);
    const paneShows = await shows(page.getByText(SCROLLBACK_MARKER), 5_000);
    observe(
      STEPS.S002,
      "S002-O03",
      session?.status === "live" && scrollback.includes(SCROLLBACK_MARKER) && paneShows,
      `the terminal stays open (session live) with its scrollback ('${SCROLLBACK_MARKER}' still in it and on screen)`,
      `session status=${session?.status ?? "gone"}; scrollback ${scrollback.includes(SCROLLBACK_MARKER) ? "holds" : "lacks"} the output; the pane ${paneShows ? "shows" : "does not show"} it`,
    );
  });

  await test.step("S003: look at the bench card", async () => {
    const res = await page.goto(`/projects/${PROJECT_ID}`);
    expect(res?.status(), `GET /projects/${PROJECT_ID}`).toBe(200);
    const card = benchCard(page, benchId);
    await shows(card);

    const marker = card.getByTestId("bench-card-stale-marker");
    const markerShown = await shows(marker);
    const markerText = markerShown ? ((await marker.first().textContent()) ?? "").trim() : "";
    // Beside the status label: the marker and the status share the card head's
    // status group.
    const besideStatus =
      markerShown &&
      (await marker.first().locator("..").getByTestId("bench-card-status").count()) === 1;
    observe(
      STEPS.S003,
      "S003-O01",
      markerText === STALE_MARKER_TEXT && besideStatus,
      `a '${STALE_MARKER_TEXT}' marker is shown beside the status label`,
      markerShown
        ? `marker reads ${JSON.stringify(markerText)}, ${besideStatus ? "beside" : "not beside"} the status label`
        : `no stale marker; the card reads: ${await cardText(card)}`,
    );

    const restart = card.getByRole("button", { name: RESTART_LABEL });
    const restartShown = await shows(restart);
    observe(
      STEPS.S003,
      "S003-O02",
      restartShown,
      `a '${RESTART_LABEL}' action is shown`,
      restartShown ? "shown" : `no such action; the card reads: ${await cardText(card)}`,
    );
  });

  await test.step("S004: click Restart with new config", async () => {
    const card = benchCard(page, benchId);
    const restart = card.getByRole("button", { name: RESTART_LABEL });
    if ((await restart.count()) > 0) await restart.first().click();

    const restarted = await waitForBench(
      request,
      benchId,
      (b) =>
        b.components.web?.status === "error" ||
        (b.components.web?.status === "running" &&
          b.components.web.pid !== before?.pid &&
          readRunLog(runLog).includes(NEW_TAG)),
      45_000,
    );
    const web = restarted?.components.web;
    const runs = readRunLog(runLog);
    observe(
      STEPS.S004,
      "S004-O01",
      !processAlive(before?.pid) &&
        web?.status === "running" &&
        web.pid !== undefined &&
        web.pid !== before?.pid &&
        runs.length === 2 &&
        runs[0] === OLD_TAG &&
        runs[1] === NEW_TAG &&
        snapshotCommand(restarted).includes(NEW_TAG),
      `the bench stops 'web' (the old process exits) and starts it with the new command (one '${NEW_TAG}' start after the '${OLD_TAG}' one)`,
      `old pid ${before?.pid ?? "none"} alive=${String(processAlive(before?.pid))}; ${describeWeb(web)}; run log: ${JSON.stringify(runs)}; snapshot command: ${snapshotCommand(restarted)}`,
    );

    const marker = card.getByTestId("bench-card-stale-marker");
    const markerGone = await hides(marker);
    const fresh = await getBench(request, benchId);
    observe(
      STEPS.S004,
      "S004-O02",
      markerGone && fresh?.stale !== true,
      "the stale marker is gone",
      `the card ${markerGone ? "shows no" : "still shows a"} stale marker; bench stale=${String(fresh?.stale)}`,
    );
  });
});
