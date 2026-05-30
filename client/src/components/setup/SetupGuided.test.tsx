// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import SetupGuided from "./SetupGuided";
import { wizardReducer, createInitialState, type WizardState } from "./wizardReducer";
import type { RouboConfig } from "@roubo/shared";
import * as useSetupHooks from "../../hooks/useSetup";

const renderInRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

// Mock hooks and components that have network or complex dependencies
vi.mock("../../hooks/useBenches", () => ({
  useProjectBenches: vi.fn(() => ({ data: [] })),
}));
vi.mock("../../hooks/useSetup", () => ({
  useRawConfig: vi.fn(() => ({ data: undefined })),
  useGitHubProjects: () => ({ data: [], isLoading: false, error: null }),
  useEnvKeys: () => ({ data: { keys: [] } }),
}));
vi.mock("./SetupYaml", () => ({
  default: () => <div data-testid="setup-yaml" />,
}));
vi.mock("../../hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: null, isLoading: false }),
}));
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
  default: () => null,
}));
vi.mock("./TemplateHighlightInput", () => ({
  default: ({ value, placeholder }: { value: string; placeholder?: string }) => (
    <input value={value} placeholder={placeholder} onChange={() => {}} />
  ),
  TemplateValidationError: () => null,
}));
vi.mock("../GitHubErrorState", () => ({
  default: () => <div data-testid="github-error" />,
}));
vi.mock("../Spinner", () => ({
  default: () => <span data-testid="spinner" />,
}));
vi.mock("../Select", () => ({
  default: () => <select />,
}));

const makeState = (configOverride?: Partial<RouboConfig>): WizardState => {
  const base = createInitialState("/repo", true, "my-project");
  if (!configOverride) return base;
  return { ...base, config: { ...base.config, ...configOverride } };
};

const validConfig: Partial<RouboConfig> = {
  project: {
    name: "test",
    displayName: "Test",
    type: "web",
    repo: "org/test",
  },
  layout: { type: "single-repo" },
  benches: { max: 5 },
  ports: { frontend: { base: 3000 } },
  tools: [],
};

describe("SetupGuided", () => {
  const defaultProps = {
    repoPath: "/repo",
    projectId: "test-project",
    isSaving: false,
    saveError: undefined,
    onSave: vi.fn(),
    isCreateMode: false,
    mode: "guided" as const,
    onModeChange: vi.fn(),
    rawYaml: "",
    onRawYamlChange: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useSetupHooks.useRawConfig).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useSetupHooks.useRawConfig>);
  });

  it("renders all six section headings", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    // Use getAllByText to handle multiple matches; just verify at least one exists
    expect(screen.getAllByText(/identity/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^components$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/bench capacity/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tools/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/inspections/i).length).toBeGreaterThan(0);
    // "Ports" section heading
    const headings = screen
      .getAllByRole("heading")
      .filter((h) => /^ports$/i.test(h.textContent ?? ""));
    expect(headings.length).toBeGreaterThan(0);
  });

  it("renders Guided and YAML toggle buttons", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    expect(screen.getByText("Guided")).toBeInTheDocument();
    expect(screen.getByText("YAML")).toBeInTheDocument();
  });

  it("renders SetupYaml when mode is yaml", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} mode="yaml" state={state} dispatch={vi.fn()} />);
    expect(screen.getByTestId("setup-yaml")).toBeInTheDocument();
  });

  it("shows guided form when mode is guided", () => {
    const state = makeState(validConfig);
    renderInRouter(
      <SetupGuided {...defaultProps} mode="guided" state={state} dispatch={vi.fn()} />,
    );
    expect(screen.getByText(/identity/i)).toBeInTheDocument();
    expect(screen.queryByTestId("setup-yaml")).not.toBeInTheDocument();
  });

  it("renders Save setup button in edit mode", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /save setup/i })).toBeInTheDocument();
  });

  it("renders Save & Register Setup button in create mode", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} isCreateMode state={state} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /save & register setup/i })).toBeInTheDocument();
  });

  it("save button is disabled when saving is in progress", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} isSaving state={state} dispatch={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /saving/i });
    expect(btn).toBeDisabled();
  });

  it("save button is disabled when validationErrors is non-empty", () => {
    const state = makeState(validConfig);
    const invalidState: WizardState = {
      ...state,
      validationErrors: { "project.name": "Required" },
    };
    renderInRouter(<SetupGuided {...defaultProps} state={invalidState} dispatch={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /save setup/i });
    expect(btn).toBeDisabled();
  });

  it("save button is enabled when all sections are valid/pristine", () => {
    // Build valid state through reducer
    let state = createInitialState("/repo", true, "test");
    state = wizardReducer(state, {
      type: "LOAD_EXISTING_CONFIG",
      payload: validConfig as RouboConfig,
    });
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /save setup/i });
    expect(btn).not.toBeDisabled();
  });

  it("calls onSave when save button is pressed", async () => {
    const onSave = vi.fn();
    let state = createInitialState("/repo", true, "test");
    state = wizardReducer(state, {
      type: "LOAD_EXISTING_CONFIG",
      payload: validConfig as RouboConfig,
    });
    renderInRouter(
      <SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} onSave={onSave} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /save setup/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("displays save error when provided", () => {
    const state = makeState(validConfig);
    renderInRouter(
      <SetupGuided
        {...defaultProps}
        state={state}
        dispatch={vi.fn()}
        saveError="Server rejected the config"
      />,
    );
    // Shown in both the validation panel summary and the detailed error block.
    expect(screen.getAllByText("Server rejected the config").length).toBeGreaterThan(0);
  });

  it("does not render default branch field when no projectId", () => {
    // useProjectSettings won't be called, so no branch row rendered
    const state = makeState(validConfig);
    renderInRouter(
      <SetupGuided {...defaultProps} projectId={undefined} state={state} dispatch={vi.fn()} />,
    );
    expect(screen.queryByText(/default branch/i)).not.toBeInTheDocument();
  });

  it("does not render extra-fields indicator by default (no raw config)", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    expect(screen.queryByTestId("extra-fields-indicator")).not.toBeInTheDocument();
  });

  it("renders extra-fields indicator when raw config has unknown keys", () => {
    const state = makeState(validConfig);
    renderInRouter(
      <SetupGuided
        {...defaultProps}
        rawYaml={"unknown_key: true\nproject:\n  name: test\n"}
        state={state}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByTestId("extra-fields-indicator")).toBeInTheDocument();
  });

  it("renders port ranges in Ports section", () => {
    const state = makeState({
      ...validConfig,
      ports: { frontend: { base: 3000 } },
      benches: { max: 3 },
    });
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    // "frontend" appears in both the form Ports section and the rail Port Ranges panel
    expect(screen.getAllByText("frontend").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/3000/).length).toBeGreaterThan(0);
  });

  it("renders bench cap input in Bench capacity section", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    const maxInput = screen.getByLabelText(/maximum concurrent benches/i);
    expect(maxInput).toBeInTheDocument();
  });

  it("dispatches UPDATE_BENCHES when bench max is changed", async () => {
    const dispatch = vi.fn();
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={dispatch} />);
    const maxInput = screen.getByLabelText(/maximum concurrent benches/i);
    await userEvent.clear(maxInput);
    await userEvent.type(maxInput, "7");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_BENCHES" }));
  });

  it("shows 'Add tool' button in Tools section", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    expect(screen.getByText(/add tool/i)).toBeInTheDocument();
  });

  it("shows 'Add inspection' button when no inspection configured", () => {
    const state = makeState({ ...validConfig, inspection: undefined });
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    expect(screen.getByText(/add inspection/i)).toBeInTheDocument();
  });

  it("shows validation error when bench max exceeds 99", async () => {
    const dispatch = vi.fn();
    const state = makeState({ ...validConfig, benches: { max: 100 } });
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={dispatch} />);
    expect(screen.getByText(/must be between 1 and 99/i)).toBeInTheDocument();
  });

  it("does not show validation error when bench max is within range", () => {
    const state = makeState({ ...validConfig, benches: { max: 9 } });
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    expect(screen.queryByText(/must be between 1 and 99/i)).not.toBeInTheDocument();
  });

  it("hides sticky top bar when embedded", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} embedded state={state} dispatch={vi.fn()} />);
    expect(screen.queryByText("Guided")).not.toBeInTheDocument();
    expect(screen.queryByText("YAML")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("renders breadcrumb and page heading in standalone mode", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    expect(screen.getByRole("link", { name: /^settings$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /project setup/i })).toBeInTheDocument();
  });

  it("does not render breadcrumb or page heading when embedded", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} embedded state={state} dispatch={vi.fn()} />);
    expect(screen.queryByRole("link", { name: /^settings$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /project setup/i })).not.toBeInTheDocument();
  });

  it("renders the shared sidebar when not embedded and projectId is present", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} state={state} dispatch={vi.fn()} />);
    // Shared rail panels — Summary and Validation are present in both modes
    expect(screen.getAllByText(/summary/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/validation/i).length).toBeGreaterThan(0);
  });

  it("does not render the sidebar when embedded", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} embedded state={state} dispatch={vi.fn()} />);
    // Summary panel should not appear when embedded (no sidebar)
    expect(screen.queryByText(/^summary$/i)).not.toBeInTheDocument();
  });

  it("does not render the sidebar when projectId is absent", () => {
    const state = makeState(validConfig);
    renderInRouter(
      <SetupGuided {...defaultProps} projectId={undefined} state={state} dispatch={vi.fn()} />,
    );
    expect(screen.queryByText(/^summary$/i)).not.toBeInTheDocument();
  });

  it("still renders all sections when embedded", () => {
    const state = makeState(validConfig);
    renderInRouter(<SetupGuided {...defaultProps} embedded state={state} dispatch={vi.fn()} />);
    expect(screen.getAllByText(/identity/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/bench capacity/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tools/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/inspections/i).length).toBeGreaterThan(0);
  });
});
