import { expect, test, type Locator, type Page } from "@playwright/test";
import { CLAUDE_PLUGIN_ID, consentAgent, waitForAvailableAgents } from "./_support/agent-env.js";

// E2E: the Terminal agent split-button renders as one control, not two
// misaligned ones. The chevron segment holds only a 12px icon, while the
// primary segment holds a line of text (empty state) or a 14px icon (tab bar).
// In a row that centres its items, the chevron came out shorter than its
// partner and sat inside its edges. jsdom computes no layout, so the unit tests
// can only prove the row asks to stretch; this proves the segments line up.

const PROJECT_ID = "split-button-geometry";
const BENCH_ID = 1;

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // A consented, available agent, so the primary segment carries its label
  // rather than rendering disabled.
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID]);

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 1,
            integrationId: "github-com",
            externalId: "1",
            title: "Split-button geometry",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

async function openTerminalTab(page: Page): Promise<void> {
  const res = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(res?.status(), "GET the bench detail page").toBe(200);
  await page.getByRole("tab", { name: "Terminal" }).click();
}

async function expectSameRow(primary: Locator, chevron: Locator, where: string): Promise<void> {
  await expect(primary, `${where}: the primary segment renders`).toBeVisible();
  await expect(chevron, `${where}: the chevron segment renders`).toBeVisible();
  const a = await primary.boundingBox();
  const b = await chevron.boundingBox();
  if (!a || !b) throw new Error(`${where}: a split-button segment has no bounding box`);
  expect(Math.abs(a.height - b.height), `${where}: both segments are one height`).toBeLessThan(0.5);
  expect(Math.abs(a.y - b.y), `${where}: both segments share a top edge`).toBeLessThan(0.5);
}

test("both Terminal split-buttons render their segments at one height", async ({ page }) => {
  await openTerminalTab(page);

  const emptyState = page.getByText("No terminal sessions").locator("xpath=..");
  await expectSameRow(
    emptyState.getByRole("button", { name: "Claude Code", exact: true }),
    emptyState.getByRole("button", { name: "Choose launch option" }),
    "empty state",
  );

  // The tab bar renders the first of the two identical chevrons.
  await expectSameRow(
    page.getByRole("button", { name: "Launch Claude Code" }),
    page.getByRole("button", { name: "Choose launch option" }).first(),
    "tab bar",
  );
});
