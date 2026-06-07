import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { registerTestProject } from "../../project-settings/_support/test-project.js";

// Shared harness for the searchable, project-first Jira source-picker e2e-flow
// specs (WU-007 picker journeys + WU-008 source-search journey). Keeping the
// picker-driving helpers in one place means every e2e_flow spec for this area
// runs off a single automation harness (issue #357 AC2) instead of copy-pasting
// the open / search / read-back boilerplate per file.

// The instance value written into each fixture project's integration override
// so the Issue Source tile renders its configured variant and the connection
// pill resolves to the scenario's "connected" state.
export const INSTANCE = "https://jira.stub.example";

// Register the fixture project pinned to the stub (with an instance so the tile
// renders its configured variant and the connection pill resolves to the
// scenario's "connected" state), open Configure, and return the picker locator.
export async function openConfigure(
  page: Page,
  request: APIRequestContext,
  projectId: string,
): Promise<{ dialog: Locator; picker: Locator }> {
  await registerTestProject(request, {
    projectId,
    plugin: "e2e-stub",
    integrationConfig: { instance: INSTANCE },
  });
  return openConfigureDialog(page, projectId);
}

// Open the Configure dialog for an ALREADY-registered project and return the
// dialog + picker locators. Split out of `openConfigure` so specs that register
// their project a different way (e.g. TC-028 needs committed team-default
// sources in roubo.yaml, which `registerTestProject` can't seed since it writes
// a per-user override) can still reuse the open / locate boilerplate.
export async function openConfigureDialog(
  page: Page,
  projectId: string,
): Promise<{ dialog: Locator; picker: Locator }> {
  await page.goto(`/projects/${projectId}/settings`);

  const tile = page.getByTestId("issue-source-tile");
  await expect(tile).toBeVisible();
  await page.getByTestId("issue-source-primary-action").click();

  // Scope to the Configure modal by its accessible name: the source-search
  // popover also carries role="dialog", so a bare getByRole("dialog") is
  // ambiguous once a picker is opened.
  const dialog = page.getByRole("dialog", { name: /Configure .*Roubo E2E Stub|Roubo E2E Stub/ });
  await expect(dialog.getByTestId("plugin-configure-dialog-header")).toBeVisible();

  const picker = dialog.getByTestId("source-picker");
  await expect(picker).toBeVisible();
  return { dialog, picker };
}

// Drive an AsyncSourceSearch control: open its popover, type a term, pick a
// result by accessible name, then close the popover by re-clicking the trigger.
// (The popover stays open on select and its overlay would otherwise intercept
// later clicks; Escape is avoided because it also dismisses the surrounding
// Configure modal in React Aria.) The popover portals to the body, so results
// are queried from `page`, not the picker.
export async function addSource(
  page: Page,
  picker: Locator,
  category: "projects" | "boards" | "filters" | "epics",
  opts: { search: string; option: RegExp },
): Promise<void> {
  const trigger = picker.getByRole("button", { name: new RegExp(`^Add ${category}$`, "i") });
  await trigger.click();
  await page
    .getByRole("searchbox", { name: new RegExp(`^Search ${category}$`, "i") })
    .fill(opts.search);
  await page.getByRole("option", { name: opts.option }).click();
  // The Popover excludes its own trigger from outside-press handling, so this
  // toggles it shut cleanly. force: the just-opened popover may overlap it.
  await trigger.click({ force: true });
}

// Read the persisted SourceSelection back through the host endpoint. Project
// entries are bare strings; board/filter/epic/mine entries are objects.
export async function readSources(
  request: APIRequestContext,
  projectId: string,
): Promise<Record<string, Array<string | { externalId: string; [k: string]: unknown }>>> {
  const res = await request.get(`/api/projects/${projectId}/integration`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    effective?: { sources?: Record<string, Array<string | { externalId: string }>> };
  };
  return body.effective?.sources ?? {};
}

export function externalIds(entries: Array<string | { externalId: string }> | undefined): string[] {
  return (entries ?? []).map((e) => (typeof e === "object" ? e.externalId : String(e)));
}

type SourceSelection = Record<string, Array<string | { externalId: string; [k: string]: unknown }>>;

// Read the three integration layers the host exposes for a project: the
// committed roubo.yaml config, the per-user override file, and the merged
// effective result. TC-028 asserts all three at once (team default unchanged,
// personal override stored, personal wins), so the helper returns each layer's
// `sources` (defaulting to {}) rather than just the effective one `readSources`
// returns.
export async function readIntegrationState(
  request: APIRequestContext,
  projectId: string,
): Promise<{ committed: SourceSelection; override: SourceSelection; effective: SourceSelection }> {
  const res = await request.get(`/api/projects/${projectId}/integration`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    committed?: { sources?: SourceSelection } | null;
    override?: { sources?: SourceSelection } | null;
    effective?: { sources?: SourceSelection };
  };
  return {
    committed: body.committed?.sources ?? {},
    override: body.override?.sources ?? {},
    effective: body.effective?.sources ?? {},
  };
}

export async function save(dialog: Locator): Promise<void> {
  await dialog.getByTestId("save-config").click();
  await expect(dialog).toBeHidden();
}
