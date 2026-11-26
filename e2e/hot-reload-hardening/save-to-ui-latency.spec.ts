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
  stateDir,
  waitForNotice,
} from "../hot-reload/_support/reload-env.js";
import {
  ADDED_PROJECT_ID,
  CHANGED_INPUTS,
  SURFACES,
  restoreStateFiles,
  snapshotStateFiles,
  type SurfaceContext,
} from "../hot-reload/_support/surfaces.js";
import { HARDENING_ENABLED, HARDENING_SKIP_REASON, percentile } from "./_support/budgets.js";

// HR-TC-048 (HR-NFR-005): save-to-UI latency is at or below 2 s at p95 on
// every surface. Each input takes 20 saves on a local volume; each is timed
// from the moment its write returns to the moment its notice shows in the
// open app, the UI update that the change makes. A wall-clock budget, so it
// runs only with ROUBO_E2E_HARDENING=1 (the nightly perf workflow), and a
// breach fails that workflow.

const SAVES_PER_SURFACE = 20;
const BUDGET_P95_MS = 2_000;
// Long enough to tell a slow save from a lost one; a lost save counts as this.
const WAIT_MS = 10_000;

let snapshot: Map<string, string | null> | null = null;
let scratchDir: string | null = null;

test.skip(!HARDENING_ENABLED, HARDENING_SKIP_REASON);

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
  await resetHarness(request);
});

test("HR-TC-048: save-to-UI latency is at or below 2 s at p95 on every surface", async ({
  page,
  request,
}) => {
  test.setTimeout(15 * 60_000);
  const rouboDir = await stateDir(request);
  snapshot = snapshotStateFiles(rouboDir);
  scratchDir = fs.mkdtempSync(path.join(rouboDir, "e2e-hr-tc-048-"));
  const project = await registerLantern(request);
  await installDatabase(request);
  const ctx: SurfaceContext = { request, rouboDir, project, idleBenchId: 1, scratchDir };
  await openWithStream(page, `/projects/${PROJECT_ID}`);

  const results: { input: string; p95: number; max: number; lost: number }[] = [];
  for (const input of CHANGED_INPUTS) {
    await test.step(`S001: ${SAVES_PER_SURFACE} saves of ${input}`, async () => {
      const samples: number[] = [];
      let lost = 0;
      for (let n = 1; n <= SAVES_PER_SURFACE; n += 1) {
        await dismissNotices(page);
        const save = await SURFACES[input].save(ctx, n);
        const start = Date.now();
        await save.write();
        const shown = await waitForNotice(page, save.notice, WAIT_MS);
        const elapsed = Date.now() - start;
        if (shown === null) lost += 1;
        samples.push(shown === null ? WAIT_MS : elapsed);
      }
      results.push({ input, p95: percentile(samples, 95), max: Math.max(...samples), lost });
    });
  }

  console.log(
    `perf-evidence ${JSON.stringify({ case: "HR-TC-048", budgetP95Ms: BUDGET_P95_MS, results })}`,
  );
  const breaches = results.filter((r) => r.p95 > BUDGET_P95_MS || r.lost > 0);
  expect(
    breaches,
    `every surface shows its save within ${BUDGET_P95_MS} ms at p95: ${JSON.stringify(results)}`,
  ).toEqual([]);
});
