import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";

// TC-181 (US-025, FR-077, FR-078, FR-080, NFR-018): the harness's own
// self-test. Proves the spawn-roundtrip chain is deterministic at the full
// HTTP layer: POST /test/__reset -> plugin-manager respawn -> --scenario /
// --now argv -> spawned plugin process -> HTTP response, twice, byte-identical.
//
// Layered with sibling coverage so this spec stays minimal:
//   - TC-176 (WU-067) covers in-process determinism at the JSON-RPC layer
//     (e2e/fixtures/stubbed-plugin/src/__tests__/determinism.test.ts).
//   - TC-177 (WU-068) covers the /test/__reset 404 gate when ROUBO_E2E is
//     unset (server/routes/test.test.ts).
//
// Adding more endpoints or assertions here would duplicate that coverage and
// widen the harness self-test's own flake surface. NFR-018 demands zero
// retries; the suite-wide 10-run reliability budget is tracked at #216
// (TC-148).

const SCENARIO = "meta-e2e-self-test";
const NOW = "2026-05-26T12:00:00.000Z";

test("byte-identical connection-status across two resets with the same --scenario + --now", async ({
  request,
}) => {
  await resetWithScenario(request, SCENARIO, NOW);
  const firstRes = await request.get("/api/plugins/e2e-stub/connection-status");
  expect(firstRes.status()).toBe(200);
  const firstText = await firstRes.text();
  const firstBody = JSON.parse(firstText) as {
    state: string;
    detail?: string;
    checkedAt?: string;
  };
  // Sanity-assert the pinned argv reached the spawned process. Without this,
  // a regression that silently stopped flowing --scenario / --now would still
  // pass: two identical-but-wrong responses are still byte-identical.
  expect(firstBody.state).toBe("connected");
  expect(firstBody.detail).toBe("meta self-test stub");
  expect(firstBody.checkedAt).toBe(NOW);

  await resetWithScenario(request, SCENARIO, NOW);
  const secondRes = await request.get("/api/plugins/e2e-stub/connection-status");
  expect(secondRes.status()).toBe(200);
  const secondText = await secondRes.text();

  // Compare the raw response body (not re-serialized JSON) so any
  // non-determinism in field ordering or whitespace would surface.
  expect(secondText).toBe(firstText);
});
