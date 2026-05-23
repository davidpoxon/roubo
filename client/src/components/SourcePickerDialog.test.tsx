// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, DialogTrigger } from "react-aria-components";
import { renderWithProviders } from "../test/renderWithProviders";
import SourcePickerDialog from "./SourcePickerDialog";
import * as api from "../lib/api";
import type { ProjectIntegrationState, SourceCandidatesResponse } from "@roubo/shared";

function renderDialog(
  props: {
    projectId?: string;
    pluginId?: string;
    pluginLabel?: string;
    initialValue?: Record<string, string[]>;
    onClose?: () => void;
  } = {},
) {
  const onClose = props.onClose ?? vi.fn();
  return renderWithProviders(
    <DialogTrigger
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Button>Choose sources</Button>
      <SourcePickerDialog
        projectId={props.projectId ?? "proj-1"}
        pluginId={props.pluginId ?? "github-com"}
        pluginLabel={props.pluginLabel ?? "GitHub.com"}
        initialValue={props.initialValue ?? {}}
      />
    </DialogTrigger>,
  );
}

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchSourceCandidates: vi.fn(),
    saveProjectSources: vi.fn(),
  };
});

const mockedFetch = vi.mocked(api.fetchSourceCandidates);
const mockedSave = vi.mocked(api.saveProjectSources);

beforeEach(() => {
  vi.resetAllMocks();
});

function multiList(): SourceCandidatesResponse {
  return {
    shape: "multi-list",
    items: [
      { externalId: "org/api", label: "org/api", icon: "repo" },
      { externalId: "org/web", label: "org/web", icon: "repo" },
    ],
  };
}

function freshState(): ProjectIntegrationState {
  return {
    effective: { plugin: "github-com" },
    committed: null,
    override: { plugin: "github-com" },
    plugin: { id: "github-com", installed: true, status: "enabled", manifest: { name: "GH" } },
    captionKey: "override-only",
  };
}

describe("SourcePickerDialog", () => {
  it("shows a loading state while candidates are fetching", () => {
    mockedFetch.mockReturnValue(new Promise(() => {}));
    renderDialog();

    expect(screen.getByText(/Loading source candidates/)).toBeInTheDocument();
  });

  it("renders the picker once candidates load and saves the user's selection", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue(multiList());
    mockedSave.mockResolvedValue(freshState());
    const onClose = vi.fn();

    renderDialog({ onClose });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: /source candidates/i })).toBeInTheDocument();
    });

    await user.click(screen.getByText("org/api"));
    await user.click(screen.getByRole("button", { name: /save sources/i }));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith("proj-1", { items: ["org/api"] });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("renders an alert when the fetch fails", async () => {
    mockedFetch.mockRejectedValue(new Error("plugin offline"));

    renderDialog();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/plugin offline/);
    });
  });

  it("Cancel closes without saving", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue(multiList());
    const onClose = vi.fn();

    renderDialog({ initialValue: { items: ["org/api"] }, onClose });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: /source candidates/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockedSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces a save error inline", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue(multiList());
    mockedSave.mockRejectedValue(new api.ApiError("write denied", 403));
    const onClose = vi.fn();

    renderDialog({ initialValue: { items: ["org/api"] }, onClose });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: /source candidates/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /save sources/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/write denied/);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
