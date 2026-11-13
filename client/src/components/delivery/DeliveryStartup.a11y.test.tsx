// @vitest-environment jsdom
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Bench } from "@roubo/shared";
import { expectNoAxeFindings } from "../../test/axe";
import { makeQueryClient } from "../../test/renderWithProviders";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchTerminals: vi.fn().mockResolvedValue([
      {
        id: "s-1",
        benchKey: "demo:3",
        label: "agent",
        createdAt: "2026-10-16T09:01:00Z",
        status: "live",
      },
    ]),
    fetchDeliverySpecSummary: vi
      .fn()
      .mockResolvedValue({ slug: "fixture-spec", units: 4, gates: 1 }),
  };
});
import DeliveryStartup from "./DeliveryStartup";

const bench = {
  id: 3,
  projectId: "demo",
  status: "active",
  variant: "specbench",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "launch",
  deliverySessionId: "s-1",
  createdAt: "2026-10-16T09:00:00Z",
  notifications: [
    {
      id: "n-1",
      type: "agent-waiting",
      priority: "action-needed",
      sourceSessionId: "s-1",
      createdAt: "2026-10-16T09:02:00Z",
    },
  ],
} as unknown as Bench;

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("DeliveryStartup", () => {
  for (const theme of THEMES) {
    it(`has no WCAG 2.1 AA finding while it waits for the operator in ${theme}`, async () => {
      const { container } = renderInTheme(
        <QueryClientProvider client={makeQueryClient()}>
          <main>
            <DeliveryStartup bench={bench} onOpenTerminal={vi.fn()} />
          </main>
        </QueryClientProvider>,
        theme,
      );
      await screen.findByRole("button", { name: "Open the terminal" });
      await screen.findByTestId("delivery-startup-counts");
      expectNoAxeFindings(
        await axe(container, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        }),
      );
    });
  }
});
