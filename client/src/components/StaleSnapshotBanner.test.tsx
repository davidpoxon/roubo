// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import StaleSnapshotBanner from "./StaleSnapshotBanner";

describe("StaleSnapshotBanner (FR-014 / TC-016)", () => {
  it("renders TC-016 copy with the plugin name substituted", () => {
    render(
      <MemoryRouter>
        <StaleSnapshotBanner pluginName="GitHub.com" />
      </MemoryRouter>,
    );
    const banner = screen.getByTestId("stale-snapshot-banner");
    expect(banner.textContent).toContain(
      "Showing the last successful issue snapshot from GitHub.com. The plugin is currently unavailable.",
    );
  });

  it("renders a Manage plugins link to /settings#plugins", () => {
    render(
      <MemoryRouter>
        <StaleSnapshotBanner pluginName="GitHub.com" />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Manage plugins" });
    expect(link.getAttribute("href")).toBe("/settings#plugins");
  });
});
