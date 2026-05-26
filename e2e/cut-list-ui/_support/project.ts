import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WU-067: the fixture project holds the minimal valid roubo.yaml the cut-list
// UI specs need to render against. `/test/__reset` clears the in-memory
// project registry, so every spec re-registers the project after the reset.
// The fixture is shared because the cut-list specs all need an e2e-stub
// integration with a known root-level `excludedStatuses` baseline (TC-173).
export const TEST_PROJECT_REPO_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "fixtures",
  "test-project",
);
export const TEST_PROJECT_ID = "e2e-cut-list-project";

/**
 * Register the fixture project after a `/test/__reset`. Pre-deletes any
 * stale registration first because `state.json` survives across Playwright
 * runs when the dev server is reused (`reuseExistingServer: !CI`) and
 * `/test/__reset` re-initialises from disk. The DELETE swallows 404 so a
 * cold start (no prior registration) still proceeds. Returns the registered
 * project's id so the caller can navigate to `/projects/${id}`.
 */
export async function registerTestProject(request: APIRequestContext): Promise<string> {
  const cleanup = await request.delete(`/api/projects/${TEST_PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());

  const res = await request.post("/api/projects", {
    data: { repoPath: TEST_PROJECT_REPO_PATH },
  });
  expect(res.status(), "register fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(TEST_PROJECT_ID);
  return body.id;
}

/**
 * Unregister the fixture project. Safe to call from `afterEach` even when the
 * spec aborted early; treats 404 as a no-op so a teardown after a missed
 * register doesn't mask the original failure.
 */
export async function unregisterTestProject(request: APIRequestContext): Promise<void> {
  const res = await request.delete(`/api/projects/${TEST_PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(res.status());
}
