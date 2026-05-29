import { expect, test } from "@playwright/test";
import type { FilterFacet } from "@roubo/shared";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, unregisterTestProject } from "./_support/project.js";

// TC-175 (US-020, FR-067, NFR-018): a plugin built against host-API 1.0.0
// omits the `filterFacets` method. The host's RPC layer rejects with
// MethodNotFound, which `plugin-filter-facets.ts` maps to the fixed
// COMMON_FACET_FALLBACK set (Status, Label, Assignee, Type). The MethodNotFound
// must not surface in the UI as an error.

const SCENARIO = "filter-facets-fallback";
const NOW = "2026-05-26T11:00:00.000Z";

// Lifted from server/services/plugin-filter-facets.ts. Keeping a literal copy
// here lets the spec assert exact equality without importing server code.
const COMMON_FACET_FALLBACK: ReadonlyArray<FilterFacet> = [
  { id: "status", label: "Status", type: "enum" },
  { id: "label", label: "Label", type: "enum" },
  { id: "assignee", label: "Assignee", type: "enum" },
  { id: "type", label: "Type", type: "enum" },
];

test.describe("TC-175: common-facet fallback when filterFacets is absent", () => {
  let projectId: string;

  test.beforeEach(async ({ request }) => {
    await resetWithScenario(request, SCENARIO, NOW);
    projectId = await registerTestProject(request);
  });

  test.afterEach(async ({ request }) => {
    await unregisterTestProject(request);
  });

  test("filterFacets endpoint returns COMMON_FACET_FALLBACK exactly", async ({ request }) => {
    const res = await request.get(`/api/projects/${projectId}/integration/filter-facets`);
    expect(res.status()).toBe(200);
    const facets = (await res.json()) as FilterFacet[];
    expect(facets).toEqual(COMMON_FACET_FALLBACK);
  });

  test("cut-list renders the four fallback sections with no MethodNotFound", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await loadAppShell(page);
    await page.goto(`/projects/${projectId}`);

    await expect(page.getByText("#20", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Filter cut list/ }).click();

    // Scope facet-header assertions to the popover so they don't match issue
    // text in the cut-list (e.g. label/assignee chip text on cards).
    const popover = page.getByRole("dialog");
    for (const facet of COMMON_FACET_FALLBACK) {
      await expect(popover.getByText(facet.label, { exact: true })).toBeVisible();
    }

    const allMessages = [...pageErrors, ...consoleErrors].join("\n");
    expect(allMessages).not.toContain("MethodNotFound");
    expect(allMessages).not.toContain("-32601");
  });
});
