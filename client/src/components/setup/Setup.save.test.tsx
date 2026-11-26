// @vitest-environment jsdom
/**
 * A save on the project setup page in edit mode, against a real query client
 * and the real project and setup hooks. The save routes re-parse roubo.yaml on
 * the server and stay silent for the app's own write, so the page must not
 * follow a save with the manual reload route, which logs and notifies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router";
import { renderWithProviders, makeQueryClient } from "../../test/renderWithProviders";
import * as api from "../../lib/api";
import Setup from "./Setup";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchRawConfig: vi.fn(),
    saveConfig: vi.fn(),
    saveRawConfig: vi.fn(),
    reloadProjectConfig: vi.fn(),
  };
});
vi.mock("../../hooks/useSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSetup")>();
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...actual,
    useScanRepo: () => ({ data: undefined, isLoading: false }),
    useEnvKeys: () => ({ data: undefined }),
    useValidateConfig: mutation,
  };
});
vi.mock("../../hooks/useBenches", () => ({
  useProjectBenches: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: null, isLoading: false }),
}));
vi.mock("./SetupGuided", () => ({
  default: ({
    onSave,
    onModeChange,
  }: {
    onSave: () => void;
    onModeChange?: (mode: string) => void;
  }) => (
    <div>
      <button onClick={onSave}>Save</button>
      <button onClick={() => onModeChange?.("yaml")}>Switch Mode</button>
    </div>
  ),
}));

const config = {
  project: { name: "lantern", displayName: "Lantern", repo: "org/lantern" },
  layout: { type: "single-repo" },
  ports: {},
  components: {},
  benches: { max: 1 },
};
const yaml = "project:\n  name: lantern\n";

function renderEditSetup() {
  const queryClient = makeQueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  renderWithProviders(
    <MemoryRouter initialEntries={["/projects/lantern/settings/setup"]}>
      <Routes>
        <Route path="/projects/:projectId/settings/setup" element={<Setup />} />
      </Routes>
    </MemoryRouter>,
    { queryClient },
  );
  const invalidatedKeys = () => invalidate.mock.calls.map(([arg]) => arg?.queryKey);
  return { invalidatedKeys };
}

beforeEach(() => {
  vi.mocked(api.fetchProjects).mockResolvedValue([
    { id: "lantern", repoPath: "/repo/lantern", configValid: true, config },
  ] as never);
  vi.mocked(api.fetchRawConfig).mockResolvedValue({ yaml });
  vi.mocked(api.saveConfig).mockResolvedValue({ path: "/repo/lantern", config } as never);
  vi.mocked(api.saveRawConfig).mockResolvedValue({ path: "/repo/lantern", config } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Setup save in edit mode", () => {
  it("HR-TC-041 a guided save does not call the reload route and refreshes projects and raw-config", async () => {
    const { invalidatedKeys } = renderEditSetup();
    await waitFor(() => expect(api.fetchProjects).toHaveBeenCalled());
    await waitFor(() => expect(api.fetchRawConfig).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidatedKeys()).toEqual(
        expect.arrayContaining([["projects"], ["raw-config", "lantern"]]),
      ),
    );
    expect(api.reloadProjectConfig).not.toHaveBeenCalled();
  });

  it("HR-TC-041 a raw YAML save does not call the reload route and refreshes projects and raw-config", async () => {
    const { invalidatedKeys } = renderEditSetup();
    await waitFor(() => expect(api.fetchRawConfig).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Switch Mode" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveRawConfig).toHaveBeenCalledWith("lantern", yaml));
    await waitFor(() =>
      expect(invalidatedKeys()).toEqual(
        expect.arrayContaining([["projects"], ["raw-config", "lantern"]]),
      ),
    );
    expect(api.saveConfig).not.toHaveBeenCalled();
    expect(api.reloadProjectConfig).not.toHaveBeenCalled();
  });
});
