import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { MarketplaceListing, PluginRecord } from "@roubo/shared";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";
import { AGENT_ARGV_LOG_PATH, clearCapturedArgv, readCapturedArgv } from "./_support/argv-log.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-002".
const observe = makeObserve("AP-TC-002");

// AP-TC-002 (#525, AP-WU-024) - E2E: install an agent plugin, configure app
// defaults, override in a project, and verify effective config.
//
// The integration-level drift guard for the AP-US-001 / AP-US-002 journey,
// spanning the slices this unit is blocked by (#506, #507, #508, #509, #510,
// #513, #514, #522, #537). It walks the authoritative AP-TC-002 e2e_flow steps
// S001-S008 as ordered, attributable observations against the REAL built app. On
// divergence each observation routes through the FR-020 failure-output contract
// (see ../component-plugins/_support/step-runner.ts): the failure reports which
// step diverged, the expected-vs-actual, and the owning slice issue(s).
//
// HOW THE CLAUDE CODE PLUGIN PRECONDITION IS MET. The shipping plugin lives in
// the sibling `roubo-plugins` repo and builds against the published SDK, so
// roubo's e2e suite cannot depend on it. Instead an agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/claude-code/ takes the `claude-code` id, exactly
// as the `github-com` / `ghe` overlays take theirs. Its `configSchema` is copied
// verbatim from the real manifest, so both the AI Agents card and the project
// Agent overrides rows render the real Model / Effort / Mode selects and the real
// Additional CLI arguments field, and its `translateLaunch` mirrors the real
// `buildArgs` + `tokenize` ordering. This is the same precondition the AP-TC-087
// guard (claude-config-launch-journey.spec.ts) is built on.
//
// THE PROJECT IS A FIXTURE, NOT `roubo-development`. AP-TC-002's third
// precondition names the real `roubo-development` project. The harness has no
// such registration and must not depend on the developer's own machine state, so
// this walks the journey against a fixture project registered through
// `/test/__register-fixture-project`. Cosmetic: nothing in the journey depends on
// which project it is, only that overrides are stored and resolved per project.
//
// THREE RECONCILIATIONS against the literal AP-TC-002 script, all deliberate and
// all asserting SHIPPED behaviour (the objective is a guard that PASSES against
// the integrated system), in the style of
// ../e2e-flow/declared-source-consent-install-journey.spec.ts:
//
//   1. S001-O01 names "an Installed section and a Marketplace section" on one
//      screen. The shipped AI Agents screen
//      (client/src/components/settings/agents/AgentsTab.tsx) renders an Installed
//      region only, and its empty state points at the Marketplace, which is a
//      SIBLING settings tab carrying an `agent` kind filter chip. Reconciled to
//      the two surfaces as shipped: the Installed region exists on Settings > AI
//      Agents, AND Settings > Marketplace lists agent-kind plugins under its
//      agent filter.
//
//   2. S002 / S003 name clicking Install on the Claude Code marketplace card,
//      integrity-verifying the downloaded package, and approving a consent
//      prompt. Neither half is drivable here. Under ROUBO_E2E the first-party
//      catalog is an INJECTED fixture (server/services/catalog-client.ts,
//      E2E_FIXTURE_ENTRIES) whose one agent-kind entry is already installed as a
//      bundled overlay, so `marketplace-card-install` never renders for an agent
//      and only `marketplace-card-installed` does; and that entry's `source` is a
//      git clone of this repository carrying a PLACEHOLDER digest, so driving the
//      real install would need network and could never pass digest verification.
//      No `/test/__*` seam serves a downloadable agent artifact. Reconciled to the
//      integrated boundaries that do exist:
//        - the agent-kind listing the card renders from carries the pinned
//          `sha256-` integrity digest the installer verifies before commit (the
//          FIELD is asserted, not a real artifact verification);
//        - the consent gate is real and enumerates exactly the runtime privileges
//          the manifest declares (GET /api/plugins/claude-code/consent);
//        - approving it (POST .../consent) records the consent and is what makes
//          the agent resolvable at all: `resolveAgent` refuses an unconsented
//          agent, so an un-approved prompt leaves every downstream step dead.
//      The real download-verify-consent-commit composition for an AGENT-kind
//      marketplace entry is covered in-process by
//      server/services/marketplace-agent-kind-journey.e2e.test.ts (AP-TC-117,
//      AP-TC-120, AP-TC-122), and the consent modal's rendered surface by
//      client/src/components/marketplace/MarketplaceConsentModal.test.tsx and its
//      a11y sibling. This guard deliberately does not restate either.
//
//   3. S008-O02 expects the preview to render as
//      `claude --model sonnet --effort high --permission-mode plan`. No host
//      surface renders that string, and none may: `lint:agent-guard` (AP-NFR-006)
//      fails the build if `server/` or `shared/` assembles a native agent CLI
//      flag. The shipped effective preview
//      (client/src/components/project-settings/AgentOverridesSection.tsx) renders
//      the resolved CONFIG, `model=sonnet, effort=high, mode=plan`, which S008-O01
//      asserts. S008-O02 is reconciled to the stronger evidence the harness can
//      produce: the REAL argv the spawned CLI received, read from the stub's argv
//      log (./_support/argv-log.ts), which proves the effective configuration
//      actually reaches the child as `--model sonnet --effort high
//      --permission-mode plan` rather than merely being rendered.
//
// PARTIAL CIRCULARITY, stated plainly: because the overlay implements the argv
// mapping, this guard cannot prove the real plugin's `buildArgs`. That mapping is
// unit-covered in roubo-plugins. What this guard proves is the HOST-side
// integrated path: app-level defaults persisted from the AI Agents form, project
// overrides overlaid per field on top of them, and the resulting effective
// configuration reaching the spawned CLI as separate argv tokens.

const PROJECT_ID = "ap-tc-002-install-configure-override";
const BENCH_ID = 1;

// The overlay's manifest declares no permission category (empty network hosts,
// empty credential slots, empty filesystem paths, `processes: false`), so the
// consent gate is satisfied by an empty acknowledgement set, and "no additional
// privileges granted" (S003-O01) is exactly that set being empty.
const EXPECTED_PRIVILEGES =
  "network.hosts=[], credentials.slots=[], filesystem.paths=[], processes=false, ports=false, docker=false";

// The application-level defaults AP-TC-002 S005 asks for.
const APP_DEFAULTS = { model: "opus", effort: "high", mode: "plan" } as const;
// The single project-level override AP-TC-002 S007 asks for; Effort and Mode are
// left inheriting.
const OVERRIDE_MODEL = "sonnet";
// S008-O01: app defaults overlaid by project overrides, as the effective preview
// renders them.
const EXPECTED_EFFECTIVE = "model=sonnet, effort=high, mode=plan";
// S008-O02 (reconciled): the same effective configuration as the argv the spawned
// CLI actually received.
const EXPECTED_ARGV_PREFIX = ["--model", "sonnet", "--effort", "high", "--permission-mode", "plan"];

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  kind: { issue: 506, title: "Widen the plugin kind discriminator to accept kind: agent" },
  sdk: {
    issue: 507,
    title: "Add the agent plugin contract to the SDK and load agent plugins through the runtime",
  },
  appConfig: {
    issue: 508,
    title: "App-level agent configuration and the AI Agents settings screen",
  },
  projectConfig: {
    issue: 509,
    title: "Project-level agent config overrides with effective-config resolution",
  },
  launch: {
    issue: 510,
    title: "Core agent launch pipeline: PTY sessions from declarative launch descriptors",
  },
  notifications: {
    issue: 513,
    title: "Agent session notifications: hook-driven and quiescence waiting/exited detection",
  },
  permissions: {
    issue: 514,
    title: "Generalized agent permissions with per-agent mapping and bench resync",
  },
  marketplace: { issue: 522, title: "Marketplace distribution for agent-kind plugins" },
  gate: { issue: 537, title: "Verify gate: Phase 2 Claude Parity & Launch Surfaces" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Navigate to Settings > AI Agents",
    owners: [SLICE.appConfig, SLICE.marketplace],
  },
  S002: {
    id: "S002",
    instruction: "In the Marketplace section, click Install on the Claude Code agent plugin",
    owners: [SLICE.marketplace, SLICE.kind],
  },
  S003: {
    id: "S003",
    instruction: "Approve the consent prompt",
    owners: [SLICE.sdk, SLICE.permissions, SLICE.appConfig],
  },
  S004: {
    id: "S004",
    instruction: "Click Configure on the Claude Code plugin card",
    owners: [SLICE.appConfig],
  },
  S005: {
    id: "S005",
    instruction: "Set Model=opus, Effort=high, Mode=plan and click Save defaults",
    owners: [SLICE.appConfig],
  },
  S006: {
    id: "S006",
    instruction: "Navigate to Project > settings and read the Agent overrides section",
    owners: [SLICE.projectConfig],
  },
  S007: {
    id: "S007",
    instruction:
      "Toggle the Model override on, set it to sonnet, and leave Effort and Mode inheriting",
    owners: [SLICE.projectConfig],
  },
  S008: {
    id: "S008",
    instruction: "Read the effective launch preview for the project",
    owners: [SLICE.projectConfig, SLICE.launch, SLICE.notifications, SLICE.gate],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  agentPluginId?: string;
}

interface DeclaredPermissions {
  network?: { hosts?: unknown[] };
  credentials?: { slots?: unknown[] };
  filesystem?: { paths?: unknown[] };
  processes?: boolean;
  ports?: boolean;
  docker?: boolean;
}

/**
 * The declared privilege set as one comparable line. Both S002-O01 (the prompt
 * lists the runtime privileges requested) and S003-O01 (no ADDITIONAL privileges
 * granted) are statements about this set, so they are asserted against one
 * rendering of it rather than two hand-rolled comparisons that could disagree.
 */
function summarisePrivileges(permissions: DeclaredPermissions | undefined): string {
  return [
    `network.hosts=${JSON.stringify(permissions?.network?.hosts ?? [])}`,
    `credentials.slots=${JSON.stringify(permissions?.credentials?.slots ?? [])}`,
    `filesystem.paths=${JSON.stringify(permissions?.filesystem?.paths ?? [])}`,
    `processes=${permissions?.processes === true}`,
    `ports=${permissions?.ports === true}`,
    `docker=${permissions?.docker === true}`,
  ].join(", ");
}

/** Pick one closed-choice control on a schema-driven form by its option label. */
async function selectChoice(
  page: Page,
  scope: Locator,
  field: string,
  label: string,
): Promise<void> {
  // React Aria's Select renders the trigger as a Button inside the testid'd root
  // and portals its ListBox to the document body, so the option is located at
  // page level rather than within the field.
  await scope.getByTestId(`config-field-${field}`).locator("button").click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function listSessions(request: APIRequestContext): Promise<TerminalSessionEntry[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`);
  expect(res.status(), "GET terminals").toBe(200);
  // The route answers with a bare array of TerminalSession, not an envelope.
  const body = (await res.json()) as TerminalSessionEntry[];
  return Array.isArray(body) ? body : [];
}

/**
 * Drop every terminal session on this spec's bench.
 *
 * Live PTY sessions are held in a module-level map keyed by project + bench and
 * are NOT among the things `/test/__reset` clears, so a session opened by an
 * earlier run of this spec (against the same fixed project id and bench id)
 * would still be listed here. Clearing them at both ends of the test is what
 * keeps "a new session opened" observable rather than shadowed by a leftover
 * (NFR-018), and keeps the idling stub from outliving the run.
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // App-level agent defaults live in `~/.roubo-dev/<checkout>/agents/_global/` and
  // are NOT among the files /test/__reset truncates, so a previous run's saved
  // Claude defaults would survive into this one and leave the form already at the
  // target values. Clearing them through the real API is what makes S005 observe
  // a genuine edit-and-save on every run (NFR-018).
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);

  // Pin the default agent rather than leaning on the "exactly one available
  // agent" fallback: the second agent overlay (codex-cli) is force-disabled by
  // every reset today, but a spec that consented and enabled it would silently
  // move S008's launch onto a different agent.
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);

  // Precondition: "A project is registered", with an active bench. A seeded bench
  // carries a real tmpdir workspace, which is all `isBenchOperable` asks of it, so
  // the journey needs no worktree provisioning and no bench start.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 525,
            integrationId: "github-com",
            externalId: "525",
            title: "Install an agent plugin, configure app defaults, override in a project",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  // Project overrides live in `~/.roubo-dev/<checkout>/agents/<projectId>/` and,
  // like the app-level defaults, outlive /test/__reset. Cleared AFTER registration
  // because the route 404s for an unregistered project.
  const clearOverrides = await request.put(
    `/api/projects/${PROJECT_ID}/agents/${CLAUDE_PLUGIN_ID}/config`,
    { data: { config: {} } },
  );
  expect(clearOverrides.status(), "PUT project agent overrides (clear)").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  // Hand the environment back: `jigs.defaultAgentPluginId` lives in settings.json,
  // which /test/__reset does not clear, so a pin left behind here would silently
  // satisfy the next spec's precondition (NFR-018).
  await setDefaultAgent(request, null);
  clearCapturedArgv();
});

test("AP-TC-002: install, configure app defaults, override in a project, verify effective config (S001-S008)", async ({
  page,
  request,
}) => {
  // --- S001: Settings > AI Agents, and the marketplace's agent listings -------
  const settingsRes = await page.goto("/settings#ai-agents");
  expect(settingsRes?.status(), "GET /settings").toBe(200);
  const agentsTab = page.getByRole("tab", { name: "AI Agents" });
  await expect(agentsTab, "the AI Agents settings tab renders").toBeVisible();
  await agentsTab.click();

  const installed = page.getByRole("region", { name: "Installed agent plugins" });
  // A TOLERATED wait, not an assertion. Every condition an observation covers has
  // to fail through `observe` so the FR-020 block names the diverged step, the
  // expected-vs-actual and the owning slice; a bare `expect(...).toBeVisible()`
  // here would pre-empt S001-O01 and fail with an unattributed Playwright
  // timeout instead. The count is then read ONCE, so the boolean and the
  // reported actual can never disagree.
  await installed.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const installedCount = await installed.count();
  observe(
    STEPS.S001,
    "S001-O01",
    installedCount === 1,
    "the AI Agents screen renders an Installed region",
    `Installed region count=${installedCount}`,
  );

  // Reconciliation 1: the Marketplace is a sibling settings tab, not a section of
  // this screen. `exact` matters, because a "Marketplaces" (source registry) tab
  // sits beside it.
  const marketplaceTab = page.getByRole("tab", { name: "Marketplace", exact: true });
  await expect(marketplaceTab, "the Marketplace settings tab renders").toBeVisible();
  await marketplaceTab.click();
  const agentFilter = page.getByTestId("marketplace-filter-agent");
  await agentFilter.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const filterCount = await agentFilter.count();
  if (filterCount === 1) await agentFilter.click();
  const agentCards = page.locator('[data-testid="marketplace-card"]');
  await agentCards
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  // Wait for the FILTERED render to land before reading the ids. The catalog
  // query holds `placeholderData: keepPreviousData` (client/src/hooks/useMarketplace.ts),
  // deliberately, so the chip row survives the refetch, which means the grid keeps
  // showing the previous unfiltered cards while the `kind=agent` request is in
  // flight. Reading straight after the click would sample that stale grid and
  // report a false S001 divergence. The kind pill is used ONLY as this settle
  // signal; the assertion itself stays the server cross-check below, since the
  // agent filter is a SERVER-side query param.
  await page
    .locator('[data-testid="marketplace-card-kind"]:not([data-kind="agent"])')
    .first()
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => {});
  const agentCardIds = await agentCards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-plugin-id") ?? "(unnamed)"),
  );
  // Cross-check the rendered ids against the agent-kind listing the server
  // actually serves. Counting cards alone would not do it: the injected fixture
  // catalog holds one entry per kind, so a regression that ignored `kind` would
  // render all three and still satisfy "at least one card".
  const catalogRes = await request.get("/api/marketplace/plugins?kind=agent");
  expect(catalogRes.status(), "GET /api/marketplace/plugins?kind=agent").toBe(200);
  const catalog = (await catalogRes.json()) as { listings?: MarketplaceListing[] };
  const agentListings = catalog.listings ?? [];
  const agentListingIds = agentListings.map((listing) => listing.id);
  observe(
    STEPS.S001,
    "S001-O01",
    filterCount === 1 &&
      agentCardIds.length >= 1 &&
      agentCardIds.every((id) => agentListingIds.includes(id)),
    "the Marketplace lists agent-kind plugins, and only agent-kind plugins, under its agent filter",
    `agent filter count=${filterCount}, listed agent cards=${JSON.stringify(agentCardIds)}, agent-kind listings=${JSON.stringify(agentListingIds)}`,
  );

  // --- S002: the install surface and the consent prompt it gates on ----------
  // Reconciliation 2a: the digest the installer verifies before commit is carried
  // on the listing the card renders from (fetched above, for S001). Under the
  // harness that digest is the fixture's placeholder, so this asserts the pinned
  // FIELD is present and well-formed, not that a real artifact verified.
  const digestPinned =
    agentListings.length >= 1 &&
    agentListings.every(
      (listing) =>
        listing.kind === "agent" && /^sha256-[0-9a-f]{64}$/.test(listing.integrity ?? ""),
    );
  observe(
    STEPS.S002,
    "S002-O01",
    digestPinned,
    "every agent-kind marketplace listing carries the pinned sha256 integrity digest the installer verifies",
    agentListings.length === 0
      ? "the marketplace served no agent-kind listing"
      : JSON.stringify(
          agentListings.map((l) => `${l.id}: kind=${l.kind}, integrity=${l.integrity}`),
        ),
  );

  // Reconciliation 2b: the consent prompt's data contract. It lists exactly the
  // runtime privileges the plugin's manifest declares, and marks the plugin
  // first-party (so it runs under the existing bundled-plugin sandbox rather than
  // being labelled unsandboxed).
  const consentRes = await request.get(`/api/plugins/${CLAUDE_PLUGIN_ID}/consent`);
  expect(consentRes.status(), "GET /api/plugins/claude-code/consent").toBe(200);
  const consentBody = (await consentRes.json()) as {
    declared?: DeclaredPermissions;
    firstParty?: boolean;
  };
  const declared = summarisePrivileges(consentBody.declared);
  observe(
    STEPS.S002,
    "S002-O01",
    declared === EXPECTED_PRIVILEGES && consentBody.firstParty === true,
    `the consent gate lists the runtime privileges the ${CLAUDE_AGENT_NAME} manifest declares (${EXPECTED_PRIVILEGES}) and marks it first-party`,
    `declared=${declared}, firstParty=${consentBody.firstParty}`,
  );

  // --- S003: approving the prompt makes the agent installed, enabled, usable --
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID]);

  const pluginsRes = await request.get("/api/plugins");
  expect(pluginsRes.status(), "GET /api/plugins").toBe(200);
  const pluginsBody = (await pluginsRes.json()) as { plugins?: PluginRecord[] };
  const record = (pluginsBody.plugins ?? []).find((p) => p.id === CLAUDE_PLUGIN_ID);
  const grantedAfterConsent = summarisePrivileges(
    record?.manifest?.permissions as DeclaredPermissions | undefined,
  );
  observe(
    STEPS.S003,
    "S003-O01",
    record !== undefined &&
      record.status === "enabled" &&
      record.source === "bundled" &&
      grantedAfterConsent === EXPECTED_PRIVILEGES,
    `${CLAUDE_AGENT_NAME} is installed and enabled, runs under the existing bundled-plugin sandbox, and holds no privileges beyond the ones it declared (${EXPECTED_PRIVILEGES})`,
    record === undefined
      ? "no installed plugin record for claude-code"
      : `status=${record.status}, source=${record.source}, permissions=${grantedAfterConsent}`,
  );

  // Consent was recorded through the API, so the already-mounted screen has to be
  // re-read before the card can reflect it. A reload, not a `goto`: the URL never
  // changed (the tab switch above is client-side), so re-navigating to it would be
  // a no-op that returns no response.
  const reloaded = await page.reload();
  expect(reloaded?.status(), "reload /settings after consent").toBe(200);
  await page.getByRole("tab", { name: "AI Agents" }).click();

  const card = installed.getByTestId(`agent-plugin-card-${CLAUDE_PLUGIN_ID}`);
  const disclosure = page.getByTestId(`agent-configure-${CLAUDE_PLUGIN_ID}`);
  await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const cardCount = await card.count();
  const disclosureCount = await disclosure.count();
  const unavailableCount = await page.getByTestId(`agent-unavailable-${CLAUDE_PLUGIN_ID}`).count();
  observe(
    STEPS.S003,
    "S003-O02",
    cardCount === 1 && disclosureCount === 1 && unavailableCount === 0,
    `a configuration card for ${CLAUDE_AGENT_NAME} appears under Installed with a Configure action`,
    `card count=${cardCount}, configure action count=${disclosureCount}, unavailable notice count=${unavailableCount}`,
  );

  // --- S004: Configure expands the schema-driven config form -----------------
  // The card mounts with its disclosure OPEN (the per-plugin config is the whole
  // point of the screen), so collapse it first and then press Configure. That way
  // the step really is "click Configure" and the observation really is the form
  // appearing, rather than a form that was already there.
  if ((await disclosure.textContent())?.includes("Hide")) {
    await disclosure.click();
    await expect(page.getByTestId(`agent-config-form-${CLAUDE_PLUGIN_ID}`)).toBeHidden();
  }
  await expect(disclosure, "the collapsed disclosure offers Configure").toHaveText(/Configure/);
  await disclosure.click();

  const form = page.getByTestId(`agent-config-form-${CLAUDE_PLUGIN_ID}`);
  // Tolerated wait again: a form that never expands leaves all four field counts
  // at 0, which S004-O01 below reports as an attributed divergence.
  await form.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const fieldCounts = {
    model: await form.getByTestId("config-field-model").count(),
    effort: await form.getByTestId("config-field-effort").count(),
    mode: await form.getByTestId("config-field-mode").count(),
    extraArgs: await form.getByTestId("config-field-extraArgs").count(),
  };
  observe(
    STEPS.S004,
    "S004-O01",
    Object.values(fieldCounts).every((count) => count === 1),
    "an application-level settings form renders from the plugin's declared config schema, showing Model, Effort and Mode fields plus an additional-arguments field",
    `model=${fieldCounts.model}, effort=${fieldCounts.effort}, mode=${fieldCounts.mode}, extraArgs=${fieldCounts.extraArgs}`,
  );

  // --- S005: Model=opus, Effort=high, Mode=plan, then Save defaults ----------
  await selectChoice(page, form, "model", "Opus");
  await selectChoice(page, form, "effort", "High");
  await selectChoice(page, form, "mode", "Plan");
  await expect(form.getByTestId("config-field-model")).toContainText("Opus");
  await expect(form.getByTestId("config-field-effort")).toContainText("High");
  await expect(form.getByTestId("config-field-mode")).toContainText("Plan");

  const save = page.getByTestId(`agent-config-save-${CLAUDE_PLUGIN_ID}`);
  await expect(save, "Save defaults is enabled once the draft diverges").toBeEnabled();
  await save.click();
  const savedNotice = form.getByText("Saved.");
  await savedNotice.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const savedNoticeCount = await savedNotice.count();

  // Read the persisted app-level record back through the real API rather than
  // trusting the form's own optimistic state.
  const configRes = await request.get(`/api/agents/${CLAUDE_PLUGIN_ID}/config`);
  expect(configRes.status(), "GET /api/agents/claude-code/config").toBe(200);
  const persisted = ((await configRes.json()) as { config?: Record<string, unknown> }).config ?? {};
  const persistedMatches = (Object.keys(APP_DEFAULTS) as (keyof typeof APP_DEFAULTS)[]).every(
    (key) => persisted[key] === APP_DEFAULTS[key],
  );
  observe(
    STEPS.S005,
    "S005-O01",
    persistedMatches && savedNoticeCount === 1,
    `the application-level defaults persist as ${JSON.stringify(APP_DEFAULTS)} and a save confirmation is shown`,
    `persisted config=${JSON.stringify(persisted)}, save confirmation count=${savedNoticeCount}`,
  );

  // --- S006: the project's Agent overrides section ---------------------------
  const projectRes = await page.goto(`/projects/${PROJECT_ID}/settings`);
  expect(projectRes?.status(), "GET the project settings page").toBe(200);

  const overrideCard = page.getByTestId(`project-agent-card-${CLAUDE_PLUGIN_ID}`);
  await overrideCard.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

  const rowKeys = ["model", "effort", "mode", "extraArgs"] as const;
  const rows: Record<string, { toggles: number; appDefault: string; inherits: number }> = {};
  for (const key of rowKeys) {
    const appDefault = page.getByTestId(`project-agent-app-default-${CLAUDE_PLUGIN_ID}-${key}`);
    rows[key] = {
      toggles: await page.getByTestId(`project-agent-toggle-${CLAUDE_PLUGIN_ID}-${key}`).count(),
      appDefault: (await appDefault.count()) === 1 ? ((await appDefault.textContent()) ?? "") : "",
      inherits: await page.getByTestId(`project-agent-inherits-${CLAUDE_PLUGIN_ID}-${key}`).count(),
    };
  }
  const everyRowWired = rowKeys.every((key) => rows[key].toggles === 1 && rows[key].inherits === 1);
  const appDefaultsShown =
    rows.model.appDefault.includes(APP_DEFAULTS.model) &&
    rows.effort.appDefault.includes(APP_DEFAULTS.effort) &&
    rows.mode.appDefault.includes(APP_DEFAULTS.mode);
  observe(
    STEPS.S006,
    "S006-O01",
    everyRowWired && appDefaultsShown,
    `the Agent overrides section for ${CLAUDE_AGENT_NAME} lists each field with an inherit toggle and shows the current app default beside each row`,
    JSON.stringify(rows),
  );

  // --- S007: override Model=sonnet, leave Effort and Mode inheriting ----------
  await page.getByTestId(`project-agent-toggle-${CLAUDE_PLUGIN_ID}-model`).click();
  const modelRow = page.getByTestId(`project-agent-field-${CLAUDE_PLUGIN_ID}-model`);
  await modelRow.getByTestId("config-field-model").waitFor({ state: "visible", timeout: 15_000 });
  await selectChoice(page, modelRow, "model", "Sonnet");
  await expect(modelRow.getByTestId("config-field-model")).toContainText("Sonnet");

  const projectSave = page.getByTestId(`project-agent-save-${CLAUDE_PLUGIN_ID}`);
  await expect(projectSave, "Save overrides is enabled once the draft diverges").toBeEnabled();
  await projectSave.click();
  await overrideCard
    .getByText("Saved.")
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});

  const modelOverrideShown = await modelRow.getByTestId("config-field-model").textContent();
  const effortInherits = await page
    .getByTestId(`project-agent-inherits-${CLAUDE_PLUGIN_ID}-effort`)
    .count();
  const modeInherits = await page
    .getByTestId(`project-agent-inherits-${CLAUDE_PLUGIN_ID}-mode`)
    .count();
  const agentsRes = await request.get(`/api/projects/${PROJECT_ID}/agents`);
  expect(agentsRes.status(), "GET /api/projects/:id/agents").toBe(200);
  const projectAgents = (await agentsRes.json()) as {
    agents?: {
      id: string;
      overrides?: Record<string, unknown>;
      effective?: Record<string, unknown>;
    }[];
  };
  const claudeState = (projectAgents.agents ?? []).find((a) => a.id === CLAUDE_PLUGIN_ID);
  const storedOverrides = claudeState?.overrides ?? {};
  observe(
    STEPS.S007,
    "S007-O01",
    (modelOverrideShown ?? "").includes("Sonnet") &&
      effortInherits === 1 &&
      modeInherits === 1 &&
      JSON.stringify(storedOverrides) === JSON.stringify({ model: OVERRIDE_MODEL }),
    `the Model row shows the override value ${OVERRIDE_MODEL}; the Effort and Mode rows show 'inherits' and stay out of the stored override subset`,
    `model row=${JSON.stringify(modelOverrideShown)}, effort inherits count=${effortInherits}, mode inherits count=${modeInherits}, stored overrides=${JSON.stringify(storedOverrides)}`,
  );

  // --- S008-O01: the effective launch preview --------------------------------
  const effectivePreview = page.getByTestId(`project-agent-effective-${CLAUDE_PLUGIN_ID}`);
  await effectivePreview.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const previewText =
    (await effectivePreview.count()) === 1 ? ((await effectivePreview.textContent()) ?? "") : "";
  const resolvedEffective = claudeState?.effective ?? {};
  observe(
    STEPS.S008,
    "S008-O01",
    previewText.includes(EXPECTED_EFFECTIVE) &&
      resolvedEffective.model === OVERRIDE_MODEL &&
      resolvedEffective.effort === APP_DEFAULTS.effort &&
      resolvedEffective.mode === APP_DEFAULTS.mode,
    `the effective configuration equals app defaults overlaid by project overrides: ${EXPECTED_EFFECTIVE}`,
    `rendered preview=${JSON.stringify(previewText)}, resolved effective=${JSON.stringify(resolvedEffective)}`,
  );

  // --- S008-O02 (reconciled): the argv the spawned CLI actually received ------
  const benchRes = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(benchRes?.status(), "GET the bench detail page").toBe(200);
  const terminalTab = page.getByRole("tab", { name: "Terminal" });
  await expect(terminalTab, "the bench detail view has a Terminal tab").toBeVisible();
  await terminalTab.click();

  // The primary segment's accessible name IS the resolved default agent
  // ("Launch <agentName>"), so finding it by that name is what proves the button
  // targets Claude Code rather than merely existing.
  const launchButton = page.getByRole("button", { name: `Launch ${CLAUDE_AGENT_NAME}` });
  // Tolerated wait, for the same reason as every other wait here: a button that
  // never appears, or one whose accessible name names a different default agent,
  // has to be reported THROUGH `observe` so the FR-020 block names S008, the
  // expected-vs-actual and the owning slice, rather than throwing an unattributed
  // Playwright timeout. The count is folded into S008-O02 below.
  await launchButton.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const launchCount = await launchButton.count();
  // Unlink first so the argv read below can only be this launch's.
  clearCapturedArgv();
  if (launchCount === 1) await launchButton.click();

  let live: TerminalSessionEntry | undefined;
  for (let attempt = 0; attempt < 40 && live === undefined; attempt += 1) {
    live = (await listSessions(request)).find(
      (session) => session.agentPluginId === CLAUDE_PLUGIN_ID && session.status === "live",
    );
    if (live === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  let argv: string[] | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    argv = readCapturedArgv();
    if (argv !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const captured = argv ?? [];
  // `--session-id <uuid>` is the descriptor's stable argv tail, and the host
  // appends any initial prompt after it, so everything before it is exactly the
  // generated-flags region the effective configuration produces.
  const sessionIdIndex = captured.indexOf("--session-id");
  observe(
    STEPS.S008,
    "S008-O02",
    launchCount === 1 &&
      argv !== null &&
      sessionIdIndex >= 0 &&
      JSON.stringify(captured.slice(0, sessionIdIndex)) === JSON.stringify(EXPECTED_ARGV_PREFIX),
    `the effective configuration reaches the spawned CLI as ${EXPECTED_ARGV_PREFIX.join(" ")} (the preview's ${EXPECTED_EFFECTIVE}, as real argv read from ${AGENT_ARGV_LOG_PATH})`,
    launchCount !== 1
      ? `no Launch ${CLAUDE_AGENT_NAME} button on the bench Terminal tab (count=${launchCount}), so nothing was spawned`
      : argv === null
        ? "no argv was captured: the child never ran"
        : sessionIdIndex < 0
          ? `no --session-id tail in ${JSON.stringify(captured)}`
          : JSON.stringify(captured.slice(0, sessionIdIndex)),
  );
});
