// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TemplateHighlightInput, { TemplateValidationError } from "./TemplateHighlightInput";

describe("TemplateHighlightInput", () => {
  it("renders an input element", () => {
    render(<TemplateHighlightInput value="" />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("renders a placeholder when provided", () => {
    render(<TemplateHighlightInput value="" placeholder="Enter value" />);
    expect(screen.getByPlaceholderText("Enter value")).toBeInTheDocument();
  });

  it("renders highlight backdrop for values with template variables", () => {
    const { container } = render(<TemplateHighlightInput value="hello {{ports.frontend}} world" />);
    // The backdrop div (aria-hidden) should be rendered with variable spans
    const backdrop = container.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeInTheDocument();
  });

  it("does not render backdrop for plain text values", () => {
    const { container } = render(<TemplateHighlightInput value="plain text" />);
    const backdrop = container.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeInTheDocument();
  });

  it("does not render backdrop for empty value", () => {
    const { container } = render(<TemplateHighlightInput value="" />);
    const backdrop = container.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeInTheDocument();
  });

  it("renders inner variant without standalone padding", () => {
    const { container } = render(<TemplateHighlightInput value="{{x}}" variant="inner" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("flex-1");
  });
});

describe("TemplateValidationError", () => {
  it("renders nothing when there are no invalid variables", () => {
    const { container } = render(<TemplateValidationError invalidVariables={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders singular "variable" for one invalid var', () => {
    render(<TemplateValidationError invalidVariables={["{{ports.bad}}"]} />);
    expect(screen.getByText(/unknown variable/i)).toBeInTheDocument();
    expect(screen.getByText(/{{ports.bad}}/i)).toBeInTheDocument();
  });

  it('renders plural "variables" for multiple invalid vars', () => {
    render(<TemplateValidationError invalidVariables={["{{a}}", "{{b}}"]} />);
    expect(screen.getByText(/unknown variables/i)).toBeInTheDocument();
  });
});
