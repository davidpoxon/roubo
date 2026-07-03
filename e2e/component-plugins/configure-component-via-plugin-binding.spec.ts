import { expect, test, type APIRequestContext } from "@playwright/test";
import { formatDivergence, makeObserve, type JourneyStep } from "./_support/step-runner.js";

// CPHM-TC-081 / CPHM-TC-082 (#317) - E2E: configure a component via a plugin
// binding, and an errored component plugin's banner guides recovery.
//
// This spec is the integration-level drift guard for the primary journey
// spanning slices #301 (remove the vestigial Role toggle from the Components
// editor) and #302 (ErroredBanner surfaces the plugin's real lastError). It
// walks the authoritative CPHM-TC-081 and CPHM-TC-082 e2e_flow steps as
// ordered, attributable observations. On divergence each observation routes
// through the FR-020 failure-output contract (see _support/step-runner.ts): the
// failure reports which step diverged, the expected-vs-actual, and the owning
// slice issue(s).
//
// Altitude: the guard runs at the integration/API + persistence level, the only
// altitude that can assert TC-081's load-bearing facts (a plugin-bound component
// persists as plugin:{ id } with NO component.type) and TC-082's errored-record
// facts (a component plugin reaches `errored` with a real missing-entry
// lastError, kind=component so the issue-snapshot line is suppressed). This
// mirrors the sibling component-deploy-journey.spec.ts (#626), which is likewise
// request-driven.
//
// Wiring status at authoring time (both slices are closed as landed on this
// branch, but each shipped only part of its own test case's expected surface):
//   - #301 removed the Role toggle and made a new component carry no
//     component.type (ComponentsList.newComponentDefaults returns {}), but it
//     did NOT add the "Component plugin" selector or schema-driven config fields
//     to the editor: ComponentRowEditor still renders only name/port/env, and
//     the plugin binding is "set elsewhere" (ComponentsList's own comment). So
//     the persistence contract is asserted HARD here, while the editor UI
//     journey (TC-081 S001/S002/S004/S005) is not drivable and is marked pending
//     against #301.
//   - #302 made the banner render the plugin's real lastError (code + message)
//     and suppress the issue-snapshot line for non-integration (component)
//     plugins, dropping the hardcoded "3 restart attempts" copy. Those facts are
//     asserted HARD. But TC-082's expected marketplace-recovery affordances (the
//     "reinstall it from the marketplace" copy and a Reinstall action) did NOT
//     ship: the missing-entry message says "check its build output exists", and
//     the banner's action is Restart (useRestartPlugin), not Reinstall. That
//     divergence is gated and marked pending against #302.

const OWNER_301 = {
  issue: 301,
  title: "Remove the vestigial Role toggle from the Components editor",
} as const;
const OWNER_302 = {
  issue: 302,
  title: "ErroredBanner surfaces the plugin's real lastError",
} as const;

const observe081 = makeObserve("CPHM-TC-081");
const observe082 = makeObserve("CPHM-TC-082");

// The harness carries `clasp-deploy-stub` as its sole installed component-kind
// plugin fixture (process/database are not carried in the e2e harness; see the
// #626 precedent). The load-bearing persistence fact TC-081 checks is the
// binding SHAPE (plugin:{ id }, no component.type), independent of which
// component plugin id is bound, so the guard binds a component to this plugin.
const COMPONENT_PLUGIN_ID = "clasp-deploy-stub";
const TC081_PROJECT_ID = "cphm-tc-081";
// `/test/__register-fixture-project`'s `componentPlugin` option binds a `deploy`
// component to the plugin in the generated roubo.yaml (config: {}, no type).
const BOUND_COMPONENT = "deploy";

// The errored component-plugin fixture (e2e/fixtures/errored-component-stub):
// a valid manifest whose entry file is intentionally absent, so plugin-manager's
// pre-spawn host check (#759) fails it closed into `errored` with a real
// missing-entry lastError. Force-disabled at boot (FAILURE_FIXTURE_PLUGIN_IDS in
// server/routes/test.ts), so the guard enables it on demand to reach that state.
const ERRORED_PLUGIN_ID = "errored-component-stub";
// The substring of the shipped #759 missing-entry message the banner renders.
const ENTRY_PATH_FRAGMENT = "dist/index.js";
// TC-082 S002-O01 expects the message to guide the user to reinstall from the
// marketplace; the shipped copy does not carry this phrase. Its live
// presence/absence is surfaced in the divergence detail for the deterministically
// gated marketplace-recovery block below (MARKETPLACE_REINSTALL_AFFORDANCE_WIRED);
// the copy alone never lifts that gate.
const MARKETPLACE_RECOVERY_COPY = "reinstall it from the marketplace";

// #301 shipped the toggle removal but NOT the editor's plugin-binding UI (no
// "Component plugin" selector, no schema-driven config fields). This is a
// client-only editor capability with no server-observable signal, so the guard
// localises the drift to #301 and marks the editor journey pending. Flip to
// true (and drive the browser journey below) once #301 ships the selector.
const COMPONENTS_EDITOR_BINDING_UI_WIRED = false;

// #302 shipped the real-lastError banner but NOT TC-082's marketplace-recovery
// affordances (S003/S004): a Reinstall action that initiates a reinstall. That
// action is a client-only affordance with no server-observable signal at this
// altitude (the banner currently exposes Restart, useRestartPlugin), so the
// server "reinstall it from the marketplace" copy alone cannot verify it:
// asserting only on the copy would let this guard pass without ever checking the
// Reinstall affordance it is named for. The guard therefore localises the drift
// to #302 and marks the recovery affordances pending. Flip to true (and drive
// the browser journey) once #302 ships the Reinstall action.
const MARKETPLACE_REINSTALL_AFFORDANCE_WIRED = false;

interface PluginListEntry {
  id: string;
  status: string;
  lastError: { code?: string; message?: string } | null;
  restartHistory: unknown[];
  manifest: { kind?: string } | null;
}

interface ComponentConfigShape {
  plugin?: { id?: string };
  type?: string;
}

const STEPS_081: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the Components editor with no legacy Role (Process/Database) toggle",
    owners: [OWNER_301],
  },
  S002: {
    id: "S002",
    instruction: "Add a component: the panel exposes a 'Component plugin' selector",
    owners: [OWNER_301],
  },
  S003: {
    id: "S003",
    instruction: "The selector lists only installed component plugins",
    owners: [OWNER_301],
  },
  S004: {
    id: "S004",
    instruction: "Select the component plugin: its config-schema fields render",
    owners: [OWNER_301],
  },
  S006: {
    id: "S006",
    instruction: "Save: the component persists as plugin:{ id }, with no component.type",
    owners: [OWNER_301],
  },
};

const STEPS_082: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "A red errored-plugin banner is shown for the affected component plugin",
    owners: [OWNER_302],
  },
  S002: {
    id: "S002",
    instruction:
      "The banner shows the real lastError and omits snapshot / '3 restart attempts' copy",
    owners: [OWNER_302],
  },
  S003: {
    id: "S003",
    instruction: "Recovery affordances are present (Reinstall + View logs)",
    owners: [OWNER_302],
  },
  S004: {
    id: "S004",
    instruction: "Click Reinstall: the reinstall flow for the affected plugin is initiated",
    owners: [OWNER_302],
  },
};

async function listPlugins(request: APIRequestContext): Promise<PluginListEntry[]> {
  const res = await request.get("/api/plugins");
  expect(res.status(), "GET /api/plugins").toBe(200);
  const body = (await res.json()) as { plugins: PluginListEntry[] };
  return body.plugins;
}

// Drive the errored fixture into its `errored` / missing-entry state via the
// real production enable -> spawn -> #759 host-check path. Enabling a disabled
// plugin whose entry file is missing fails the spawn, so the enable route
// returns 409, but the in-memory record transitions to `errored` with the real
// missing-entry lastError. We tolerate the 409 and assert on the record itself.
async function seedErroredComponentPlugin(request: APIRequestContext): Promise<PluginListEntry> {
  await request.post(`/api/plugins/${ERRORED_PLUGIN_ID}/enable`, { data: {} });
  const entry = (await listPlugins(request)).find((p) => p.id === ERRORED_PLUGIN_ID);
  if (!entry) {
    throw new Error(`${ERRORED_PLUGIN_ID} was not discovered by the plugin manager`);
  }
  return entry;
}

test.beforeEach(async ({ request }) => {
  const res = await request.post("/test/__reset", { data: {} });
  expect(res.status(), "POST /test/__reset").toBe(200);
});

test("CPHM-TC-081: a plugin-bound component persists as plugin:{ id } with no component.type (S003, S006)", async ({
  request,
}) => {
  // Register a fixture project whose roubo.yaml binds a `deploy` component to the
  // installed component plugin (config: {}, no legacy type). This is the persisted
  // result of the "add -> bind -> save" journey, which is the fact TC-081 checks.
  const register = await request.post("/test/__register-fixture-project", {
    data: { projectId: TC081_PROJECT_ID, componentPlugin: COMPONENT_PLUGIN_ID },
  });
  expect(register.status(), "register fixture project").toBe(200);

  // --- S003: the selector would list installed component plugins. Assert the
  // bound plugin is discovered as an installed component-kind plugin. ---
  const bound = (await listPlugins(request)).find((p) => p.id === COMPONENT_PLUGIN_ID);
  observe081(
    STEPS_081.S003,
    "S003-O01",
    bound !== undefined && bound.manifest?.kind === "component",
    `${COMPONENT_PLUGIN_ID} is an installed component-kind plugin the selector would list`,
    bound === undefined
      ? `${COMPONENT_PLUGIN_ID} not installed`
      : `kind=${bound.manifest?.kind ?? "none"}, status=${bound.status}`,
  );

  // --- S006: the persisted component carries plugin:{ id } and NO component.type. ---
  const configRes = await request.get(`/api/projects/${TC081_PROJECT_ID}/config`);
  expect(configRes.status(), "GET project config").toBe(200);
  const configBody = (await configRes.json()) as {
    config: { components?: Record<string, ComponentConfigShape> };
  };
  const component = configBody.config.components?.[BOUND_COMPONENT];

  observe081(
    STEPS_081.S006,
    "S006-O03",
    component !== undefined,
    `component "${BOUND_COMPONENT}" is present in the project's components, bound to the plugin`,
    component === undefined ? "component absent" : "component present",
  );
  observe081(
    STEPS_081.S006,
    "S006-O01",
    component?.plugin?.id === COMPONENT_PLUGIN_ID,
    `persisted binding is plugin: { id: "${COMPONENT_PLUGIN_ID}" }`,
    `plugin.id=${component?.plugin?.id ?? "absent"}`,
  );
  observe081(
    STEPS_081.S006,
    "S006-O02",
    component !== undefined && component.type === undefined,
    "the deprecated component.type field is not written for the plugin-bound component",
    `component.type=${component?.type ?? "undefined"}`,
  );
});

test("CPHM-TC-081: the Components editor add, bind, configure, save journey (S001, S002, S004, S005)", async () => {
  // The persistence contract above is asserted HARD. The browser journey of
  // driving the editor (open editor -> Add component -> pick a plugin from the
  // 'Component plugin' selector -> fill the schema-driven fields -> Save) is not
  // drivable today: #301 removed the Role toggle but did not add the selector or
  // schema-driven fields, so ComponentRowEditor still renders only name/port/env
  // and the plugin binding is set outside the editor. Emit the FR-020
  // attribution and mark the journey pending against #301; when #301 ships the
  // selector, flip COMPONENTS_EDITOR_BINDING_UI_WIRED and drive the journey here.
  if (!COMPONENTS_EDITOR_BINDING_UI_WIRED) {
    const detail = formatDivergence(
      "CPHM-TC-081",
      STEPS_081.S002,
      "S002-O01",
      "the Add-component panel exposes a 'Component plugin' selector that renders the bound plugin's config-schema fields and persists plugin:{ id }",
      "the Components editor ships no plugin selector and no schema-driven fields; the plugin binding is set outside the editor",
    );
    test.info().annotations.push({ type: "blocked-by", description: detail });
    test.fixme(true, detail);
    return;
  }
});

test("CPHM-TC-082: an errored component plugin surfaces its real lastError (S001, S002)", async ({
  request,
}) => {
  const errored = await seedErroredComponentPlugin(request);

  // --- S001: the record is `errored`, which is what makes PluginCard render the
  // red ErroredBanner for the affected component plugin. ---
  observe082(
    STEPS_082.S001,
    "S001-O01",
    errored.status === "errored",
    "the affected component plugin is in status 'errored' (drives the red errored banner)",
    `status=${errored.status}`,
  );

  // --- S002-O01: the banner renders the real lastError (code + message). The
  // shipped missing-entry error carries the code and the entry path. ---
  observe082(
    STEPS_082.S002,
    "S002-O01",
    errored.lastError?.code === "missing-entry" &&
      typeof errored.lastError?.message === "string" &&
      errored.lastError.message.includes(ENTRY_PATH_FRAGMENT),
    `real lastError present: code "missing-entry" and message naming ${ENTRY_PATH_FRAGMENT}`,
    `code=${errored.lastError?.code ?? "none"}, message=${errored.lastError?.message ?? "none"}`,
  );

  // --- S002-O02: the banner omits the issue-snapshot line and the "3 restart
  // attempts" copy. Both are data-driven: the snapshot notice renders only for
  // kind==="integration", and the "3 restart attempts" state is restart-budget
  // exhaustion (a populated restartHistory + a restart-budget lastError), not a
  // fail-fast missing-entry error. A component plugin with a missing-entry error
  // and no restart history therefore shows neither. ---
  observe082(
    STEPS_082.S002,
    "S002-O02",
    errored.manifest?.kind === "component" &&
      errored.restartHistory.length === 0 &&
      errored.lastError?.code === "missing-entry",
    "kind=component (issue-snapshot line suppressed) with no restart-budget exhaustion ('3 restart attempts' copy omitted)",
    `kind=${errored.manifest?.kind ?? "none"}, restartHistory=${errored.restartHistory.length}, code=${errored.lastError?.code ?? "none"}`,
  );
});

test("CPHM-TC-082: the errored banner guides marketplace recovery (S002 copy, S003, S004)", async ({
  request,
}) => {
  const errored = await seedErroredComponentPlugin(request);

  // The real-lastError facts above are asserted HARD. TC-082 additionally expects
  // the banner to guide the user to reinstall from the marketplace (S002-O01's
  // "reinstall it from the marketplace" copy) and to expose a Reinstall action
  // that initiates a reinstall (S003-O01 / S004-O01). Neither shipped: the
  // missing-entry message says "check its build output exists", and the banner's
  // recovery action is Restart (useRestartPlugin), not Reinstall.
  //
  // The Reinstall affordance (S003/S004) is a client-only concern with no
  // server-observable signal at this altitude, so this block stays deterministically
  // pending against #302 until the affordance ships and is driven at the browser
  // level. We surface the live "reinstall it from the marketplace" copy state in
  // the divergence so the pending note stays accurate as #302 evolves, but never
  // let the copy alone lift the gate (asserting only the copy would pass this
  // guard without ever checking the Reinstall action it is named for).
  if (!MARKETPLACE_REINSTALL_AFFORDANCE_WIRED) {
    const marketplaceRecoveryCopyShipped = (errored.lastError?.message ?? "").includes(
      MARKETPLACE_RECOVERY_COPY,
    );
    const detail = formatDivergence(
      "CPHM-TC-082",
      STEPS_082.S003,
      "S003-O01",
      `the banner guides marketplace recovery: message includes "${MARKETPLACE_RECOVERY_COPY}" and a Reinstall action initiates a reinstall`,
      `recovery copy ${marketplaceRecoveryCopyShipped ? "present" : "absent"}; the banner exposes a Restart action (useRestartPlugin), not Reinstall`,
    );
    test.info().annotations.push({ type: "blocked-by", description: detail });
    test.fixme(true, detail);
    return;
  }
});
