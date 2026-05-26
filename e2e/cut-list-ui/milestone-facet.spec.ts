import { expect, test } from "@playwright/test";
import type { FilterFacet, FilterFacetOption } from "@roubo/shared";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, unregisterTestProject } from "./_support/project.js";

// TC-174 (US-020, FR-065/066/067, NFR-018): the stubbed plugin declares a
// `milestone` facet via the `filterFacets` RPC (WU-045). The host's filter-
// facets endpoint returns it alongside the inline `status` facet, and the
// cut-list lazily fetches options for `enum-async` facets via
// `getFacetOptions` only after the user opens the section.

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

  test("opening the Milestone section in the filter popover lazily fetches options", async ({
    page,
  }) => {
    await loadAppShell(page);
    await page.goto(`/projects/${projectId}`);

    // All three scenario issues are visible by default.
    await expect(page.getByText("acme/widgets#10")).toBeVisible();
    await expect(page.getByText("acme/widgets#11")).toBeVisible();
    await expect(page.getByText("acme/widgets#12")).toBeVisible();

    await page.getByRole("button", { name: /^Filter cut list/ }).click();
    // Scope to the popover dialog so the "Milestone" facet header isn't
    // confused with issue titles like "Milestone v1.2 bug" in the cut-list.
    const popover = page.getByRole("dialog");
    await expect(popover.getByText("Milestone", { exact: true })).toBeVisible();

    // enum-async sections render closed; clicking "Load options" triggers the
    // first network request to the host's facet-options endpoint.
    const facetOptionsResponse = page.waitForResponse(
      (resp) =>
        resp
          .url()
          .includes(`/api/projects/${projectId}/integration/facet-options?facetId=milestone`) &&
        resp.status() === 200,
    );
    await popover.getByRole("button", { name: "Load options" }).first().click();
    await facetOptionsResponse;

    await popover.getByRole("option", { name: "v1.2" }).click();

    await expect(page.getByText("acme/widgets#10")).toBeVisible();
    await expect(page.getByText("acme/widgets#11")).toBeVisible();
    await expect(page.getByText("acme/widgets#12")).toHaveCount(0);
  });
});
