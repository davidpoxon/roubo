import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { MarketplaceListing, PluginRecord } from "@roubo/shared";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  clearAgentConfig,
  consentAgent,
  disablePlugin,
  enablePlugin,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-115".
const observe = makeObserve("AP-TC-115");

// AP-TC-115 (#534, AP-WU-033) - E2E: install an agent plugin from the
// marketplace end to end and see it in launch surfaces.
//
// The integration-level drift guard for the AP-US-011 journey (AP-FR-022,
// AP-NFR-001, AP-NFR-006), spanning the slices this unit is blocked by (#507,
// #510, #513, #514, #519, #521, #522, #537). It walks the authoritative
// AP-TC-115 e2e_flow steps S001-S007 as ordered, attributable observations
// against the REAL built app. On divergence each observation routes through the
// FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice issue(s).
//
// HOW THE GEMINI CLI PRECONDITION IS MET. No Gemini agent plugin exists in
// roubo-plugins/plugins/, and the harness has no seam serving a downloadable,
// digest-pinned artifact, so the literal click-Install-and-download leg is not
// drivable. An agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/gemini-cli/ takes the `gemini-cli` id instead,
// exactly as the `claude-code` and `codex-cli` overlays take theirs, with a
// matching agent-kind entry injected into the e2e catalog fixture
// (server/services/catalog-client.ts, E2E_FIXTURE_ENTRIES) so the Marketplace
// renders a real Gemini CLI listing. The overlay's declared compatibility window
// is S002's worked example verbatim (floor 0.9.0, tested <= 1.2.3), and its
// probe and launch descriptor both name `roubo-e2e-gemini-stub`, deliberately
// NOT `gemini`, so a real install cannot win the PATH lookup.
//
// FOUR RECONCILIATIONS against the literal AP-TC-115 script, all deliberate and
// all asserting SHIPPED behaviour (the objective is a guard that PASSES against
// the integrated system), in the style of ./install-configure-override-journey.spec.ts
// (AP-TC-002), which hit the same marketplace wall:
//
//   1. S001 names "the Marketplace section of Settings > AI Agents". The shipped
//      AI Agents screen (client/src/components/settings/agents/AgentsTab.tsx)
//      renders an Installed region only, and its empty state points at the
//      Marketplace, which is a SIBLING settings tab carrying an `agent` kind
//      filter chip. Reconciled to the two surfaces as shipped: the Installed
//      region on Settings > AI Agents, then Settings > Marketplace under its
//      agent filter.
//
//   2. S001-O01 expects the listing to carry an Install BUTTON. Under the
//      harness the Gemini CLI overlay is discovered as a bundled plugin, so the
//      listing is annotated `installed: true` (server/services/marketplace.ts,
//      `annotate`) and MarketplaceCard renders the "Installed" affordance rather
//      than the Install button, by design. Reconciled to the install affordance
//      the card renders for this state: exactly one of the two is present, and
//      it is the installed form. What the case is really asking, that the agent
//      listing is present and actionable from the Marketplace, is what is
//      asserted.
//
//   3. S003 / S004 name clicking Install, a consent prompt, and the downloaded
//      package passing integrity verification. Neither the download nor the
//      verification is drivable here: no `/test/__*` seam serves an agent
//      artifact, and the injected fixture catalog's sources carry PLACEHOLDER
//      digests, so a real install would need network and could never verify.
//      Reconciled to the integrated boundaries that do exist:
//        - the consent gate is REAL and enumerates exactly the runtime
//          privileges the manifest declares (GET /api/plugins/gemini-cli/consent),
//          and approving it (POST .../consent) is what makes the agent
//          resolvable at all: `resolveAgent` refuses an unconsented agent, so an
//          un-approved prompt leaves every downstream step dead;
//        - the listing carries the pinned `sha256-` integrity digest the
//          installer verifies before commit (the FIELD is asserted, not a real
//          artifact verification).
//      The real download-verify-consent-commit composition for an AGENT-kind
//      marketplace entry is covered in-process by
//      server/services/marketplace-agent-kind-journey.e2e.test.ts (AP-TC-117,
//      AP-TC-120, AP-TC-122), against a gemini-cli fixture of its own. This
//      guard deliberately does not restate it.
//
//      The "moves into the Installed section" half of S004 IS driven: the
//      overlay is force-disabled by every /test/__reset
//      (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts), so before
//      consent its card carries the unavailable notice, and consenting plus
//      enabling is what clears it. The before/after pair is read on the real
//      screen.
//
//   4. S005-O02 expects the plugin status to show "Configured". No such status
//      ships: AgentPluginCard renders `Ready` for an available agent and
//      AgentConfigForm renders a "Saved." confirmation after a successful save.
//      Reconciled to those two, plus the durable evidence behind them: the
//      defaults read back through GET /api/agents/gemini-cli/config.
//
// PARTIAL CIRCULARITY, stated plainly and inherited from the sibling guards:
// because the overlay implements its own launch mapping, this proves the
// HOST-side integrated path (a marketplace agent listing, its consent gate, the
// AI Agents form persisting app-level defaults, and the launch menu spawning a
// PTY through that plugin) and not a real Gemini CLI plugin's argv mapping.
// There is no shipped Gemini plugin to prove that against. Argv evidence is the
// AP-TC-087 guard's job (claude-config-launch-journey.spec.ts), and this
// overlay's stub deliberately never writes the shared argv log.

const PLUGIN_ID = "gemini-cli";
const AGENT_NAME = "Gemini CLI";
const PROJECT_ID = "ap-tc-115-marketplace-install-launch";
const BENCH_ID = 1;

/** The command the `gemini-cli` overlay's launch descriptor names. */
const AGENT_COMMAND = "roubo-e2e-gemini-stub";

/** The launch menu section every installed, available agent is listed under. */
const ALL_AGENTS_SECTION = "All agents";

// The compatibility window the overlay declares, which is AP-TC-115 S002's
// worked example verbatim.
const VERSION_FLOOR = "floor 0.9.0";
const VERSION_CEILING = "tested <= 1.2.3";

// The overlay's manifest declares no permission category (empty network hosts,
// empty credential slots, empty filesystem paths, `processes: false`), so the
// consent gate is satisfied by an empty acknowledgement set and the "declared
// capabilities" the prompt describes are exactly this set.
const EXPECTED_PRIVILEGES =
  "network.hosts=[], credentials.slots=[], filesystem.paths=[], processes=false, ports=false, docker=false";

// The launch defaults AP-TC-115 S005 asks for. The keys are the overlay's own
// (modelName / approval), deliberately not the claude-code overlay's
// model / effort / mode, so the page-wide `config-field-*` count the AP-TC-087
// guard reads cannot move.
const LAUNCH_DEFAULTS = { modelName: "gemini-2.5-pro", approval: "auto-edit" } as const;
const MODEL_OPTION_LABEL = "Gemini 2.5 Pro";
const APPROVAL_OPTION_LABEL = "Auto edit";

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  sdk: {
    issue: 507,
    title: "Add the agent plugin contract to the SDK and load agent plugins through the runtime",
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
  versionGate: { issue: 519, title: "Agent CLI version compatibility gate and surfacing" },
  removal: { issue: 521, title: "Remove the built-in Claude Code launch path from core" },
  marketplace: { issue: 522, title: "Marketplace distribution for agent-kind plugins" },
  gate: { issue: 537, title: "Verify gate: Phase 2 Claude Parity & Launch Surfaces" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open Settings > AI Agents and scroll to the Marketplace section",
    owners: [SLICE.marketplace],
  },
  S002: {
    id: "S002",
    instruction: "Read the compatibility metadata shown on the Gemini CLI listing",
    owners: [SLICE.marketplace, SLICE.versionGate],
  },
  S003: {
    id: "S003",
    instruction: "Click Install on the Gemini CLI listing",
    owners: [SLICE.marketplace, SLICE.permissions, SLICE.sdk],
  },
  S004: {
    id: "S004",
    instruction: "Review and accept the consent prompt",
    owners: [SLICE.marketplace, SLICE.sdk],
  },
  S005: {
    id: "S005",
    instruction:
      "Click Configure on the installed Gemini CLI plugin, set launch defaults, and Save",
    owners: [SLICE.sdk],
  },
  S006: {
    id: "S006",
    instruction: "Open a bench Terminal tab and open the agent launch menu",
    owners: [SLICE.launch, SLICE.removal],
  },
  S007: {
    id: "S007",
    instruction: "Launch Gemini CLI from the Terminal launch menu",
    owners: [SLICE.launch, SLICE.notifications, SLICE.gate],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  command?: string;
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
 * The declared privilege set as one comparable line, so the consent prompt's
 * contents (S003-O01) are asserted against one rendering of it rather than a
 * hand-rolled comparison per category.
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

/** Every agent-kind listing the marketplace actually serves. */
async function readAgentListings(request: APIRequestContext): Promise<MarketplaceListing[]> {
  const res = await request.get("/api/marketplace/plugins?kind=agent");
  expect(res.status(), "GET /api/marketplace/plugins?kind=agent").toBe(200);
  const body = (await res.json()) as { listings?: MarketplaceListing[] };
  return body.listings ?? [];
}

/**
 * Open the split button's grouped launch menu. With no sessions open the tab bar
 * and the empty state each render one chevron, so there are two identical
 * triggers; the first is the one in the tab bar.
 */
async function openLaunchMenu(page: Page): Promise<Locator> {
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await expect(trigger, "the Agent split button offers a launch menu").toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu");
  // A TOLERATED wait, not an assertion: a menu that never opens leaves the
  // observations below to report the divergence through the FR-020 block rather
  // than failing here as an unattributed Playwright timeout.
  await menu.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // The menu is data-INDEPENDENT: every MenuSection renders before the agent
  // inventory resolves, and the chevron that opens it is never disabled. So
  // waiting on the menu alone would let the rows below be read against an empty
  // "All agents" list. Wait for the first agent row too, also TOLERATED.
  await menu
    .getByTestId("launch-agent-item")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  return menu;
}

/**
 * The "All agents" row for one agent. Every row carries the same
 * `launch-agent-item` test id, so the row is identified by its accessible name,
 * which AgentItem builds as `<agent name>: <effective params or blocker>`.
 */
function allAgentsRow(page: Page, agentName: string): Locator {
  return page
    .getByRole("group", { name: ALL_AGENTS_SECTION })
    .getByRole("menuitem", { name: new RegExp(`^${agentName}:`) });
}

/** Select the AI Agents settings tab on an already-loaded settings page. */
async function selectAgentsTab(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "AI Agents" });
  await expect(tab, "the AI Agents settings tab renders").toBeVisible();
  await tab.click();
}

/** Navigate to the AI Agents settings screen. */
async function openAgentsTab(page: Page): Promise<void> {
  const res = await page.goto("/settings#ai-agents");
  expect(res?.status(), "GET /settings").toBe(200);
  await selectAgentsTab(page);
}

/**
 * Re-read the settings page after a state change made through the API.
 *
 * A reload, not a `goto`: the tab switches on this screen are client-side, so
 * the URL never changed and re-navigating to it would be a no-op that returns no
 * response.
 */
async function reloadAgentsTab(page: Page): Promise<void> {
  const reloaded = await page.reload();
  expect(reloaded?.status(), "reload /settings").toBe(200);
  await selectAgentsTab(page);
}

test.beforeEach(async ({ request }) => {
  // Every tolerated wait in this guard is time an observation is allowed to take
  // before it reports a divergence, and on a failing run they add up well past
  // the config's 30s per-test default: the ten 15s waits below, plus
  // `waitForAvailableAgents` and the S007 session poll (40 x 250ms each). An
  // S006 divergence alone spends 45s across `openLaunchMenu` and the row wait. A
  // budget that expired mid-step would abort the test before `observe` ran,
  // replacing the FR-020 attribution block with a bare unattributed timeout,
  // which is precisely the failure-output contract this unit exists to deliver.
  // Raised here rather than in playwright.config.ts so the other agent-plugin
  // specs keep the tighter budget. The happy path is unaffected: the whole
  // journey runs in a second or two.
  test.setTimeout(180_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // The overlay is force-disabled by the reset above
  // (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS), which is the harness's stand-in for
  // "not installed yet": the journey's own S004 is what enables it. Nothing here
  // consents or enables it.
  //
  // App-level agent defaults live in `~/.roubo-dev/<checkout>/agents/_global/`
  // and are NOT among the files /test/__reset truncates, so this spec's own
  // saved defaults would survive from a previous run and leave the S005 form
  // already at the target values with Save disabled (NFR-018).
  await clearAgentConfig(request, PLUGIN_ID);

  // Pin the default agent rather than leaning on the "exactly one available
  // agent" fallback, which this spec removes for itself by making a second agent
  // available. The launch menu's built-in section names the default agent, so
  // S006 needs one resolved. This is a settings write only; the agent is still
  // disabled at this point.
  await setDefaultAgent(request, PLUGIN_ID);

  // Precondition: a project with an active bench. A seeded bench carries a real
  // tmpdir workspace, which is all `isBenchOperable` asks of it, so the journey
  // needs no worktree provisioning and no bench start.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 534,
            integrationId: "github-com",
            externalId: "534",
            title: "Install an agent plugin from the marketplace and see it in launch surfaces",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  // Hand the environment back the way it was found (NFR-018): the default agent
  // lives in settings.json and the saved defaults in `agents/_global/`, neither
  // of which /test/__reset clears, and the overlay is opt-in per spec so the
  // single-available-agent fallback other guards depend on stays intact.
  await setDefaultAgent(request, null);
  await clearAgentConfig(request, PLUGIN_ID);
  await disablePlugin(request, PLUGIN_ID);
});

test("AP-TC-115: install the Gemini CLI agent plugin from the marketplace, configure it, and launch it (S001-S007)", async ({
  page,
  request,
}) => {
  // --- S001: the AI Agents screen, then the Marketplace listing --------------
  await openAgentsTab(page);

  const installed = page.getByRole("region", { name: "Installed agent plugins" });
  // A TOLERATED wait, not an assertion. Every condition an observation covers
  // has to fail through `observe` so the FR-020 block names the diverged step,
  // the expected-vs-actual and the owning slice; a bare
  // `expect(...).toBeVisible()` here would pre-empt S001-O01 and fail with an
  // unattributed Playwright timeout instead. Counts are then read ONCE, so the
  // boolean and the reported actual can never disagree.
  await installed.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const installedRegionCount = await installed.count();

  // The pre-install half of S004-O02, captured here while the plugin is still
  // disabled: its card is listed but carries the unavailable notice, so
  // "moves into the Installed section" is a real before/after rather than an
  // assertion about a card that never changed.
  const preConsentCard = await installed.getByTestId(`agent-plugin-card-${PLUGIN_ID}`).count();
  const preConsentUnavailable = await page.getByTestId(`agent-unavailable-${PLUGIN_ID}`).count();

  // Reconciliation 1: the Marketplace is a sibling settings tab, not a section
  // of this screen. `exact` matters, because a "Marketplaces" (source registry)
  // tab sits beside it.
  const marketplaceTab = page.getByRole("tab", { name: "Marketplace", exact: true });
  await expect(marketplaceTab, "the Marketplace settings tab renders").toBeVisible();
  await marketplaceTab.click();

  const agentFilter = page.getByTestId("marketplace-filter-agent");
  await agentFilter.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await agentFilter.count()) === 1) await agentFilter.click();
  // Wait for the FILTERED render to land before reading the card. The catalog
  // query holds `placeholderData: keepPreviousData`
  // (client/src/hooks/useMarketplace.ts) deliberately, so the grid keeps showing
  // the previous unfiltered cards while the `kind=agent` request is in flight.
  await page
    .locator('[data-testid="marketplace-card-kind"]:not([data-kind="agent"])')
    .first()
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => {});

  const card = page.locator(`[data-testid="marketplace-card"][data-plugin-id="${PLUGIN_ID}"]`);
  await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const cardCount = await card.count();
  // Reconciliation 2: exactly one install affordance renders, and under the
  // harness it is the installed form, because the overlay is discovered as a
  // bundled plugin and the listing is therefore annotated `installed: true`.
  const installButtons =
    cardCount === 1 ? await card.getByTestId("marketplace-card-install").count() : 0;
  const installedBadges =
    cardCount === 1 ? await card.getByTestId("marketplace-card-installed").count() : 0;
  observe(
    STEPS.S001,
    "S001-O01",
    installedRegionCount === 1 && cardCount === 1 && installedBadges === 1 && installButtons === 0,
    `the AI Agents screen renders an Installed region, and the Marketplace lists ${AGENT_NAME} with exactly one install affordance (the "Installed" form, since the overlay is a bundled plugin the catalog reports as already installed)`,
    `Installed region count=${installedRegionCount}, ${AGENT_NAME} marketplace card count=${cardCount}, Install button count=${installButtons}, Installed badge count=${installedBadges}`,
  );

  const kindChip = card.getByTestId("marketplace-card-kind");
  const kindCount = cardCount === 1 ? await kindChip.count() : 0;
  const kind = kindCount === 1 ? await kindChip.getAttribute("data-kind") : null;
  observe(
    STEPS.S001,
    "S001-O02",
    kindCount === 1 && kind === "agent",
    `the ${AGENT_NAME} listing carries an 'agent' kind chip`,
    `kind chip count=${kindCount}, data-kind=${JSON.stringify(kind)}`,
  );

  // --- S002: the compatibility window on the listing -------------------------
  const compatibility = card.getByTestId("marketplace-card-agent-compatibility");
  const compatibilityCount = cardCount === 1 ? await compatibility.count() : 0;
  const compatibilityText =
    compatibilityCount === 1 ? ((await compatibility.textContent()) ?? "") : "";
  const declared =
    compatibilityCount === 1 ? await compatibility.getAttribute("data-declared") : null;
  observe(
    STEPS.S002,
    "S002-O01",
    declared === "true" &&
      compatibilityText.includes(VERSION_FLOOR) &&
      compatibilityText.includes(VERSION_CEILING),
    `the listing displays the declared version floor and tested ceiling: "${VERSION_FLOOR}" and "${VERSION_CEILING}"`,
    compatibilityCount === 1
      ? `data-declared=${JSON.stringify(declared)}, rendered=${JSON.stringify(compatibilityText)}`
      : "the listing rendered no agent-compatibility line",
  );

  // --- S003 (reconciled): the consent gate the install commit is held behind --
  const consentRes = await request.get(`/api/plugins/${PLUGIN_ID}/consent`);
  expect(consentRes.status(), `GET /api/plugins/${PLUGIN_ID}/consent`).toBe(200);
  const consentBody = (await consentRes.json()) as {
    declared?: DeclaredPermissions;
    firstParty?: boolean;
  };
  const declaredPrivileges = summarisePrivileges(consentBody.declared);
  observe(
    STEPS.S003,
    "S003-O01",
    declaredPrivileges === EXPECTED_PRIVILEGES && consentBody.firstParty === true,
    `the consent gate describes exactly the capabilities the ${AGENT_NAME} manifest declares (${EXPECTED_PRIVILEGES}), before installation proceeds`,
    `declared=${declaredPrivileges}, firstParty=${consentBody.firstParty}`,
  );

  // --- S004: accepting the prompt installs and enables the plugin ------------
  await consentAgent(request, PLUGIN_ID);
  // The harness's analogue of the install commit: the overlay is force-disabled
  // by every reset, so enabling it here is what turns an inert record into a
  // running, resolvable agent.
  await enablePlugin(request, PLUGIN_ID);
  await waitForAvailableAgents(request, [PLUGIN_ID]);

  // Reconciliation 3: the digest the installer verifies before commit is carried
  // on the listing the card renders from. Under the harness that digest is the
  // fixture's placeholder, so this asserts the pinned FIELD is present and
  // well-formed, not that a real artifact verified.
  const agentListings = await readAgentListings(request);
  const listing = agentListings.find((entry) => entry.id === PLUGIN_ID);
  observe(
    STEPS.S004,
    "S004-O01",
    listing !== undefined &&
      listing.kind === "agent" &&
      /^sha256-[0-9a-f]{64}$/.test(listing.integrity ?? ""),
    `the ${AGENT_NAME} listing carries the pinned sha256 integrity digest the installer verifies before commit`,
    listing === undefined
      ? `the marketplace served no agent-kind listing for ${PLUGIN_ID}: ${JSON.stringify(agentListings.map((l) => l.id))}`
      : `kind=${listing.kind}, integrity=${listing.integrity}`,
  );

  // Consent and enable were recorded through the API, so the already-mounted
  // screen has to be re-read before the card can reflect them.
  await reloadAgentsTab(page);
  const agentCard = installed.getByTestId(`agent-plugin-card-${PLUGIN_ID}`);
  const disclosure = page.getByTestId(`agent-configure-${PLUGIN_ID}`);
  await agentCard.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const agentCardCount = await agentCard.count();
  const disclosureCount = await disclosure.count();
  const unavailableCount = await page.getByTestId(`agent-unavailable-${PLUGIN_ID}`).count();

  const pluginsRes = await request.get("/api/plugins");
  expect(pluginsRes.status(), "GET /api/plugins").toBe(200);
  const record = (((await pluginsRes.json()) as { plugins?: PluginRecord[] }).plugins ?? []).find(
    (plugin) => plugin.id === PLUGIN_ID,
  );
  observe(
    STEPS.S004,
    "S004-O02",
    preConsentCard === 1 &&
      preConsentUnavailable === 1 &&
      agentCardCount === 1 &&
      disclosureCount === 1 &&
      unavailableCount === 0 &&
      record?.status === "enabled",
    `${AGENT_NAME} moves into the Installed section of Settings > AI Agents as a usable card with a Configure action (it carried an unavailable notice before consent)`,
    `before consent: card count=${preConsentCard}, unavailable notice count=${preConsentUnavailable}; after: card count=${agentCardCount}, configure action count=${disclosureCount}, unavailable notice count=${unavailableCount}, plugin status=${record?.status ?? "no record"}`,
  );

  // --- S005: Configure, set launch defaults, Save ----------------------------
  // The card mounts with its disclosure OPEN (the per-plugin config is the whole
  // point of the screen), so collapse it first and then press Configure. That
  // way the step really is "click Configure" and the observation really is the
  // form appearing, rather than a form that was already there.
  if ((await disclosure.textContent())?.includes("Hide")) {
    await disclosure.click();
    await expect(page.getByTestId(`agent-config-form-${PLUGIN_ID}`)).toBeHidden();
  }
  await expect(disclosure, "the collapsed disclosure offers Configure").toHaveText(/Configure/);
  await disclosure.click();

  const form = page.getByTestId(`agent-config-form-${PLUGIN_ID}`);
  // Tolerated wait again: a form that never expands leaves every field count at
  // 0, which S005-O01 below reports as an attributed divergence.
  await form.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const fieldCounts = {
    modelName: await form.getByTestId("config-field-modelName").count(),
    approval: await form.getByTestId("config-field-approval").count(),
    cliArgs: await form.getByTestId("config-field-cliArgs").count(),
  };
  observe(
    STEPS.S005,
    "S005-O01",
    Object.values(fieldCounts).every((count) => count === 1),
    `a configuration form rendered from the ${AGENT_NAME} plugin's declared schema is shown, with one control per declared property (modelName, approval, cliArgs)`,
    `modelName=${fieldCounts.modelName}, approval=${fieldCounts.approval}, cliArgs=${fieldCounts.cliArgs}`,
  );

  await selectChoice(page, form, "modelName", MODEL_OPTION_LABEL);
  await selectChoice(page, form, "approval", APPROVAL_OPTION_LABEL);
  await expect(form.getByTestId("config-field-modelName")).toContainText(MODEL_OPTION_LABEL);
  await expect(form.getByTestId("config-field-approval")).toContainText(APPROVAL_OPTION_LABEL);

  const save = page.getByTestId(`agent-config-save-${PLUGIN_ID}`);
  await expect(save, "Save defaults is enabled once the draft diverges").toBeEnabled();
  await save.click();
  // Tolerated wait: the "Saved." indicator is how long to wait for the round
  // trip, not the whole observation. The persisted record is read back below.
  const savedNotice = form.getByText("Saved.");
  await savedNotice.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const savedNoticeCount = await savedNotice.count();

  const configRes = await request.get(`/api/agents/${PLUGIN_ID}/config`);
  expect(configRes.status(), `GET /api/agents/${PLUGIN_ID}/config`).toBe(200);
  const persisted = ((await configRes.json()) as { config?: Record<string, unknown> }).config ?? {};
  const persistedMatches = (Object.keys(LAUNCH_DEFAULTS) as (keyof typeof LAUNCH_DEFAULTS)[]).every(
    (key) => persisted[key] === LAUNCH_DEFAULTS[key],
  );
  // Reconciliation 4: no "Configured" status ships. The shipped confirmation is
  // the form's "Saved." plus the persisted record behind it.
  observe(
    STEPS.S005,
    "S005-O02",
    persistedMatches && savedNoticeCount === 1,
    `the launch defaults are saved as ${JSON.stringify(LAUNCH_DEFAULTS)} and the card confirms the save`,
    `persisted config=${JSON.stringify(persisted)}, save confirmation count=${savedNoticeCount}`,
  );

  // --- S006: the bench Terminal tab's agent launch menu ----------------------
  const benchRes = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(benchRes?.status(), "GET the bench detail page").toBe(200);
  const terminalTab = page.getByRole("tab", { name: "Terminal" });
  await expect(terminalTab, "the bench detail view has a Terminal tab").toBeVisible();
  await terminalTab.click();

  await openLaunchMenu(page);
  const row = allAgentsRow(page, AGENT_NAME);
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const rowCount = await row.count();
  const allAgentsNames = await page
    .getByRole("group", { name: ALL_AGENTS_SECTION })
    .getByTestId("launch-agent-item")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? node.textContent),
    );
  observe(
    STEPS.S006,
    "S006-O01",
    rowCount === 1,
    `${AGENT_NAME} appears in the launch menu's "${ALL_AGENTS_SECTION}" list`,
    `matching rows=${rowCount}, rows listed=${JSON.stringify(allAgentsNames)}`,
  );

  // --- S007: launching it opens a PTY session for this agent -----------------
  if (rowCount === 1) await row.click();

  let sessions: TerminalSessionEntry[] = [];
  let live: TerminalSessionEntry | undefined;
  for (let attempt = 0; attempt < 40 && live === undefined; attempt += 1) {
    sessions = await listSessions(request);
    live = sessions.find(
      (session) => session.agentPluginId === PLUGIN_ID && session.status === "live",
    );
    if (live === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  observe(
    STEPS.S007,
    "S007-O01",
    live !== undefined && live.command === AGENT_COMMAND,
    `a PTY terminal session for ${AGENT_NAME} opens in the bench (status=live, agentPluginId=${PLUGIN_ID}), running the CLI the overlay's descriptor names, "${AGENT_COMMAND}"`,
    sessions.length === 0
      ? "no terminal session was created"
      : sessions
          .map(
            (session) =>
              `${session.id}: status=${session.status}, agent=${session.agentPluginId}, command=${session.command}`,
          )
          .join("; "),
  );
});
