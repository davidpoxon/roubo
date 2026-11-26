import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  PROJECT_ID,
  createActiveBench,
  dismissNotices,
  enableProcessPlugin,
  getBench,
  installDatabase,
  openWithStream,
  pollUntil,
  registerLantern,
  removeDatabase,
  resetHarness,
  settleApplies,
  sleep,
  startWeb,
  stateDir,
  stopEverything,
  waitForNotice,
} from "./_support/reload-env.js";
import {
  ADDED_PROJECT_ID,
  SURFACES,
  marketplaceUpdate,
  restoreStateFiles,
  snapshotStateFiles,
  type ChangedInput,
  type SurfaceContext,
} from "./_support/surfaces.js";

// HR-TC-039 (HR-NFR-005): no in-scope apply terminates a terminal, an agent
// session or a running component. Bench 2 of 'lantern' runs a 'web' process
// component and holds a terminal and an agent session; one applied change of
// each input in turn must leave all three as they were: the same PTY process
// with its scrollback, the same live agent session, the same component
// process. It runs against the server that Playwright started and never
// restarts.
//
// The component is bound to the `process` component overlay, a host-process
// plugin that runs on every platform, so the sweep needs no Docker. The agent
// is the `claude-code` overlay, whose CLI is the e2e stub that idles.
// "state.json for an idle bench" edits bench 1, a seeded record that is never
// started; bench 2 is set up through the app, so it runs from its own
// snapshot of the edited roubo.yaml.
//
// GET /test/__terminal-pids names the PTY process of each session, since the
// session list the app serves carries no process id.

const IDLE_BENCH = 1;
// The bench the sweep sets up through the app; the seeded bench 1 holds id 1.
const ACTIVE_BENCH = 2;
const AGENT_PLUGIN_ID = "claude-code";
const SCROLLBACK_MARKER = "hr-tc-039-scrollback";

// The inputs of the case's sweep, in its order: roubo.yaml, plugin update,
// settings, projects.json, state.json for an idle bench, consent,
// plugins-state, .env.
const SWEEP: readonly ChangedInput[] = [
  "project-config",
  "plugin",
  "settings",
  "projects",
  "bench-state",
  "consent",
  "plugin-state",
  "env",
];

interface SessionWire {
  id: string;
  status: string;
  agentPluginId?: string;
}

async function listSessions(request: APIRequestContext): Promise<SessionWire[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${ACTIVE_BENCH}/terminals`);
  if (!res.ok()) return [];
  return (await res.json()) as SessionWire[];
}

async function ptyPids(request: APIRequestContext): Promise<Map<string, number | null>> {
  const res = await request.get(
    `/test/__terminal-pids?projectId=${PROJECT_ID}&benchId=${ACTIVE_BENCH}`,
  );
  expect(res.status(), "GET /test/__terminal-pids").toBe(200);
  const { sessions } = (await res.json()) as { sessions: { id: string; pid: number | null }[] };
  return new Map(sessions.map((s) => [s.id, s.pid]));
}

function processAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Send keystrokes to a terminal session over the socket the pane itself uses. */
async function sendTerminalInput(page: Page, sessionId: string, data: string): Promise<void> {
  await page.evaluate(
    async ({ id, input }) => {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/ws/terminal/${id}`);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "input", data: input }));
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

let snapshot: Map<string, string | null> | null = null;
let scratchDir: string | null = null;

test.beforeEach(async ({ request }) => {
  await resetHarness(request);
});

test.afterEach(async ({ request }) => {
  await stopEverything(request);
  await request.delete(`/api/projects/${ADDED_PROJECT_ID}?force=true`);
  if (snapshot !== null) restoreStateFiles(snapshot);
  snapshot = null;
  await removeDatabase(request);
  if (scratchDir !== null) fs.rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = null;
  // The restore above queued applies: let them finish before the next case.
  await settleApplies(request);
  await resetHarness(request);
});

test("HR-TC-039: an apply on every surface leaves the terminal, the agent session and the component process as they were", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const rouboDir = await stateDir(request);
  snapshot = snapshotStateFiles(rouboDir);
  scratchDir = fs.mkdtempSync(path.join(rouboDir, "e2e-hr-tc-039-"));

  // Preconditions: 'lantern' is registered, and bench 2 is active with a
  // plugin-backed component.
  await enableProcessPlugin(request);
  const consent = await request.post(`/api/plugins/${AGENT_PLUGIN_ID}/consent`, {
    data: { acknowledgedCategories: [] },
  });
  expect(consent.status(), `precondition: consent ${AGENT_PLUGIN_ID}`).toBe(200);
  const project = await registerLantern(request, { seed: 1, gitInit: true });
  await installDatabase(request);
  const ctx: SurfaceContext = { request, rouboDir, project, idleBenchId: IDLE_BENCH, scratchDir };
  expect(await createActiveBench(request), "the new bench takes the next id").toBe(ACTIVE_BENCH);
  const web = (await startWeb(request, ACTIVE_BENCH)).components.web;

  let terminalId = "";
  let agentId = "";
  await test.step("S001: open a terminal on bench 2, launch an agent session, and confirm the web component is running", async () => {
    const open = await request.post(
      `/api/projects/${PROJECT_ID}/benches/${ACTIVE_BENCH}/terminals`,
      { data: {} },
    );
    expect(open.status(), "POST a terminal session on bench 2").toBe(201);
    terminalId = ((await open.json()) as { sessionId: string }).sessionId;

    const launch = await pollUntil(
      () =>
        request.post(`/api/projects/${PROJECT_ID}/benches/${ACTIVE_BENCH}/terminals`, {
          data: { agentPluginId: AGENT_PLUGIN_ID },
        }),
      (res) => res.status() === 201,
      20_000,
      500,
    );
    expect(launch.status(), `POST an agent session (${AGENT_PLUGIN_ID}) on bench 2`).toBe(201);
    agentId = ((await launch.json()) as { sessionId: string }).sessionId;

    await openWithStream(page, `/projects/${PROJECT_ID}/benches/${ACTIVE_BENCH}`);
    await sendTerminalInput(page, terminalId, `echo ${SCROLLBACK_MARKER}\r`);
    const scrollback = await pollUntil(
      () => readScrollback(page, terminalId),
      (text) => text.includes(SCROLLBACK_MARKER),
      10_000,
      250,
    );
    const sessions = await listSessions(request);
    const live = (id: string) => sessions.find((s) => s.id === id)?.status === "live";
    expect(
      {
        terminal: live(terminalId) && scrollback.includes(SCROLLBACK_MARKER),
        agent: live(agentId),
        web: web.status === "running" && processAlive(web.pid),
      },
      "all three are live",
    ).toEqual({ terminal: true, agent: true, web: true });
  });

  const before = await ptyPids(request);
  const terminalPid = before.get(terminalId) ?? null;
  const agentPid = before.get(agentId) ?? null;
  expect(processAlive(terminalPid) && processAlive(agentPid), "both PTYs have a live process").toBe(
    true,
  );

  const failures: string[] = [];
  let n = 0;
  for (const input of SWEEP) {
    n += 1;
    await test.step(`S002: one applied change of ${input}`, async () => {
      await dismissNotices(page);
      // The plugin update is a marketplace update, as HR-FR-007 makes one.
      const save = input === "plugin" ? marketplaceUpdate(ctx) : await SURFACES[input].save(ctx, n);
      await save.write();
      const notice = await waitForNotice(page, save.notice, 10_000);
      if (notice === null) failures.push(`${input}: no applied notice ('${save.expected}')`);
      // Long enough for a wrongly stopped process to be gone and reported.
      await sleep(1_000);

      const pids = await ptyPids(request);
      const sessions = await listSessions(request);
      const terminal = sessions.find((s) => s.id === terminalId);
      const agent = sessions.find((s) => s.id === agentId);
      const scrollback = await readScrollback(page, terminalId);
      const after = (await getBench(request, ACTIVE_BENCH))?.components.web;

      if (terminal?.status !== "live" || pids.get(terminalId) !== terminalPid) {
        failures.push(
          `${input}: the terminal PTY changed (pid ${terminalPid} -> ${pids.get(terminalId) ?? "gone"}, status ${terminal?.status ?? "gone"})`,
        );
      }
      if (!processAlive(terminalPid) || !scrollback.includes(SCROLLBACK_MARKER)) {
        failures.push(`${input}: the terminal process or its scrollback is gone`);
      }
      if (agent?.status !== "live" || pids.get(agentId) !== agentPid || !processAlive(agentPid)) {
        failures.push(
          `${input}: the agent session ${agentId} is not the same live session (status ${agent?.status ?? "gone"})`,
        );
      }
      if (after?.status !== "running" || after.pid !== web.pid || !processAlive(web.pid)) {
        failures.push(
          `${input}: the web component process changed (pid ${web.pid} -> ${after?.pid ?? "none"}, status ${after?.status ?? "none"})`,
        );
      }
    });
  }

  expect(failures, "every apply keeps the terminal, the agent session and the component").toEqual(
    [],
  );
});
