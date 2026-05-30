import { expect, test } from "@playwright/test";
import type { FilterFacet, FilterFacetOption } from "@roubo/shared";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, unregisterTestProject } from "./_support/project.js";

// TC-174 (US-020, FR-065/066/067, NFR-018): the stubbed plugin declares a
// `milestone` facet via the `filterFacets` RPC (WU-045). The host's filter-
// facets endpoint returns it alongside the inline `status` facet, and the
// cut-list fetches options for `enum-async` facets via `getFacetOptions`.
// Options are prefetched on load and the section fetches them as soon as the
// popover renders, so they appear without a manual "Load options" click.

const SCENARIO = "filter-facets-milestone";
const NOW = "2026-05-26T10:00:00.000Z";

test.describe("TC-174: milestone facet via filterFacets RPC", () => {
  let projectId: string;

  test.beforeEach(async ({ request }) => {
    await resetWithScenario(request, SCENARIO, NOW);
    projectId = await registerTestProject(request);
  });

  test.afterEach(async ({ request }) => {
    await unregisterTestProject(request);
  });

  test("filterFacets endpoint includes the milestone facet (enum-async)", async ({ request }) => {
    const res = await request.get(`/api/projects/${projectId}/integration/filter-facets`);
    expect(res.status()).toBe(200);
    const facets = (await res.json()) as FilterFacet[];
    const milestone = facets.find((f) => f.id === "milestone");
    expect(milestone).toBeDefined();
    expect(milestone?.type).toBe("enum-async");
    expect(milestone?.label).toBe("Milestone");
  });

  test("getFacetOptions returns the lazy-loaded milestone option set", async ({ request }) => {
    const res = await request.get(
      `/api/projects/${projectId}/integration/facet-options?facetId=milestone`,
    );
    expect(res.status()).toBe(200);
    const options = (await res.json()) as FilterFacetOption[];
    expect(options.map((o) => o.value).sort()).toEqual(["v1.2", "v1.3"]);
  });

  test("opening the Milestone section in the filter popover shows fetched options", async ({
    page,
  }) => {
    await loadAppShell(page);

    // The cut-list prefetches enum-async facet options on load and the section
    // fetches them as soon as the popover renders, so watch for the facet-
    // options request from the moment we navigate to the project.
    const facetOptionsResponse = page.waitForResponse(
      (resp) =>
        resp
          .url()
          .includes(`/api/projects/${projectId}/integration/facet-options?facetId=milestone`) &&
        resp.status() === 200,
    );

    await page.goto(`/projects/${projectId}`);

    // All three scenario issues are visible by default.
    await expect(page.getByText("#10", { exact: true })).toBeVisible();
    await expect(page.getByText("#11", { exact: true })).toBeVisible();
    await expect(page.getByText("#12", { exact: true })).toBeVisible();

    await facetOptionsResponse;

    await page.getByRole("button", { name: /^Filter cut list/ }).click();
    // Scope to the popover dialog so the "Milestone" facet header isn't
    // confused with issue titles like "Milestone v1.2 bug" in the cut-list.
    const popover = page.getByRole("dialog");
    await expect(popover.getByText("Milestone", { exact: true })).toBeVisible();

    // enum-async sections render their options eagerly: there is no "Load
    // options" button and the option appears straight away.
    await expect(popover.getByRole("button", { name: "Load options" })).toHaveCount(0);
    await popover.getByRole("option", { name: "v1.2" }).click();

    await expect(page.getByText("#10", { exact: true })).toBeVisible();
    await expect(page.getByText("#11", { exact: true })).toBeVisible();
    await expect(page.getByText("#12", { exact: true })).toHaveCount(0);
  });
});
