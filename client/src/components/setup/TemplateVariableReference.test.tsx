// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplateVariableReference from "./TemplateVariableReference";
import type { TemplateVariableContext } from "./templateDescriptions";

const baseCtx: TemplateVariableContext = {
  portNames: ["frontend", "backend"],
  componentNames: ["web", "api"],
  ports: { frontend: { base: 3000 }, backend: { base: 4000 } },
  components: {},
  projectName: "my-project",
};

describe("TemplateVariableReference", () => {
  it("does not render dialog when not open", () => {
    render(<TemplateVariableReference ctx={baseCtx} isOpen={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog when open", () => {
    render(<TemplateVariableReference ctx={baseCtx} isOpen onOpenChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /template variables/i })).toBeInTheDocument();
  });

  it("renders port variables in the reference", () => {
    render(<TemplateVariableReference ctx={baseCtx} isOpen onOpenChange={vi.fn()} />);
    // May appear multiple times (list + table): just verify presence
    expect(screen.getAllByText("{{ports.frontend}}").length).toBeGreaterThan(0);
  });

  it("renders bench port examples table when ports are configured", () => {
    render(<TemplateVariableReference ctx={baseCtx} isOpen onOpenChange={vi.fn()} />);
    expect(screen.getByText("Port values across benches")).toBeInTheDocument();
    // "Bench 1/2/3" appear in the table headers
    expect(screen.getAllByText("Bench 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bench 2").length).toBeGreaterThan(0);
  });

  it("renders workspace paths section when projectName is set", () => {
    render(<TemplateVariableReference ctx={baseCtx} isOpen onOpenChange={vi.fn()} />);
    expect(screen.getByText("Workspace paths across benches")).toBeInTheDocument();
  });

  it("calls onOpenChange(false) when close button is pressed", async () => {
    const onOpenChange = vi.fn();
    render(<TemplateVariableReference ctx={baseCtx} isOpen onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole("button", { name: "" })); // X button
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
