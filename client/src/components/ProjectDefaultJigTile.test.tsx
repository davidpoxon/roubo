// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import { ProjectDefaultJigTile } from "./ProjectDefaultJigTile";
import type { RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import { useJigs } from "../hooks/useJigs";
import { useProjectDefaultJig, useUpdateProjectDefaultJig } from "../hooks/useProjectDefaultJig";

vi.mock("../hooks/useJigs", () => ({
  useJigs: vi.fn(),
}));

vi.mock("../hooks/useProjectDefaultJig", () => ({
  useProjectDefaultJig: vi.fn(),
  useUpdateProjectDefaultJig: vi.fn(),
}));

const mockedUseJigs = vi.mocked(useJigs);
const mockedUseProjectDefaultJig = vi.mocked(useProjectDefaultJig);
const mockedUseUpdateProjectDefaultJig = vi.mocked(useUpdateProjectDefaultJig);

const baseConfig = {
  project: {
    name: "my-app",
    displayName: "My App",
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
  mockedUseJigs.mockReturnValue({
    data: [],
    isLoading: false,
  } as unknown as ReturnType<typeof useJigs>);
  mockedUseProjectDefaultJig.mockReturnValue({
    data: { jigId: "__global_default__", source: "global" },
    isLoading: false,
  } as unknown as ReturnType<typeof useProjectDefaultJig>);
  mockedUseUpdateProjectDefaultJig.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);
});

function renderTile(
  draft: string | null = null,
  onChange = vi.fn(),
  project = baseProject,
  showProjectName = true,
) {
  return renderWithProviders(
    <ProjectDefaultJigTile
      project={project}
      draft={draft}
      onChange={onChange}
      showProjectName={showProjectName}
    />,
  );
}

describe("ProjectDefaultJigTile", () => {
  it("renders the effective jig name and source label", () => {
    mockedUseJigs.mockReturnValue({
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
    } as unknown as ReturnType<typeof useJigs>);

    renderTile();

    expect(screen.getByText("Effective:")).toBeInTheDocument();
    expect(screen.getAllByText("Default").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Global default")).toBeInTheDocument();
  });

  it('shows "From project settings" source label when source is project', () => {
    mockedUseJigs.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Jig",
          description: "",
          icon: "code",
          source: "project",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useJigs>);
    mockedUseProjectDefaultJig.mockReturnValue({
      data: { jigId: "my-bp", source: "project" },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectDefaultJig>);

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
    mockedUseProjectDefaultJig.mockReturnValue({
      data: { jigId: "my-bp", source: "issue-type-mapping" },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectDefaultJig>);

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

  it("jig option is selected when draft matches a jig id", () => {
    mockedUseJigs.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Jig",
          description: "",
          icon: "code",
          source: "project",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useJigs>);

    renderTile("my-bp");

    expect(screen.getByRole("radio", { name: /my jig/i })).toBeChecked();
  });

  it('calls onChange with null when "Use app default" is clicked while a jig is selected', async () => {
    const onChange = vi.fn();
    mockedUseJigs.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Jig",
          description: "",
          icon: "code",
          source: "project",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useJigs>);

    const user = userEvent.setup();
    renderTile("my-bp", onChange);
    await user.click(screen.getByText("Use app default"));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("calls onChange with jig id when a jig row is clicked", async () => {
    const onChange = vi.fn();
    mockedUseJigs.mockReturnValue({
      data: [
        {
          id: "my-bp",
          name: "My Jig",
          description: "",
          icon: "code",
          source: "app",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useJigs>);

    const user = userEvent.setup();
    renderTile(null, onChange);
    await user.click(screen.getByText("My Jig"));

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
    mockedUseProjectDefaultJig.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useProjectDefaultJig>);

    renderTile();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  describe("uncontrolled (auto-save) mode", () => {
    it("calls mutate when a jig is selected", async () => {
      const mutateMock = vi.fn();
      mockedUseJigs.mockReturnValue({
        data: [
          {
            id: "my-bp",
            name: "My Jig",
            description: "",
            icon: "code",
            source: "app",
          },
        ],
        isLoading: false,
      } as unknown as ReturnType<typeof useJigs>);
      mockedUseUpdateProjectDefaultJig.mockReturnValue({
        mutate: mutateMock,
        mutateAsync: vi.fn(),
        isPending: false,
        isError: false,
      } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);

      const user = userEvent.setup();
      renderWithProviders(<ProjectDefaultJigTile project={baseProject} />);
      await user.click(screen.getByText("My Jig"));

      expect(mutateMock).toHaveBeenCalledWith("my-bp");
    });

    it("shows error message in uncontrolled mode when mutation fails", () => {
      mockedUseUpdateProjectDefaultJig.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: false,
        isError: true,
      } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);

      renderWithProviders(<ProjectDefaultJigTile project={baseProject} />);

      expect(screen.getByText("Failed to save. Please try again.")).toBeInTheDocument();
    });

    it("applies disabled styling while mutation is pending in uncontrolled mode", () => {
      mockedUseUpdateProjectDefaultJig.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: true,
        isError: false,
      } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);

      renderWithProviders(<ProjectDefaultJigTile project={baseProject} />);

      const picker = screen.getByRole("radiogroup");
      expect(picker.className).toContain("opacity-60");
      expect(picker.className).toContain("pointer-events-none");
    });
  });
});
