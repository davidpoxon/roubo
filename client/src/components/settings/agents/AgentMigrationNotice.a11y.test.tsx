// @vitest-environment jsdom
//
// AP-NFR-004: zero serious axe violations on the one-time upgrade notice, and a
// dismiss control that is reachable and operable from the keyboard alone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { SettingsResponse } from "@roubo/shared";
import { expectNoAxeFindings } from "../../../test/axe";

vi.mock("../../../hooks/useSettings");

import { useSettings as _useSettings } from "../../../hooks/useSettings";
import AgentMigrationNotice from "./AgentMigrationNotice";

const mockedSettings = vi.mocked(_useSettings);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedSettings.mockReturnValue({
    settings: {
      theme: "dark",
      legacyAgentSettingsPresent: true,
      contextWindow: 200_000,
    } as SettingsResponse,
    isLoading: false,
    updateSettings: vi.fn(),
  } as unknown as ReturnType<typeof _useSettings>);
});

describe("AgentMigrationNotice: axe-core", () => {
  it("has no axe violations", async () => {
    const { container } = render(<AgentMigrationNotice />);

    expectNoAxeFindings(await axe(container));
  });

  it("exposes the notice as a named note landmark", () => {
    render(<AgentMigrationNotice />);

    expect(screen.getByRole("note", { name: /agent settings notice/i })).toBeTruthy();
  });

  it("gives the icon-only dismiss control an accessible name", () => {
    render(<AgentMigrationNotice />);

    const dismiss = screen.getByRole("button", { name: /dismiss agent settings notice/i });
    expect(dismiss.textContent).not.toMatch(/[a-z]{3}/i);
  });

  it("reaches the dismiss control by keyboard and operates it with Enter", async () => {
    const user = userEvent.setup();
    render(<AgentMigrationNotice />);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /dismiss agent settings notice/i }),
    );

    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
  });
});
