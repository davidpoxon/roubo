// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import WizardSidebar from "./WizardSidebar";
import { SECTION_LABELS, type WizardSection, type SectionStatus } from "./wizardReducer";
import type { ComponentConfig, ComponentType, ToolConfig, UserConfig } from "@roubo/shared";

const ALL_SECTIONS: WizardSection[] = [
  "project",
  "layout",
  "components",
  "tools",
  "users",
  "inspection",
  "benches",
  "review",
];

function makeSectionStatus(
  overrides: Partial<Record<WizardSection, SectionStatus>> = {},
): Record<WizardSection, SectionStatus> {
  return Object.fromEntries(ALL_SECTIONS.map((s) => [s, overrides[s] ?? "pristine"])) as Record<
    WizardSection,
    SectionStatus
  >;
}

const defaultComponents: Record<string, ComponentConfig> = {};
const defaultTools: ToolConfig[] = [];
const defaultUsers: UserConfig[] = [];

function renderSidebar(
  currentSection: WizardSection,
  overrides?: Partial<Record<WizardSection, SectionStatus>>,
  options?: {
    onNavigate?: (section: WizardSection) => void;
    onNavigateSubStep?: (section: WizardSection, subStep: string) => void;
    onAddComponent?: (type: ComponentType) => void;
    onAddTool?: () => void;
    onAddUser?: () => void;
    components?: Record<string, ComponentConfig>;
    tools?: ToolConfig[];
    users?: UserConfig[];
    currentSubStep?: string | null;
  },
) {
  const onNavigate = options?.onNavigate ?? vi.fn();
  const onNavigateSubStep = options?.onNavigateSubStep ?? vi.fn();
  const onAddComponent = options?.onAddComponent ?? vi.fn();
  const onAddTool = options?.onAddTool ?? vi.fn();
  const onAddUser = options?.onAddUser ?? vi.fn();

  return render(
    <MemoryRouter>
      <WizardSidebar
        currentSection={currentSection}
        currentSubStep={options?.currentSubStep ?? null}
        sectionStatus={makeSectionStatus(overrides)}
        components={options?.components ?? defaultComponents}
        tools={options?.tools ?? defaultTools}
        users={options?.users ?? defaultUsers}
        onNavigate={onNavigate}
        onNavigateSubStep={onNavigateSubStep}
        onAddComponent={onAddComponent}
        onAddTool={onAddTool}
        onAddUser={onAddUser}
      />
    </MemoryRouter>,
  );
}

describe("WizardSidebar", () => {
  it("renders all section labels", () => {
    renderSidebar("project");
    for (const label of Object.values(SECTION_LABELS)) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("calls onNavigate when a section button is clicked", async () => {
    const onNavigate = vi.fn();
    renderSidebar("project", {}, { onNavigate });
    await userEvent.click(screen.getByText(SECTION_LABELS["components"]));
    expect(onNavigate).toHaveBeenCalledWith("components");
  });

  it("renders a Settings back button", () => {
    renderSidebar("project");
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it('shows "opt" label for optional sections (tools, inspection)', () => {
    renderSidebar("project");
    const optLabels = screen.getAllByText("opt");
    expect(optLabels.length).toBeGreaterThanOrEqual(2);
  });

  describe("component sub-items", () => {
    const components: Record<string, ComponentConfig> = {
      database: { type: "database", migration: { command: "", args: [] } },
      server: { type: "process", command: "npm start" },
    };

    it("renders component names as sub-items", () => {
      renderSidebar("components", {}, { components });
      expect(screen.getByText("database")).toBeInTheDocument();
      expect(screen.getByText("server")).toBeInTheDocument();
    });

    it("renders an Add button under Components", () => {
      renderSidebar("components", {}, { components });
      // There will be two "Add" buttons (components and tools), get all
      const addButtons = screen.getAllByText("Add");
      expect(addButtons.length).toBeGreaterThanOrEqual(1);
    });

    it("calls onNavigateSubStep when a component sub-item is clicked", async () => {
      const onNavigateSubStep = vi.fn();
      renderSidebar("components", {}, { components, onNavigateSubStep });
      await userEvent.click(screen.getByText("server"));
      expect(onNavigateSubStep).toHaveBeenCalledWith("components", "server");
    });

    it("calls onAddComponent with type when Add button under Components is clicked", async () => {
      const onAddComponent = vi.fn();
      renderSidebar("components", {}, { components, onAddComponent });
      // The Add buttons: first one is under Components section in sidebar order
      const addButtons = screen.getAllByText("Add");
      // components comes before tools in WIZARD_SECTIONS, so first Add = components Add
      await userEvent.click(addButtons[0]);
      // A type-picker popover should appear: select Database
      await userEvent.click(screen.getByText("Database"));
      expect(onAddComponent).toHaveBeenCalledWith("database");
    });

    it("calls onAddComponent with process type when Process is selected from popover", async () => {
      const onAddComponent = vi.fn();
      renderSidebar("components", {}, { components, onAddComponent });
      const addButtons = screen.getAllByText("Add");
      await userEvent.click(addButtons[0]);
      await userEvent.click(screen.getByText("Process"));
      expect(onAddComponent).toHaveBeenCalledWith("process");
    });

    it("highlights active sub-step with amber color", () => {
      renderSidebar("components", {}, { components, currentSubStep: "server" });
      const serverButton = screen.getByText("server").closest("button");
      expect(serverButton?.className).toContain("amber");
    });

    it("shows no component sub-items when components is empty", () => {
      renderSidebar("project", {}, { components: {} });
      expect(screen.queryByText("database")).not.toBeInTheDocument();
      expect(screen.queryByText("server")).not.toBeInTheDocument();
    });
  });

  describe("tool sub-items", () => {
    const tools: ToolConfig[] = [
      {
        name: "Frontend",
        icon: "globe",
        type: "browser",
        url: "{{urls.frontend}}",
      },
      {
        name: "API Docs",
        icon: "code",
        type: "browser",
        url: "{{urls.api}}/swagger",
      },
    ];

    it("renders tool names as sub-items", () => {
      renderSidebar("tools", {}, { tools });
      expect(screen.getByText("Frontend")).toBeInTheDocument();
      expect(screen.getByText("API Docs")).toBeInTheDocument();
    });

    it('renders "Untitled" for tools with empty names', () => {
      const unnamedTools: ToolConfig[] = [{ name: "", icon: "globe", type: "browser" }];
      renderSidebar("tools", {}, { tools: unnamedTools });
      expect(screen.getByText("Untitled")).toBeInTheDocument();
    });

    it("calls onNavigateSubStep when a tool sub-item is clicked", async () => {
      const onNavigateSubStep = vi.fn();
      renderSidebar("tools", {}, { tools, onNavigateSubStep });
      await userEvent.click(screen.getByText("Frontend"));
      expect(onNavigateSubStep).toHaveBeenCalledWith("tools", "tool-0");
    });

    it("calls onAddTool when Add button under Tools is clicked", async () => {
      const onAddTool = vi.fn();
      renderSidebar("tools", {}, { tools, onAddTool });
      const addButtons = screen.getAllByText("Add");
      // Add buttons appear in section order: components(0), tools(1), users(2)
      await userEvent.click(addButtons[1]);
      expect(onAddTool).toHaveBeenCalled();
    });

    it("highlights active tool sub-step", () => {
      renderSidebar("tools", {}, { tools, currentSubStep: "tool-1" });
      const apiButton = screen.getByText("API Docs").closest("button");
      expect(apiButton?.className).toContain("amber");
    });

    it("renders tool icon button without error when icon is unrecognised (Globe fallback)", () => {
      const unknownIconTools: ToolConfig[] = [
        { name: "Mystery", icon: "unknown-icon", type: "browser" },
      ];
      renderSidebar("tools", {}, { tools: unknownIconTools });
      expect(screen.getByText("Mystery")).toBeInTheDocument();
    });
  });

  describe("user sub-items", () => {
    const users: UserConfig[] = [
      { name: "Alice", properties: { role: "admin" } },
      { name: "Bob", properties: {} },
    ];

    it("renders user names as sub-items", () => {
      renderSidebar("users", {}, { users });
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
    });

    it('renders "Untitled" for users with empty names', () => {
      renderSidebar("users", {}, { users: [{ name: "", properties: {} }] });
      expect(screen.getByText("Untitled")).toBeInTheDocument();
    });

    it("calls onNavigateSubStep when a user sub-item is clicked", async () => {
      const onNavigateSubStep = vi.fn();
      renderSidebar("users", {}, { users, onNavigateSubStep });
      await userEvent.click(screen.getByText("Alice"));
      expect(onNavigateSubStep).toHaveBeenCalledWith("users", "user-0");
    });

    it("calls onAddUser when Add button under Users is clicked", async () => {
      const onAddUser = vi.fn();
      renderSidebar("users", {}, { users, onAddUser });
      const addButtons = screen.getAllByText("Add");
      // Add buttons appear in section order: components(0), tools(1), users(2)
      await userEvent.click(addButtons[2]);
      expect(onAddUser).toHaveBeenCalled();
    });

    it("highlights active user sub-step", () => {
      renderSidebar("users", {}, { users, currentSubStep: "user-1" });
      const bobButton = screen.getByText("Bob").closest("button");
      expect(bobButton?.className).toContain("amber");
    });
  });
});
