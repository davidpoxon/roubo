// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ProjectPermissionsEditorPage } from "./ProjectPermissionsEditorPage";
import { useProjectPermissions } from "../../hooks/useProjectPermissions";
import { useToast } from "../../hooks/useToast";

vi.mock("../../hooks/useProjectPermissions", () => ({
  useProjectPermissions: vi.fn(),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: vi.fn(() => ({ data: [] })),
}));

vi.mock("../../hooks/useToast", () => ({
  useToast: vi.fn(() => ({ addToast: vi.fn() })),
}));

const mockedUseProjectPermissions = vi.mocked(useProjectPermissions);
const mockedUseToast = vi.mocked(useToast);

function makeDefaultHook(overrides = {}) {
  return {
    permissions: { allow: [], deny: [], ask: [] },
    isLoading: false,
    updatePermissions: vi.fn(),
    isError: false,
    error: null,
    resyncBenches: vi.fn(),
    isResyncing: false,
    ...overrides,
  };
}

function LocationCapture({ onChange }: { onChange: (path: string) => void }) {
  const location = useLocation();
  onChange(location.pathname);
  return null;
}

function renderEditor(projectId = "my-app") {
  let capturedPath = "";
  const result = renderWithProviders(
    <MemoryRouter initialEntries={[`/projects/${projectId}/settings/permissions`]}>
      <Routes>
        <Route
          path="/projects/:projectId/settings/permissions"
          element={<ProjectPermissionsEditorPage projectId={projectId} />}
        />
        <Route
          path="/projects/:projectId/settings"
          element={
            <LocationCapture
              onChange={(p) => {
                capturedPath = p;
              }}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { ...result, getCapturedPath: () => capturedPath };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseProjectPermissions.mockReturnValue(makeDefaultHook());
});

describe("ProjectPermissionsEditorPage", () => {
  it("renders the page heading", () => {
    renderEditor();
    expect(screen.getByRole("heading", { name: "Claude Code permissions" })).toBeInTheDocument();
  });

  it("renders the Add rule container", () => {
    renderEditor();
    expect(screen.getByText("Add rule")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Bash(pytest:*)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
  });

  it("renders template chips", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: "Bash(*)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read(./**)" })).toBeInTheDocument();
  });

  it("renders allow rules in the table", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: { allow: ["Bash(npm test:*)"], deny: [], ask: [] },
      }),
    );
    renderEditor();
    expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    expect(screen.getAllByText("allow").length).toBeGreaterThan(0);
  });

  it("renders deny rules in the table", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] },
      }),
    );
    renderEditor();
    expect(screen.getByText("Bash(rm:*)")).toBeInTheDocument();
    // badge "deny" may appear in option elements too: at least one should be in a span
    expect(screen.getAllByText("deny").length).toBeGreaterThan(0);
  });

  it("renders ask rules in the table", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: { allow: [], deny: [], ask: ["Edit(.env*)"] },
      }),
    );
    renderEditor();
    expect(screen.getByText("Edit(.env*)")).toBeInTheDocument();
    expect(screen.getAllByText("ask").length).toBeGreaterThan(0);
  });

  it("adding a rule calls updatePermissions with correct payload", async () => {
    const updatePermissions = vi.fn();
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: { allow: ["Bash(npm test:*)"], deny: ["Bash(rm:*)"], ask: [] },
        updatePermissions,
      }),
    );
    const user = userEvent.setup();
    renderEditor();

    const input = screen.getByPlaceholderText("Bash(pytest:*)");
    await user.type(input, "Read(src/**)");
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    expect(updatePermissions).toHaveBeenCalledWith({
      allow: ["Bash(npm test:*)", "Read(src/**)"],
      deny: ["Bash(rm:*)"],
      ask: [],
    });
  });

  it("clicking a template chip populates the input", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: "Bash(*)" }));
    expect(screen.getByPlaceholderText("Bash(pytest:*)")).toHaveValue("Bash(*)");
  });

  it("shows duplicate error and does not call updatePermissions for existing rule", async () => {
    const updatePermissions = vi.fn();
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: { allow: ["Bash(npm test:*)"], deny: [], ask: [] },
        updatePermissions,
      }),
    );
    const user = userEvent.setup();
    renderEditor();
    const input = screen.getByPlaceholderText("Bash(pytest:*)");
    await user.type(input, "Bash(npm test:*)");
    await user.click(screen.getByRole("button", { name: /^add$/i }));
    expect(updatePermissions).not.toHaveBeenCalled();
    expect(screen.getByText("Rule already exists")).toBeInTheDocument();
  });

  it("shows error message when update or fetch fails", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({ isError: true, error: new Error("Server error") }),
    );
    renderEditor();
    expect(
      screen.getByText("Failed to load or save permissions. Please try again."),
    ).toBeInTheDocument();
  });

  it("back link navigates to settings overview", async () => {
    const user = userEvent.setup();
    const { getCapturedPath } = renderEditor("my-app");
    await user.click(screen.getByRole("link", { name: /settings/i }));
    expect(getCapturedPath()).toBe("/projects/my-app/settings");
  });

  it("shows loading state", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({ permissions: undefined, isLoading: true }),
    );
    renderEditor();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("renders Import from project and Export JSON buttons", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: /import from project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export json/i })).toBeInTheDocument();
  });

  it("renders Re-sync benches button", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: /re-sync benches/i })).toBeInTheDocument();
  });

  it("shows success toast after successful resync", async () => {
    const addToast = vi.fn();
    mockedUseToast.mockReturnValue({ addToast, removeToast: vi.fn() });
    const resyncBenches = vi.fn().mockImplementation(
      (
        _data: unknown,
        {
          onSuccess,
        }: {
          onSuccess: (r: {
            resynced: number;
            skipped: number;
            errors: { benchId: number; message: string }[];
          }) => void;
        },
      ) => {
        onSuccess({ resynced: 2, skipped: 0, errors: [] });
      },
    );
    mockedUseProjectPermissions.mockReturnValue(makeDefaultHook({ resyncBenches }));

    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: /re-sync benches/i }));

    expect(addToast).toHaveBeenCalledWith("Re-synced 2 benches");
  });

  it("shows error toast when resync fails", async () => {
    const addToast = vi.fn();
    mockedUseToast.mockReturnValue({ addToast, removeToast: vi.fn() });
    const resyncBenches = vi
      .fn()
      .mockImplementation((_data: unknown, { onError }: { onError: (e: Error) => void }) => {
        onError(new Error("Connection refused"));
      });
    mockedUseProjectPermissions.mockReturnValue(makeDefaultHook({ resyncBenches }));

    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: /re-sync benches/i }));

    expect(addToast).toHaveBeenCalledWith("Connection refused", { duration: 8000 });
  });
});
