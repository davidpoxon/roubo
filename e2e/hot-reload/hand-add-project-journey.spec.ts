import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";

// HR-TC-026 (HR-US-007): the integration-level drift guard for the hot-reload
// journey "hand-add a project to projects.json and see it in the cut list". It
// runs against the BUILT app, with the server that Playwright started and never
// restarts: the project is added by editing projects.json from outside the app,
// as a user would in an editor, and nothing in the app is asked to register it.
//
// The assertions follow the authoritative e2e_flow steps of the case, one
// observation per expectation, and never a slice's implementation. Each
// observation routes through the FR-020 failure-output contract
// (../component-plugins/_support/step-runner.ts): a failure names the diverged
// step, the expected versus actual at that step, and the owning slice(s).
//
// The case names ~/.roubo/projects.json and ~/Developer/lantern-2. The server
// under test reads its state from a dev state dir (GET /test/__state-dir names
// it), and the lantern-2 checkout is made under that dir rather than in the
// user's own ~/Developer, so the run writes nothing outside test-owned state.
// Both sit under the home directory, so the notice still names the checkout by
// its `~` path, as the case's notice does.
//
// lantern-2's issues come from the stubbed integration plugin (e2e-stub),
// pinned to the `hot-reload-hand-added-project` scenario, which seeds open
// issues of the lantern-2 repository.

const observe = makeObserve("HR-TC-026");

const PROJECT_ID = "lantern-2";
const SCENARIO = "hot-reload-hand-added-project";
const NOW = "2026-11-26T09:00:00.000Z";
// Far from the other fixture projects' port bases (39100 and up), so the
// hand-added project cannot be refused for a port overlap.
const PORT_BASE = 39700;
// The open issues the scenario seeds, by title: what "lantern-2 issues are
// listed" looks for in the cut list.
const ISSUE_TITLES = ["Dim the lantern at dusk", "Refit the lantern wick"] as const;
const APPLIED_NOTICE = `Project ${PROJECT_ID}: roubo.yaml applied.`;

// The slices this journey is blocked by, named by title: they are filed in a
// tracker this public repository does not link to (see step-runner.ts).
const SLICE = {
  events: {
    title:
      "input-changed event on the server stream and a non-blocking client notice with targeted refresh",
  },
  configWatch: {
    title:
      "Watch roubo.yaml per project: re-parse on save, keep last good, notify, mark running benches stale",
  },
  stateFiles: {
    title: "Watch ~/.roubo state files: apply hand edits",
  },
  projectLifecycle: {
    title: "Project add, remove, and re-path propagate to every view and watch",
  },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction:
      "Append a valid project entry for ~/Developer/lantern-2 to ~/.roubo/projects.json and save",
    owners: [SLICE.stateFiles, SLICE.projectLifecycle, SLICE.events],
  },
  S002: {
    id: "S002",
    instruction: "Open the cut list",
    owners: [SLICE.projectLifecycle, SLICE.events],
  },
  S003: {
    id: "S003",
    instruction: "Save lantern-2/.roubo/roubo.yaml",
    owners: [SLICE.projectLifecycle, SLICE.configWatch, SLICE.events],
  },
};

/** `p` with the home directory written as `~`, as a notice names a project path. */
function tildePath(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** A valid roubo.yaml for lantern-2, bound to the stubbed integration plugin. */
function lantern2Yaml(displayName: string): string {
  return `project:
  name: ${PROJECT_ID}
  displayName: ${displayName}
  type: web
  repo: lantern/lantern-2
layout:
  type: single-repo
components:
  app:
    plugin:
      id: process
    config:
      command: "true"
ports:
  app:
    base: ${PORT_BASE}
benches:
  max: 1
integration:
  plugin: e2e-stub
  sources:
    Repository:
      - "lantern/lantern-2"
`;
}

interface StateDir {
  rouboDir: string;
  projectsFile: string;
}

async function stateDir(request: APIRequestContext): Promise<StateDir> {
  const res = await request.get("/test/__state-dir");
  expect(res.status(), "precondition: GET /test/__state-dir").toBe(200);
  return (await res.json()) as StateDir;
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

/** Whether a notice that reads `text` shows within `timeout` ms. */
async function noticeShown(page: Page, text: string, timeout = 5_000): Promise<boolean> {
  return page
    .getByTestId("input-change-notices")
    .getByRole("status")
    .filter({ hasText: text })
    .first()
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
}

// The lantern-2 checkout of this run, removed again after it.
let checkoutRoot: string | null = null;

test.beforeEach(async ({ request }) => {
  // The reset drops every registered project and empties projects.json, so the
  // hand edit below is the only thing that can register lantern-2.
  await resetWithScenario(request, SCENARIO, NOW);
});

test.afterEach(async ({ request }) => {
  // Unregister before the checkout goes, so no roubo.yaml watch is left on a
  // removed directory; the next reset empties projects.json.
  const res = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404], "teardown: DELETE the hand-added project").toContain(res.status());
  if (checkoutRoot !== null) {
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
    checkoutRoot = null;
  }
});

test("HR-TC-026: a project appended to projects.json by hand registers, lists its issues in the cut list and arms its roubo.yaml watch (S001-S003)", async ({
  page,
  request,
}) => {
  const { rouboDir, projectsFile } = await stateDir(request);
  checkoutRoot = fs.mkdtempSync(path.join(rouboDir, "e2e-hand-added-"));
  const repoPath = path.join(checkoutRoot, PROJECT_ID);
  const configFile = path.join(repoPath, ".roubo", "roubo.yaml");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, lantern2Yaml("Lantern 2"));

  // The app is open before the edit, so every change has to reach it in place.
  await openWithStream(page, "/");

  await test.step("S001: append a project entry for lantern-2 to projects.json and save", async () => {
    const before = fs.existsSync(projectsFile)
      ? (JSON.parse(fs.readFileSync(projectsFile, "utf-8")) as { projects?: unknown[] })
      : { projects: [] };
    const projects = Array.isArray(before.projects) ? before.projects : [];
    const edited = { ...before, projects: [...projects, { id: PROJECT_ID, repoPath }] };
    fs.writeFileSync(projectsFile, `${JSON.stringify(edited, null, 2)}\n`);

    const expected = `Project ${PROJECT_ID} registered from ${tildePath(repoPath)}.`;
    const shown = await noticeShown(page, expected);
    observe(
      STEPS.S001,
      "S001-O01",
      shown,
      `a notice reads '${expected}'`,
      `after 5000 ms: ${await noticeTexts(page)}`,
    );
  });

  await test.step("S002: open the cut list", async () => {
    // The project list refreshes in place: lantern-2 is in the sidebar of the
    // page that was open before the edit, and opening it opens its cut list.
    const row = page.locator(`[data-project-id="${PROJECT_ID}"]`);
    const listed = await row.waitFor({ state: "visible", timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    const sidebar = (await page
      .locator("[data-project-id]")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-project-id")))) as string[];
    observe(
      STEPS.S002,
      "S002-O01",
      listed,
      `the project list shows '${PROJECT_ID}' with no reload`,
      `the sidebar lists: ${sidebar.join(", ") || "no project"}`,
    );

    await row.getByRole("button").first().click();
    const projectUrl = new RegExp(`/projects/${PROJECT_ID}$`);
    const opened = await page.waitForURL(projectUrl, { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    observe(
      STEPS.S002,
      "S002-O02",
      opened,
      `opening '${PROJECT_ID}' goes to its project page, a URL that ends in /projects/${PROJECT_ID}`,
      `after 5000 ms the page is at ${page.url()}`,
    );

    const missing: string[] = [];
    for (const title of ISSUE_TITLES) {
      const visible = await page
        .getByText(title, { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(
          () => true,
          () => false,
        );
      if (!visible) missing.push(title);
    }
    observe(
      STEPS.S002,
      "S002-O03",
      missing.length === 0,
      `the cut list lists the lantern-2 issues: ${ISSUE_TITLES.join(", ")}`,
      missing.length === 0 ? "listed" : `not listed after 10000 ms: ${missing.join(", ")}`,
    );
  });

  await test.step("S003: save lantern-2/.roubo/roubo.yaml", async () => {
    fs.writeFileSync(configFile, lantern2Yaml("Lantern Two"));
    const shown = await noticeShown(page, APPLIED_NOTICE);
    observe(
      STEPS.S003,
      "S003-O01",
      shown,
      `an applied notice for lantern-2 reads '${APPLIED_NOTICE}', proving its watcher is armed`,
      `after 5000 ms: ${await noticeTexts(page)}`,
    );
  });
});
