// @vitest-environment jsdom
//
// The controls view of the Delivery tab, by keyboard and screen reader
// (SB-TC-055; SB-FR-021, SB-FR-022, SB-NFR-004): the role matrix, the
// lifecycle buttons and the wind-down dialog are reachable and named, the
// dialog traps the focus and returns it to Wind down on close, and axe finds
// no WCAG 2.1 AA violation in either theme.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { Bench } from "@roubo/shared";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { QueryClientProvider } from "@tanstack/react-query";
import { expectNoAxeFindings } from "../../test/axe";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import { makeQueryClient, renderWithProviders } from "../../test/renderWithProviders";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    changeDeliveryRole: vi.fn(),
    pauseDelivery: vi.fn(),
    windDownDelivery: vi.fn(),
    resumeDelivery: vi.fn(),
    approveDelivery: vi.fn(),
  };
});
import * as api from "../../lib/api";
import LifecycleControls from "./LifecycleControls";
import RoleMatrix from "./RoleMatrix";

const bench = {
  id: 3,
  projectId: "demo",
  status: "active",
  variant: "specbench",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "launch",
} as unknown as Bench;

// Two roles, running, with a gating case unmet so Approve waits.
function snapshot() {
  const record = fourUnitRecord();
  record.roles = { main: { tier: "balanced" }, "unit-coder": { tier: "fast" } };
  return foldDelivery({ record, events: [] });
}

function ControlsView() {
  const current = snapshot();
  return (
    <section aria-label="Cost, health and controls">
      <RoleMatrix projectId="demo" benchId={3} snapshot={current} />
      <LifecycleControls bench={bench} snapshot={current} sessionStartBlocked={false} />
    </section>
  );
}

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Controls view accessibility", () => {
  it("SB-TC-055 every control is reachable by Tab and named, the wind-down dialog traps the focus and returns it, and axe finds nothing", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ControlsView />);

    // Every control has a name.
    const controls = [...screen.getAllByRole("combobox"), ...screen.getAllByRole("button")];
    for (const control of controls) {
      expect(control).toHaveAccessibleName();
    }
    expect(screen.getByRole("list", { name: "Role matrix" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Lifecycle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAccessibleDescription(
      /gate-after-b/,
    );
    expectNoAxeFindings(await axe(container));

    // Step 1: Tab walks the matrix, then the enabled lifecycle buttons. A
    // Save waits for a change and Approve for the gating cases, so neither
    // takes the focus yet.
    const order = [
      screen.getByRole("combobox", { name: "Model of main" }),
      screen.getByRole("combobox", { name: "Model of unit-coder" }),
      screen.getByRole("button", { name: "Pause" }),
      screen.getByRole("button", { name: "Wind down" }),
      screen.getByRole("button", { name: "Resume" }),
    ];
    for (const control of order) {
      await user.tab();
      expect(control).toHaveFocus();
    }

    // A changed model makes its Save reachable, right after its menu.
    const coder = screen.getByRole("combobox", { name: "Model of unit-coder" });
    await user.selectOptions(coder, "large");
    coder.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Save the model of unit-coder" })).toHaveFocus();

    // The wind-down dialog opens from the keyboard and holds the focus.
    const windDown = screen.getByRole("button", { name: "Wind down" });
    windDown.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("alertdialog", { name: "Wind down the delivery?" });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Confirm wind down" });
    for (let step = 0; step < 4; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.tab({ shift: true });
    expect([cancel, confirm]).toContain(document.activeElement);

    // Step 2: axe over the open dialog.
    expectNoAxeFindings(await axe(document.body));

    // Escape closes it, and the focus returns to Wind down.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(windDown).toHaveFocus());

    // Cancel closes it the same way, and nothing was posted.
    await user.keyboard("{Enter}");
    const again = await screen.findByRole("alertdialog");
    await user.click(within(again).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(windDown).toHaveFocus());
    expect(api.windDownDelivery).not.toHaveBeenCalled();
  });

  for (const theme of THEMES) {
    it(`SB-TC-055 has no axe findings in ${theme}`, async () => {
      const { container } = renderInTheme(
        <QueryClientProvider client={makeQueryClient()}>
          <ControlsView />
        </QueryClientProvider>,
        theme,
      );
      expect(screen.getByRole("list", { name: "Role matrix" })).toBeInTheDocument();
      expectNoAxeFindings(await axe(container));
    });
  }
});
