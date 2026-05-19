// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ToolChipList from "./ToolChipList";
import type { ToolConfig } from "@roubo/shared";

vi.mock("./TemplateInsert", () => ({
  default: ({ onInsert }: { onInsert: (v: string) => void }) => (
    <button data-testid="template-insert" onClick={() => onInsert("{{test}}")}>
      Insert
    </button>
  ),
}));
vi.mock("./TemplateHighlightInput", () => ({
  default: ({ value, placeholder }: { value: string; placeholder?: string }) => (
    <input value={value} placeholder={placeholder} onChange={() => {}} />
  ),
  TemplateValidationError: () => null,
}));

const baseProps = {
  portNames: [],
  componentNames: [],
  ports: {},
  components: {},
  projectName: "test",
};

const browserTool: ToolConfig = {
  name: "Open app",
  icon: "globe",
  type: "browser",
  url: "http://localhost:3000",
};

describe("ToolChipList", () => {
  it("shows empty state when no tools", () => {
    render(<ToolChipList tools={[]} {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByText(/no tools configured/i)).toBeInTheDocument();
  });

  it("renders a chip for each tool", () => {
    render(<ToolChipList tools={[browserTool]} {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByText("Open app")).toBeInTheDocument();
    expect(screen.getByText("browser")).toBeInTheDocument();
  });

  it("expands inline editor when chip is clicked", async () => {
    render(<ToolChipList tools={[browserTool]} {...baseProps} dispatch={vi.fn()} />);
    await userEvent.click(screen.getByText("Open app"));
    expect(screen.getByPlaceholderText("Tool name")).toBeInTheDocument();
  });

  it("collapses inline editor when chip is clicked again", async () => {
    render(<ToolChipList tools={[browserTool]} {...baseProps} dispatch={vi.fn()} />);
    const chip = screen.getByText("Open app");
    await userEvent.click(chip);
    await userEvent.click(chip);
    expect(screen.queryByPlaceholderText("Tool name")).not.toBeInTheDocument();
  });

  it("dispatches SET_TOOLS when Add tool is clicked", async () => {
    const dispatch = vi.fn();
    render(<ToolChipList tools={[]} {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByText(/add tool/i));
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_TOOLS",
      payload: [expect.objectContaining({ name: "", icon: "globe", type: "browser" })],
    });
  });

  it("auto-expands the editor for a newly added tool", async () => {
    const dispatch = vi.fn();
    const { rerender } = render(<ToolChipList tools={[]} {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByText(/add tool/i));
    const newTool: ToolConfig = { name: "", icon: "globe", type: "browser" };
    rerender(<ToolChipList tools={[newTool]} {...baseProps} dispatch={dispatch} />);
    expect(screen.getByPlaceholderText("Tool name")).toBeInTheDocument();
  });

  it("dispatches SET_TOOLS when a tool is removed via trash button", async () => {
    const dispatch = vi.fn();
    render(<ToolChipList tools={[browserTool]} {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByText("Open app"));
    await userEvent.click(screen.getByRole("button", { name: /remove tool/i }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_TOOLS",
      payload: [],
    });
  });

  it("dispatches SET_TOOLS when tool name is changed", async () => {
    const dispatch = vi.fn();
    render(<ToolChipList tools={[browserTool]} {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByText("Open app"));
    const nameInput = screen.getByPlaceholderText("Tool name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "X");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_TOOLS" }));
  });
});
