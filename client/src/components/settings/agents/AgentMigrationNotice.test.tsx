// @vitest-environment jsdom
//
// The one-time upgrade notice on Settings > AI Agents (AP-FR-021, issue #521).
// AP-TC-109 (shown once, dismissible, stays dismissed across a restart),
// AP-TC-110 (absent on a fresh install), AP-TC-111 (says outright that nothing
// was migrated).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SettingsResponse } from "@roubo/shared";

vi.mock("../../../hooks/useSettings");

import { useSettings as _useSettings } from "../../../hooks/useSettings";
import AgentMigrationNotice, { STORAGE_KEY } from "./AgentMigrationNotice";

const mockedSettings = vi.mocked(_useSettings);

function settingsResult(settings?: Partial<SettingsResponse>) {
  return {
    settings: settings as SettingsResponse | undefined,
    isLoading: false,
    updateSettings: vi.fn(),
  } as unknown as ReturnType<typeof _useSettings>;
}

/** An upgrader: the raw settings file still carries the retired block. */
function upgrading() {
  mockedSettings.mockReturnValue(
    settingsResult({ theme: "dark", legacyAgentSettingsPresent: true, contextWindow: 200_000 }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("AgentMigrationNotice", () => {
  it("AP-TC-109 S001: shows the notice to an upgrader carrying the legacy settings block", () => {
    upgrading();

    render(<AgentMigrationNotice />);

    expect(screen.getByTestId("agent-migration-notice")).toBeTruthy();
    expect(screen.getByRole("note", { name: /agent settings notice/i })).toBeTruthy();
  });

  it("AP-TC-110: renders nothing on a fresh install, where no legacy block exists", () => {
    mockedSettings.mockReturnValue(
      settingsResult({ theme: "dark", legacyAgentSettingsPresent: false, contextWindow: 200_000 }),
    );

    render(<AgentMigrationNotice />);

    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
  });

  it("AP-TC-110: renders nothing while settings are still loading, so it never flashes", () => {
    mockedSettings.mockReturnValue(settingsResult(undefined));

    render(<AgentMigrationNotice />);

    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
  });

  it("AP-TC-111 S002: states outright that the previous preferences were not carried over", () => {
    upgrading();

    render(<AgentMigrationNotice />);

    const notice = screen.getByTestId("agent-migration-notice");
    expect(notice.textContent).toMatch(/not carried over/i);
    expect(notice.textContent).toMatch(/agent plugin/i);
  });

  it("AP-TC-109 S002: dismissing hides the notice and records the dismissal", async () => {
    upgrading();
    const user = userEvent.setup();

    render(<AgentMigrationNotice />);
    await user.click(screen.getByRole("button", { name: /dismiss agent settings notice/i }));

    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("AP-TC-109 S003: stays dismissed on a later mount, which is what survives a restart", async () => {
    upgrading();
    const user = userEvent.setup();

    const first = render(<AgentMigrationNotice />);
    await user.click(screen.getByRole("button", { name: /dismiss agent settings notice/i }));
    first.unmount();

    // The legacy block is still in the settings file: only the recorded
    // dismissal keeps the notice away, which is the "exactly once" claim.
    render(<AgentMigrationNotice />);

    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
  });

  it("AP-TC-109 S003: a recorded dismissal suppresses the notice on first render, with no flash", () => {
    upgrading();
    localStorage.setItem(STORAGE_KEY, "true");

    render(<AgentMigrationNotice />);

    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
  });

  it("stays hidden when localStorage is unavailable, rather than showing a notice it cannot retire", () => {
    upgrading();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    render(<AgentMigrationNotice />);

    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
    getItem.mockRestore();
  });

  it("still dismisses in the UI when the dismissal cannot be written", async () => {
    upgrading();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const user = userEvent.setup();

    render(<AgentMigrationNotice />);
    await user.click(screen.getByRole("button", { name: /dismiss agent settings notice/i }));

    expect(screen.queryByTestId("agent-migration-notice")).toBeNull();
    setItem.mockRestore();
  });

  it("names no specific AI coding product, per docs/brand.md", () => {
    upgrading();

    render(<AgentMigrationNotice />);

    const notice = screen.getByTestId("agent-migration-notice");
    expect(notice.textContent).not.toMatch(/claude|codex|gemini|copilot/i);
  });
});
