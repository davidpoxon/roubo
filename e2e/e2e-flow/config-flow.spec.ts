import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";
import {
  addSource,
  externalIds,
  openConfigureDialog,
  readIntegrationState,
  save,
} from "./_support/picker.js";

// WU-010 (#359): the config-area end-to-end journey for team-default vs
// personal source sets. This mirrors the single `e2e_flow` case in the
// `config` area of `.specifications/jira-sources-scale/test-cases.json`:
//
//   TC-028 a team default is overridden by a personal source set
//
// It shares the e2e-flow harness (`_support/picker.ts`, `_support/scenario.ts`)
// with the picker- and source-search-area journeys, so the whole area runs as a
// single CI suite (the `pr-check` workflow runs `npx playwright test`, which
// includes the `e2e-flow` project), satisfying AC2/AC3.
//
// Unlike the picker specs (which register their project via a per-user override),
// the precondition here is a TEAM DEFAULT shipped in the committed roubo.yaml, so
// the project is registered from a checked-in fixture dir via POST /api/projects.
// The fixture's team default is a single-category set (`project: [PLAT]`); the
// personal selection swaps it to PAY so the whole `project` array is replaced
// wholesale, with no second category to leak back through the per-category merge
// (the override file only carries the categories the user actually selected).

const SCENARIO = "jira-sources-scale-picker";
const NOW = "2026-05-21T13:00:00.000Z";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "config-flow-project");
const PROJECT_ID = "e2e-config-flow";

async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register config-flow fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(PROJECT_ID);

  // Pin the active plugin in the per-user override. The Configure dialog's save
  // (PUT /integration/config) refuses with 409 "no-active-integration" unless
  // the active plugin lives in the override, since that is what the Switch flow
  // establishes. This models a developer whose integration is already active;
  // the TEAM DEFAULT sources still live only in the committed roubo.yaml (the
  // override carries no `sources` key), so the developer "has not customized
  // sources" yet, satisfying the TC-028 precondition.
  const pin = await request.put(`/api/projects/${PROJECT_ID}/integration/override`, {
    data: { plugin: "e2e-stub" },
  });
  expect(pin.status(), "pin active plugin in override").toBe(200);
}

test.beforeEach(async ({ request }) => {
  // __reset wipes the integrations dir, so the per-user override this spec
  // writes is cleaned before the next run; the committed roubo.yaml is never
  // mutated, so no fixture restore is needed.
  await resetWithScenario(request, SCENARIO, NOW);
  await registerProject(request);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
});

test("TC-028: a team default is overridden by a personal source set", async ({ page, request }) => {
  await loadAppShell(page);
  const { dialog, picker } = await openConfigureDialog(page, PROJECT_ID);

  // Step 1 - open the configurator as a developer who has not customized
  // sources: the team default shipped in roubo.yaml (project PLAT) is shown as a
  // removable chip, and it is the only source in scope.
  await expect(picker.getByRole("button", { name: /^Remove PLAT$/i })).toBeVisible();
  await expect(picker.getByRole("button", { name: /^Remove PAY$/i })).toHaveCount(0);

  // Step 2 - replace the team default with a personal selection: drop the team's
  // Platform project, then add the Payments project, and save. (Removing first
  // keeps the picker in the same single-selection state the picker specs add
  // into, so `addSource` leaves the Configure dialog open as it does there.) The
  // save path writes the per-user override file (PUT /integration/sources); it
  // never rewrites the committed roubo.yaml.
  await picker.getByRole("button", { name: /^Remove PLAT$/i }).click();
  await expect(picker.getByRole("button", { name: /^Remove PLAT$/i })).toHaveCount(0);
  await addSource(page, picker, "projects", { search: "Payments", option: /Payments/ });
  await expect(picker.getByRole("button", { name: /^Remove Payments$/i })).toBeVisible();

  await save(dialog);

  const { committed, override, effective } = await readIntegrationState(request, PROJECT_ID);

  // The personal override is stored in the per-user file...
  expect(externalIds(override.project)).toEqual(["PAY"]);
  // ...the committed roubo.yaml is unchanged (still the team default)...
  expect(externalIds(committed.project)).toEqual(["PLAT"]);
  // ...and the personal selection wins at resolution time.
  expect(externalIds(effective.project)).toEqual(["PAY"]);
});
