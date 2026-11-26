import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  PROJECT_ID,
  dismissNotices,
  installDatabase,
  openWithStream,
  registerLantern,
  removeDatabase,
  resetHarness,
  settleApplies,
  stateDir,
  waitForNotice,
} from "./_support/reload-env.js";
import {
  ADDED_PROJECT_ID,
  CHANGED_INPUTS,
  SURFACES,
  marketplaceUpdate,
  restoreStateFiles,
  snapshotStateFiles,
  type SurfaceContext,
} from "./_support/surfaces.js";
import { NOTICE_SAMPLES, type NoticeInput } from "./_support/notice-samples.js";

// HR-TC-036: one applied change of each input, made on disk while the app is
// open, shows one notice whose text is the recorded sample of that input
// (./_support/notice-samples.ts), one line that starts with the surface's
// thing. It runs against the server that Playwright started and never
// restarts.
//
// The plugin change is a hand edit of the manifest of an installed plugin
// ('database', installed through the marketplace from the e2e catalog), which
// swaps its process: the plugin update of HR-FR-007.

let snapshot: Map<string, string | null> | null = null;
let scratchDir: string | null = null;

test.beforeEach(async ({ request }) => {
  await resetHarness(request);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/projects/${ADDED_PROJECT_ID}?force=true`);
  if (snapshot !== null) restoreStateFiles(snapshot);
  snapshot = null;
  await removeDatabase(request);
  if (scratchDir !== null) fs.rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = null;
  // The restore above queued applies: let them finish before the next case.
  await settleApplies(request);
  await resetHarness(request);
});

test("HR-TC-036: the notice of an applied change of each input matches its recorded sample", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const rouboDir = await stateDir(request);
  snapshot = snapshotStateFiles(rouboDir);
  scratchDir = fs.mkdtempSync(path.join(rouboDir, "e2e-hr-tc-036-"));
  const project = await registerLantern(request);
  await installDatabase(request);
  const ctx: SurfaceContext = { request, rouboDir, project, idleBenchId: 1, scratchDir };

  await openWithStream(page, `/projects/${PROJECT_ID}`);

  const rows: { input: NoticeInput; expected: string; actual: string | null }[] = [];
  for (const input of CHANGED_INPUTS) {
    await test.step(`S001: one applied change of ${input}`, async () => {
      await dismissNotices(page);
      // The plugin input's sample is that of a marketplace update.
      const save = input === "plugin" ? marketplaceUpdate(ctx) : await SURFACES[input].save(ctx, 1);
      await save.write();
      const actual = await waitForNotice(page, save.notice, 10_000);
      rows.push({ input, expected: save.expected, actual });
    });
  }

  const report = rows
    .map((r) => `${r.input}: ${r.actual === null ? "no notice" : JSON.stringify(r.actual)}`)
    .join("\n");
  for (const row of rows) {
    const { thing } = NOTICE_SAMPLES[row.input];
    expect(row.actual, `the ${row.input} notice equals its recorded sample\n${report}`).toBe(
      row.expected,
    );
    const text = row.actual ?? "";
    expect(
      text.includes("\n"),
      `the ${row.input} notice is one line: ${JSON.stringify(text)}`,
    ).toBe(false);
    expect(
      text.startsWith(thing),
      `the ${row.input} notice starts with '${thing}': ${JSON.stringify(text)}`,
    ).toBe(true);
  }
});
