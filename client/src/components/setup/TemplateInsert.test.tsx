// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplateInsert from "./TemplateInsert";
import type { TemplateVariableContext } from "./templateDescriptions";

const ctxWithPorts: TemplateVariableContext = {
  portNames: ["frontend"],
  componentNames: ["web"],
  ports: { frontend: { base: 3000 } },
  components: {},
  projectName: "my-project",
};

describe("TemplateInsert", () => {
  it("renders the insert button when variables are available", () => {
    render(<TemplateInsert ctx={ctxWithPorts} onInsert={vi.fn()} />);
    expect(screen.getByRole("button", { name: /insert template variable/i })).toBeInTheDocument();
  });

  it("opens the popover when the button is pressed", async () => {
    render(<TemplateInsert ctx={ctxWithPorts} onInsert={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /insert template variable/i }));
    // Popover should show variable syntax
    expect(screen.getByText("{{ports.frontend}}")).toBeInTheDocument();
  });

  it("calls onInsert and closes popover when a variable is selected", async () => {
    const onInsert = vi.fn();
    render(<TemplateInsert ctx={ctxWithPorts} onInsert={onInsert} />);
    await userEvent.click(screen.getByRole("button", { name: /insert template variable/i }));
    await userEvent.click(screen.getByText("{{ports.frontend}}"));
    expect(onInsert).toHaveBeenCalledWith("{{ports.frontend}}");
  });

  // #1286: hover must keep the item text at WCAG AA (text-secondary-raised in DESIGN.md).
  it("keeps the description and formula at AA contrast on item hover", async () => {
    render(<TemplateInsert ctx={ctxWithPorts} onInsert={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /insert template variable/i }));

    const description = screen.getByText(/Allocated port for frontend/).closest("p");
    const formula = screen.getByText(/base \+ \(bench - 1\)/);
    expect(description).not.toBeNull();

    for (const el of [description as HTMLElement, formula]) {
      // The hover tone is the text-body role (the raised secondary step), which
      // semantic-dark.css switches per theme, so no dark: pair is needed.
      expect(el).toHaveClass("group-hover/item:text-text-body");
      expect(el.className).not.toMatch(/dark:/);
    }
  });
});
