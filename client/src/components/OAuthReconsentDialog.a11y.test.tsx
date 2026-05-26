// @vitest-environment jsdom
//
// WU-036 / TC-099: zero serious axe violations on the OAuth re-consent dialog.
// The dialog has internal phase state driven by deep-link callbacks; this
// test renders the initial idle state and the error state (triggered via
// startGithubPluginOauth rejection) so axe can scan two of the visually
// distinct DOM trees. The connecting / waiting-for-browser / success states
// share markup with these two (a heading, copy block, button cluster, and a
// status banner with role="status" or role="alert"), so the per-state risk
// surface is well-covered by these two.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OAuthReconsentDialog from "./OAuthReconsentDialog";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}

expect.extend({ toHaveNoViolations });

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    startGithubPluginOauth: vi.fn(),
  };
});

import { startGithubPluginOauth } from "../lib/api";

const mockedStart = vi.mocked(startGithubPluginOauth);

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OAuthReconsentDialog — axe-core (WU-036)", () => {
  it("has no axe violations in the initial idle state", async () => {
    const { baseElement } = renderWithClient(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={() => {}}
        onSuccess={() => {}}
        onCancelled={() => {}}
      />,
    );
    // React Aria's Modal portals outside the render container; scan the full
    // document body so the dialog markup is included.
    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in the error state", async () => {
    mockedStart.mockRejectedValueOnce(new Error("Network unreachable"));
    const user = userEvent.setup();
    const { baseElement, getByTestId } = renderWithClient(
      <OAuthReconsentDialog
        isOpen
        onOpenChange={() => {}}
        onSuccess={() => {}}
        onCancelled={() => {}}
      />,
    );

    await user.click(getByTestId("oauth-reconsent-continue"));
    await waitFor(() => {
      expect(getByTestId("oauth-reconsent-live-region").textContent).toContain("failed");
    });

    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });
});
