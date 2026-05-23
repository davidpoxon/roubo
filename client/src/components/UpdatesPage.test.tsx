// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import UpdatesPage from "./UpdatesPage";

describe("UpdatesPage", () => {
  beforeEach(() => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: {
        getAppVersion: vi.fn().mockResolvedValue("1.2.3"),
        onDeepLink: vi.fn(),
        onNavigate: vi.fn(),
        platform: "darwin",
        setTitleBarOverlayTheme: vi.fn(),
      },
    });
  });

  it("renders the heading", async () => {
    render(<UpdatesPage />);
    expect(screen.getByRole("heading", { name: /updates/i })).toBeInTheDocument();
    // The async getAppVersion() resolution would otherwise fire setState after
    // the test ends and trip React's act() warning. Wait for it to settle.
    await screen.findByText(/Version 1\.2\.3/);
  });

  it("renders the app version after resolving", async () => {
    render(<UpdatesPage />);
    await waitFor(() => expect(screen.getByText(/Version 1\.2\.3/)).toBeInTheDocument());
  });

  it("renders the auto-update info message", async () => {
    render(<UpdatesPage />);
    expect(screen.getByText(/checks for updates automatically every hour/i)).toBeInTheDocument();
    await screen.findByText(/Version 1\.2\.3/);
  });

  it('shows "unknown" version when getAppVersion rejects', async () => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: {
        getAppVersion: vi.fn().mockRejectedValue(new Error("IPC error")),
        onDeepLink: vi.fn(),
        onNavigate: vi.fn(),
        platform: "darwin",
        setTitleBarOverlayTheme: vi.fn(),
      },
    });
    render(<UpdatesPage />);
    await waitFor(() => expect(screen.getByText(/Version unknown/)).toBeInTheDocument());
  });

  it("renders without crashing when window.roubo is undefined", () => {
    Object.defineProperty(window, "roubo", { configurable: true, value: undefined });
    expect(() => render(<UpdatesPage />)).not.toThrow();
  });
});
