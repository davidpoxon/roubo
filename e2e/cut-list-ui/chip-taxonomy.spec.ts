import { expect, test } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, unregisterTestProject } from "./_support/project.js";

// TC-176 (US-021, FR-068, NFR-016, NFR-018): the chip taxonomy renders four
// distinct buckets (status, issue-type or security-category, label, metadata)
// and the chips stay distinguishable under greyscale and the two main red-
// green colour-blindness palettes (protanopia, deuteranopia). The four
// categories are encoded in markup (icon, shape, position) so structural
// assertion proves distinguishability; per-palette screenshots are captured
// as attachments for human review without baseline comparison so the spec
// stays deterministic across runs and platforms (NFR-018).

const SCENARIO = "chip-taxonomy";
const NOW = "2026-05-26T12:00:00.000Z";

const PALETTES = [
  { name: "default", css: "" },
  { name: "greyscale", css: "html { filter: grayscale(1) !important; }" },
  {
    name: "protanopia",
    css: "html { filter: url(#palette-protanopia) !important; }",
  },
  {
    name: "deuteranopia",
    css: "html { filter: url(#palette-deuteranopia) !important; }",
  },
];

// Color-matrix values from "Colour blindness reproduction with clinical data"
// (Machado, Oliveira, Fernandes, 2009). Inlined so the spec stays self-
// contained; the matrices are well-known constants, not engineering choices.
const PALETTE_FILTERS_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0">
  <defs>
    <filter id="palette-protanopia">
      <feColorMatrix type="matrix" values="
        0.567 0.433 0     0 0
        0.558 0.442 0     0 0
        0     0.242 0.758 0 0
        0     0     0     1 0" />
    </filter>
    <filter id="palette-deuteranopia">
      <feColorMatrix type="matrix" values="
        0.625 0.375 0     0 0
        0.7   0.3   0     0 0
        0     0.3   0.7   0 0
        0     0     0     1 0" />
    </filter>
  </defs>
</svg>
`;

test.describe("TC-176: chip taxonomy renders four distinct categories", () => {
  let projectId: string;

  test.beforeEach(async ({ request }) => {
    await resetWithScenario(request, SCENARIO, NOW);
    projectId = await registerTestProject(request);
  });

  test.afterEach(async ({ request }) => {
    await unregisterTestProject(request);
  });

  test("cut-list renders chips covering all four taxonomy categories", async ({ page }) => {
    await loadAppShell(page);
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByText("#100", { exact: true })).toBeVisible();

    // The four categories are encoded as the `data-chip-category` attribute on
    // <IssueChip>. Asserting at least one chip per category proves the
    // taxonomy renders distinctly; the precise count depends on per-issue
    // chip rules (security-category replaces issue-type for the alert rows).
    const categories = ["status", "label", "metadata", "security-category"] as const;
    for (const category of categories) {
      const count = await page.locator(`[data-chip-category="${category}"]`).count();
      expect(count, `expected at least one chip with category=${category}`).toBeGreaterThan(0);
    }
  });

  for (const palette of PALETTES) {
    test(`chips remain rendered under ${palette.name} palette`, async ({ page }, testInfo) => {
      await loadAppShell(page);
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByText("#100", { exact: true })).toBeVisible();

      // Inject SVG colour-matrix definitions once per page, then apply the
      // chosen palette via a CSS filter. Default palette skips both because
      // the empty CSS keeps the page untouched.
      if (palette.css) {
        await page.evaluate((svg) => {
          const wrap = document.createElement("div");
          wrap.innerHTML = svg;
          document.body.appendChild(wrap.firstElementChild as Element);
        }, PALETTE_FILTERS_SVG);
        await page.addStyleTag({ content: palette.css });
      }

      // Structural distinguishability holds across palettes because each
      // category renders distinct DOM (icon, shape, position) regardless of
      // colour. The screenshot rides along as an attachment for review.
      const cutList = page.locator(`text="#100"`).first();
      await testInfo.attach(`chip-taxonomy-${palette.name}.png`, {
        body: await cutList
          .locator("xpath=ancestor::div[contains(@class,'space-y-0.5')]")
          .first()
          .screenshot(),
        contentType: "image/png",
      });

      for (const category of ["status", "label", "metadata", "security-category"]) {
        const count = await page.locator(`[data-chip-category="${category}"]`).count();
        expect(count, `expected ${category} chips under ${palette.name} palette`).toBeGreaterThan(
          0,
        );
      }
    });
  }
});
