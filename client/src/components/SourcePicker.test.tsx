// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SourceCandidatesResponse, SourceSelection } from "@roubo/shared";
import SourcePicker from "./SourcePicker";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: { startGithubPluginOauth: vi.fn() },
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, startGithubPluginOauth: apiMocks.startGithubPluginOauth };
});

function ControlledPicker({
  response,
  initial = {},
  onChangeSpy,
}: {
  response: SourceCandidatesResponse;
  initial?: SourceSelection;
  onChangeSpy?: (next: SourceSelection) => void;
}) {
  // Inline tiny wrapper so tests exercise the real controlled flow.
  const [value, setValue] = useStateValue(initial);
  return (
    <SourcePicker
      response={response}
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
    />
  );
}

// Mini state helper — avoids pulling React import in the test wrapper boilerplate.
import { useState } from "react";
function useStateValue(
  initial: SourceSelection,
): [SourceSelection, (next: SourceSelection) => void] {
  const [value, setValue] = useState<SourceSelection>(initial);
  return [value, setValue];
}

const multiListFixture: SourceCandidatesResponse = {
  shape: "multi-list",
  items: [
    { externalId: "org/api", label: "org/api", sublabel: "Backend service", icon: "repo" },
    { externalId: "org/web", label: "org/web", sublabel: "Frontend", icon: "repo" },
    { externalId: "proj-42", label: "Roadmap", sublabel: "Project board", icon: "project" },
  ],
};

const categorizedFixture: SourceCandidatesResponse = {
  shape: "categorized-multi-list",
  categories: [
    {
      id: "boards",
      label: "Boards",
      items: [
        { externalId: "b1", label: "Engineering", icon: "board" },
        { externalId: "b2", label: "Design", icon: "board" },
      ],
    },
    {
      id: "epics",
      label: "Epics",
      items: [{ externalId: "e1", label: "Q1 launch", icon: "epic" }],
    },
    {
      id: "filters",
      label: "Filters",
      items: [{ externalId: "f1", label: "Open bugs", icon: "filter" }],
    },
  ],
};

describe("SourcePicker — multi-list (TC-021)", () => {
  it("renders combined items with type-aware affordances and selection chips", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker response={multiListFixture} onChangeSpy={onChange} />);

    // Items are listed with labels and sublabels in a single combined list.
    const list = screen.getByRole("listbox", { name: /source candidates/i });
    expect(within(list).getByText("org/api")).toBeInTheDocument();
    expect(within(list).getByText("Backend service")).toBeInTheDocument();
    expect(within(list).getByText("Roadmap")).toBeInTheDocument();

    // Select two items.
    await user.click(within(list).getByText("org/api"));
    await user.click(within(list).getByText("Roadmap"));

    // Both appear in the chip strip; counter reflects selection.
    expect(screen.getByText(/Selected \(2\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove org/api" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Roadmap" })).toBeInTheDocument();

    // Removing a chip propagates back to onChange.
    await user.click(screen.getByRole("button", { name: "Remove org/api" }));
    expect(screen.queryByRole("button", { name: "Remove org/api" })).not.toBeInTheDocument();

    // onChange was called with the persisted SourceSelection shape (key "items").
    expect(onChange).toHaveBeenLastCalledWith({ items: ["proj-42"] });
  });

  it("filters the list via the search field", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={multiListFixture} />);

    const list = screen.getByRole("listbox", { name: /source candidates/i });
    expect(within(list).getByText("org/api")).toBeInTheDocument();
    expect(within(list).getByText("Roadmap")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: /search source candidates/i }), "road");

    expect(within(list).queryByText("org/api")).not.toBeInTheDocument();
    expect(within(list).getByText("Roadmap")).toBeInTheDocument();
  });
});

describe("SourcePicker — categorized-multi-list (TC-022)", () => {
  it("renders one tab per category and shows per-tab count badges", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={categorizedFixture} />);

    const tabList = screen.getByRole("tablist", { name: /source categories/i });
    expect(within(tabList).getByRole("tab", { name: /Boards/ })).toBeInTheDocument();
    expect(within(tabList).getByRole("tab", { name: /Epics/ })).toBeInTheDocument();
    expect(within(tabList).getByRole("tab", { name: /Filters/ })).toBeInTheDocument();

    // The first tab is selected by default; select an item.
    const boardsList = screen.getByRole("listbox", { name: /boards candidates/i });
    await user.click(within(boardsList).getByText("Engineering"));

    // Boards tab now shows a count badge of 1; Epics shows none.
    const boardsTab = within(tabList).getByRole("tab", { name: /Boards/ });
    expect(within(boardsTab).getByLabelText(/1 selected/)).toBeInTheDocument();
    expect(
      within(within(tabList).getByRole("tab", { name: /Epics/ })).queryByLabelText(/selected/),
    ).not.toBeInTheDocument();
  });

  it("scopes search and selection per tab and groups chips by category", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={categorizedFixture} />);

    // Select a Board.
    const boardsList = screen.getByRole("listbox", { name: /boards candidates/i });
    await user.click(within(boardsList).getByText("Engineering"));

    // Switch to Epics tab and select.
    await user.click(screen.getByRole("tab", { name: /Epics/ }));
    const epicsList = screen.getByRole("listbox", { name: /epics candidates/i });
    await user.click(within(epicsList).getByText("Q1 launch"));

    // Chip strip is grouped: "Boards" group + "Epics" group, each with the right chip.
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Engineering" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Q1 launch" })).toBeInTheDocument();
  });
});

describe("SourcePicker — accessibility & keyboard nav (TC-076)", () => {
  it("makes search focusable and selects with Space inside the list", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker response={multiListFixture} onChangeSpy={onChange} />);

    const search = screen.getByRole("searchbox", { name: /search source candidates/i });

    // React Aria's focus hooks update state when focus moves into a managed
    // node, so direct .focus() calls must run inside act() to keep the renders
    // tracked (CLAUDE.md: tests must produce zero stderr).
    act(() => {
      search.focus();
    });
    expect(search).toHaveFocus();

    const list = screen.getByRole("listbox", { name: /source candidates/i });
    const firstOption = within(list).getByRole("option", { name: /org\/api/ });
    act(() => {
      firstOption.focus();
    });
    await user.keyboard(" ");

    expect(onChange).toHaveBeenLastCalledWith({ items: ["org/api"] });
  });

  it("announces selection changes via an aria-live region (TC-076)", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={multiListFixture} />);

    // The chip strip carries the selected count and chip list and is wrapped
    // in aria-live="polite" so screen readers announce each selection change
    // (TC-076 expects "Selection state updates and is announced").
    const list = screen.getByRole("listbox", { name: /source candidates/i });
    await user.click(within(list).getByText("org/api"));

    const count = screen.getByText(/Selected \(1\)/);
    const region = count.parentElement;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("categorized tabs expose tablist role and per-tab selection counts (TC-076)", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={categorizedFixture} />);

    // TabList is named so screen readers announce the category list when focus enters.
    const tabList = screen.getByRole("tablist", { name: /source categories/i });
    expect(tabList).toBeInTheDocument();

    // Selecting an item populates the tab's count badge with an aria-label so
    // screen readers announce "N selected" alongside the tab label.
    const boardsList = screen.getByRole("listbox", { name: /boards candidates/i });
    await user.click(within(boardsList).getByText("Engineering"));

    const boardsTab = within(tabList).getByRole("tab", { name: /Boards/ });
    expect(within(boardsTab).getByLabelText(/1 selected/i)).toBeInTheDocument();
  });
});

describe("SourcePicker: security & quality alerts disclosure (WU-030)", () => {
  it("renders three unchecked checkboxes per selected GitHub-family source (AC #1)", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={multiListFixture} initial={{ items: ["org/api"] }} />);

    // Expand the disclosure so the checkboxes are reachable.
    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );

    const codeCheckbox = screen.getByRole("checkbox", { name: "Code Scanning alerts" });
    const secretCheckbox = screen.getByRole("checkbox", { name: "Secret Scanning alerts" });
    const depCheckbox = screen.getByRole("checkbox", { name: "Dependabot alerts" });
    expect(codeCheckbox).not.toBeChecked();
    expect(secretCheckbox).not.toBeChecked();
    expect(depCheckbox).not.toBeChecked();
  });

  it("toggling a checkbox emits the object form via onChange (AC #2)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ControlledPicker
        response={multiListFixture}
        initial={{ items: ["org/api"] }}
        onChangeSpy={onChange}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Code Scanning alerts" }));

    expect(onChange).toHaveBeenLastCalledWith({
      items: [{ externalId: "org/api", includeCodeQLAlerts: true }],
    });
  });

  it("shows a chip-count and comma-separated summary on the collapsed label (AC #9)", async () => {
    render(
      <ControlledPicker
        response={multiListFixture}
        initial={{
          items: [
            {
              externalId: "org/api",
              includeCodeQLAlerts: true,
              includeDependabotAlerts: true,
            },
          ],
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Security & quality alerts for org\/api/i });
    expect(within(trigger).getByText("(Code Scanning, Dependabot)")).toBeInTheDocument();
    expect(within(trigger).getByLabelText(/2 enabled/)).toBeInTheDocument();
  });

  it("renders a warning chip with accessible cause when a warning matches the row (AC #7)", async () => {
    const user = userEvent.setup();
    const warning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
    };
    render(
      <SourcePicker
        response={multiListFixture}
        value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
        onChange={() => {}}
        warnings={[warning]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );

    const description = screen.getByText(warning.cause);
    expect(description).toHaveClass("sr-only");
  });

  describe("OAuth re-consent (WU-031)", () => {
    let queryClient: QueryClient;
    let windowOpenSpy: ReturnType<typeof vi.fn>;

    function wrapWithProviders(node: React.ReactElement): ReactNode {
      return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
    }

    beforeEach(() => {
      apiMocks.startGithubPluginOauth.mockReset();
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.invalidateQueries = vi.fn() as never;
      Object.defineProperty(window, "roubo", {
        configurable: true,
        value: {
          onDeepLink: vi.fn(() => () => {}),
          onNavigate: vi.fn(() => () => {}),
          platform: "darwin",
          setTitleBarOverlayTheme: vi.fn(),
          getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
        },
      });
      windowOpenSpy = vi.fn();
      vi.stubGlobal("open", windowOpenSpy);
    });

    afterEach(() => {
      Object.defineProperty(window, "roubo", { configurable: true, value: undefined });
      vi.unstubAllGlobals();
    });

    const oauthWarning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
      detail: { status: 401 as const },
    };

    const nonOauthWarning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
      detail: { status: 403 as const },
    };

    it("renders the chip as a button when the warning is a 401 on a security category", async () => {
      const user = userEvent.setup();
      render(
        wrapWithProviders(
          <SourcePicker
            response={multiListFixture}
            value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
            onChange={() => {}}
            warnings={[oauthWarning]}
          />,
        ),
      );

      await user.click(
        screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
      );

      // Two buttons named "Unavailable" should not be possible; the chip is
      // the only one with that name + a button role.
      const chip = screen.getByRole("button", { name: /unavailable/i });
      expect(chip.tagName).toBe("BUTTON");
    });

    it("renders the chip as a non-interactive span when the warning is not OAuth-recoverable", async () => {
      const user = userEvent.setup();
      const { container } = render(
        wrapWithProviders(
          <SourcePicker
            response={multiListFixture}
            value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
            onChange={() => {}}
            warnings={[nonOauthWarning]}
          />,
        ),
      );
      await user.click(
        screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
      );
      // Chip should not be a button (no accessible name "Unavailable" on a BUTTON).
      expect(screen.queryByRole("button", { name: /unavailable/i })).toBeNull();
      const chip = container.querySelector('[data-chip-category="status"]') as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip?.tagName).toBe("SPAN");
    });

    it("opens the OAuth re-consent dialog when the chip-as-button is clicked", async () => {
      const user = userEvent.setup();
      render(
        wrapWithProviders(
          <SourcePicker
            response={multiListFixture}
            value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
            onChange={() => {}}
            warnings={[oauthWarning]}
          />,
        ),
      );
      await user.click(
        screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
      );
      await user.click(screen.getByRole("button", { name: /unavailable/i }));
      expect(screen.getByTestId("oauth-reconsent-dialog")).toBeInTheDocument();
    });

    it("shows a Retry hint inside the chip after the user cancels the OAuth flow", async () => {
      apiMocks.startGithubPluginOauth.mockResolvedValueOnce({
        url: "https://github.com/login/oauth/authorize?state=xyz",
      });
      const user = userEvent.setup();
      render(
        wrapWithProviders(
          <SourcePicker
            response={multiListFixture}
            value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
            onChange={() => {}}
            warnings={[oauthWarning]}
          />,
        ),
      );
      await user.click(
        screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
      );
      await user.click(screen.getByRole("button", { name: /unavailable/i }));
      await user.click(screen.getByRole("button", { name: /continue to github/i }));
      await waitFor(() => expect(windowOpenSpy).toHaveBeenCalled());
      await user.click(screen.getByTestId("oauth-reconsent-cancel"));

      await waitFor(() =>
        expect(screen.getByTestId("oauth-reconsent-retry-hint")).toBeInTheDocument(),
      );
    });
  });

  it("renders a GHE PAT scope reminder chip for missing-scope when pluginId is 'ghe' (WU-040 / TC-137 GHE PAT branch)", async () => {
    const user = userEvent.setup();
    const warning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
      code: "missing-scope" as const,
      detail: { status: 401 },
    };
    render(
      <SourcePicker
        response={multiListFixture}
        value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
        onChange={() => {}}
        warnings={[warning]}
        chipContext={{ pluginId: "ghe", gheInstanceUrl: "https://ghe.example.com" }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );

    const link = screen.getByTestId("alert-chip-missing-scope-ghe");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link).toHaveAttribute("href", "https://ghe.example.com/settings/tokens");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.textContent).toMatch(/Verify your PAT has security_events scope/);
  });

  it("trims trailing slash from gheInstanceUrl when building the token settings link", async () => {
    const user = userEvent.setup();
    const warning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
      code: "missing-scope" as const,
    };
    render(
      <SourcePicker
        response={multiListFixture}
        value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
        onChange={() => {}}
        warnings={[warning]}
        chipContext={{ pluginId: "ghe", gheInstanceUrl: "https://ghe.example.com/" }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );

    const link = screen.getByTestId("alert-chip-missing-scope-ghe");
    expect(link).toHaveAttribute("href", "https://ghe.example.com/settings/tokens");
  });

  it("renders a github.com 'Reconnect GitHub' chip for missing-scope when pluginId is 'github-com'", async () => {
    const user = userEvent.setup();
    const onReconnect = vi.fn();
    const warning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
      code: "missing-scope" as const,
    };
    render(
      <SourcePicker
        response={multiListFixture}
        value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
        onChange={() => {}}
        warnings={[warning]}
        chipContext={{ pluginId: "github-com", onReconnectOAuth: onReconnect }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );

    const chip = screen.getByTestId("alert-chip-missing-scope-github-com");
    expect(chip.textContent).toMatch(/Reconnect GitHub/);
    await user.click(chip);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("renders the NFR-015 graceful copy for scope-unverifiable warnings", async () => {
    const user = userEvent.setup();
    const NFR_015 =
      "Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.";
    const warning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: NFR_015,
      code: "scope-unverifiable" as const,
    };
    render(
      <SourcePicker
        response={multiListFixture}
        value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
        onChange={() => {}}
        warnings={[warning]}
        chipContext={{ pluginId: "ghe", gheInstanceUrl: "https://ghe.example.com" }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );

    const chip = screen.getByTestId("alert-chip-scope-unverifiable");
    expect(chip.textContent).toMatch(/Verify token/);
    expect(screen.getByText(NFR_015)).toHaveClass("sr-only");
  });

  it("falls back to the generic 'Unavailable' chip when missing-scope has no plugin context", async () => {
    const user = userEvent.setup();
    const warning = {
      category: "code-scanning" as const,
      sourceExternalId: "org/api",
      cause: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
      code: "missing-scope" as const,
    };
    render(
      <SourcePicker
        response={multiListFixture}
        value={{ items: [{ externalId: "org/api", includeCodeQLAlerts: true }] }}
        onChange={() => {}}
        warnings={[warning]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Security & quality alerts for org\/api/i }),
    );

    expect(screen.queryByTestId("alert-chip-missing-scope-ghe")).toBeNull();
    expect(screen.queryByTestId("alert-chip-missing-scope-github-com")).toBeNull();
    expect(screen.getByText(/Unavailable/)).toBeInTheDocument();
  });
});
