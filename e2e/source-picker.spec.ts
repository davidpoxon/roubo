import { expect, test } from "@playwright/test";

// Covers TC-021, TC-022, TC-076 at the browser level. The spec drives the
// real React + React Aria SourcePicker against a Vite-served dev fixture
// (`client/source-picker-fixture.html`) so it doesn't need a running server
// or a fixture integration plugin. The fixture echoes the current selection
// into a JSON debug block keyed `value-debug`.

const MULTI_FIXTURE = "/source-picker-fixture.html";
const CATEGORIZED_FIXTURE = "/source-picker-fixture.html?shape=categorized";

async function readDebug(page: import("@playwright/test").Page) {
  const raw = await page.getByTestId("value-debug").textContent();
  return JSON.parse(raw ?? "{}") as Record<string, string[]>;
}

test.describe("SourcePicker — multi-list (TC-021)", () => {
  test("selects items, surfaces chips, removes via chip", async ({ page }) => {
    await page.goto(MULTI_FIXTURE);

    const list = page.getByRole("listbox", { name: /source candidates/i });
    await expect(list).toBeVisible();
    await expect(list.getByText("org/api")).toBeVisible();

    await list.getByText("org/api").click();
    await list.getByText("Roadmap").click();

    expect(await readDebug(page)).toEqual({ items: ["org/api", "proj-42"] });

    await page.getByRole("button", { name: "Remove org/api" }).click();
    expect(await readDebug(page)).toEqual({ items: ["proj-42"] });
  });

  test("filters via search field", async ({ page }) => {
    await page.goto(MULTI_FIXTURE);

    const list = page.getByRole("listbox", { name: /source candidates/i });
    await expect(list.getByText("org/api")).toBeVisible();

    await page.getByRole("searchbox", { name: /search source candidates/i }).fill("road");

    await expect(list.getByText("org/api")).toHaveCount(0);
    await expect(list.getByText("Roadmap")).toBeVisible();
  });
});

test.describe("SourcePicker — categorized-multi-list (TC-022)", () => {
  test("tabs render with per-category counts and scoped selection", async ({ page }) => {
    await page.goto(CATEGORIZED_FIXTURE);

    const tabList = page.getByRole("tablist", { name: /source categories/i });
    await expect(tabList.getByRole("tab", { name: /Boards/ })).toBeVisible();
    await expect(tabList.getByRole("tab", { name: /Epics/ })).toBeVisible();
    await expect(tabList.getByRole("tab", { name: /Filters/ })).toBeVisible();

    // Boards is selected by default.
    await page
      .getByRole("listbox", { name: /boards candidates/i })
      .getByText("Engineering")
      .click();

    await expect(
      tabList.getByRole("tab", { name: /Boards/ }).getByLabel(/1 selected/),
    ).toBeVisible();

    await tabList.getByRole("tab", { name: /Epics/ }).click();
    await page
      .getByRole("listbox", { name: /epics candidates/i })
      .getByText("Q1 launch")
      .click();

    expect(await readDebug(page)).toEqual({ boards: ["b1"], epics: ["e1"] });
  });
});

test.describe("SourcePicker — accessibility (TC-076)", () => {
  test("keyboard navigation selects with Space and removes chip with Enter", async ({ page }) => {
    await page.goto(MULTI_FIXTURE);

    const list = page.getByRole("listbox", { name: /source candidates/i });
    await list.getByRole("option", { name: /org\/api/ }).focus();
    await page.keyboard.press("Space");

    expect(await readDebug(page)).toEqual({ items: ["org/api"] });

    await page.getByRole("button", { name: "Remove org/api" }).focus();
    await page.keyboard.press("Enter");

    expect(await readDebug(page)).toEqual({});
  });
});
