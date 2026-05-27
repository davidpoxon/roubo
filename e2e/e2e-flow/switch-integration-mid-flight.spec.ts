import { expect, test } from "@playwright/test";
import { registerFixtureProject, resetWithScenario } from "./_support/scenario.js";

// TC-161 (US-006/US-025, FR-028/029/077/078/080, NFR-018): a project on
// github.com with two pre-existing benches switches mid-flight to the
// self-hosted Jira plugin. The dialog drives the override write; existing
// benches keep their `assignedIssue` snapshot but render the
// "Issue from previous integration" badge; the new cut list pulls from the
// Jira-flavoured stub.
//
// The two pre-existing benches are seeded directly into state via
// `registerFixtureProject`'s `seedBenches` option (added for TC-161). Driving
// the real bench-provisioning flow twice through the UI is too expensive for
// NFR-018 (10 consecutive zero-retry runs); the seed shortcut matches the
// trade-off already made for project registration (`#232`).
//
// Post-switch Jira configuration (instance + sources) is written via
// `PUT /api/projects/:id/integration/config` because the Switch dialog only
// owns the plugin-id flip — the Configure dialog would normally collect
// instance / sources next, and exercising that second dialog is out of scope
// for TC-161 (covered by TC-157, `jira-self-hosted-source-config.spec.ts`).

const SCENARIO = "mid-flight-switch-github-to-jira";
const NOW = "2026-05-27T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("switching from github.com to Jira mid-flight badges existing benches and routes the cut list to Jira (TC-161)", async ({
  page,
  request,
}) => {
  const { projectId } = await registerFixtureProject(request, {
    projectId: "tc-161",
    plugin: "github-com",
    integrationConfig: {
      sources: { repo: [{ externalId: "acme/widgets" }] },
      capturedUserId: { externalId: "alice", displayName: "Alice Stub" },
    },
    seedBenches: [
      {
        assignedIssue: {
          number: 101,
          integrationId: "github-com",
          externalId: "acme/widgets#101",
          title: "Pre-switch bench 1",
        },
      },
      {
        assignedIssue: {
          number: 102,
          integrationId: "github-com",
          externalId: "acme/widgets#102",
          title: "Pre-switch bench 2",
        },
      },
    ],
  });

  // Sanity: pre-switch the project is on github-com.
  const preIntegration = await request.get(`/api/projects/${projectId}/integration`);
  expect(preIntegration.status()).toBe(200);
  expect((await preIntegration.json()).plugin.id).toBe("github-com");

  // Open Settings and the Switch dialog.
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByRole("button", { name: "Switch integration" }).click();

  // The dialog renders both bundled plugins; pick Self-hosted Jira. React
  // Aria's Radio wraps a hidden input in a label whose descendant divs
  // intercept pointer events, so click the visible label by its text rather
  // than the hidden role=radio input.
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Switch integration" })).toBeVisible();
  await dialog.locator("label").filter({ hasText: "Self-hosted Jira" }).click();
  await expect(dialog.getByRole("radio", { name: /Self-hosted Jira/ })).toBeChecked();

  // The confirm CTA shares the "Switch integration" label with the trigger
  // we already clicked. Scope to the dialog so the trigger does not match.
  await dialog.getByRole("button", { name: "Switch integration" }).click();
  await expect(dialog).toBeHidden();

  // Override now points at jira-self-hosted; sources were cleared by the
  // PUT /integration/override handler.
  const postIntegration = await request.get(`/api/projects/${projectId}/integration`);
  expect(postIntegration.status()).toBe(200);
  expect((await postIntegration.json()).plugin.id).toBe("jira-self-hosted");

  // Configure the Jira instance + sources so the cut list call has the
  // inputs the bundled overlay's manifest requires. Mirrors what the
  // Configure dialog would write on its own.
  const configRes = await request.put(`/api/projects/${projectId}/integration/config`, {
    data: {
      instance: "https://jira.stub.example",
      sources: { projects: [{ externalId: "PROJ-A" }] },
    },
  });
  expect(configRes.status()).toBe(200);

  // Benches tab: each pre-switch bench carries
  // `assignedIssue.integrationId === "github-com"` while the active
  // integration is now "jira-self-hosted", so BenchCard renders the
  // "Issue from previous integration" badge on both.
  await page.goto(`/projects/${projectId}`);
  const badges = page.getByTestId("previous-integration-badge");
  await expect(badges).toHaveCount(2);
  await expect(badges.first()).toHaveText("Issue from previous integration");
  await expect(badges.nth(1)).toHaveText("Issue from previous integration");

  // Cut list call now routes to the jira-self-hosted plugin process. The
  // shared scenario tags its issues with `integrationId: "jira-self-hosted"`
  // and Jira-style externalIds, so seeing those rows is direct proof that
  // the call landed on the Jira overlay (and not on the prior github-com
  // overlay, which would have produced the same scenario data but only if
  // the override had not flipped). Combined with the
  // GET /integration check above this is belt-and-braces.
  const issuesRes = await request.get(`/api/projects/${projectId}/issues?page=1&pageSize=10`);
  expect(issuesRes.status()).toBe(200);
  const issuesBody = (await issuesRes.json()) as {
    items: Array<{ integrationId: string; externalId: string }>;
  };
  expect(issuesBody.items.length).toBeGreaterThan(0);
  for (const item of issuesBody.items) {
    expect(item.integrationId).toBe("jira-self-hosted");
    expect(item.externalId).toMatch(/^PROJ-/);
  }
});
