import { expect, test } from "@playwright/test";
import {
  expectConnectionStatePillState,
  fetchConnectionStateLog,
  resetWithScenario,
} from "../e2e-flow/_support/scenario.js";

// TC-169 (US-014, FR-054, FR-055, NFR-017, NFR-023): a previously-connected
// plugin whose next `getConnectionStatus` returns `auth-problem` causes the
// chip to flip to "Sign in again" with a "Token expired" tooltip, and the
// transition is recorded in the observability log.
//
// The stubbed plugin's `connectionStatusSequence` returns "connected" on the
// first call and "auth-problem" on the second. The spec pre-warms the server
// cache with a direct API call (call #1), then loads Settings > Plugins (call
// #2, triggered by `useConnectionStatus` + `useOpportunisticRecheckOnMount`)
// and asserts the chip has flipped together with the journal entry.
//
// The "rechecking..." transient is part of the UX requirement but is too
// timing-sensitive to assert deterministically under NFR-018's zero-retry
// budget across 10 CI runs, so this spec asserts the *result* of the flip
// (final pill state + the tap entry) rather than the intermediate text. The
// tap is the ROUBO_E2E=1-only mirror of the structured log emitted by
// `recordConnectionStateTransition` (TC-153 / NFR-023).

const SCENARIO = "status-auth-problem-flip";
const NOW = "2026-05-22T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("token expiry flips the chip to auth-problem and journals the transition", async ({
  page,
  request,
}) => {
  // Pre-warm: this is the "github.com connected" precondition. The server
  // caches the stub's first sequence entry (state: "connected").
  const warmRes = await request.get("/api/plugins/e2e-stub/connection-status");
  expect(warmRes.status()).toBe(200);
  const warmBody = (await warmRes.json()) as { state: string; detail?: string };
  expect(warmBody.state).toBe("connected");

  // Navigating to Settings > Plugins fires the opportunistic recheck, which
  // forces a fresh RPC. The stub returns its second sequence entry
  // ("auth-problem" with detail "Token expired"), the chip transitions, and
  // the server pushes a connected → auth-problem entry to the journal.
  await page.goto("/settings#plugins");

  const stubCard = page.locator('[data-testid="plugin-card"][data-plugin-id="e2e-stub"]');
  await expect(stubCard).toBeVisible();
  await expectConnectionStatePillState(stubCard, "auth-problem");

  // Tooltip detail surface. React Aria's TooltipTrigger only opens after a
  // pointer-warmup delay (and only on real keyboard focus), so opening the
  // tooltip from Playwright is flaky under NFR-018's zero-retry budget.
  // The pill projects the same string into `aria-label` (`"Sign in again:
  // Token expired"`), so assistive tech sees the detail even with the popup
  // closed — assert on that instead. The aria-label is the contractual
  // accessibility surface; the visible tooltip is a UX echo of it.
  const pill = stubCard.getByTestId("connection-status-pill");
  await expect(pill).toHaveAttribute("aria-label", "Sign in again: Token expired");

  // Journal assertion: filter for the connected → auth-problem transition
  // rather than asserting on total length, so a future change that adds a
  // null → connected pre-warm entry (or any other trigger) does not flake
  // this spec.
  const entries = await fetchConnectionStateLog(request);
  const flip = entries.filter(
    (e) =>
      e.pluginId === "e2e-stub" &&
      e.previousState === "connected" &&
      e.newState === "auth-problem" &&
      e.trigger === "ui-recheck",
  );
  expect(flip).toHaveLength(1);
});
