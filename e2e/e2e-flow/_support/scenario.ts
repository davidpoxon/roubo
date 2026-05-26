import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// WU-064: shape of one entry in the in-memory connection-state transition
// journal exposed by `GET /test/__connection-state-log`. Kept in lock-step
// with `ConnectionStateLogEntry` in server/services/plugin-manager.ts. Both
// live behind the journal that #221 (TC-153) will replace with durable
// logging; remove this type at the same time.
export interface ConnectionStateLogEntry {
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
  opts: { projectId: string; plugin: string },
): Promise<{ projectId: string; repoPath: string }> {
  const res = await request.post("/test/__register-fixture-project", { data: opts });
  expect(res.status()).toBe(200);
  return (await res.json()) as { projectId: string; repoPath: string };
}

/**
 * Read the in-memory connection-state transition journal exposed by
 * `GET /test/__connection-state-log`. WU-064 (TC-169) asserts that a recheck
 * appended an entry. Stand-in for the durable logging tracked by #221
 * (TC-153); remove this helper together with the route when that lands.
 */
export async function fetchConnectionStateLog(
  request: APIRequestContext,
): Promise<ConnectionStateLogEntry[]> {
  const res = await request.get("/test/__connection-state-log");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { entries: ConnectionStateLogEntry[] };
  return body.entries;
}
