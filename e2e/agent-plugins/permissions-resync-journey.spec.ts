import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CLAUDE_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  readBenchWorkspacePath,
  setDefaultAgent,
  setProjectPermissions,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-057".
const observe = makeObserve("AP-TC-057");

// AP-TC-057 (#530, AP-WU-029) - E2E: editing the project's agent permissions and
// re-syncing writes the mapped rules into every bench workspace's settings file.
//
// One of the three integration-level drift guards for the AP-US-007 journey
// (AP-FR-016, AP-NFR-001). It walks the authoritative AP-TC-057 e2e_flow steps
// S001-S004 as ordered, attributable observations against the REAL built app. On
// divergence each observation routes through the FR-020 failure-output contract
// (see ../component-plugins/_support/step-runner.ts): the failure reports which
// step diverged, the expected-vs-actual, and the owning slice issue(s) from this
// unit's blocked_by set.
//
// HOW THE CLAUDE CODE PLUGIN PRECONDITION IS MET, and the PARTIAL CIRCULARITY
// that follows: identical to the AP-TC-087 guard, whose header states it in full
// (claude-config-launch-journey.spec.ts). The `claude-code` bundled overlay
// under e2e/fixtures/bundled-overlays/ takes the real plugin's id and mirrors its
// manifest, including the permissions capability
// (`rules: { carrier: "workspace-write", resync: true }`) and the allow/deny/ask
// `unionArray` op ordering. Because the overlay supplies that mapping, this guard
// cannot prove the shipped plugin's own rule mapping; that is unit-covered in
// roubo-plugins. What it does prove is the HOST-side integrated path: the editor
// persisting a rule, the resync route fanning out over every operable bench, and
// core executing the plugin's declarative descriptor into each bench workspace
// and nowhere else.
//
// ONE PLACE THE SHIPPED SURFACE IS NARROWER THAN THE CASE'S WORDING, asserted
// against what ships rather than silently reworded: S003 says "Click Resync
// benches" and S003-O01 expects a toast reporting "permissions re-injected into
// 2 bench workspaces". The button reads "Re-sync benches" and the toast reads
// "Re-synced 2 benches" (ProjectPermissionsEditorPage.tsx), which is the same
// fact in the product's own voice.

const PROJECT_ID = "ap-tc-057-permissions-resync";
/** "The project has 2 active benches with provisioned workspaces". */
const BENCH_IDS = [1, 2];

/**
 * "The Agent permissions table already contains allow/ask/deny rules". Every
 * pattern names a command rather than a path, so none of them is near
 * `assertSafeRules`' outside-the-workspace rejection and the fixture cannot fail
 * for a reason the case is not about.
 */
const SEEDED = {
  allow: ["Bash(ls:*)"],
  ask: ["Bash(git push:*)"],
  deny: ["Bash(rm:*)"],
};

/** The rule S002 adds, verbatim from the case. */
const NEW_RULE = "Bash(npm test *)";

const SETTINGS_REL_PATH = path.join(".claude", "settings.local.json");
const RESYNC_BUTTON = "Re-sync benches";
const RESYNC_TOAST = `Re-synced ${BENCH_IDS.length} benches`;

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  permissions: {
    issue: 514,
    title: "Generalized agent permissions with per-agent mapping and bench resync",
  },
  launch: { issue: 510, title: "Core agent launch pipeline: PTY sessions from descriptors" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open Project settings and scroll to Agent permissions",
    owners: [SLICE.permissions],
  },
  S002: {
    id: "S002",
    instruction: "Click Add rule and add allow Bash(npm test *)",
    owners: [SLICE.permissions],
  },
  S003: {
    id: "S003",
    instruction: "Click Resync benches",
    owners: [SLICE.permissions],
  },
  S004: {
    id: "S004",
    instruction: "Open .claude/settings.local.json in a bench workspace",
    owners: [SLICE.permissions, SLICE.launch],
  },
};

/** The workspace-relative settings file of one bench, parsed, or null. */
function readWorkspaceSettings(workspacePath: string): Record<string, unknown> | null {
  const file = path.join(workspacePath, SETTINGS_REL_PATH);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The `permissions` block of one bench's settings file, with every list normalised. */
function readWorkspaceRules(workspacePath: string): {
  allow: string[];
  ask: string[];
  deny: string[];
} | null {
  const settings = readWorkspaceSettings(workspacePath);
  if (settings === null) return null;
  const block = settings.permissions;
  if (block === null || typeof block !== "object" || Array.isArray(block)) return null;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const raw = block as Record<string, unknown>;
  return { allow: list(raw.allow), ask: list(raw.ask), deny: list(raw.deny) };
}

/** One rendered rule row, located by the pattern cell whose parent IS the row. */
function ruleRow(page: Page, pattern: string) {
  return page.getByText(pattern, { exact: true }).locator("..");
}

/** Whether the table renders `pattern` on a row badged with `type`. */
async function hasRule(page: Page, type: string, pattern: string): Promise<boolean> {
  const row = ruleRow(page, pattern);
  if ((await row.count()) !== 1) return false;
  return (await row.getByText(type, { exact: true }).count()) === 1;
}

/** Open the project's Agent permissions editor. */
async function openPermissionsEditor(page: Page): Promise<void> {
  const res = await page.goto(`/projects/${PROJECT_ID}/settings/permissions`);
  expect(res?.status(), "GET the project settings permissions page").toBe(200);
}

/** The bench workspaces this run's resync must reach, in bench order. */
async function readWorkspacePaths(request: APIRequestContext): Promise<string[]> {
  const paths: string[] = [];
  for (const benchId of BENCH_IDS) {
    paths.push(await readBenchWorkspacePath(request, PROJECT_ID, benchId));
  }
  return paths;
}

let repoPath = "";

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "Claude Code plugin is Configured and is the default agent".
  // Consent is what makes the agent resolvable at all (`resolveAgent` refuses an
  // unconsented one), and the pin is what makes `resolveProjectAgentPluginId`
  // answer with it, which is what the resync route asks the plugin for its rules
  // carrier through. App-level defaults are cleared rather than set: this journey
  // is about the permissions axis, and a leftover from another spec must not
  // change which descriptor comes back (NFR-018).
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID]);
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);

  // Precondition: "The project has 2 active benches with provisioned
  // workspaces". A seeded bench carries a real tmpdir workspace, which is what
  // the resync route writes into and what this spec then reads back off disk.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: BENCH_IDS.map((benchId) => ({
        assignedIssue: {
          number: 530,
          integrationId: "github-com",
          externalId: `530-${benchId}`,
          title: `Bench ${benchId}, whose workspace the re-sync has to reach`,
        },
      })),
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
  repoPath = ((await register.json()) as { repoPath: string }).repoPath;

  // Precondition: "The Agent permissions table already contains allow/ask/deny
  // rules". Written through the same route the editor's own saves take.
  await setProjectPermissions(request, PROJECT_ID, SEEDED);
});

test.afterEach(async ({ request }) => {
  await setDefaultAgent(request, null);
  // Permissions live in `<rouboDir>/permissions/<projectId>.json`, which
  // `/test/__reset` does not truncate, so they are cleared explicitly.
  await setProjectPermissions(request, PROJECT_ID, { allow: [], ask: [], deny: [] });
});

test("AP-TC-057: adding a rule and re-syncing writes the mapped rules into every bench workspace (S001-S004)", async ({
  page,
  request,
}) => {
  // Four steps across two surfaces, each guarded by a tolerated wait of up to
  // 15s, so the default 30s budget is not the thing under test. Without this the
  // accumulated waits on a real divergence would blow the budget before
  // `observe` runs, and the failure would arrive as an unattributed Playwright
  // timeout rather than the FR-020 block the unit's failure-output criterion
  // requires.
  test.setTimeout(180_000);

  const workspacePaths = await readWorkspacePaths(request);

  // --- S001: the table renders the existing allow, ask and deny rules -------
  await openPermissionsEditor(page);
  const table = page.getByText("Agent permissions", { exact: true });
  // A TOLERATED wait, not an assertion: a screen that never renders leaves the
  // observation below to report the divergence through the FR-020 block rather
  // than failing here as an unattributed Playwright timeout.
  await table
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  await ruleRow(page, SEEDED.allow[0])
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  // Rows are read ONCE so the boolean and the reported actual cannot disagree.
  const rendered = {
    allow: await hasRule(page, "allow", SEEDED.allow[0]),
    ask: await hasRule(page, "ask", SEEDED.ask[0]),
    deny: await hasRule(page, "deny", SEEDED.deny[0]),
  };
  observe(
    STEPS.S001,
    "S001-O01",
    rendered.allow && rendered.ask && rendered.deny,
    `the rule table renders the existing allow (${SEEDED.allow[0]}), ask (${SEEDED.ask[0]}) and deny (${SEEDED.deny[0]}) rules`,
    `rows found: allow=${rendered.allow}, ask=${rendered.ask}, deny=${rendered.deny}`,
  );

  // --- S002: Add rule appends the new allow rule ----------------------------
  // The Add rule control opens on `allow`, which is the type the case asks for,
  // so the type select is deliberately left alone: touching it would assert the
  // select rather than the addition.
  const pattern = page.getByRole("textbox", { name: "Rule pattern" });
  await expect(pattern, "the Add rule row offers a pattern field").toBeVisible();
  await pattern.fill(NEW_RULE);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const newRow = ruleRow(page, NEW_RULE);
  await newRow.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const newRuleRendered = await hasRule(page, "allow", NEW_RULE);
  // Read the persisted record back through the real API rather than trusting the
  // table's own optimistic state: the resync in S003 reads the STORED rules, so a
  // row that rendered without persisting would make S004 fail with an unrelated
  // expected-vs-actual.
  const storedRes = await request.get(`/api/projects/${PROJECT_ID}/permissions`);
  expect(storedRes.status(), "GET the project's permissions").toBe(200);
  const stored = (await storedRes.json()) as { allow?: string[] };
  observe(
    STEPS.S002,
    "S002-O01",
    newRuleRendered && (stored.allow ?? []).includes(NEW_RULE),
    `the new allow rule "${NEW_RULE}" appears in the table and is persisted`,
    `row rendered=${newRuleRendered}, stored allow=${JSON.stringify(stored.allow ?? [])}`,
  );

  // --- S003: Re-sync benches confirms how many workspaces it reached --------
  const resync = page.getByRole("button", { name: RESYNC_BUTTON });
  await expect(resync, `the editor offers "${RESYNC_BUTTON}"`).toBeVisible();
  await resync.click();

  const toast = page.getByRole("status").filter({ hasText: RESYNC_TOAST });
  await toast.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const toastCount = await toast.count();
  const anyToast = page.getByRole("status");
  const anyToastText =
    (await anyToast.count()) > 0 ? ((await anyToast.first().textContent()) ?? "").trim() : "none";
  observe(
    STEPS.S003,
    "S003-O01",
    toastCount === 1,
    `a confirmation toast reports the permissions reaching both bench workspaces ("${RESYNC_TOAST}")`,
    `matching toasts=${toastCount}, toast on screen=${JSON.stringify(anyToastText)}`,
  );

  // --- S004: what each bench workspace's settings file actually contains ----
  // Read off disk, not through an API: the case is about the file an agent will
  // read at startup, and only the file itself is evidence of that.
  const perBench = workspacePaths.map((workspacePath) => ({
    workspacePath,
    rules: readWorkspaceRules(workspacePath),
  }));
  const expected = {
    allow: [...SEEDED.allow, NEW_RULE],
    deny: SEEDED.deny,
    ask: SEEDED.ask,
  };
  const mapped = perBench.every(
    ({ rules }) =>
      rules !== null &&
      expected.allow.every((rule) => rules.allow.includes(rule)) &&
      expected.ask.every((rule) => rules.ask.includes(rule)) &&
      expected.deny.every((rule) => rules.deny.includes(rule)),
  );
  observe(
    STEPS.S004,
    "S004-O01",
    mapped,
    `every bench's ${SETTINGS_REL_PATH} maps the project's permissions onto allow/ask/deny arrays including the newly added rule: ${JSON.stringify(expected)}`,
    perBench
      .map(({ workspacePath, rules }) =>
        rules === null
          ? `${workspacePath}: no readable ${SETTINGS_REL_PATH}`
          : `${workspacePath}: ${JSON.stringify(rules)}`,
      )
      .join("; "),
  );

  // Containment (AP-NFR-001): the descriptor's `relPath` is resolved against the
  // BENCH WORKSPACE, so each bench gets its own file and the project repo, which
  // is the nearest directory an escaping relative path would land in, gets
  // nothing. Distinct paths are what rules out a single shared write target that
  // merely happened to satisfy the assertion above.
  const insideEachWorkspace = perBench.every(({ workspacePath }) =>
    fs.existsSync(path.join(workspacePath, SETTINGS_REL_PATH)),
  );
  const distinctTargets = new Set(perBench.map(({ workspacePath }) => workspacePath)).size === 2;
  const repoUntouched = !fs.existsSync(path.join(repoPath, SETTINGS_REL_PATH));
  observe(
    STEPS.S004,
    "S004-O02",
    insideEachWorkspace && distinctTargets && repoUntouched,
    `the write is confined to each bench workspace: one ${SETTINGS_REL_PATH} per bench and none in the project repo (${repoPath})`,
    `per-workspace files=${insideEachWorkspace}, distinct workspaces=${distinctTargets}, repo clean=${repoUntouched}`,
  );
});
