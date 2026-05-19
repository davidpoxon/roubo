// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionInspection from "./SectionInspection";
import type { InspectionConfig } from "@roubo/shared";

vi.mock("./SubdirectoryPicker", () => ({
  default: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <div>
      <label>{label}</label>
      <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  ),
}));
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

const baseInspection: InspectionConfig = {
  framework: "playwright",
  directory: "tests",
  command: "npx playwright test",
};

const baseProps = {
  portNames: ["frontend"],
  componentNames: ["web"],
  ports: { frontend: { base: 3000 } },
  components: {},
  projectName: "my-project",
  repoPath: "/repo",
};

describe("SectionInspection", () => {
  it("shows Add inspection button when inspection is undefined", () => {
    render(<SectionInspection inspection={undefined} {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add inspection/i })).toBeInTheDocument();
  });

  it("does not auto-dispatch when inspection is undefined", () => {
    const dispatch = vi.fn();
    render(<SectionInspection inspection={undefined} {...baseProps} dispatch={dispatch} />);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches UPDATE_INSPECTION with blank values when Add inspection is clicked", async () => {
    const dispatch = vi.fn();
    render(<SectionInspection inspection={undefined} {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /add inspection/i }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_INSPECTION",
      payload: { framework: "", directory: "", command: "" },
    });
  });

  it("renders form fields when inspection is defined", () => {
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByPlaceholderText("playwright")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("npx playwright test")).toBeInTheDocument();
  });

  it("renders Remove button when inspection is defined", () => {
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /remove inspection/i })).toBeInTheDocument();
  });

  it("dispatches UPDATE_INSPECTION with undefined when Remove is clicked", async () => {
    const dispatch = vi.fn();
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /remove inspection/i }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_INSPECTION",
      payload: undefined,
    });
  });

  it("dispatches UPDATE_INSPECTION when framework changes", async () => {
    const dispatch = vi.fn();
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={dispatch} />);
    const input = screen.getByPlaceholderText("playwright");
    await userEvent.clear(input);
    await userEvent.type(input, "jest");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_INSPECTION" }));
  });

  it("renders the Add variable button when inspection is defined", () => {
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add variable/i })).toBeInTheDocument();
  });

  it("dispatches UPDATE_INSPECTION when command field changes", async () => {
    const dispatch = vi.fn();
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={dispatch} />);
    const commandInput = screen.getByPlaceholderText("npx playwright test");
    await userEvent.clear(commandInput);
    await userEvent.type(commandInput, "npx jest");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_INSPECTION" }));
  });

  it("dispatches UPDATE_INSPECTION when directory field changes", async () => {
    const dispatch = vi.fn();
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={dispatch} />);
    const dirInput = screen.getByLabelText("Directory");
    await userEvent.clear(dirInput);
    await userEvent.type(dirInput, "spec");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_INSPECTION" }));
  });

  it("dispatches UPDATE_INSPECTION when Add variable is clicked", async () => {
    const dispatch = vi.fn();
    render(<SectionInspection inspection={baseInspection} {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /add variable/i }));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_INSPECTION",
        payload: expect.objectContaining({
          env: expect.objectContaining({ "": "" }),
        }),
      }),
    );
  });

  it("dispatches UPDATE_INSPECTION when env variable is removed", async () => {
    const dispatch = vi.fn();
    const inspectionWithEnv: InspectionConfig = {
      ...baseInspection,
      env: { BASE_URL: "http://localhost" },
    };
    render(<SectionInspection inspection={inspectionWithEnv} {...baseProps} dispatch={dispatch} />);
    const removeEnvBtn = screen.getAllByRole("button", {
      name: /remove environment variable/i,
    })[0];
    await userEvent.click(removeEnvBtn);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_INSPECTION" }));
  });
});
