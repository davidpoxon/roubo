import { expect, test } from "@playwright/test";
import { resetWithScenario } from "./_support/scenario.js";
import { addSource, externalIds, openConfigure, readSources, save } from "./_support/picker.js";

// WU-007 (#356): the picker-area end-to-end journeys for the searchable,
// project-first Jira source picker. These mirror the seven `e2e_flow` picker
// cases from `.specifications/jira-sources-scale/test-cases.json`:
//
//   TC-019 project-first scoping        TC-026 assigned-to-me
//   TC-020 scrum board                  TC-027 epic scope
//   TC-021 saved filter                 TC-029 disambiguate similar names
//   TC-023 combine multiple sources
//
// All seven share one scenario (`jira-sources-scale-picker`) and the e2e-flow
// harness, so they run as a single CI suite (the project's `pr-check` workflow
// runs `npx playwright test`, which includes the `e2e-flow` project).
//
// Scope note: these specs assert the *picker journey* and the *persisted source
// selection* read back through `GET /integration`. The TCs also describe a "cut
// list preview" with JQL semantics (active-sprint-only, OR-union de-dup, mine
// in-scope vs anywhere). There is no in-dialog preview, and the stub does not
// execute JQL, so those semantics are covered by the plugin unit tests in
// `plugins/jira-self-hosted/src/jql.test.ts` (TC-004, TC-007, TC-008), not here.

const SCENARIO = "jira-sources-scale-picker";
const NOW = "2026-05-21T13:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-019: a developer scopes to a Jira project before adding sources", async ({
  page,
  request,
}) => {
  const projectId = "tc-019";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  // Project scope is the first and only enabled control; board/filter/epic are
  // gated until a project is in scope.
  await expect(picker.getByRole("button", { name: /^Add projects$/i })).toBeEnabled();
  await expect(picker.getByRole("button", { name: /^Add boards$/i })).toBeDisabled();
  await expect(picker.getByRole("button", { name: /^Add filters$/i })).toBeDisabled();
  await expect(picker.getByRole("button", { name: /^Add epics$/i })).toBeDisabled();

  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });

  // A project chip appears and the scoped pickers become enabled.
  await expect(picker.getByRole("button", { name: /^Remove Platform$/i })).toBeVisible();
  await expect(picker.getByRole("button", { name: /^Add boards$/i })).toBeEnabled();
  await expect(picker.getByRole("button", { name: /^Add filters$/i })).toBeEnabled();
  await expect(picker.getByRole("button", { name: /^Add epics$/i })).toBeEnabled();

  await save(dialog);

  const sources = await readSources(request, projectId);
  expect(externalIds(sources.project)).toContain("PLAT");
});

test("TC-020: a developer adds their scrum board", async ({ page, request }) => {
  const projectId = "tc-020";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });
  // The board result is found with its project key and board id on the
  // secondary line (textValue "PLAT Scrum Board, PLAT · board #482").
  await addSource(page, picker, "boards", { search: "Scrum", option: /PLAT Scrum Board.*#482/ });

  await save(dialog);

  const sources = await readSources(request, projectId);
  expect(externalIds(sources.board)).toEqual(["482"]);
  // Active-sprint-only is a JQL-builder default (jql.test.ts), not a picker
  // control, so the board entry simply carries its project scope here.
  expect(sources.board?.[0]).toMatchObject({ externalId: "482", project: "PLAT" });
});

test("TC-021: a developer adds a saved filter as a source", async ({ page, request }) => {
  const projectId = "tc-021";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });
  await addSource(page, picker, "filters", { search: "Team open bugs", option: /#10231/ });

  await save(dialog);

  const sources = await readSources(request, projectId);
  expect(externalIds(sources.filter)).toEqual(["10231"]);
});

test("TC-023: a developer combines multiple sources across types", async ({ page, request }) => {
  const projectId = "tc-023";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });
  await addSource(page, picker, "boards", { search: "Scrum", option: /PLAT Scrum Board/ });
  await addSource(page, picker, "filters", { search: "Team open bugs", option: /#10231/ });

  // Both appear in the configured-source list as removable chips.
  await expect(picker.getByRole("button", { name: /^Remove PLAT Scrum Board$/i })).toBeVisible();
  await expect(picker.getByRole("button", { name: /^Remove Team open bugs$/i })).toBeVisible();

  await save(dialog);

  // The cut list is the union of both sources (de-dup is JQL semantics, covered
  // by jql.test.ts); here we assert both sources persist under their category.
  const sources = await readSources(request, projectId);
  expect(externalIds(sources.board)).toEqual(["482"]);
  expect(externalIds(sources.filter)).toEqual(["10231"]);
});

test("TC-026: a developer adds an assigned-to-me source", async ({ page, request }) => {
  const projectId = "tc-026";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });

  // Enabling assigned-to-me with a project in scope defaults to in-scoped-projects.
  // The React Aria Switch / Radio accessible elements are visually-hidden inputs
  // behind their painted track, so force the click past the intercepting visual.
  await picker.getByRole("switch", { name: /Include assigned to me/i }).click({ force: true });
  await expect(picker.getByRole("radio", { name: /^In scoped projects$/i })).toBeChecked();

  // Switch to anywhere mode.
  await picker.getByRole("radio", { name: /^Anywhere$/i }).click({ force: true });
  await expect(picker.getByRole("radio", { name: /^Anywhere$/i })).toBeChecked();

  await save(dialog);

  const sources = await readSources(request, projectId);
  expect(externalIds(sources.mine)).toEqual(["mine"]);
  expect(sources.mine?.[0]).toMatchObject({ externalId: "mine", mineScope: "anywhere" });
});

test("TC-027: a developer scopes a bench to a single epic", async ({ page, request }) => {
  const projectId = "tc-027";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });
  // The epic is found within the project (no instance-wide dump).
  await addSource(page, picker, "epics", { search: "Platform", option: /Platform Q2 roadmap/ });

  await save(dialog);

  const sources = await readSources(request, projectId);
  expect(externalIds(sources.epic)).toEqual(["PLAT-100"]);
});

test("TC-029: a developer distinguishes two similarly named filters", async ({ page, request }) => {
  const projectId = "tc-029";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });

  // Search the shared name fragment: both filters appear, each with its project
  // key and filter id on the secondary line, so they can be told apart.
  const filtersTrigger = picker.getByRole("button", { name: /^Add filters$/i });
  await filtersTrigger.click();
  await page.getByRole("searchbox", { name: /^Search filters$/i }).fill("Team open bugs");
  const results = page.getByRole("listbox", { name: /Filters results/i });
  await expect(results.getByRole("option", { name: /#10231/ })).toBeVisible();
  await expect(results.getByRole("option", { name: /#10999/ })).toBeVisible();

  // Select the intended filter by its id, not its near-identical name.
  await results.getByRole("option", { name: /#10999/ }).click();
  await filtersTrigger.click({ force: true });

  await save(dialog);

  const sources = await readSources(request, projectId);
  expect(externalIds(sources.filter)).toEqual(["10999"]);
});
