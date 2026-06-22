import { expect, test } from "@playwright/test";
import { registerFixtureProject, resetWithScenario } from "./_support/scenario.js";

// TC-032 (FR-006, US-002): end-to-end proof of the hard start-gate journey. With
// enforceIssueDependencies ON at the project level, attempting to start a bench
// for a Phase-3 unit (WU-051) whose upstream Phase-2 gate (WU-040) has not yet
// passed is refused with 409 GATE_BLOCKED naming WU-040. Once the Phase-2 batch
// is verified and WU-040's tracker issue closes, retrying succeeds with 201 and
// no gate-blocking error.
//
// This drives the live POST /api/projects/:id/benches route and its real
// assertGateOpen start-gate (server/services/start-gate.ts), the stubbed
// integration plugin (e2e-stub), and a real git-initialised fixture worktree
// (so S003's "the bench is created and running" provisions an actual bench,
// not a mock). The gate keys purely on enforceIssueDependencies ON + the
// unit's blockedBy; the fixture roubo.yaml turns enforcement ON via the
// registerFixtureProject `enforceIssueDependencies` knob, and the stub's
// getIssue drops a blocker once its tracker issue is journalled as closed
// (mirroring the real GitHub plugin, which lists only open blockers).
//
// Drift guard: this spec MUST follow .specifications/verify-gate/test-cases.json
// case TC-032 step for step. If TC-032 changes, update this spec to match.
// Failure-output contract (TC-032 acceptance criterion 3): every assertion below
// names the diverging step id, the expected-vs-actual, and the owning slice
// issue from this unit's blocked-by set, so a red run localizes the integration
// drift to one attributable slice:
//   - S001 (409 GATE_BLOCKED) is owned by the hard start-gate slice, #699/#722.
//   - S002 (gate transitions to passed / tracker closes) is owned by the gate
//     lifecycle slice, #721.
//   - S003 (201, bench created and running) composes both slices.

const SCENARIO = "start-gate-blocks-then-allows";
const NOW = "2026-06-22T09:00:00.000Z";

// WU-040 is WU-051's upstream Phase-2 gate tracker; WU-051 is the gated Phase-3
// unit. blockedBy carries externalIds (the gate reads them verbatim).
const WU_040 = "acme/widgets#40";
const WU_051 = "acme/widgets#51";
const WU_040_ENCODED = encodeURIComponent(WU_040);
const WU_051_ENCODED = encodeURIComponent(WU_051);

// Owning slice issues from this unit's blocked-by set, surfaced in failure
// messages so a red step points at one slice (TC-032 acceptance criterion 3).
const START_GATE_SLICE = "#699/#722 (hard start-gate)";
const GATE_LIFECYCLE_SLICE = "#721 (gate lifecycle: close-on-pass)";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-032: hard start-gate blocks WU-051, then allows it once WU-040's gate passes", async ({
  request,
}) => {
  const { projectId } = await registerFixtureProject(request, {
    projectId: "tc-032",
    plugin: "e2e-stub",
    integrationConfig: {
      sources: { repo: [{ externalId: "acme/widgets" }] },
      capturedUserId: { externalId: "alice", displayName: "Alice Stub" },
    },
    // A real repo on disk so S003's create-and-assign provisions an actual
    // worktree-backed bench ("the bench is created and running"), not a mock.
    projectRepo: "acme/widgets",
    gitInit: true,
    // Turn the host's hard start-gate ON at the project level.
    enforceIssueDependencies: true,
  });

  // ---- S001: attempt to start a bench for WU-051 before the gate has passed.
  // Expected (S001-O01): HTTP 409 GATE_BLOCKED referencing WU-040.
  const s001 = await request.post(`/api/projects/${projectId}/benches`, {
    data: { externalId: WU_051 },
  });
  const s001Body = (await s001.json()) as { code?: string; blockedBy?: string[] };
  expect(
    s001.status(),
    `S001-O01 diverged: expected HTTP 409 (gate blocked) but got ${s001.status()}; ` +
      `owning slice ${START_GATE_SLICE}`,
  ).toBe(409);
  expect(
    s001Body.code,
    `S001-O01 diverged: expected code "GATE_BLOCKED" but got ${JSON.stringify(s001Body.code)}; ` +
      `owning slice ${START_GATE_SLICE}`,
  ).toBe("GATE_BLOCKED");
  expect(
    s001Body.blockedBy,
    `S001-O01 diverged: expected the gate to reference WU-040 (${WU_040}) but got ` +
      `${JSON.stringify(s001Body.blockedBy)}; owning slice ${START_GATE_SLICE}`,
  ).toContain(WU_040);

  // No bench should have been created for the blocked unit.
  const afterBlock = await request.get(`/api/projects/${projectId}/benches`);
  expect(afterBlock.status()).toBe(200);
  const afterBlockBenches = (await afterBlock.json()) as Array<{
    assignedIssue?: { externalId: string };
  }>;
  expect(
    afterBlockBenches.some((b) => b.assignedIssue?.externalId === WU_051),
    `S001-O01 diverged: a bench was created for the blocked unit WU-051 despite the gate; ` +
      `owning slice ${START_GATE_SLICE}`,
  ).toBe(false);

  // ---- S002: verify the Phase-2 batch so WU-040's gate transitions to passed
  // (its tracker issue closes). Expected (S002-O01): WU-040's gate status
  // becomes passed/closed.
  const s002 = await request.post(
    `/api/projects/${projectId}/issues/${WU_040_ENCODED}/transitions`,
    {
      data: { transitionName: "Closed" },
    },
  );
  expect(
    s002.status(),
    `S002-O01 diverged: closing WU-040's tracker issue failed with HTTP ${s002.status()}; ` +
      `owning slice ${GATE_LIFECYCLE_SLICE}`,
  ).toBe(200);

  const wu040After = await request.get(`/api/projects/${projectId}/issues/${WU_040_ENCODED}`);
  expect(wu040After.status()).toBe(200);
  const wu040Body = (await wu040After.json()) as { currentState: string };
  expect(
    wu040Body.currentState,
    `S002-O01 diverged: expected WU-040's gate to read Closed but got ` +
      `${JSON.stringify(wu040Body.currentState)}; owning slice ${GATE_LIFECYCLE_SLICE}`,
  ).toBe("Closed");

  // With the upstream gate passed, WU-051 should no longer report WU-040 as a
  // blocker (the host re-reads blockedBy live on the start path).
  const wu051After = await request.get(`/api/projects/${projectId}/issues/${WU_051_ENCODED}`);
  expect(wu051After.status()).toBe(200);
  const wu051Body = (await wu051After.json()) as { blockedBy: string[] };
  expect(
    wu051Body.blockedBy,
    `S002-O01 diverged: WU-051 still reports WU-040 as a blocker after the gate passed ` +
      `(${JSON.stringify(wu051Body.blockedBy)}); owning slice ${GATE_LIFECYCLE_SLICE}`,
  ).not.toContain(WU_040);

  // ---- S003: retry starting a bench for WU-051. Expected (S003-O01): HTTP 201;
  // the bench is created and running, with no gate-blocking error.
  const s003 = await request.post(`/api/projects/${projectId}/benches`, {
    data: { externalId: WU_051 },
  });
  const s003Body = (await s003.json()) as {
    status?: string;
    code?: string;
    bench?: { assignedIssue?: { externalId: string } };
  };
  expect(
    s003.status(),
    `S003-O01 diverged: expected HTTP 201 (bench created) but got ${s003.status()} ` +
      `(body ${JSON.stringify(s003Body)}); owning slices ${START_GATE_SLICE} + ${GATE_LIFECYCLE_SLICE}`,
  ).toBe(201);
  // No gate-blocking error: a 201 carries the success envelope, never a
  // GATE_BLOCKED / GATE_INDETERMINATE code.
  expect(
    s003Body.status,
    `S003-O01 diverged: expected the create-and-assign success envelope but got ` +
      `${JSON.stringify(s003Body)}; owning slices ${START_GATE_SLICE} + ${GATE_LIFECYCLE_SLICE}`,
  ).toBe("success");
  expect(
    s003Body.code,
    `S003-O01 diverged: expected no gate-blocking error but got code ` +
      `${JSON.stringify(s003Body.code)}; owning slices ${START_GATE_SLICE} + ${GATE_LIFECYCLE_SLICE}`,
  ).toBeUndefined();
  expect(
    s003Body.bench?.assignedIssue?.externalId,
    `S003-O01 diverged: the created bench was not assigned WU-051 (got ` +
      `${JSON.stringify(s003Body.bench?.assignedIssue?.externalId)}); owning slices ` +
      `${START_GATE_SLICE} + ${GATE_LIFECYCLE_SLICE}`,
  ).toBe(WU_051);
});
