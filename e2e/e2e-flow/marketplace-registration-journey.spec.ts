import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { FIRST_PARTY_SOURCE_ID, type MarketplaceSourceSummary } from "@roubo/shared";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";

// CPHMTP-TC-002 (CPHMTP-FR-001 / FR-002 / FR-003 / NFR-003 / US-001 / US-004,
// issue #570): end-to-end proof of the register-a-third-party-marketplace
// journey. An operator opens Settings > Marketplaces, clicks "Add marketplace…",
// consents in the registration dialog (raw URL shown verbatim, a masked
// credential, the arbitrary-code acknowledgement gating Register), registers,
// and the new source lands in the list as an Unverified row whose meta records
// the registration date and credential.
//
// This is the integration-level drift guard for the journey spanning slices
// #553 (the marketplace source registry: GET/POST /api/marketplace/sources, the
// persisted row that doubles as the FR-002 consent record) and #562 (the
// registration consent modal: aria-disabled Register, masked credential, raw
// URL). It drives the authoritative CPHMTP-TC-002 e2e_flow steps S001-S008 as
// ordered, attributable observations. On divergence each observation routes
// through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice issue(s), so a red run
// localises the drift to one attributable slice (issue #570 acceptance
// criterion 9).
//
// UI observations are asserted directly against the shipped selectors; backend
// side-effects are asserted via GET /api/marketplace/sources, where the
// persisted row IS the consent record (url, hasCredential, registeredAt, and,
// by construction, an unsigned non-first-party id). The credential itself is
// never read back (it lives in the OS keyring); the API's `hasCredential:true`
// proxy is what this guard asserts (Keyring-on-CI note below).
//
// Deep-link idiom: the built server's SPA fallback 404s on a direct GET of
// /settings, so this navigates from the already-loaded shell via
// window.history.pushState + a PopStateEvent, the same idiom the plugin-grid
// spec uses to reach /settings#plugins.
//
// Three deliberate reconciliations against the literal CPHMTP-TC-002 script,
// all asserting SHIPPED behaviour (the objective is a test that PASSES against
// the integrated system), each flagged for later spec reconciliation:
//   - S007-O01: TC-002 expects an explicit confirmation that "the source was
//     registered and consent recorded". The shipped Add path shows NO success
//     toast: it only closes the modal, and the row appears in the list. This
//     guard asserts modal-closed + row-present rather than a toast.
//   - S007-O03: TC-002 expects "no catalog fetch triggered by registration".
//     At Playwright fidelity this guard asserts the achievable proxy:
//     registration completes as a pure write with no error surfaced and the
//     source persisted as an untouched unsigned row. The full-fidelity backend
//     assertions (keyring `set` called, catalog fetch-count 0, unsigned row
//     persisted) live in the in-process vitest journey
//     server/services/marketplace-tamper-tc049-journey.e2e.test.ts.
//   - S008-O02: TC-002 expects the row meta to read "credential attached
//     (Authorization)". The shipped row renders "· credential attached" (no
//     "(Authorization)" suffix). This guard asserts the shipped copy.
//
// Keyring on CI: POST /api/marketplace/sources with a credential writes to the
// real OS keyring via credential-store. On this macOS dev host the `security`
// CLI makes that write succeed; on a headless CI runner with no secret service
// the write can fail and the pure-write POST would 500. The server tests all
// mock credential-store (they never touch a real keyring), so this is the first
// e2e path to exercise a real keyring write. See the final summary / issue #570
// notes: if the CI e2e job lacks a keyring, the credential leg needs a keyring
// step in .github/workflows/e2e.yml (or an e2e credential-store stub), which is
// out of scope for this test-authoring unit. This guard asserts the keyring
// only through the API's `hasCredential:true` proxy, never by reading the
// secret back.

const SCENARIO = "default";
const NOW = "2026-07-18T10:00:00.000Z";

// A well-formed https catalog URL that is NOT the reserved first-party URL, in
// canonical WHATWG-href form so the value typed into the field equals the
// normalised value the server persists (validated.href). Registration is a
// PURE WRITE (CPHMTP-NFR-003), so no host is ever contacted; example.com is a
// reserved documentation host and safe as a never-fetched candidate.
const REGISTER_URL = "https://plugins.example.com/catalog.json";
// The optional credential the operator enters. Asserted masked in the field
// (type=password) and, once registered, surfaced only as the API's
// `hasCredential:true` and the row's "· credential attached" meta.
const CREDENTIAL = "s3cr3t-marketplace-token";

// The slice issues that own each phase of the journey (issue #570 Blocked by),
// used by the FR-020 failure-output contract to attribute a divergence.
const SLICE = {
  registry: {
    issue: 553,
    title:
      "marketplace source registry: GET/POST /api/marketplace/sources, the persisted consent record",
  },
  consentModal: {
    issue: 562,
    title: "registration consent modal: aria-disabled Register, masked credential, raw URL",
  },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction:
      "Open Settings > Marketplaces with no third-party source registered yet (built-in first-party present)",
    owners: [SLICE.registry],
  },
  S002: {
    id: "S002",
    instruction:
      'Click "Add marketplace…"; the registration consent modal opens with the consent-before-fetch sub-text',
    owners: [SLICE.consentModal],
  },
  S003: {
    id: "S003",
    instruction:
      "The Marketplace URL field shows the raw candidate URL exactly as it will be fetched",
    owners: [SLICE.consentModal],
  },
  S004: {
    id: "S004",
    instruction: "Enter the optional credential; the field is masked (type=password)",
    owners: [SLICE.consentModal],
  },
  S005: {
    id: "S005",
    instruction:
      'Before acknowledging, "Register marketplace" is gated (aria-disabled="true"); decline is the default',
    owners: [SLICE.consentModal],
  },
  S006: {
    id: "S006",
    instruction:
      'Check the arbitrary-code acknowledgement; "Register marketplace" becomes enabled (aria-disabled="false")',
    owners: [SLICE.consentModal],
  },
  S007: {
    id: "S007",
    instruction:
      "Click Register; the modal closes and the consent record is persisted (no catalog fetch)",
    owners: [SLICE.consentModal, SLICE.registry],
  },
  S008: {
    id: "S008",
    instruction:
      'Return to the Marketplaces list; the new source is a row with its URL, an "Unverified source" marker, and the registration meta',
    owners: [SLICE.registry],
  },
};

const observe = makeObserve("CPHMTP-TC-002");

/**
 * Run a web-first Playwright assertion (which retries until it passes or times
 * out) and reduce it to a boolean, so an observation can wait for an async UI
 * transition yet still route its pass/fail through the FR-020 observer rather
 * than throwing a bare Playwright error with no slice attribution.
 */
async function toBool(assertion: Promise<unknown>): Promise<boolean> {
  return assertion.then(
    () => true,
    () => false,
  );
}

async function fetchSources(request: APIRequestContext): Promise<MarketplaceSourceSummary[]> {
  const res = await request.get("/api/marketplace/sources");
  expect(res.status(), "GET /api/marketplace/sources").toBe(200);
  const body = (await res.json()) as { sources: MarketplaceSourceSummary[] };
  return body.sources;
}

/**
 * `/test/__reset` does not wipe marketplace-sources.json (it survives a reset by
 * design), so a source registered by a prior run of this spec would break S001's
 * precondition and turn the S007 POST into a 409 replace. Remove any row at the
 * test URL after the reset so every run (including the 10x reliability sweep)
 * starts from "this source is not registered yet". DELETE guards its keyring
 * cleanup, so this is safe on a keyring-less CI host too.
 */
async function removeSourceIfPresent(request: APIRequestContext, url: string): Promise<void> {
  const existing = (await fetchSources(request)).find((s) => s.url === url);
  if (existing) {
    const del = await request.delete(`/api/marketplace/sources/${existing.id}`);
    expect([204, 404], "DELETE pre-existing test source").toContain(del.status());
  }
}

/**
 * Load the built shell, then client-side navigate to /settings#marketplaces so
 * ProjectSettings mounts with the Marketplaces tab pre-selected. Direct GET of
 * /settings 404s (SPA fallback), so drive history from the loaded shell.
 */
async function openMarketplacesSettings(page: Page): Promise<void> {
  await loadAppShell(page);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/settings#marketplaces");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
  await removeSourceIfPresent(request, REGISTER_URL);
});

test("CPHMTP-TC-002: register a third-party marketplace end to end (S001-S008 drift guard)", async ({
  request,
  page,
}) => {
  // ---- S001: open Settings > Marketplaces; the built-in first-party source is
  // present and the candidate URL is not registered yet.
  await openMarketplacesSettings(page);
  const addButton = page.getByTestId("add-marketplace");
  const addVisible = await toBool(expect(addButton).toBeVisible());

  const before = await fetchSources(request);
  const firstPartyPresent = before.some((s) => s.id === FIRST_PARTY_SOURCE_ID);
  const targetNotRegistered = !before.some((s) => s.url === REGISTER_URL);
  observe(
    STEPS.S001,
    "O01",
    addVisible && firstPartyPresent && targetNotRegistered,
    `the Marketplaces settings section is reachable, the built-in first-party source is listed, and ${REGISTER_URL} is not registered yet`,
    `add button visible=${addVisible}, first-party present=${firstPartyPresent}, target already registered=${!targetNotRegistered}`,
  );

  // ---- S002: click "Add marketplace…"; the consent modal opens with its
  // consent-before-fetch sub-text.
  await addButton.click();
  const modal = page.getByTestId("marketplace-source-consent-modal");
  const modalOpen = await toBool(expect(modal).toBeVisible());
  const titleShown = await toBool(
    expect(modal.getByText("Register a third-party marketplace", { exact: false })).toBeVisible(),
  );
  observe(
    STEPS.S002,
    "O01",
    modalOpen && titleShown,
    'clicking "Add marketplace…" opens the registration consent modal (title "Register a third-party marketplace")',
    `modal visible=${modalOpen}, title visible=${titleShown}`,
  );
  const consentBeforeFetch = await toBool(
    expect(
      modal.getByText("nothing is requested from it until you register", { exact: false }),
    ).toBeVisible(),
  );
  observe(
    STEPS.S002,
    "O02",
    consentBeforeFetch,
    "the modal sub-text states nothing is requested from the URL until you register (consent before fetch)",
    consentBeforeFetch ? "sub-text present" : "consent-before-fetch sub-text not found",
  );
  const warningShown = await toBool(
    expect(modal.getByTestId("marketplace-source-consent-warning")).toBeVisible(),
  );
  observe(
    STEPS.S002,
    "O03",
    warningShown,
    "the unsigned / arbitrary-code warning block is shown in the modal",
    warningShown ? "warning block present" : "warning block absent",
  );

  const urlInput = modal.getByTestId("marketplace-source-consent-url").locator("input");
  const credInput = modal.getByTestId("marketplace-source-consent-credential").locator("input");
  const ack = modal.getByTestId("marketplace-source-consent-ack");
  const confirm = modal.getByTestId("marketplace-source-consent-confirm");

  // ---- S003: the URL field shows the raw candidate URL exactly as it will be
  // fetched (type=url, verbatim value, "shown exactly as it will be fetched" hint).
  await urlInput.fill(REGISTER_URL);
  const urlType = await urlInput.getAttribute("type");
  const urlValue = await urlInput.inputValue();
  observe(
    STEPS.S003,
    "O01",
    urlType === "url" && urlValue === REGISTER_URL,
    `the Marketplace URL field shows the raw candidate URL exactly ("${REGISTER_URL}", type=url)`,
    `type=${urlType}, value="${urlValue}"`,
  );
  const hintShown = await toBool(
    expect(modal.getByText("Shown exactly as it will be fetched.", { exact: false })).toBeVisible(),
  );
  observe(
    STEPS.S003,
    "O02",
    hintShown,
    'the URL field hint confirms it is "shown exactly as it will be fetched"',
    hintShown ? "hint present" : "hint absent",
  );

  // ---- S004: the credential field is masked (type=password).
  await credInput.fill(CREDENTIAL);
  const credType = await credInput.getAttribute("type");
  observe(
    STEPS.S004,
    "O01",
    credType === "password",
    "the Credential field is masked (type=password)",
    `type=${credType}`,
  );

  // ---- S005: before acknowledging, Register is gated. CRITICAL: the control is
  // aria-disabled (NOT native disabled), so assert the attribute, never :disabled.
  const gatedBefore = await toBool(expect(confirm).toHaveAttribute("aria-disabled", "true"));
  observe(
    STEPS.S005,
    "O01",
    gatedBefore,
    'Register is gated (aria-disabled="true") before the acknowledgement, even with the URL filled (decline is the default)',
    `aria-disabled="${await confirm.getAttribute("aria-disabled")}"`,
  );

  // ---- S006: checking the arbitrary-code acknowledgement enables Register.
  await ack.click();
  const enabledAfter = await toBool(expect(confirm).toHaveAttribute("aria-disabled", "false"));
  observe(
    STEPS.S006,
    "O01",
    enabledAfter,
    'Register becomes enabled (aria-disabled="false") once the acknowledgement is checked',
    `aria-disabled="${await confirm.getAttribute("aria-disabled")}"`,
  );

  // ---- S007: click Register. The modal closes (no success toast ships; see
  // S007-O01 note above), the consent record is persisted, and registration is
  // a pure write (no catalog fetch, no error surfaced).
  await confirm.click();
  const modalClosed = await toBool(expect(modal).toBeHidden());
  observe(
    STEPS.S007,
    "O01",
    modalClosed,
    "the consent modal closes after Register (shipped shows no success toast; TC-002 expected an explicit 'registered + consent recorded' confirmation)",
    modalClosed ? "modal closed" : "modal still visible",
  );

  const after = await fetchSources(request);
  const registered = after.find((s) => s.url === REGISTER_URL);
  const recordPersisted =
    registered !== undefined &&
    registered.id !== FIRST_PARTY_SOURCE_ID &&
    registered.hasCredential === true &&
    typeof registered.registeredAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(registered.registeredAt);
  observe(
    STEPS.S007,
    "O02",
    recordPersisted,
    `a consent record is persisted for ${REGISTER_URL} (unsigned non-first-party row, hasCredential=true, ISO registeredAt) via GET /api/marketplace/sources`,
    `persisted row=${JSON.stringify(registered ?? null)}`,
  );
  // S007-O03: no catalog fetch at Playwright fidelity. The modal stays open on a
  // failed pure-write, so modal-closed + a persisted unsigned row is the
  // achievable proxy for "registration succeeded with no fetch and no error
  // surfaced". Full-fidelity fetch-count/keyring assertions:
  // server/services/marketplace-tamper-tc049-journey.e2e.test.ts.
  observe(
    STEPS.S007,
    "O03",
    modalClosed && recordPersisted,
    "registration is a pure write: it completes with no error surfaced and no catalog fetch is triggered (full-fidelity fetch-count/keyring assertions live in the vitest tamper journey)",
    `modal closed=${modalClosed}, unsigned row persisted=${recordPersisted}`,
  );

  // ---- S008: back on the Marketplaces list, the new source is a row with its
  // URL, an "Unverified source" marker, and the registration meta.
  const sourceId = registered?.id ?? "";
  const row = page.locator(`[data-testid="marketplace-source-row"][data-source-id="${sourceId}"]`);
  const rowVisible = await toBool(expect(row).toBeVisible());
  const rowUrl = (await row.getByTestId("marketplace-source-url").textContent())?.trim();
  const pill = row.getByTestId("marketplace-source-pill");
  const pillVerified = await pill.getAttribute("data-verified");
  const pillText = (await pill.textContent())?.trim() ?? "";
  observe(
    STEPS.S008,
    "O01",
    rowVisible &&
      rowUrl === REGISTER_URL &&
      pillVerified === "false" &&
      pillText.includes("Unverified source"),
    `the new source appears as a row showing its URL (${REGISTER_URL}) and an "Unverified source" marker`,
    `row visible=${rowVisible}, url="${rowUrl}", pill data-verified=${pillVerified}, pill text="${pillText}"`,
  );

  const metaText = (await row.getByTestId("marketplace-source-meta").textContent())?.trim() ?? "";
  // Shipped copy is "Registered <YYYY-MM-DD> · credential attached" (U+00B7
  // middot). TC-002 expected the "(Authorization)" suffix, which does NOT ship
  // (see the S008-O02 reconciliation note above).
  const metaMatches =
    /^Registered \d{4}-\d{2}-\d{2}/.test(metaText) &&
    metaText.includes("· credential attached") &&
    !metaText.includes("(Authorization)");
  observe(
    STEPS.S008,
    "O02",
    metaMatches,
    'the row meta shows "Registered <YYYY-MM-DD> · credential attached" (shipped copy; TC-002 expected the "(Authorization)" suffix, which does not ship)',
    `meta="${metaText}"`,
  );
});
