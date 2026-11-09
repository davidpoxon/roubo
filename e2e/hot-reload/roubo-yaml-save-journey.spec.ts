import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { registerFixtureProject } from "../e2e-flow/_support/scenario.js";

// HR-TC-001 / HR-TC-045 (HR-US-001): the integration-level drift guard for the
// hot-reload journey "save roubo.yaml and set up a new bench with the new
// definition, no relaunch", and for its budget "a change flows from disk to log
// line to event to UI within 2 s". It runs against the BUILT app, with the
// server that Playwright started and never restarts.
//
// The assertions follow the authoritative e2e_flow steps of the two cases, one
// observation per expectation, and never a slice's implementation. Each
// observation routes through the FR-020 failure-output contract
// (../component-plugins/_support/step-runner.ts): a failure names the diverged
// step, the expected versus actual at that step, and the owning slice(s).
//
// The server log has no Playwright reader, so the apply lines are read through
// GET /test/__input-watcher-log, the ROUBO_E2E=1-only mirror of every
// `[input-watcher] surface=... outcome=...` line the server writes.

const observe001 = makeObserve("HR-TC-001");
const observe045 = makeObserve("HR-TC-045");

const PROJECT_ID = "lantern";
const NOTICE_TEXT = "Project lantern: roubo.yaml applied.";
const BUDGET_MS = 2_000;
// Far from the fixture's default app port base (39100), so the new range
// cannot overlap it.
const WORKER_PORT_BASE = 39600;

// The slices of this journey, named by title: they are filed in a tracker this
// public repository does not link to (see step-runner.ts).
const SLICE = {
  watcher: { title: "InputWatcher module for hot reload" },
  events: { title: "input-changed events and the non-blocking notice" },
  clientRefresh: { title: "Refresh the project views on a project-config change" },
  configWatch: { title: "Watch each project's roubo.yaml and apply saves live" },
  benchSnapshot: { title: "A bench keeps the component definitions it was set up with" },
} as const;

const STEPS_001: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction:
      "Open lantern/.roubo/roubo.yaml in an editor and add a component 'worker' with a process command and a port base",
    owners: [SLICE.configWatch],
  },
  S002: {
    id: "S002",
    instruction: "Save the file",
    owners: [SLICE.configWatch, SLICE.watcher, SLICE.events],
  },
  S003: {
    id: "S003",
    instruction: "Open the lantern project page",
    owners: [SLICE.configWatch, SLICE.clientRefresh],
  },
  S004: {
    id: "S004",
    instruction: "Click Set up bench",
    owners: [SLICE.benchSnapshot, SLICE.configWatch],
  },
};

const STEPS_045: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Start the server with one registered project and subscribe to the stream",
    owners: [SLICE.events],
  },
  S002: {
    id: "S002",
    instruction: "Save the project's roubo.yaml and start a timer",
    owners: [SLICE.configWatch, SLICE.watcher, SLICE.events, SLICE.clientRefresh],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The fixture roubo.yaml with a `worker` process component and its port base added. */
function withWorker(yaml: string): string {
  const worker =
    "  worker:\n" +
    "    plugin:\n" +
    "      id: process\n" +
    "    config:\n" +
    '      command: "sleep 30"\n' +
    "ports:\n" +
    "  worker:\n" +
    `    base: ${WORKER_PORT_BASE}\n`;
  return yaml.replace(/^ports:\n/m, worker);
}

/** The project-config applied lines of this project in the server log. */
async function appliedLines(request: APIRequestContext, repoPath: string): Promise<string[]> {
  const res = await request.get("/test/__input-watcher-log");
  expect(res.status(), "GET /test/__input-watcher-log").toBe(200);
  const { lines } = (await res.json()) as { lines: string[] };
  const repoName = path.basename(repoPath);
  return lines.filter(
    (l) =>
      l.startsWith("[input-watcher] surface=project-config ") &&
      l.includes(" outcome=applied ") &&
      l.includes(`${repoName}/.roubo/roubo.yaml `),
  );
}

/**
 * Wait for the first applied line, then for a quiet window, so a second line
 * for the same save would be counted too.
 */
async function settledAppliedLines(
  request: APIRequestContext,
  repoPath: string,
): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await appliedLines(request, repoPath)).length === 0) {
    await sleep(50);
  }
  await sleep(750);
  return appliedLines(request, repoPath);
}

/** Open a page of the app with its notification stream connected. */
async function openWithStream(page: Page, url: string): Promise<void> {
  const stream = page.waitForResponse((r) => r.url().includes("/api/notifications/stream"));
  const res = await page.goto(url);
  expect(res?.status(), `GET ${url}`).toBe(200);
  await stream;
}

/** The text of each notice on screen, for the actual side of a divergence. */
async function noticeTexts(page: Page): Promise<string> {
  const texts = await page.getByTestId("input-change-notices").getByRole("status").allInnerTexts();
  return texts.length === 0 ? "no notice" : texts.map((t) => JSON.stringify(t)).join(", ");
}

/** The component names the Project setup tile lists. */
async function setupTileText(page: Page): Promise<string> {
  const tile = page.getByRole("region", { name: "Project setup", exact: true });
  return ((await tile.textContent()) ?? "").replace(/\s+/g, " ").trim();
}

interface StreamFrame {
  type?: string;
  surface?: string;
  outcome?: string;
  projectId?: string;
}

/** A subscriber of GET /api/notifications/stream, read from the test process. */
async function subscribeToStream(baseURL: string): Promise<{
  frames: StreamFrame[];
  close: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(new URL("/api/notifications/stream", baseURL), {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  expect(res.status, "GET /api/notifications/stream").toBe(200);
  const frames: StreamFrame[] = [];
  const body = res.body;
  if (!body) throw new Error("the notification stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as StreamFrame);
          }
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // The abort at close ends the read.
    }
  })();
  return { frames, close: () => controller.abort() };
}

function projectConfigEvents(frames: StreamFrame[]): StreamFrame[] {
  return frames.filter(
    (f) =>
      f.type === "input-changed" && f.surface === "project-config" && f.projectId === PROJECT_ID,
  );
}

interface BenchWire {
  id: number;
  status: string;
  error?: string;
  components: Record<string, { status: string; error?: string }>;
}

async function listBenches(request: APIRequestContext): Promise<BenchWire[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches`);
  expect(res.status(), `GET /api/projects/${PROJECT_ID}/benches`).toBe(200);
  return (await res.json()) as BenchWire[];
}

// Precondition of HR-TC-001 S004: "Click Set up bench" both sets the bench up
// and starts it, which is the app's behaviour with auto-start on. The setting
// is global, so the test that turns it on puts the old value back.
let restoreSettings: Record<string, unknown> | null = null;

async function enableAutoStart(request: APIRequestContext): Promise<void> {
  const current = await request.get("/api/settings");
  expect(current.status(), "precondition: GET /api/settings").toBe(200);
  const settings = (await current.json()) as Record<string, unknown> & {
    benches?: Record<string, unknown>;
  };
  restoreSettings = settings;
  const res = await request.put("/api/settings", {
    data: {
      ...settings,
      benches: {
        enforceIssueDependencies: false,
        ...settings.benches,
        autoStartComponents: true,
      },
    },
  });
  expect(res.status(), "precondition: PUT /api/settings benches.autoStartComponents").toBe(200);
}

// Precondition of HR-TC-001 S004's start leg: the 'worker' component is bound to
// the `process` component plugin. The e2e harness swaps the bundled plugins for
// its overlays, and the `process` overlay
// (e2e/fixtures/bundled-overlays/process/) is installed but forced disabled by
// every /test/__reset, so this test opts in: it enables the overlay and records
// the consent a user gives before a first start. Like the real plugin, the
// overlay declares no permission category, so the consent acknowledges none.
// The next reset disables it again.
async function enableProcessPlugin(request: APIRequestContext): Promise<void> {
  const enable = await request.post("/api/plugins/process/enable");
  expect(enable.status(), "precondition: POST /api/plugins/process/enable").toBe(204);
  const res = await request.post("/api/plugins/process/consent", {
    data: { acknowledgedCategories: [] },
  });
  expect(res.status(), "precondition: POST /api/plugins/process/consent").toBe(200);
}

test.beforeEach(async ({ request }) => {
  const res = await request.post("/test/__reset", { data: {} });
  expect(res.status(), "POST /test/__reset").toBe(200);
});

test.afterEach(async ({ request }) => {
  // Stop any bench the journey set up, so its worker does not outlive the test.
  const benches = await request.get(`/api/projects/${PROJECT_ID}/benches`);
  if (benches.ok()) {
    for (const bench of (await benches.json()) as BenchWire[]) {
      await request.post(`/api/projects/${PROJECT_ID}/benches/${bench.id}/stop`, { data: {} });
    }
  }
  if (restoreSettings !== null) {
    await request.put("/api/settings", { data: restoreSettings });
    restoreSettings = null;
  }
});

/**
 * HR-TC-001 S001-S003, shared by both HR-TC-001 tests: edit and save
 * roubo.yaml with the app open, then open the project page.
 */
async function saveAndOpenProjectPage(
  page: Page,
  request: APIRequestContext,
  repoPath: string,
): Promise<void> {
  const configFile = path.join(repoPath, ".roubo", "roubo.yaml");
  await openWithStream(page, "/");

  let edited = "";
  await test.step("S001: add a component 'worker' with a process command and a port base", async () => {
    const before = fs.readFileSync(configFile, "utf-8");
    edited = withWorker(before);
    observe001(
      STEPS_001.S001,
      "S001-O01",
      edited !== before && /\n {2}worker:\n/.test(edited),
      "the edited roubo.yaml declares a 'worker' process component and a 'worker' port base",
      edited === before ? "the fixture roubo.yaml has no ports block to extend" : "edited",
    );
  });

  await test.step("S002: save the file", async () => {
    const start = Date.now();
    fs.writeFileSync(configFile, edited);

    const notice = page
      .getByTestId("input-change-notices")
      .getByRole("status")
      .filter({ hasText: NOTICE_TEXT });
    const shown = await notice
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    const elapsed = Date.now() - start;
    observe001(
      STEPS_001.S002,
      "S002-O01",
      shown && elapsed <= BUDGET_MS,
      `within ${BUDGET_MS} ms a notice reads '${NOTICE_TEXT}'`,
      shown ? `the notice showed after ${elapsed} ms` : `after 5000 ms: ${await noticeTexts(page)}`,
    );

    const lines = await settledAppliedLines(request, repoPath);
    observe001(
      STEPS_001.S002,
      "S002-O02",
      lines.length === 1,
      "the server log has one line with surface=project-config outcome=applied",
      `${lines.length} such line(s)${lines.length > 0 ? `: ${lines.join(" | ")}` : ""}`,
    );
  });

  await test.step("S003: open the lantern project page", async () => {
    const res = await page.goto(`/projects/${PROJECT_ID}/settings`);
    expect(res?.status(), `GET /projects/${PROJECT_ID}/settings`).toBe(200);
    const tile = page.getByRole("region", { name: "Project setup", exact: true });
    const listed = await tile
      .getByText("worker")
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    observe001(
      STEPS_001.S003,
      "S003-O01",
      listed,
      "the component list shows 'worker'",
      `the Project setup tile reads: ${await setupTileText(page)}`,
    );
  });
}

test("HR-TC-001: a saved roubo.yaml applies with no relaunch and the project page lists worker (S001-S003)", async ({
  page,
  request,
}) => {
  const { repoPath } = await registerFixtureProject(request, { projectId: PROJECT_ID });
  await saveAndOpenProjectPage(page, request, repoPath);
});

test("HR-TC-001: Set up bench sets up a new bench with the new definition and starts worker (S001-S004)", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await enableAutoStart(request);
  await enableProcessPlugin(request);
  // A real worktree is provisioned for the bench, so the fixture repo is a git
  // repository pinned to its local HEAD.
  const { repoPath } = await registerFixtureProject(request, {
    projectId: PROJECT_ID,
    gitInit: true,
  });
  await saveAndOpenProjectPage(page, request, repoPath);

  await test.step("S004: click Set up bench", async () => {
    const res = await page.goto(`/projects/${PROJECT_ID}`);
    expect(res?.status(), `GET /projects/${PROJECT_ID}`).toBe(200);
    await page.getByRole("button", { name: "Set up bench", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Set up bench" });
    await dialog.getByRole("button", { name: "Set up", exact: true }).click();
    await expect(dialog, "the Set up bench dialog closes on Set up").toBeHidden();

    let benches: BenchWire[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      benches = await listBenches(request);
      if (benches.length > 0) break;
      await sleep(200);
    }
    const bench = benches[0];
    const names = bench ? Object.keys(bench.components) : [];
    observe001(
      STEPS_001.S004,
      "S004-O01",
      bench !== undefined && names.includes("worker"),
      "the new bench lists 'worker' among its components",
      bench === undefined ? "no bench was set up" : `the bench lists: ${names.join(", ")}`,
    );

    // S004-O01 throws when the bench or its worker is missing; this narrows.
    if (bench === undefined || bench.components.worker === undefined) return;

    // "...and starts it": the worker reaches running.
    let worker = bench.components.worker;
    const startDeadline = Date.now() + 45_000;
    while (Date.now() < startDeadline) {
      const live = (await listBenches(request)).find((b) => b.id === bench.id);
      worker = live?.components.worker ?? worker;
      if (worker.status === "running" || worker.status === "error") break;
      await sleep(250);
    }

    observe001(
      STEPS_001.S004,
      "S004-O02",
      worker.status === "running",
      "the new bench starts 'worker' (status running)",
      `worker status=${worker.status}${worker.error ? ` (${worker.error})` : ""}`,
    );
  });
});

test("HR-TC-045: a change flows from disk to log line to event to UI within 2 s", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("the hot-reload project has no baseURL");
  let stream: Awaited<ReturnType<typeof subscribeToStream>> | null = null;
  try {
    let repoPath = "";
    await test.step("S001: start the server with one registered project and subscribe to the stream", async () => {
      ({ repoPath } = await registerFixtureProject(request, { projectId: PROJECT_ID }));
      const projects = await request.get("/api/projects");
      const ids = ((await projects.json()) as { id: string }[]).map((p) => p.id);
      observe045(
        STEPS_045.S001,
        "S001-O01",
        ids.length === 1 && ids[0] === PROJECT_ID,
        `one registered project, '${PROJECT_ID}'`,
        `registered: ${ids.join(", ") || "none"}`,
      );
      stream = await subscribeToStream(baseURL);
      // The project page is open before the save, so the change has to reach it
      // in place, with no reload.
      await openWithStream(page, `/projects/${PROJECT_ID}/settings`);
      await expect(
        page.getByRole("region", { name: "Project setup", exact: true }),
        "precondition: the Project setup tile lists the fixture's components",
      ).toContainText("app");
    });

    await test.step("S002: save the project's roubo.yaml and start a timer", async () => {
      const configFile = path.join(repoPath, ".roubo", "roubo.yaml");
      const edited = withWorker(fs.readFileSync(configFile, "utf-8"));
      const start = Date.now();
      fs.writeFileSync(configFile, edited);

      const tile = page.getByRole("region", { name: "Project setup", exact: true });
      const shown = await tile
        .getByText("worker")
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(
          () => true,
          () => false,
        );
      const elapsed = Date.now() - start;

      const lines = await settledAppliedLines(request, repoPath);
      observe045(
        STEPS_045.S002,
        "S002-O01",
        lines.length === 1,
        "one log line with surface=project-config outcome=applied is written",
        `${lines.length} such line(s)${lines.length > 0 ? `: ${lines.join(" | ")}` : ""}`,
      );

      const events = projectConfigEvents(stream?.frames ?? []);
      observe045(
        STEPS_045.S002,
        "S002-O02",
        events.length === 1 && events[0].outcome === "applied",
        "one input-changed event arrives (surface project-config, outcome applied)",
        `${events.length} event(s): ${JSON.stringify(events)}`,
      );

      observe045(
        STEPS_045.S002,
        "S002-O03",
        shown && elapsed <= BUDGET_MS,
        `the project page shows the change within ${BUDGET_MS} ms of the save`,
        shown
          ? `the page showed 'worker' after ${elapsed} ms`
          : `after 5000 ms the Project setup tile reads: ${await setupTileText(page)}`,
      );
    });
  } finally {
    (stream as { close: () => void } | null)?.close();
  }
});
