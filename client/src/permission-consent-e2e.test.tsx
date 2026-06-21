// @vitest-environment jsdom
//
// Integration-level E2E test for the permission-consent journey: a consumer
// reviews the declared permissions of a first-party (Redis-shaped) component
// plugin, ticks the acknowledgement, and consents before the plugin runs,
// asserting the authoritative e2e_flow case CP-TC-076 step by step (issue #625).
//
// This is the journey's drift guard, mirroring server/component-plugins-e2e.test.ts
// (the CP-TC-027 / #623 drift guard): it exercises the integrated journey through
// the already-shipped, real seams of the slices it spans, rather than re-testing
// any single slice. The slices owned by this work unit are #599 (the consent
// journey), #602 (the `declaredCategories` derivation + ports/docker categories),
// #615 (the PermissionConsentModal + consent gate), #618, and #620. A failing
// step is localised back to the owning slice(s) via OWNING_SLICES below (FR-020).
//
// Hermetic by construction (matching the PermissionConsentModal.test.tsx
// precedent): a real QueryClientProvider, the REAL PermissionConsentModal, and
// the REAL useGrantConsent mutation, with only the `../lib/api` consent boundary
// mocked (no network, no real server). The useToast hook is mocked so the error
// path's addToast emits no console noise.
//
// FIDELITY NOTE (asserts the real shipped behaviour, now matched by the spec):
// CP-TC-076's authoritative prose has been reconciled to the shipped consent UX
// (#678 chose option 1: reconcile the spec, keep the marketplace install flow out
// of scope for v1). The spec now states the shipped surfaces, so this guard's
// assertions and CP-TC-076's prose agree: the "Review permissions for {name}"
// title, the "Acknowledge and continue" confirm label, the "Docker" /
// "Network ports" categories with their generic descriptions, the grantConsent ->
// onConsented seam (no success toast, no marketplace badge, no `roubo/redis`
// v1.3.0 plugin identity), and the aria-disabled confirm gate (NFR-007). This
// guard still asserts the integrated journey through the shipped seams, exactly as
// CP-TC-027 did; #678 is now closed out by the reconciled prose.
//
// Icon discrepancy (S002): CP-TC-076 now specifies a "shield-check" trust icon, in
// line with the shipped modal, which renders ShieldCheck for a first-party plugin
// (ShieldAlert is reserved for third-party). S002 asserts the trust banner's
// content/role (unsandboxed in this release + the v2-isolation note) and
// data-first-party, NOT the exact icon.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginPermissions } from "@roubo/shared";
import PermissionConsentModal from "./components/PermissionConsentModal";

// Mock only the consent boundary in ../lib/api; everything else (the real
// useGrantConsent mutation, declaredCategories, the modal) runs for real.
vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    grantPluginConsent: vi.fn(),
  };
});

// useToast's addToast is called by useGrantConsent's onError. Mock it so no
// toast side effect (and no console noise) escapes the hermetic harness.
vi.mock("./hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

import { grantPluginConsent } from "./lib/api";

const mockedGrant = vi.mocked(grantPluginConsent);

// The slices this journey integrates, from #625's covers set. Reported when a
// step diverges so a failure is attributable to a slice (FR-020).
const OWNING_SLICES = "#599, #602, #615, #618, #620";

const PLUGIN_ID = "redis";
const PLUGIN_NAME = "Redis";

// The Redis-shaped first-party manifest the consumer reviews: network hosts are
// empty (so network is NOT declared), docker is an empty object, and ports names
// the redis component. declaredCategories() therefore surfaces EXACTLY ports and
// docker, in PERMISSION_CATEGORIES order (ports before docker), and nothing else.
function redisPermissions(): PluginPermissions {
  return {
    network: { hosts: [] },
    credentials: { slots: [] },
    filesystem: { paths: [] },
    processes: false,
    ports: { names: ["redis"] },
    docker: {},
  } as PluginPermissions;
}

function renderConsentModal(onConsented: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PermissionConsentModal
        pluginId={PLUGIN_ID}
        pluginName={PLUGIN_NAME}
        declared={redisPermissions()}
        firstParty
        onCancel={() => {}}
        onConsented={onConsented}
      />
    </QueryClientProvider>,
  );
}

// ── Canonical CP-TC-076 step sequence (single source of truth) ──
//
// The labels are both what each step runs under and the expected order the
// terminal drift guard asserts against: drop or reorder a step and the recorded
// run no longer equals TC076_SEQUENCE, so the test fails (mirrors TC027_SEQUENCE
// in the component-plugins-e2e precedent).
const TC076_STEPS = {
  modalPresent: "S001 Consumer: the consent modal is present over a modal backdrop",
  trustBanner:
    "S002 Consumer: the trust banner states the plugin is unsandboxed in this release, notes enforced isolation in v2, and carries data-first-party true",
  permissionList:
    "S003 Consumer: the permission list shows EXACTLY the two declared categories (docker, ports) with plain-language descriptions and no extras",
  confirmGated:
    "S004 Consumer: the confirm control is gated (aria-disabled true) before acknowledgement and pressing it does not fire the consent mutation",
  ackEnables:
    "S005 Consumer: ticking the acknowledgement checkbox enables the confirm control (aria-disabled false)",
  confirmConsents:
    "S006 Consumer: pressing the enabled confirm fires grantConsent with the acknowledged categories and the onConsented callback runs",
} as const;
const TC076_SEQUENCE = [
  TC076_STEPS.modalPresent,
  TC076_STEPS.trustBanner,
  TC076_STEPS.permissionList,
  TC076_STEPS.confirmGated,
  TC076_STEPS.ackEnables,
  TC076_STEPS.confirmConsents,
];

// ── FR-020 failure-output wrapper ──
//
// Each CP-TC-076 step runs inside step(): on divergence it reports the diverging
// step label, the expected-vs-actual, and the owning slice issue(s), so a failure
// is attributable to a slice rather than the whole journey.
async function step<T>(label: string, expectation: string, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `CP-TC-076 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${OWNING_SLICES}`,
      { cause },
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Permission-consent E2E (CP-TC-076): consumer reviews declared permissions and consents", () => {
  it("runs the full journey end to end and matches CP-TC-076", async () => {
    const executed: string[] = [];
    const track = async <T,>(
      label: string,
      expectation: string,
      body: () => T | Promise<T>,
    ): Promise<T> => {
      const result = await step(label, expectation, body);
      executed.push(label);
      return result;
    };

    mockedGrant.mockResolvedValueOnce({
      pluginId: PLUGIN_ID,
      acknowledgedCategories: ["ports", "docker"],
      consentedAt: "2026-06-22T00:00:00.000Z",
    });
    const onConsented = vi.fn();
    const user = userEvent.setup();
    const { getByTestId } = renderConsentModal(onConsented);

    // S001: the consent modal is present with a modal backdrop (#615).
    await track(
      TC076_STEPS.modalPresent,
      "the permission-consent-modal renders inside a modal backdrop overlay",
      () => {
        const modal = getByTestId("permission-consent-modal");
        expect(modal).toBeInTheDocument();
        // The ModalOverlay backdrop wraps the dialog (bg + backdrop-blur).
        const overlay = modal.closest("[class*='backdrop-blur']");
        expect(overlay).not.toBeNull();
      },
    );

    // S002: the trust banner is present, states the plugin is unsandboxed in this
    // release and notes enforced isolation arrives in v2, and carries
    // data-first-party true (#615). Asserts content/role, NOT the icon (see the
    // icon-discrepancy note in the header: the modal renders ShieldCheck for a
    // first-party plugin, not the "shield-alert" TC-076 names).
    await track(
      TC076_STEPS.trustBanner,
      "permission-consent-trust reports unsandboxed-in-this-release, the v2-isolation note, and data-first-party true",
      () => {
        const trust = getByTestId("permission-consent-trust");
        expect(trust).toBeInTheDocument();
        expect(trust.getAttribute("data-first-party")).toBe("true");
        expect(trust.textContent).toMatch(/unsandboxed in this release/i);
        expect(trust.textContent).toMatch(/v2/i);
        expect(trust.textContent).toMatch(/isolation/i);
      },
    );

    // S003: the permission list shows EXACTLY the two declared categories
    // (docker, ports) with plain-language descriptions and NO extras. This
    // exercises the declaredCategories derivation: empty network.hosts means
    // network is not declared (#602).
    await track(
      TC076_STEPS.permissionList,
      "permission-consent-list lists exactly docker and ports with plain-language descriptions and no other categories",
      () => {
        const list = getByTestId("permission-consent-list");
        const items = list.querySelectorAll("[data-category]");
        const categories = Array.from(items).map((el) => el.getAttribute("data-category"));
        // Exactly the two declared categories, in PERMISSION_CATEGORIES order.
        expect(categories).toEqual(["ports", "docker"]);
        // Plain-language descriptions for each (the modal's generic copy).
        expect(within(list).getByText(/Network ports/)).toBeInTheDocument();
        expect(within(list).getByText(/Allocate bench ports: redis\./)).toBeInTheDocument();
        expect(within(list).getByText(/^Docker$/)).toBeInTheDocument();
        expect(
          within(list).getByText(/Manage Docker containers via the host broker\./),
        ).toBeInTheDocument();
        // No extra categories leaked in (network has empty hosts, so not declared).
        expect(list.querySelector('[data-category="network"]')).toBeNull();
        expect(list.querySelector('[data-category="credentials"]')).toBeNull();
        expect(list.querySelector('[data-category="filesystem"]')).toBeNull();
        expect(list.querySelector('[data-category="processes"]')).toBeNull();
      },
    );

    // S004: the confirm control is gated (aria-disabled true, not native
    // disabled, per NFR-007) before the acknowledgement is ticked, and pressing
    // it does not fire the consent mutation (the guarded no-op) (#615).
    await track(
      TC076_STEPS.confirmGated,
      "permission-consent-confirm is aria-disabled true before acknowledgement and pressing it does not call grantConsent",
      async () => {
        const confirm = getByTestId("permission-consent-confirm");
        expect(confirm.getAttribute("aria-disabled")).toBe("true");
        expect(confirm).not.toBeDisabled();
        await user.click(confirm);
        expect(mockedGrant).not.toHaveBeenCalled();
        expect(onConsented).not.toHaveBeenCalled();
      },
    );

    // S005: ticking the acknowledgement checkbox enables the confirm control
    // (aria-disabled false) (#615).
    await track(
      TC076_STEPS.ackEnables,
      "ticking permission-consent-ack flips permission-consent-confirm to aria-disabled false",
      async () => {
        await user.click(getByTestId("permission-consent-ack"));
        expect(getByTestId("permission-consent-confirm").getAttribute("aria-disabled")).toBe(
          "false",
        );
      },
    );

    // S006: pressing the now-enabled confirm fires grantConsent with the
    // acknowledged categories and the onConsented callback runs (the dialog-close
    // seam). The on-disk ConsentRecord persistence is covered by
    // server/component-plugins-e2e.test.ts (S007) and plugin-consent-state.test.ts,
    // so this asserts the mutation payload, not the on-disk record (#615).
    await track(
      TC076_STEPS.confirmConsents,
      "pressing the enabled confirm calls grantConsent('redis', ['ports','docker']) and runs onConsented",
      async () => {
        await user.click(getByTestId("permission-consent-confirm"));
        await waitFor(() => {
          expect(mockedGrant).toHaveBeenCalledWith(PLUGIN_ID, ["ports", "docker"]);
        });
        expect(onConsented).toHaveBeenCalled();
      },
    );

    // Terminal drift guard: the integrated run matches CP-TC-076's step sequence
    // end to end. A dropped or reordered step makes executed != TC076_SEQUENCE.
    expect(executed).toEqual(TC076_SEQUENCE);
  });

  // FR-020: prove the failure-output wrapper localises a diverging step,
  // reporting the diverging label, expected-vs-actual, and the owning slices.
  it("on failure reports the diverging step, expected-vs-actual, and owning slices", async () => {
    await expect(
      step(TC076_STEPS.confirmConsents, "the consent mutation fires", () => {
        // Drive a divergence: assert the mutation fired when it did not.
        if (!mockedGrant.mock.calls.length) {
          throw new Error("grantConsent was never called");
        }
      }),
    ).rejects.toThrow(/CP-TC-076 step diverged/);

    const captured = await step(TC076_STEPS.confirmConsents, "the consent mutation fires", () => {
      throw new Error("grantConsent was never called");
    }).catch((e: Error) => e.message);

    expect(captured).toContain("expected: the consent mutation fires");
    expect(captured).toContain("actual:   grantConsent was never called");
    expect(captured).toContain(`owning slice(s): ${OWNING_SLICES}`);
  });
});
