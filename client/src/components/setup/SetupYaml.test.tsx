// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import SetupYaml from "./SetupYaml";
import type { SetupYamlEditorRef } from "./SetupYamlEditor";

vi.mock("./SetupYamlEditor", () => ({
  default: forwardRef<SetupYamlEditorRef>(function MockSetupYamlEditor(_props, ref) {
    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      format: vi.fn(),
      scrollToLine: vi.fn(),
    }));
    return <div data-testid="setup-yaml-editor" />;
  }),
}));

const VALID_YAML = `project:\n  name: nova\n`;

describe("SetupYaml", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Format button (Validate moved to sidebar)", () => {
    render(<SetupYaml rawYaml={VALID_YAML} onRawYamlChange={() => {}} onSave={() => {}} />);
    expect(screen.getByRole("button", { name: "Format" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Validate" })).not.toBeInTheDocument();
  });

  it("shows roubo.yaml filename in toolbar", () => {
    render(<SetupYaml rawYaml={VALID_YAML} onRawYamlChange={() => {}} onSave={() => {}} />);
    expect(screen.getByText("roubo.yaml")).toBeInTheDocument();
  });

  it("shows keyboard save hint", () => {
    render(<SetupYaml rawYaml={VALID_YAML} onRawYamlChange={() => {}} onSave={() => {}} />);
    expect(screen.getByText(/⌘S|Ctrl\+S/)).toBeInTheDocument();
  });

  it("shows format error when formatError prop is set", () => {
    render(
      <SetupYaml
        rawYaml={VALID_YAML}
        onRawYamlChange={() => {}}
        onSave={() => {}}
        formatError="Fix YAML errors before formatting."
      />,
    );
    expect(screen.getByText(/Fix YAML errors before formatting/)).toBeInTheDocument();
  });

  it("clicking Format calls onFormatErrorChange(null) and then attempts format", () => {
    const onFormatErrorChange = vi.fn();
    render(
      <SetupYaml
        rawYaml={VALID_YAML}
        onRawYamlChange={() => {}}
        onSave={() => {}}
        onFormatErrorChange={onFormatErrorChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(onFormatErrorChange).toHaveBeenCalledWith(null);
  });

  it("clicking Format on invalid YAML calls onFormatErrorChange with error message", () => {
    const onFormatErrorChange = vi.fn();
    render(
      <SetupYaml
        rawYaml="{ bad: yaml: :"
        onRawYamlChange={() => {}}
        onSave={() => {}}
        onFormatErrorChange={onFormatErrorChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(onFormatErrorChange).toHaveBeenCalledWith("Fix YAML errors before formatting.");
  });

  it("displays saveError in the toolbar when provided", () => {
    render(
      <SetupYaml
        rawYaml={VALID_YAML}
        onRawYamlChange={() => {}}
        onSave={() => {}}
        saveError="disk full"
      />,
    );
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });
});
