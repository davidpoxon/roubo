// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SectionReview from "./SectionReview";
import { WIZARD_SECTIONS, type WizardSection, type SectionStatus } from "./wizardReducer";

vi.mock("../../hooks/useSetup", () => ({
  useGitHubProjects: () => ({ data: [] }),
}));

function makeStatus(
  overrides: Partial<Record<WizardSection, SectionStatus>> = {},
): Record<WizardSection, SectionStatus> {
  const status = {} as Record<WizardSection, SectionStatus>;
  for (const s of WIZARD_SECTIONS) status[s] = "pristine";
  return { ...status, ...overrides };
}

const baseConfig = {
  project: {
    name: "test",
    displayName: "Test",
    type: "web" as const,
    repo: "",
  },
  layout: { type: "single-repo" as const },
  components: { web: { type: "process" as const, command: "npm run dev" } },
  ports: { web: { base: 3000 } },
  benches: { max: 5 },
};

function renderReview(
  sectionStatus: Record<WizardSection, SectionStatus>,
  dispatch = vi.fn(),
  props: Partial<React.ComponentProps<typeof SectionReview>> = {},
) {
  return render(
    <SectionReview
      config={baseConfig}
      repoPath="/repo"
      isEditMode={false}
      sectionStatus={sectionStatus}
      dispatch={dispatch}
      onSave={vi.fn()}
      isSaving={false}
      saveSuccess={false}
      {...props}
    />,
  );
}

describe("SectionReview", () => {
  it("enables save button when all required sections are valid", () => {
    renderReview(
      makeStatus({
        project: "valid",
        layout: "valid",
        components: "valid",
        benches: "valid",
      }),
    );
    expect(screen.getByText("Save Config")).not.toBeDisabled();
  });

  it("disables save button when a required section is invalid", () => {
    renderReview(
      makeStatus({
        project: "valid",
        layout: "invalid",
        components: "valid",
        benches: "valid",
      }),
    );
    expect(screen.getByText("Save Config")).toBeDisabled();
  });

  it("disables save button when a required section is pristine", () => {
    renderReview(
      makeStatus({
        project: "valid",
        layout: "pristine",
        components: "valid",
        benches: "valid",
      }),
    );
    expect(screen.getByText("Save Config")).toBeDisabled();
  });

  it("disables save button when an optional section is invalid", () => {
    renderReview(
      makeStatus({
        project: "valid",
        layout: "valid",
        components: "valid",
        benches: "valid",
        tools: "invalid",
      }),
    );
    expect(screen.getByText("Save Config")).toBeDisabled();
  });

  it("shows incomplete sections list when required sections are not valid", () => {
    renderReview(
      makeStatus({
        project: "valid",
        layout: "invalid",
        components: "valid",
        benches: "valid",
      }),
    );
    expect(screen.getByText("Incomplete sections:")).toBeDefined();
    expect(screen.getByText(/Layout/)).toBeDefined();
  });

  it("does not show incomplete sections list when all required sections are valid", () => {
    renderReview(
      makeStatus({
        project: "valid",
        layout: "valid",
        components: "valid",
        benches: "valid",
      }),
    );
    expect(screen.queryByText("Incomplete sections:")).toBeNull();
  });

  it("dispatches invalid when there are invalid sections", () => {
    const dispatch = vi.fn();
    renderReview(
      makeStatus({
        project: "valid",
        layout: "invalid",
        components: "valid",
        benches: "valid",
      }),
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SECTION_STATUS",
      payload: { section: "review", status: "invalid" },
    });
  });

  it("dispatches invalid when a non-required section is invalid", () => {
    const dispatch = vi.fn();
    renderReview(
      makeStatus({
        project: "valid",
        layout: "valid",
        components: "valid",
        benches: "valid",
        tools: "invalid",
      }),
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SECTION_STATUS",
      payload: { section: "review", status: "invalid" },
    });
  });

  it("does not dispatch when all required sections are valid", () => {
    const dispatch = vi.fn();
    renderReview(
      makeStatus({
        project: "valid",
        layout: "valid",
        components: "valid",
        benches: "valid",
      }),
      dispatch,
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_SECTION_STATUS" }),
    );
  });

  it("does not dispatch when all required sections are pristine", () => {
    const dispatch = vi.fn();
    renderReview(makeStatus(), dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch again when review is already invalid", () => {
    const dispatch = vi.fn();
    renderReview(
      makeStatus({
        project: "valid",
        layout: "invalid",
        components: "valid",
        benches: "valid",
        review: "invalid",
      }),
      dispatch,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches pristine when review is invalid but all required sections become valid", () => {
    const dispatch = vi.fn();
    renderReview(
      makeStatus({
        project: "valid",
        layout: "valid",
        components: "valid",
        benches: "valid",
        review: "invalid",
      }),
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SECTION_STATUS",
      payload: { section: "review", status: "pristine" },
    });
  });

  it("shows saving state on button", () => {
    renderReview(
      makeStatus({
        project: "valid",
        layout: "valid",
        components: "valid",
        benches: "valid",
      }),
      vi.fn(),
      { isSaving: true },
    );
    expect(screen.getByText("Saving...")).toBeDefined();
  });

  it("shows save error message", () => {
    renderReview(makeStatus(), vi.fn(), { saveError: "Save failed" });
    expect(screen.getByText("Save failed")).toBeDefined();
  });

  it("shows save success message in create mode", () => {
    renderReview(makeStatus(), vi.fn(), {
      saveSuccess: true,
      isEditMode: false,
    });
    expect(screen.getByText("Config saved.")).toBeDefined();
  });

  it("shows save success message in edit mode", () => {
    renderReview(makeStatus(), vi.fn(), {
      saveSuccess: true,
      isEditMode: true,
    });
    expect(screen.getByText(/Config saved. Restart/)).toBeDefined();
  });

  it("shows register button after save in create mode", () => {
    renderReview(makeStatus(), vi.fn(), {
      saveSuccess: true,
      isEditMode: false,
      onRegister: vi.fn(),
    });
    expect(screen.getByText("Register Project")).toBeDefined();
  });

  it("shows registering state on register button", () => {
    renderReview(makeStatus(), vi.fn(), {
      saveSuccess: true,
      isEditMode: false,
      onRegister: vi.fn(),
      isRegistering: true,
    });
    expect(screen.getByText("Registering...")).toBeDefined();
  });

  it("renders tools with browser type showing URL", () => {
    renderReview(makeStatus(), vi.fn(), {
      config: {
        ...baseConfig,
        tools: [
          {
            name: "App",
            type: "browser" as const,
            icon: "globe",
            url: "http://localhost:3000",
          },
        ],
      },
    });
    expect(screen.getByText("App")).toBeDefined();
    expect(screen.getByText("http://localhost:3000")).toBeDefined();
  });

  it("renders tools with non-browser type showing command", () => {
    renderReview(makeStatus(), vi.fn(), {
      config: {
        ...baseConfig,
        tools: [
          {
            name: "Shell",
            type: "shell" as const,
            icon: "terminal",
            command: "bash",
          },
        ],
      },
    });
    expect(screen.getByText("Shell")).toBeDefined();
    expect(screen.getByText("bash")).toBeDefined();
  });

  it("renders tool with unknown icon using fallback", () => {
    renderReview(makeStatus(), vi.fn(), {
      config: {
        ...baseConfig,
        tools: [
          {
            name: "Custom",
            type: "browser" as const,
            icon: "unknown-icon-xyz",
            url: "http://example.com",
          },
        ],
      },
    });
    expect(screen.getByText("Custom")).toBeDefined();
  });

  it("renders inspection section with details", () => {
    renderReview(makeStatus(), vi.fn(), {
      config: {
        ...baseConfig,
        inspection: {
          framework: "jest",
          directory: "tests/",
          command: "npm test",
          env: { NODE_ENV: "test" },
        },
      },
    });
    expect(screen.getByText("jest")).toBeDefined();
    expect(screen.getByText("npm test")).toBeDefined();
    expect(screen.getByText("NODE_ENV")).toBeDefined();
  });

  it("renders meta-repo layout with submodules", () => {
    renderReview(makeStatus(), vi.fn(), {
      config: {
        ...baseConfig,
        layout: {
          type: "meta-repo" as const,
          submodules: { api: "packages/api", backend: "packages/backend" },
        },
      },
    });
    expect(screen.getByText("api")).toBeDefined();
    expect(screen.getByText("backend")).toBeDefined();
  });
});
