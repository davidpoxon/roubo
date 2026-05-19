// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import { ProjectDefaultBlueprintTile } from "./ProjectDefaultBlueprintTile";
import type { RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import { useBlueprints } from "../hooks/useBlueprints";
import {
  useProjectDefaultBlueprint,
  useUpdateProjectDefaultBlueprint,
} from "../hooks/useProjectDefaultBlueprint";

vi.mock("../hooks/useBlueprints", () => ({
  useBlueprints: vi.fn(),
}));

vi.mock("../hooks/useProjectDefaultBlueprint", () => ({
  useProjectDefaultBlueprint: vi.fn(),
  useUpdateProjectDefaultBlueprint: vi.fn(),
}));

const mockedUseBlueprints = vi.mocked(useBlueprints);
const mockedUseProjectDefaultBlueprint = vi.mocked(useProjectDefaultBlueprint);
const mockedUseUpdateProjectDefaultBlueprint = vi.mocked(useUpdateProjectDefaultBlueprint);

const baseConfig = {
  project: {
    name: "my-app",
    displayName: "My App",
    type: "web" as const,
    repo: "org/my-app",
  },
  layout: { type: "monorepo" as const },
  components: {},
  ports: {},
  benches: { max: 3 },
};

const baseProject: RegisteredProject = {
  id: "my-app",
  repoPath: "/home/user/my-app",
  configValid: true,
  config: baseConfig,
  settings: DEFAULT_PROJECT_SETTINGS,
};

beforeEach(() => {
  mockedUseBlueprints.mockReturnValue({
    data: [],
    isLoading: false,
  } as unknown as ReturnType<typeof useBlueprints>);
  mockedUseProjectDefaultBlueprint.mockReturnValue({
    data: { blueprintId: "__global_default__", source: "global" },
    isLoading: false,
  } as unknown as ReturnType<typeof useProjectDefaultBlueprint>);
  mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);
});

function renderTile(
  draft: string | null = null,
  onChange = vi.fn(),
  project = baseProject,
  showProjectName = true,
) {
  return renderWithProviders(
    <ProjectDefaultBlueprintTile
      project={project}
      draft={draft}
      onChange={onChange}
      showProjectName={showProjectName}
    />,
  );
}

describe("ProjectDefaultBlueprintTile", () => {
  it("renders the effective blueprint name and source label", () => {
    mockedUseBlueprints.mockReturnValue({
      data: [
        {
          id: "__global_default__",
          name: "Default",
          description: "",
          icon: "sparkles",
          source: "app",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useBlueprints>);

    renderTile();

    expect(screen.getByText("Effective:")).toBeInTheDocument();
    expect(screen.getAllByText("Default").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Global default")).toBeInTheDocument();
  });

  it('shows "From project settings" source label when source is project', () => {
    mockedUseBlueprints.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Blueprint",
          description: "",
          icon: "code",
          source: "project",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useBlueprints>);
    mockedUseProjectDefaultBlueprint.mockReturnValue({
      data: { blueprintId: "my-bp", source: "project" },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectDefaultBlueprint>);

    renderTile("my-bp");

    expect(screen.getByText("From project settings")).toBeInTheDocument();
  });

  it("shows Override badge when draft is not null", () => {
    renderTile("my-bp");
    expect(screen.getByText("Override")).toBeInTheDocument();
    expect(screen.getByText(/Project override active/)).toBeInTheDocument();
  });

  it("does not show Override badge when draft is null", () => {
    renderTile(null);
    expect(screen.queryByText("Override")).not.toBeInTheDocument();
  });

  it("does not show Override badge when source is issue-type-mapping", () => {
    mockedUseProjectDefaultBlueprint.mockReturnValue({
      data: { blueprintId: "my-bp", source: "issue-type-mapping" },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectDefaultBlueprint>);

    renderTile(null);

    expect(screen.queryByText("Override")).not.toBeInTheDocument();
  });

  it('renders "Use app default" option', () => {
    renderTile();
    expect(screen.getByText("Use app default")).toBeInTheDocument();
  });

  it("Use app default is selected when draft is null", () => {
    renderTile(null);
    expect(screen.getByRole("radio", { name: /use app default/i })).toBeChecked();
  });

  it("blueprint option is selected when draft matches a blueprint id", () => {
    mockedUseBlueprints.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Blueprint",
          description: "",
          icon: "code",
          source: "project",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useBlueprints>);

    renderTile("my-bp");

    expect(screen.getByRole("radio", { name: /my blueprint/i })).toBeChecked();
  });

  it('calls onChange with null when "Use app default" is clicked while a blueprint is selected', async () => {
    const onChange = vi.fn();
    mockedUseBlueprints.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Blueprint",
          description: "",
          icon: "code",
          source: "project",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useBlueprints>);

    const user = userEvent.setup();
    renderTile("my-bp", onChange);
    await user.click(screen.getByText("Use app default"));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("calls onChange with blueprint id when a blueprint row is clicked", async () => {
    const onChange = vi.fn();
    mockedUseBlueprints.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Blueprint",
          description: "",
          icon: "code",
          source: "app",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useBlueprints>);

    const user = userEvent.setup();
    renderTile(null, onChange);
    await user.click(screen.getByText("My Blueprint"));

    expect(onChange).toHaveBeenCalledWith("my-bp");
  });

  it("renders project name heading when showProjectName is true", () => {
    renderTile(null, vi.fn(), baseProject, true);
    expect(screen.getByText("My App")).toBeInTheDocument();
  });

  it("omits project name heading when showProjectName is false", () => {
    renderTile(null, vi.fn(), baseProject, false);
    expect(screen.queryByText("My App")).not.toBeInTheDocument();
  });

  it("shows loading spinner while data is loading", () => {
    mockedUseProjectDefaultBlueprint.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useProjectDefaultBlueprint>);

    renderTile();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  describe("uncontrolled (auto-save) mode", () => {
    it("calls mutate when a blueprint is selected", async () => {
      const mutateMock = vi.fn();
      mockedUseBlueprints.mockReturnValue({
        data: [
          {
            id: "my-bp",
            name: "My Blueprint",
            description: "",
            icon: "code",
            source: "app",
          },
        ],
        isLoading: false,
      } as unknown as ReturnType<typeof useBlueprints>);
      mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
        mutate: mutateMock,
        mutateAsync: vi.fn(),
        isPending: false,
        isError: false,
      } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);

      const user = userEvent.setup();
      renderWithProviders(<ProjectDefaultBlueprintTile project={baseProject} />);
      await user.click(screen.getByText("My Blueprint"));

      expect(mutateMock).toHaveBeenCalledWith("my-bp");
    });

    it("shows error message in uncontrolled mode when mutation fails", () => {
      mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: false,
        isError: true,
      } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);

      renderWithProviders(<ProjectDefaultBlueprintTile project={baseProject} />);

      expect(screen.getByText("Failed to save. Please try again.")).toBeInTheDocument();
    });

    it("applies disabled styling while mutation is pending in uncontrolled mode", () => {
      mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: true,
        isError: false,
      } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);

      renderWithProviders(<ProjectDefaultBlueprintTile project={baseProject} />);

      const picker = screen.getByRole("radiogroup");
      expect(picker.className).toContain("opacity-60");
      expect(picker.className).toContain("pointer-events-none");
    });
  });
});
