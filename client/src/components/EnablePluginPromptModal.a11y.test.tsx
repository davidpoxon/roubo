// @vitest-environment jsdom
//
// TC-152 (WCAG 2.1 AA): the Enable-plugin prompt modal must pass an axe-core
// scan. We render the idle state (initial focus on the Enable confirm button)
// and the error state (after a failed enable attempt surfaces the inline
// error banner), since these are the two visually distinct trees the user can
// encounter. The pending state shares markup with idle except for a disabled
// Enable button, so it's covered by the idle scan.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EnablePluginPromptModal from "./EnablePluginPromptModal";
import { expectNoAxeFindings } from "../test/axe";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    enablePlugin: vi.fn(),
  };
});

// The shared useEnablePlugin hook routes errors through a global toast. Stub
// it so the hook can render outside a ToastProvider without affecting the axe
// markup under test.
vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

import { enablePlugin } from "../lib/api";

const mockedEnablePlugin = vi.mocked(enablePlugin);

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EnablePluginPromptModal: axe-core (TC-152, WCAG 2.1 AA)", () => {
  it("has no axe violations in the idle state", async () => {
    const { baseElement } = renderWithClient(
      <EnablePluginPromptModal
        projectId="proj-1"
        pluginId="github-com"
        pluginName="GitHub.com"
        onCancel={() => {}}
        onEnabled={() => {}}
      />,
    );
    // React Aria's Modal portals outside the render container; scan the full
    // document body so the dialog markup is included.
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe violations in the inline-error state", async () => {
    mockedEnablePlugin.mockRejectedValueOnce(new Error("plugin process refused to start"));
    const user = userEvent.setup();
    const { baseElement, getByTestId } = renderWithClient(
      <EnablePluginPromptModal
        projectId="proj-1"
        pluginId="github-com"
        pluginName="GitHub.com"
        onCancel={() => {}}
        onEnabled={() => {}}
      />,
    );

    await user.click(getByTestId("enable-plugin-confirm"));
    await waitFor(() => {
      expect(getByTestId("enable-plugin-error")).toBeInTheDocument();
    });

    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });
});
