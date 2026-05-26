import { expect, type APIRequestContext, type Page } from "@playwright/test";

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
