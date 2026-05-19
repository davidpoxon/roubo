// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SaveBar from "./SaveBar";

describe("SaveBar", () => {
  it("renders the save label", () => {
    render(<SaveBar onSave={vi.fn()} isSaving={false} isDisabled={false} saveLabel="Save setup" />);
    expect(screen.getByRole("button", { name: /save setup/i })).toBeInTheDocument();
  });

  it("calls onSave when button is pressed", async () => {
    const onSave = vi.fn();
    render(<SaveBar onSave={onSave} isSaving={false} isDisabled={false} saveLabel="Save setup" />);
    await userEvent.click(screen.getByRole("button", { name: /save setup/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("button is disabled when isDisabled=true", () => {
    render(<SaveBar onSave={vi.fn()} isSaving={false} isDisabled={true} saveLabel="Save setup" />);
    expect(screen.getByRole("button", { name: /save setup/i })).toBeDisabled();
  });

  it("button is disabled when isSaving=true", () => {
    render(<SaveBar onSave={vi.fn()} isSaving={true} isDisabled={false} saveLabel="Saving…" />);
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });

  it("does not call onSave when disabled", async () => {
    const onSave = vi.fn();
    render(<SaveBar onSave={onSave} isSaving={false} isDisabled={true} saveLabel="Save setup" />);
    await userEvent.click(screen.getByRole("button", { name: /save setup/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renders errorSummary when provided", () => {
    render(
      <SaveBar
        onSave={vi.fn()}
        isSaving={false}
        isDisabled={false}
        saveLabel="Save setup"
        errorSummary="2 fields need attention"
      />,
    );
    expect(screen.getByText("2 fields need attention")).toBeInTheDocument();
  });

  it("does not render errorSummary when not provided", () => {
    render(<SaveBar onSave={vi.fn()} isSaving={false} isDisabled={false} saveLabel="Save setup" />);
    expect(screen.queryByText(/need attention/i)).not.toBeInTheDocument();
  });

  it("renders the correct label for create mode", () => {
    render(
      <SaveBar
        onSave={vi.fn()}
        isSaving={false}
        isDisabled={false}
        saveLabel="Save & Register Setup"
      />,
    );
    expect(screen.getByRole("button", { name: /save & register setup/i })).toBeInTheDocument();
  });
});
