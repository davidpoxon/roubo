import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { AssignedIssue } from "@roubo/shared";

// TC-153: shape of one entry in the ROUBO_E2E=1-only tap exposed by
// `GET /test/__connection-state-log`. The tap mirrors the structured log
// lines emitted by `recordConnectionStateTransition` in
// server/services/plugin-manager.ts; keep this type in lock-step with the
// exported `ConnectionStateLogEntry` there.
export interface ConnectionStateLogEntry {
  event: "plugin.connection-state.changed";
  pluginId: string;
  previousState: string | null;
  newState: string;
  trigger: string;
  at: string;
}

/**
 * Reset server singletons and pin the stubbed plugin to a scenario + frozen
 * clock for the duration of a single spec (WU-063). All e2e-flow specs go
 * through this helper so that the calling shape is uniform and the assertion
 * about the 200 response is centralised.
 */
export async function resetWithScenario(
  request: APIRequestContext,
  scenario: string,
  now: string,
): Promise<void> {
  const res = await request.post("/test/__reset", { data: { scenario, now } });
  expect(res.status()).toBe(200);
}

/**
 * Fetch the stubbed plugin's live connection-status and assert both the
 * scenario-derived `detail` and the pinned `checkedAt`. This is the
 * end-to-end proof that the spec's --scenario / --now reached the spawned
 * plugin process and the response made it back through the host RPC layer.
 */
export async function expectStubConnectionStatus(
  request: APIRequestContext,
  expected: { detail: string; checkedAt: string },
): Promise<void> {
  const res = await request.get("/api/plugins/e2e-stub/connection-status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { state: string; detail?: string; checkedAt?: string };
  expect(body.state).toBe("connected");
  expect(body.detail).toBe(expected.detail);
  expect(body.checkedAt).toBe(expected.checkedAt);
}

/**
 * Load the built client shell and confirm it returned a 200 with the React
 * root element present. Used by every e2e-flow spec to keep a real browser
 * navigation in the loop alongside the API-level scenario assertions.
 */
export async function loadAppShell(page: Page): Promise<void> {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.locator("#root")).toBeAttached();
}

/**
 * Assert that, inside `scope`, the `ConnectionStatusPill` is visible and is
 * carrying the expected `data-state` value. WU-064 (TC-168/TC-169): the pill
 * is the testable surface for connection-status placement assertions; callers
 * pass a Locator that scopes the query to one of the three placements
 * (PluginCard, Configure modal header, project Issue Source tile).
 */
export async function expectConnectionStatePillState(
  scope: Locator,
  expectedState: string,
): Promise<void> {
  const pill = scope.getByTestId("connection-status-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("data-state", expectedState);
}

/**
 * Register a throwaway project for the duration of one spec, pinned to the
 * requested plugin via an integration override. The fixture is torn down by
 * the next `/test/__reset` call (see #232), so specs that need a registered
 * project can compose this with `resetWithScenario` in `beforeEach`. The
 * returned `projectId` is suitable for `page.goto(`/projects/${id}/settings`)`.
 */
export async function registerFixtureProject(
  request: APIRequestContext,
  opts: {
    projectId: string;
    plugin: string;
    // WU-068: optional extra integration fields (instance, sources,
    // capturedUserId, etc.) merged into the saved override alongside
    // `plugin`. Specs use this to drive surfaces (e.g. Source-tile instance
    // line) that only render when the override carries the matching value.
    integrationConfig?: Record<string, unknown>;
    // TC-161: optional list of benches to seed against the fixture project,
    // each pinned with its own `assignedIssue`. The server route persists
    // them onto fresh tmpdir-backed PersistedBench rows and reloads
    // bench-manager so subsequent GET /api/projects/:id/benches surfaces
    // them. Use this when a spec needs benches that pre-date a later
    // mutation (e.g. an integration switch) without paying the cost of the
    // real bench-provisioning flow.
    seedBenches?: Array<{ assignedIssue: AssignedIssue }>;
  },
): Promise<{ projectId: string; repoPath: string }> {
  const res = await request.post("/test/__register-fixture-project", { data: opts });
  expect(res.status()).toBe(200);
  return (await res.json()) as { projectId: string; repoPath: string };
}

/**
 * Read the ROUBO_E2E=1-only tap exposed by `GET /test/__connection-state-log`.
 * The tap mirrors the structured log lines emitted by
 * `recordConnectionStateTransition` (TC-153 / NFR-023). TC-169 uses it to
 * assert that an opportunistic recheck observed a state transition without
 * scraping the running server's stdout.
 */
export async function fetchConnectionStateLog(
  request: APIRequestContext,
): Promise<ConnectionStateLogEntry[]> {
  const res = await request.get("/test/__connection-state-log");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { entries: ConnectionStateLogEntry[] };
  return body.entries;
}

/**
 * Read the persisted plugin-enable-state file via the e2e harness endpoint.
 * TC-154 (#222) asserts the NFR-024 invariant ("plugin remains in its
 * previous disabled state on spawn failure") by snapshotting this map before
 * and after the Enable click; the snapshot lets the spec verify that the
 * on-disk file was not mutated, without poking the filesystem from the
 * test process.
 */
export async function fetchPluginEnableState(
  request: APIRequestContext,
): Promise<Record<string, "enabled" | "disabled">> {
  const res = await request.get("/test/__plugin-enable-state");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { plugins: Record<string, "enabled" | "disabled"> };
  return body.plugins;
}
