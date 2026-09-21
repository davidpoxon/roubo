import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CURSOR_PLUGIN_ID,
  consentAgent,
  disablePlugin,
  enablePlugin,
  readBenchWorkspacePath,
  readBenches,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "APCC-TC-046".
const observe = makeObserve("APCC-TC-046");

// APCC-TC-046: a completed turn raises a notification for the right bench.
//
// The integration-level drift guard for the APCC-FR-017 / APCC-US-004 journey.
// It walks the authoritative APCC-TC-046 e2e_flow steps S001-S003
// (.specifications/agent-plugins-cursor-cli/test-cases.json in the product
// spec) as ordered, attributable observations against the REAL built app: the host's
// file-notifier launch path, the notifier program it installs, the hook
// registration it writes into each bench worktree, the correlation token it
// registers, and the notification route the notifier POSTs to. On divergence
// each observation routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice(s).
//
// HOW THE CURSOR PLUGIN IS PROVIDED. The shipping plugin lives in the sibling
// `roubo-plugins` repo and builds against the published SDK, so roubo's e2e
// suite cannot depend on it. The agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/cursor-cli/ takes the `cursor-cli` id and
// copies the shipped plugin's notification wiring and quiescence fallback
// verbatim. Its stub (e2e/fixtures/bin/roubo-e2e-cursor-stub) plays the Cursor
// CLI: it redraws while a turn runs, and when the spec drops a finish-turn file
// into its worktree it runs every `hooks.stop[]` command it finds in that
// worktree's `.cursor/hooks.json`, with a `stop` payload on standard input. The
// overlay is force-DISABLED by every /test/__reset
// (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts), so this spec opts
// in and hands it back disabled.
//
// PARTIAL CIRCULARITY, stated plainly: because the overlay copies the wiring,
// this guard cannot prove the shipped plugin's descriptor, which is unit-covered
// in roubo-plugins. What it proves is everything the host does with that
// descriptor across two concurrent benches.
//
// TELLING THE HOOK FROM THE FALLBACK. The plugin keeps a 3000ms quiescence
// fallback on for every session, and the fallback raises the same
// `agent-waiting` type the hook does. Two things keep S003 about the hook:
//   - Both stubs redraw every 250ms while their turn runs, so neither session
//     goes quiet, and the fallback cannot fire for bench 2 at all.
//   - The fallback records the session label as the notification's metadata
//     and the hook route records none, so the first sighting of bench 1's
//     notification says which path raised it. The stub runs the hook about
//     500ms after its last redraw, well inside the 3000ms window.
//
// SPEC-TEXT DRIFT. STEPS and OBSERVATIONS below carry the case's text verbatim.
// When test-cases.json is reachable at TEST_CASES_PATH, the test first
// compares them with it and fails on any difference. When it is not, the
// comparison is recorded as an annotation and skipped.

const PROJECT_ID = "apcc-us-004-cursor-notification-journey";

// `/test/__register-fixture-project` writes `seedBenches[i]` with `id: i + 1`.
const FIRST_BENCH = 1;
const SECOND_BENCH = 2;

/** The notifier program the host installs and names in the hook command. */
const NOTIFIER_PROGRAM = "roubo-notify";

/** Mirrors FINISH_TURN_FILE in e2e/fixtures/bin/roubo-e2e-cursor-stub. */
const FINISH_TURN_FILE = ".roubo-e2e-cursor-finish-turn";

/** How long S003-O02 keeps watching the second bench after the first notifies. */
const SECOND_BENCH_HOLD_MS = 2000;

/** The case's authoritative text. */
const TEST_CASES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.specifications/agent-plugins-cursor-cli/test-cases.json",
);
const CASE_ID = "APCC-TC-046";

// The slices this unit is blocked by, used by the FR-020 failure-output contract
// to attribute a divergence to an owning slice. Their issues live in a tracker
// this repository does not link to, so each is named by a short descriptive
// label of what it delivers, not by its issue number or issue title. The
// journey-to-slice mapping is by requirement and story overlap, so each step
// names a conservative superset.
const SLICE = {
  hooks: { title: "Cursor CLI hook delivery investigation" },
  stdin: { title: "Notifier program reads its payload on standard input" },
  plugin: { title: "Cursor CLI plugin package and launch translation" },
  wiring: { title: "Cursor session notification wiring and quiescence fallback" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Launch a Cursor session in one bench while a second bench also runs a session.",
    owners: [SLICE.plugin, SLICE.wiring],
  },
  S002: {
    id: "S002",
    instruction: "Read the hook registration the host wrote into the first bench.",
    owners: [SLICE.wiring, SLICE.stdin, SLICE.hooks],
  },
  S003: {
    id: "S003",
    instruction: "Let the first session finish a turn.",
    owners: [SLICE.stdin, SLICE.wiring, SLICE.hooks],
  },
};

/** Each observation's expected text, verbatim from the case. */
const OBSERVATIONS: Record<string, Record<string, string>> = {
  S001: { "S001-O01": "Both sessions start." },
  S002: {
    "S002-O01": "It registers the notifier for the completion event.",
    "S002-O02": "It carries that session's correlation value.",
  },
  S003: {
    "S003-O01": "A notification is raised for the first bench.",
    "S003-O02": "No notification is raised for the second bench.",
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  agentPluginId?: string;
}

interface NotificationEntry {
  id: string;
  type: string;
  sourceSessionId?: string;
  metadata?: Record<string, unknown>;
}

interface CaseStep {
  id: string;
  instruction: string;
  observations: { id: string; expected: string }[];
}

/** The case's steps as test-cases.json records them, or null when it is not reachable. */
function readAuthoritativeSteps(): CaseStep[] | null {
  if (!existsSync(TEST_CASES_PATH)) return null;
  const parsed = JSON.parse(readFileSync(TEST_CASES_PATH, "utf-8")) as {
    cases: { id: string; steps: CaseStep[] }[];
  };
  // Projected onto the fields this file copies, so a key the case gains later
  // (a note, a tag) is not mistaken for drift in the text.
  return (parsed.cases.find((entry) => entry.id === CASE_ID)?.steps ?? []).map((step) => ({
    id: step.id,
    instruction: step.instruction,
    observations: step.observations.map((o) => ({ id: o.id, expected: o.expected })),
  }));
}

/** The same shape, built from this file's copy. */
function localSteps(): CaseStep[] {
  return Object.values(STEPS).map((step) => ({
    id: step.id,
    instruction: step.instruction,
    observations: Object.entries(OBSERVATIONS[step.id] ?? {}).map(([id, expected]) => ({
      id,
      expected,
    })),
  }));
}

function describeStep(step: CaseStep | undefined): string {
  if (step === undefined) return "no such step";
  const observations = step.observations.map((o) => `${o.id} "${o.expected}"`).join("; ");
  return `"${step.instruction}" / ${observations}`;
}

async function listSessions(
  request: APIRequestContext,
  benchId: number,
): Promise<TerminalSessionEntry[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${benchId}/terminals`);
  if (res.status() !== 200) return [];
  const body = (await res.json()) as TerminalSessionEntry[];
  return Array.isArray(body) ? body : [];
}

/**
 * Drop every terminal session on both benches. Live PTY sessions are NOT
 * cleared by `/test/__reset`, so a session from an earlier run would shadow the
 * one under test and leave a heartbeating stub behind.
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const benchId of [FIRST_BENCH, SECOND_BENCH]) {
    for (const session of await listSessions(request, benchId)) {
      await request.delete(
        `/api/projects/${PROJECT_ID}/benches/${benchId}/terminals/${session.id}`,
      );
    }
  }
}

/** Launch a Cursor session on one bench; answers the route's status and session id. */
async function launchCursor(
  request: APIRequestContext,
  benchId: number,
): Promise<{ status: number; sessionId?: string; error?: string }> {
  const res = await request.post(`/api/projects/${PROJECT_ID}/benches/${benchId}/terminals`, {
    data: { agentPluginId: CURSOR_PLUGIN_ID },
  });
  const body = (await res.json().catch(() => ({}))) as { sessionId?: string; error?: string };
  return { status: res.status(), ...body };
}

/** Poll until the session reads live on its bench, or give up after ~10s. */
async function waitForLiveSession(
  request: APIRequestContext,
  benchId: number,
  sessionId: string | undefined,
): Promise<string> {
  let seen = "no session";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const session = (await listSessions(request, benchId)).find((s) => s.id === sessionId);
    if (session !== undefined) {
      seen = `status=${session.status}, agent=${session.agentPluginId ?? "none"}`;
      if (session.status === "live" && session.agentPluginId === CURSOR_PLUGIN_ID) return seen;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return seen;
}

/** One bench's notifications, read through the route the bench screens use. */
async function readNotifications(
  request: APIRequestContext,
  benchId: number,
): Promise<NotificationEntry[]> {
  const bench = (await readBenches(request, PROJECT_ID)).find((entry) => entry.id === benchId);
  return (bench?.notifications ?? []) as NotificationEntry[];
}

function describeNotifications(notifications: NotificationEntry[]): string {
  return notifications.length === 0
    ? "no notifications on the bench"
    : notifications
        .map(
          (n) =>
            `${n.type} (session ${n.sourceSessionId ?? "none"}, metadata ${JSON.stringify(n.metadata ?? null)})`,
        )
        .join("; ");
}

/**
 * Split a POSIX-quoted command into words: bare words, and single-quoted words
 * with `'\''` for an embedded quote. That is every form joinShellCommand emits.
 */
function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === " ") {
      if (started) words.push(current);
      current = "";
      started = false;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return [];
      current += command.slice(i + 1, end);
      started = true;
      i = end;
    } else if (char === "\\" && command[i + 1] === "'") {
      current += "'";
      started = true;
      i += 1;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** The `hooks.stop[]` commands in one bench's hooks file, or why none could be read. */
function readStopCommands(workspacePath: string): {
  version?: unknown;
  commands: string[];
  error?: string;
} {
  const file = join(workspacePath, ".cursor", "hooks.json");
  if (!existsSync(file)) return { commands: [], error: `${file} does not exist` };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      version?: unknown;
      hooks?: { stop?: { command?: unknown }[] };
    };
    const stop = Array.isArray(parsed.hooks?.stop) ? parsed.hooks.stop : [];
    return {
      version: parsed.version,
      commands: stop
        .map((entry) => entry.command)
        .filter((c): c is string => typeof c === "string"),
    };
  } catch (err) {
    return { commands: [], error: `${file} is not JSON: ${(err as Error).message}` };
  }
}

let workspaces: string[] = [];

test.beforeEach(async ({ request }) => {
  test.setTimeout(90_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: the Cursor agent plugin is installed, enabled and consented.
  // `resolveAgent` refuses an unconsented agent before it hands out a
  // connection, so without consent the launch would 403.
  await enablePlugin(request, CURSOR_PLUGIN_ID);
  await consentAgent(request, CURSOR_PLUGIN_ID);
  await waitForAvailableAgents(request, [CURSOR_PLUGIN_ID]);

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 1,
            integrationId: "github-com",
            externalId: "1",
            title: "The bench whose session finishes a turn",
          },
        },
        {
          assignedIssue: {
            number: 2,
            integrationId: "github-com",
            externalId: "2",
            title: "A second bench whose session keeps working",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  workspaces = [
    await readBenchWorkspacePath(request, PROJECT_ID, FIRST_BENCH),
    await readBenchWorkspacePath(request, PROJECT_ID, SECOND_BENCH),
  ];
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  for (const workspace of workspaces) {
    rmSync(join(workspace, FINISH_TURN_FILE), { force: true });
  }
  // Hand the environment back with the opt-in overlay off again: the
  // lone-available-agent fallback other specs lean on depends on it (NFR-018).
  await disablePlugin(request, CURSOR_PLUGIN_ID);
});

test(
  "APCC-TC-046: a completed turn raises a notification for the right bench (S001-S003)",
  { tag: "@APCC-TC-046" },
  async ({ request }) => {
    // --- Spec text: this file's copy matches the authoritative case ----------
    const authoritative = readAuthoritativeSteps();
    if (authoritative === null) {
      test.info().annotations.push({
        type: "spec-text",
        description: `${TEST_CASES_PATH} is not reachable from this checkout, so the step text was not compared.`,
      });
    } else {
      // Spec-text drift is this file's to fix, not a slice's, so it fails with
      // its own message rather than through the slice-attributed observer.
      const local = localSteps();
      const ids = (steps: CaseStep[]): string => steps.map((s) => s.id).join(", ");
      expect(
        ids(local),
        `${CASE_ID} spec-text drift: the case's step ids differ from this file's copy. Re-copy the case text.`,
      ).toBe(ids(authoritative) || "no steps (case not found)");
      for (const step of local) {
        expect(
          describeStep(step),
          `${CASE_ID} spec-text drift at ${step.id}: this file's copy differs from the case. Re-copy the case text.`,
        ).toBe(describeStep(authoritative.find((s) => s.id === step.id)));
      }
    }

    const [firstWorkspace] = workspaces;

    // --- S001: a Cursor session in each bench; both start ---------------------
    const first = await launchCursor(request, FIRST_BENCH);
    const second = await launchCursor(request, SECOND_BENCH);
    const firstLive = await waitForLiveSession(request, FIRST_BENCH, first.sessionId);
    const secondLive = await waitForLiveSession(request, SECOND_BENCH, second.sessionId);
    const liveShape = `status=live, agent=${CURSOR_PLUGIN_ID}`;
    observe(
      STEPS.S001,
      "S001-O01",
      first.status === 201 &&
        second.status === 201 &&
        first.sessionId !== undefined &&
        second.sessionId !== undefined &&
        first.sessionId !== second.sessionId &&
        firstLive === liveShape &&
        secondLive === liveShape,
      `${OBSERVATIONS.S001["S001-O01"]} Both launches answer 201 with distinct session ids, and each session reads ${liveShape}.`,
      `bench ${FIRST_BENCH}: ${first.status} ${first.sessionId ?? first.error ?? ""} (${firstLive}); ` +
        `bench ${SECOND_BENCH}: ${second.status} ${second.sessionId ?? second.error ?? ""} (${secondLive})`,
    );
    const firstSessionId = first.sessionId ?? "";
    const secondSessionId = second.sessionId ?? "";

    // --- S002: the hook registration in the first bench ----------------------
    const registration = readStopCommands(firstWorkspace);
    const words =
      registration.commands.length === 1 ? splitShellWords(registration.commands[0]) : [];
    const registrationShape =
      registration.error ??
      `version=${JSON.stringify(registration.version)}, hooks.stop commands=${JSON.stringify(registration.commands)}`;
    observe(
      STEPS.S002,
      "S002-O01",
      registration.version === 1 &&
        registration.commands.length === 1 &&
        words.length === 2 &&
        basename(words[0]) === NOTIFIER_PROGRAM,
      `${OBSERVATIONS.S002["S002-O01"]} .cursor/hooks.json has version 1 and exactly one hooks.stop entry, whose command runs the installed ${NOTIFIER_PROGRAM} with one argument.`,
      registrationShape,
    );
    observe(
      STEPS.S002,
      "S002-O02",
      words[1] === firstSessionId && firstSessionId !== secondSessionId,
      `${OBSERVATIONS.S002["S002-O02"]} The command's one argument is the first bench's session id ${firstSessionId}, not the second bench's ${secondSessionId}.`,
      words.length > 0 ? `command words ${JSON.stringify(words)}` : registrationShape,
    );

    // --- S003: the first session finishes a turn ------------------------------
    // Whatever each bench already carries is the baseline its observation is
    // judged against, so only a notification raised after the turn counts.
    const firstBenchBefore = new Set(
      (await readNotifications(request, FIRST_BENCH)).map((n) => n.id),
    );
    const secondBenchBefore = new Set(
      (await readNotifications(request, SECOND_BENCH)).map((n) => n.id),
    );
    writeFileSync(join(firstWorkspace, FINISH_TURN_FILE), "finish\n", "utf-8");

    // The FIRST sighting is what tells the hook from the fallback: the fallback
    // would overwrite the hook notification's metadata once its window lapses.
    let firstSighting: NotificationEntry | undefined;
    let firstBenchSeen: NotificationEntry[] = [];
    for (let attempt = 0; attempt < 150 && firstSighting === undefined; attempt += 1) {
      firstBenchSeen = await readNotifications(request, FIRST_BENCH);
      firstSighting = firstBenchSeen.find(
        (n) =>
          n.type === "agent-waiting" &&
          n.sourceSessionId === firstSessionId &&
          !firstBenchBefore.has(n.id),
      );
      if (firstSighting === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    observe(
      STEPS.S003,
      "S003-O01",
      firstSighting !== undefined && firstSighting.metadata === undefined,
      `${OBSERVATIONS.S003["S003-O01"]} An agent-waiting notification for session ${firstSessionId} on bench ${FIRST_BENCH}, raised after the turn finished and by the stop hook (no quiescence label metadata).`,
      describeNotifications(firstBenchSeen),
    );

    // Watched across a hold rather than read once, so a notification raised and
    // then dismissed by the second stub's next redraw is still caught. Any
    // notification of any type that was not there before the turn counts, and
    // so does any agent-waiting one or any from the first session even if it
    // was: createNotification reuses an entry's id for a repeat raise.
    const secondBenchStray = new Map<string, NotificationEntry>();
    let secondBenchSeen: NotificationEntry[] = [];
    const holdUntil = Date.now() + SECOND_BENCH_HOLD_MS;
    while (Date.now() < holdUntil) {
      secondBenchSeen = await readNotifications(request, SECOND_BENCH);
      for (const n of secondBenchSeen) {
        if (
          !secondBenchBefore.has(n.id) ||
          n.type === "agent-waiting" ||
          n.sourceSessionId === firstSessionId
        ) {
          secondBenchStray.set(n.id, n);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    observe(
      STEPS.S003,
      "S003-O02",
      secondBenchStray.size === 0,
      `${OBSERVATIONS.S003["S003-O02"]} Bench ${SECOND_BENCH} gains no notification of any type, and carries no agent-waiting one and none from session ${firstSessionId}, in the ${SECOND_BENCH_HOLD_MS}ms after bench ${FIRST_BENCH} notified.`,
      secondBenchStray.size === 0
        ? describeNotifications(secondBenchSeen)
        : `raised during the hold: ${describeNotifications([...secondBenchStray.values()])}`,
    );
  },
);
