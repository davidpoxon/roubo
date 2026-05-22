// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../../hooks/usePlugins");
import { usePluginLogs as _usePluginLogs } from "../../../hooks/usePlugins";
import ViewLogsDialog from "./ViewLogsDialog";

const mockedLogs = vi.mocked(_usePluginLogs);

function setLogsReturn(
  lines: {
    ts: string;
    source: "stdout" | "stderr" | "host";
    level?: "info" | "warn" | "error";
    text: string;
  }[],
) {
  const refetch = vi.fn();
  mockedLogs.mockReturnValue({
    data: { lines },
    isLoading: false,
    isFetching: false,
    refetch,
  } as unknown as ReturnType<typeof _usePluginLogs>);
  return refetch;
}

describe("ViewLogsDialog (TC-017)", () => {
  beforeEach(() => {
    setLogsReturn([
      { ts: "2026-05-22T00:00:00.000Z", source: "stdout", text: "hello world" },
      { ts: "2026-05-22T00:00:01.000Z", source: "stderr", level: "error", text: "boom" },
    ]);
  });

  it("displays current.log lines with timestamp, level, and message", () => {
    render(
      <ViewLogsDialog pluginId="github-com" pluginName="GitHub.com" isOpen onClose={() => {}} />,
    );
    expect(screen.getByText("hello world")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("2026-05-22T00:00:00.000Z")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("switches to previous.log when the previous tab is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ViewLogsDialog pluginId="github-com" pluginName="GitHub.com" isOpen onClose={() => {}} />,
    );
    expect(mockedLogs).toHaveBeenLastCalledWith("github-com", "current", true);
    await user.click(screen.getByTestId("log-file-previous"));
    await waitFor(() => {
      expect(mockedLogs).toHaveBeenLastCalledWith("github-com", "previous", true);
    });
  });

  it("filters lines by the search input (case-insensitive substring)", async () => {
    const user = userEvent.setup();
    render(
      <ViewLogsDialog pluginId="github-com" pluginName="GitHub.com" isOpen onClose={() => {}} />,
    );
    const input = screen.getByPlaceholderText("Filter...");
    await user.type(input, "HELLO");
    expect(screen.getByText("hello world")).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("renders the empty-state message when there are no entries", () => {
    setLogsReturn([]);
    render(
      <ViewLogsDialog pluginId="github-com" pluginName="GitHub.com" isOpen onClose={() => {}} />,
    );
    expect(screen.getByText("No log entries yet.")).toBeTruthy();
  });

  it("refresh button triggers a refetch", async () => {
    const refetch = setLogsReturn([]);
    const user = userEvent.setup();
    render(
      <ViewLogsDialog pluginId="github-com" pluginName="GitHub.com" isOpen onClose={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: "Refresh logs" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("calls onClose when the X button is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ViewLogsDialog pluginId="github-com" pluginName="GitHub.com" isOpen onClose={onClose} />,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not query for logs while closed", () => {
    render(
      <ViewLogsDialog
        pluginId="github-com"
        pluginName="GitHub.com"
        isOpen={false}
        onClose={() => {}}
      />,
    );
    expect(mockedLogs).toHaveBeenLastCalledWith("github-com", "current", false);
  });
});
