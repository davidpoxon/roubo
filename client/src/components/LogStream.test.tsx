// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import LogStream from "./LogStream";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

describe("LogStream", () => {
  it("shows waiting message when logs are empty", async () => {
    mockedApi.fetchComponentLogs.mockResolvedValue({ logs: [] } as never);
    render(<LogStream projectId="p1" benchId={1} component="backend" />);
    await waitFor(() => expect(mockedApi.fetchComponentLogs).toHaveBeenCalled());
    expect(screen.getByText(/waiting for output/i)).toBeInTheDocument();
  });

  it("renders log lines when fetched", async () => {
    mockedApi.fetchComponentLogs.mockResolvedValue({ logs: ["line one", "line two"] } as never);
    render(<LogStream projectId="p1" benchId={1} component="backend" />);
    await waitFor(() => expect(screen.getByText("line one")).toBeInTheDocument());
    expect(screen.getByText("line two")).toBeInTheDocument();
  });

  it("renders the copy and clear buttons", async () => {
    mockedApi.fetchComponentLogs.mockResolvedValue({ logs: ["log"] } as never);
    const { container } = render(<LogStream projectId="p1" benchId={1} component="backend" />);
    await waitFor(() => expect(screen.getByText("log")).toBeInTheDocument());
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
  });

  it("clears logs when the clear button is pressed", async () => {
    mockedApi.fetchComponentLogs.mockResolvedValue({ logs: ["some log"] } as never);
    const { container } = render(<LogStream projectId="p1" benchId={1} component="backend" />);
    await waitFor(() => expect(screen.getByText("some log")).toBeInTheDocument());

    const buttons = container.querySelectorAll("button");
    const clearBtn = buttons[1]; // second button is the Eraser (clear)
    act(() => {
      clearBtn.click();
    });
    await waitFor(() => expect(screen.getByText(/waiting for output/i)).toBeInTheDocument());
  });

  it("does not throw when fetchComponentLogs rejects", async () => {
    mockedApi.fetchComponentLogs.mockRejectedValue(new Error("network") as never);
    render(<LogStream projectId="p1" benchId={1} component="backend" />);
    await waitFor(() => expect(mockedApi.fetchComponentLogs).toHaveBeenCalled());
    // No error thrown — "waiting for output" is still shown
    expect(screen.getByText(/waiting for output/i)).toBeInTheDocument();
  });

  it("calls clipboard.writeText when copy button is pressed", async () => {
    mockedApi.fetchComponentLogs.mockResolvedValue({ logs: ["a", "b"] } as never);
    const { container } = render(<LogStream projectId="p1" benchId={1} component="backend" />);
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    const buttons = container.querySelectorAll("button");
    act(() => {
      buttons[0].click();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("a\nb");
  });
});
