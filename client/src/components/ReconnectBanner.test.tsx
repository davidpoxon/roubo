// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReconnectBanner from "./ReconnectBanner";

describe("ReconnectBanner", () => {
  it("renders nothing when connected", () => {
    const { container } = render(
      <ReconnectBanner state="connected" attempt={0} onRetry={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when connecting", () => {
    const { container } = render(
      <ReconnectBanner state="connecting" attempt={0} onRetry={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders reconnecting state with attempt count", () => {
    render(<ReconnectBanner state="reconnecting" attempt={3} onRetry={() => {}} />);
    expect(screen.getByText(/Reconnecting.*attempt 3/)).toBeTruthy();
  });

  it("shows retry button after 5 attempts", () => {
    render(<ReconnectBanner state="reconnecting" attempt={6} onRetry={() => {}} />);
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("does not show retry button for early attempts", () => {
    render(<ReconnectBanner state="reconnecting" attempt={3} onRetry={() => {}} />);
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("calls onRetry when retry button is pressed", async () => {
    const onRetry = vi.fn();
    render(<ReconnectBanner state="reconnecting" attempt={6} onRetry={onRetry} />);

    await userEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders ended state", () => {
    render(<ReconnectBanner state="ended" attempt={0} onRetry={() => {}} />);
    expect(screen.getByText("Process ended")).toBeTruthy();
  });

  it("does not show retry button in ended state", () => {
    render(<ReconnectBanner state="ended" attempt={0} onRetry={() => {}} />);
    expect(screen.queryByText("Retry")).toBeNull();
  });
});
