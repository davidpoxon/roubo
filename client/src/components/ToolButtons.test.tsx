// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ToolButtons from "./ToolButtons";
import { getToolErrorMessage } from "../lib/tool-error-message";

vi.mock("../hooks/useTools");
import { useTools, useExecuteTool } from "../hooks/useTools";

vi.mock("../hooks/useProjects");
import { useProjects } from "../hooks/useProjects";

vi.mock("../hooks/useToast");
import { useToast } from "../hooks/useToast";

const mockUseTools = vi.mocked(useTools);
const mockUseExecuteTool = vi.mocked(useExecuteTool);
const mockUseProjects = vi.mocked(useProjects);

function makeExecuteMock() {
  return { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof useExecuteTool>;
}

beforeEach(() => {
  mockUseProjects.mockReturnValue({ data: [] } as unknown as ReturnType<typeof useProjects>);
  vi.mocked(useToast).mockReturnValue({ addToast: vi.fn(), removeToast: vi.fn() });
});

describe("ToolButtons", () => {
  it("renders nothing when no tools are available", () => {
    mockUseTools.mockReturnValue({ data: [] } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue(makeExecuteMock());
    const { container } = render(<ToolButtons projectId="p1" benchId={1} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when tools is undefined", () => {
    mockUseTools.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue(makeExecuteMock());
    const { container } = render(<ToolButtons projectId="p1" benchId={1} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a single button for a single tool", () => {
    mockUseTools.mockReturnValue({
      data: [{ name: "Browser", icon: "globe", enabled: true, requiresUserPicker: false }],
    } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue(makeExecuteMock());
    render(<ToolButtons projectId="p1" benchId={1} />);
    expect(screen.getByText("Browser")).toBeInTheDocument();
  });

  it("executes the tool when the single button is clicked", async () => {
    const mutate = vi.fn();
    mockUseTools.mockReturnValue({
      data: [{ name: "Browser", icon: "globe", enabled: true, requiresUserPicker: false }],
    } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof useExecuteTool
    >);
    render(<ToolButtons projectId="p1" benchId={1} />);
    await userEvent.click(screen.getByText("Browser"));
    expect(mutate).toHaveBeenCalledWith(
      { projectId: "p1", benchId: 1, index: 0 },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("renders a disabled button when tool is not enabled", () => {
    mockUseTools.mockReturnValue({
      data: [{ name: "IDE", icon: "code", enabled: false, requiresUserPicker: false }],
    } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue(makeExecuteMock());
    render(<ToolButtons projectId="p1" benchId={1} />);
    expect(screen.getByRole("button", { name: "IDE" })).toBeDisabled();
  });

  it("renders compact mode with a single trigger button", () => {
    mockUseTools.mockReturnValue({
      data: [{ name: "Browser", icon: "globe", enabled: true, requiresUserPicker: false }],
    } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue(makeExecuteMock());
    render(<ToolButtons projectId="p1" benchId={1} compact />);
    // In compact mode there is only 1 button (the ExternalLink trigger)
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
  });

  it("executes tool 0 when the split primary button is clicked", async () => {
    const mutate = vi.fn();
    mockUseTools.mockReturnValue({
      data: [
        { name: "Browser", icon: "globe", enabled: true, requiresUserPicker: false },
        { name: "IDE", icon: "code", enabled: true, requiresUserPicker: false },
      ],
    } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof useExecuteTool
    >);
    render(<ToolButtons projectId="p1" benchId={1} />);
    await userEvent.click(screen.getByText("Browser"));
    expect(mutate).toHaveBeenCalledWith(
      { projectId: "p1", benchId: 1, index: 0 },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("renders a split button when there are multiple tools", () => {
    mockUseTools.mockReturnValue({
      data: [
        { name: "Browser", icon: "globe", enabled: true, requiresUserPicker: false },
        { name: "IDE", icon: "code", enabled: true, requiresUserPicker: false },
      ],
    } as unknown as ReturnType<typeof useTools>);
    mockUseExecuteTool.mockReturnValue(makeExecuteMock());
    render(<ToolButtons projectId="p1" benchId={1} />);
    expect(screen.getByText("Browser")).toBeInTheDocument();
    // The split button has a chevron button as well
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  describe("user picker", () => {
    const usersFixture = [
      { name: "Alice", properties: { email: "alice@example.com" } },
      { name: "Bob", properties: { email: "bob@example.com" } },
    ];

    beforeEach(() => {
      mockUseProjects.mockReturnValue({
        data: [{ id: "p1", repoPath: "/repo", configValid: true, config: { users: usersFixture } }],
      } as unknown as ReturnType<typeof useProjects>);
    });

    it("opens the user picker modal when clicking a tool with requiresUserPicker", async () => {
      mockUseTools.mockReturnValue({
        data: [{ name: "Login", icon: "globe", enabled: true, requiresUserPicker: true }],
      } as unknown as ReturnType<typeof useTools>);
      mockUseExecuteTool.mockReturnValue(makeExecuteMock());
      render(<ToolButtons projectId="p1" benchId={1} />);
      await userEvent.click(screen.getByText("Login"));
      expect(screen.getByText("Select a user")).toBeInTheDocument();
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
    });

    it("executes with userName when a user is selected from the modal", async () => {
      const mutate = vi.fn();
      mockUseTools.mockReturnValue({
        data: [{ name: "Login", icon: "globe", enabled: true, requiresUserPicker: true }],
      } as unknown as ReturnType<typeof useTools>);
      mockUseExecuteTool.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
        typeof useExecuteTool
      >);
      render(<ToolButtons projectId="p1" benchId={1} />);
      await userEvent.click(screen.getByText("Login"));
      await userEvent.click(screen.getByText("Alice"));
      expect(mutate).toHaveBeenCalledWith(
        { projectId: "p1", benchId: 1, index: 0, userName: "Alice" },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    });

    it("opens the user picker modal when a requiresUserPicker tool is selected via compact dropdown", async () => {
      mockUseTools.mockReturnValue({
        data: [{ name: "Login", icon: "globe", enabled: true, requiresUserPicker: true }],
      } as unknown as ReturnType<typeof useTools>);
      mockUseExecuteTool.mockReturnValue(makeExecuteMock());
      render(<ToolButtons projectId="p1" benchId={1} compact />);
      // Open the compact dropdown
      await userEvent.click(screen.getByRole("button"));
      await userEvent.click(screen.getByText("Login"));
      expect(screen.getByText("Select a user")).toBeInTheDocument();
    });

    it("executes immediately when requiresUserPicker is true but no users configured", async () => {
      const mutate = vi.fn();
      mockUseProjects.mockReturnValue({
        data: [{ id: "p1", repoPath: "/repo", configValid: true, config: { users: [] } }],
      } as unknown as ReturnType<typeof useProjects>);
      mockUseTools.mockReturnValue({
        data: [{ name: "Login", icon: "globe", enabled: true, requiresUserPicker: true }],
      } as unknown as ReturnType<typeof useTools>);
      mockUseExecuteTool.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
        typeof useExecuteTool
      >);
      render(<ToolButtons projectId="p1" benchId={1} />);
      await userEvent.click(screen.getByText("Login"));
      expect(mutate).toHaveBeenCalledWith(
        { projectId: "p1", benchId: 1, index: 0 },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
      expect(screen.queryByText("Select a user")).not.toBeInTheDocument();
    });
  });
});

describe("getToolErrorMessage", () => {
  it("returns the error message for a plain Error", () => {
    expect(getToolErrorMessage(new Error("something went wrong"))).toBe("something went wrong");
  });

  it("returns a stringified value for non-Error input", () => {
    expect(getToolErrorMessage("raw string error")).toBe("raw string error");
  });

  it("returns a VS Code-specific message when the code CLI is not found", () => {
    const err = new Error("/bin/sh: code: command not found");
    expect(getToolErrorMessage(err)).toBe(
      "VS Code CLI not found. Open VS Code and run: Shell Command: Install 'code' command in PATH",
    );
  });

  it('returns a VS Code-specific message for dash-style "not found" (no "command" prefix)', () => {
    const err = new Error("/bin/sh: code: not found");
    expect(getToolErrorMessage(err)).toBe(
      "VS Code CLI not found. Open VS Code and run: Shell Command: Install 'code' command in PATH",
    );
  });

  it("returns a generic PATH message for other command-not-found errors", () => {
    const err = new Error("/bin/sh: brew: command not found");
    expect(getToolErrorMessage(err)).toBe(
      "'brew' not found on PATH. Check that the command is installed and available in your shell.",
    );
  });

  it("returns the raw message for unrelated errors (no command-not-found pattern)", () => {
    const err = new Error("EACCES: permission denied, open '/tmp/foo'");
    expect(getToolErrorMessage(err)).toBe("EACCES: permission denied, open '/tmp/foo'");
  });
});
