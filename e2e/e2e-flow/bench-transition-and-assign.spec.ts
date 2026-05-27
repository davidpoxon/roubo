import { expect, test } from "@playwright/test";
import { registerFixtureProject, resetWithScenario } from "./_support/scenario.js";

// TC-162 (US-008/US-025, FR-035/036/037/077/078/080, NFR-018): from the bench
// detail view, a user transitions the attached issue's status (Open -> In
// review), then assigns the issue to themself. Both writes round-trip through
// the stubbed-plugin journal and survive a page reload. WU-064 (#155) shipped
// TC-168 and TC-169 but never automated TC-162; #239 closes that gap.
//
// The bench is seeded directly into state via `registerFixtureProject`'s
// `seedBenches` option (TC-161 pattern). Driving real bench provisioning is
// too expensive for NFR-018; the seed shortcut mirrors the trade-off already
// made for project registration (#232).

const SCENARIO = "bench-transition-and-assign";
const NOW = "2026-05-27T09:00:00.000Z";
const EXTERNAL_ID = "acme/widgets#42";
const EXTERNAL_ID_ENCODED = encodeURIComponent(EXTERNAL_ID);

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("user transitions issue status from Open to In review and assigns to self (TC-162)", async ({
  page,
  request,
}) => {
  const { projectId } = await registerFixtureProject(request, {
    projectId: "tc-162",
    plugin: "e2e-stub",
    integrationConfig: {
      sources: { repo: [{ externalId: "acme/widgets" }] },
      capturedUserId: { externalId: "alice", displayName: "Alice Stub" },
    },
    seedBenches: [
      {
        assignedIssue: {
          number: 42,
          integrationId: "e2e-stub",
          externalId: EXTERNAL_ID,
          title: "TC-162 transition + assign target",
        },
      },
    ],
  });

  // Seeded benches are written with sequential ids starting at 1
  // (server/routes/test.ts:496). One seed => benchId 1.
  await page.goto(`/projects/${projectId}/benches/1`);

  const transitionTrigger = page.getByTestId("transition-trigger");
  const assignControl = page.getByTestId("assign-control");

  // Initial state from the scenario JSON: Open, unassigned.
  await expect(transitionTrigger).toHaveText(/Open/);
  await expect(assignControl).toHaveText("Assign to me");
  await expect(assignControl).toHaveAttribute("aria-pressed", "false");

  // Transition: Open -> In review. The trigger button is the bench badge for
  // issue status (renders `issue.currentState`); after the mutation invalidates
  // the bench-issue query the trigger re-renders with the new state.
  await transitionTrigger.click();
  const transitionList = page.getByRole("listbox", { name: "Available transitions" });
  await transitionList.getByRole("option", { name: "In review" }).click();
  await expect(transitionTrigger).toHaveText(/In review/);

  // Belt-and-braces: confirm the stub journal reflects the transition.
  const postTransition = await request.get(
    `/api/projects/${projectId}/issues/${EXTERNAL_ID_ENCODED}`,
  );
  expect(postTransition.status()).toBe(200);
  expect((await postTransition.json()).currentState).toBe("In review");

  // Assign to self. The button is a toggle; aria-pressed flips and the label
  // swaps to "Unassign me".
  await assignControl.click();
  await expect(assignControl).toHaveText("Unassign me");
  await expect(assignControl).toHaveAttribute("aria-pressed", "true");

  const postAssign = await request.get(`/api/projects/${projectId}/issues/${EXTERNAL_ID_ENCODED}`);
  expect(postAssign.status()).toBe(200);
  const postAssignBody = (await postAssign.json()) as {
    assignees: Array<{ externalId: string }>;
  };
  expect(postAssignBody.assignees.map((a) => a.externalId)).toContain("alice");

  // Persistence across reload. The stub journal lives for the duration of the
  // plugin process and is only reset by the next `/test/__reset` call in
  // `beforeEach`, so a browser reload should round-trip both writes.
  await page.reload();
  await expect(page.getByTestId("transition-trigger")).toHaveText(/In review/);
  const assignAfterReload = page.getByTestId("assign-control");
  await expect(assignAfterReload).toHaveText("Unassign me");
  await expect(assignAfterReload).toHaveAttribute("aria-pressed", "true");
});
