// @vitest-environment jsdom
/**
 * The raw roubo.yaml editor of the project setup page against a real query
 * client and the real notification stream hook: a project-config apply that
 * arrives while the editor holds unsent text refetches the saved copy and
 * leaves the text as typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router";
import type { InputChangedEvent } from "@roubo/shared";
import { renderWithProviders, makeQueryClient } from "../../test/renderWithProviders";
import { useNotificationStream } from "../../hooks/useNotificationStream";
import * as api from "../../lib/api";
import Setup from "./Setup";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, fetchRawConfig: vi.fn(), fetchDelivery: vi.fn() };
});
vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    data: [{ id: "lantern", repoPath: "/repo/lantern", configValid: false }],
  }),
  useRegisterProject: () => ({ mutate: vi.fn(), isPending: false }),
  useReloadProjectConfig: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../hooks/useSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSetup")>();
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...actual,
    useScanRepo: () => ({ data: undefined, isLoading: false }),
    useEnvKeys: () => ({ data: undefined }),
    useValidateConfig: mutation,
    useSaveConfig: mutation,
    useSaveRawConfig: mutation,
  };
});
vi.mock("../../hooks/useBenches", () => ({
  useProjectBenches: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: null, isLoading: false }),
}));
// A plain textarea stands in for the YAML editor, bound as the real one is.
vi.mock("./SetupGuided", () => ({
  default: ({
    rawYaml,
    onRawYamlChange,
  }: {
    rawYaml: string;
    onRawYamlChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="roubo.yaml"
      value={rawYaml}
      onChange={(e) => onRawYamlChange(e.target.value)}
    />
  ),
}));

interface FakeSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  readyState: number;
  close: () => void;
}

let source: FakeSource;

function StreamAndSetup() {
  useNotificationStream();
  return (
    <MemoryRouter initialEntries={["/projects/lantern/settings/setup"]}>
      <Routes>
        <Route path="/projects/:projectId/settings/setup" element={<Setup />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "EventSource",
    vi.fn(function FakeEventSource() {
      source = { onmessage: null, onerror: null, onopen: null, readyState: 0, close: vi.fn() };
      return source;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Setup raw config editor and input-changed events", () => {
  it("HR-TC-035 a project-config apply refetches the raw config and keeps the unsent editor text", async () => {
    const fetchRawConfig = vi.mocked(api.fetchRawConfig);
    fetchRawConfig.mockResolvedValue({ yaml: "project:\n  name: lantern\n" });
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderWithProviders(<StreamAndSetup />, { queryClient });

    const editor = await screen.findByLabelText("roubo.yaml");
    await waitFor(() => expect(editor).toHaveValue("project:\n  name: lantern\n"));
    await userEvent.clear(editor);
    await userEvent.type(editor, "draft note");
    expect(fetchRawConfig).toHaveBeenCalledTimes(1);

    fetchRawConfig.mockResolvedValue({ yaml: "project:\n  name: lantern\nbenches:\n  max: 4\n" });
    const event: InputChangedEvent = {
      type: "input-changed",
      surface: "project-config",
      outcome: "applied",
      projectId: "lantern",
      summary: "Project lantern: roubo.yaml applied.",
    };
    act(() => source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));

    await waitFor(() => expect(fetchRawConfig).toHaveBeenCalledTimes(2));
    expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([
      ["projects"],
      ["raw-config", "lantern"],
      ["benches"],
    ]);
    await waitFor(() =>
      expect(queryClient.getQueryData(["raw-config", "lantern"])).toEqual({
        yaml: "project:\n  name: lantern\nbenches:\n  max: 4\n",
      }),
    );
    expect(screen.getByLabelText("roubo.yaml")).toHaveValue("draft note");
  });
});
