// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ComponentRowEditor from "./ComponentRowEditor";
import type { ComponentConfig } from "@roubo/shared";

const processComp: ComponentConfig = {
  type: "process",
  command: "npm run dev",
};
const dbComp: ComponentConfig = {
  type: "database",
  docker: { composeFile: "docker-compose.yml", service: "postgres" },
};

function makeProps(overrides?: Partial<Parameters<typeof ComponentRowEditor>[0]>) {
  return {
    componentKey: "api",
    component: processComp,
    portBase: 3000,
    maxBenches: 3,
    otherComponentNames: [] as string[],
    isExpanded: false,
    onToggleExpand: vi.fn(),
    onRename: vi.fn(),
    onUpdate: vi.fn(),
    onUpdatePort: vi.fn(),
    onRequestRemove: vi.fn(),
    ...overrides,
  };
}

describe("ComponentRowEditor — collapsed row", () => {
  it("renders name input, role badge and port", () => {
    render(<ComponentRowEditor {...makeProps()} />);
    expect(screen.getByLabelText(/component name/i)).toHaveValue("api");
    expect(screen.getByText("Process")).toBeInTheDocument();
    expect(screen.getByLabelText(/base port/i)).toHaveValue(3000);
  });

  it("shows Expand aria-label when collapsed", () => {
    render(<ComponentRowEditor {...makeProps()} />);
    expect(screen.getByRole("button", { name: /expand/i })).toBeInTheDocument();
  });

  it("shows Collapse aria-label when expanded", () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    expect(screen.getByRole("button", { name: /collapse/i })).toBeInTheDocument();
  });

  it("calls onToggleExpand when chevron button pressed", async () => {
    const onToggleExpand = vi.fn();
    render(<ComponentRowEditor {...makeProps({ onToggleExpand })} />);
    await userEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("calls onRename with trimmed name on blur when name changed", async () => {
    const onRename = vi.fn();
    render(<ComponentRowEditor {...makeProps({ onRename })} />);
    const nameInput = screen.getByLabelText(/component name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "backend");
    await userEvent.tab();
    expect(onRename).toHaveBeenCalledWith("backend");
  });

  it("does not call onRename when name is unchanged on blur", async () => {
    const onRename = vi.fn();
    render(<ComponentRowEditor {...makeProps({ onRename })} />);
    const nameInput = screen.getByLabelText(/component name/i);
    await userEvent.click(nameInput);
    await userEvent.tab();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("does not call onRename when Escape pressed after typing a new name", async () => {
    const onRename = vi.fn();
    render(<ComponentRowEditor {...makeProps({ onRename })} />);
    const nameInput = screen.getByLabelText(/component name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "backend");
    await userEvent.keyboard("{Escape}");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("shows renameError message when provided", () => {
    render(<ComponentRowEditor {...makeProps({ renameError: "Name already in use" })} />);
    expect(screen.getByText("Name already in use")).toBeInTheDocument();
  });

  it("shows portConflictLabel when provided", () => {
    render(
      <ComponentRowEditor
        {...makeProps({
          portConflictLabel: "Conflicts with other-project api (3000–3002)",
        })}
      />,
    );
    expect(screen.getByText(/conflicts with other-project/i)).toBeInTheDocument();
  });

  it("calls onUpdatePort when port value changed", async () => {
    const onUpdatePort = vi.fn();
    // Use undefined portBase so input is uncontrolled-empty; typing one digit fires onChange
    render(<ComponentRowEditor {...makeProps({ portBase: undefined, onUpdatePort })} />);
    const portInput = screen.getByLabelText(/base port/i);
    await userEvent.type(portInput, "4");
    expect(onUpdatePort).toHaveBeenCalledWith(4);
  });

  it("calls onRequestRemove when trash button pressed", async () => {
    const onRequestRemove = vi.fn();
    render(<ComponentRowEditor {...makeProps({ onRequestRemove })} />);
    await userEvent.click(screen.getByRole("button", { name: /remove api/i }));
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
  });

  it("shows Database badge for database type", () => {
    render(<ComponentRowEditor {...makeProps({ component: dbComp })} />);
    expect(screen.getByText("Database")).toBeInTheDocument();
  });
});

describe("ComponentRowEditor — expanded panel", () => {
  it("shows role toggle group with Process and Database options", () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    const group = screen.getByRole("group", { name: /role/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^process$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^database$/i })).toBeInTheDocument();
  });

  it("calls onUpdate stripping process fields when switched to database", async () => {
    const onUpdate = vi.fn();
    render(
      <ComponentRowEditor
        {...makeProps({
          component: { type: "process", command: "npm run dev", setup: "npm install" },
          isExpanded: true,
          onUpdate,
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^database$/i }));
    expect(onUpdate).toHaveBeenCalledWith({
      type: "database",
      command: undefined,
      setup: undefined,
      directory: undefined,
    });
  });

  it("calls onUpdate stripping docker fields when switched to process", async () => {
    const onUpdate = vi.fn();
    render(
      <ComponentRowEditor
        {...makeProps({
          component: {
            type: "database",
            docker: { composeFile: "docker-compose.yml", service: "pg" },
          },
          isExpanded: true,
          onUpdate,
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^process$/i }));
    expect(onUpdate).toHaveBeenCalledWith({ type: "process", docker: undefined });
  });

  it("does not call onUpdate when current role button clicked", async () => {
    const onUpdate = vi.fn();
    render(<ComponentRowEditor {...makeProps({ isExpanded: true, onUpdate })} />);
    await userEvent.click(screen.getByRole("button", { name: /^process$/i }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("shows Command field for process type", () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    expect(screen.getByLabelText(/^command$/i)).toBeInTheDocument();
  });

  it("calls onUpdate with command when command field changes", async () => {
    const onUpdate = vi.fn();
    render(
      <ComponentRowEditor
        {...makeProps({
          component: { type: "process", command: "" },
          isExpanded: true,
          onUpdate,
        })}
      />,
    );
    await userEvent.type(screen.getByLabelText(/^command$/i), "n");
    expect(onUpdate).toHaveBeenCalledWith({ command: "n" });
  });

  it("shows Docker compose file and service fields for database type", () => {
    render(<ComponentRowEditor {...makeProps({ component: dbComp, isExpanded: true })} />);
    expect(screen.getByLabelText(/docker compose file/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/docker service/i)).toBeInTheDocument();
  });

  it("calls onUpdate with docker when compose file changes", async () => {
    const onUpdate = vi.fn();
    render(
      <ComponentRowEditor {...makeProps({ component: dbComp, isExpanded: true, onUpdate })} />,
    );
    const composeInput = screen.getByLabelText(/docker compose file/i);
    await userEvent.clear(composeInput);
    await userEvent.type(composeInput, "compose.yml");
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        docker: expect.objectContaining({
          composeFile: expect.stringContaining("compose"),
        }),
      }),
    );
  });

  it("shows empty env message when no env vars", () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    expect(screen.getByText(/no environment variables/i)).toBeInTheDocument();
  });

  it("renders existing env rows", () => {
    render(
      <ComponentRowEditor
        {...makeProps({
          component: { ...processComp, env: { PORT: "8080" } },
          isExpanded: true,
        })}
      />,
    );
    expect(screen.getByLabelText(/environment variable name 1/i)).toHaveValue("PORT");
    expect(screen.getByLabelText(/environment variable value 1/i)).toHaveValue("8080");
  });

  it("calls onUpdate when Add variable is clicked", async () => {
    const onUpdate = vi.fn();
    render(<ComponentRowEditor {...makeProps({ isExpanded: true, onUpdate })} />);
    await userEvent.click(screen.getByRole("button", { name: /add variable/i }));
    expect(onUpdate).toHaveBeenCalled();
  });

  it("calls onUpdate with env undefined when last env row removed", async () => {
    const onUpdate = vi.fn();
    render(
      <ComponentRowEditor
        {...makeProps({
          component: { ...processComp, env: { KEY: "val" } },
          isExpanded: true,
          onUpdate,
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove environment variable 1/i }));
    expect(onUpdate).toHaveBeenCalledWith({ env: undefined });
  });

  it("shows no other components message when otherComponentNames is empty", () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    expect(screen.getByText(/no other components/i)).toBeInTheDocument();
  });

  it("renders depends-on chip for each other component", () => {
    render(
      <ComponentRowEditor
        {...makeProps({
          otherComponentNames: ["postgres", "redis"],
          isExpanded: true,
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "postgres" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "redis" })).toBeInTheDocument();
  });

  it("chip is aria-pressed true when dependency is active", () => {
    render(
      <ComponentRowEditor
        {...makeProps({
          component: { ...processComp, dependsOn: ["postgres"] },
          otherComponentNames: ["postgres", "redis"],
          isExpanded: true,
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "postgres" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "redis" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onUpdate to add dependency when chip clicked", async () => {
    const onUpdate = vi.fn();
    render(
      <ComponentRowEditor
        {...makeProps({
          otherComponentNames: ["postgres"],
          isExpanded: true,
          onUpdate,
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "postgres" }));
    expect(onUpdate).toHaveBeenCalledWith({ dependsOn: ["postgres"] });
  });

  it("calls onUpdate to remove dependency when active chip clicked", async () => {
    const onUpdate = vi.fn();
    render(
      <ComponentRowEditor
        {...makeProps({
          component: { ...processComp, dependsOn: ["postgres"] },
          otherComponentNames: ["postgres"],
          isExpanded: true,
          onUpdate,
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "postgres" }));
    expect(onUpdate).toHaveBeenCalledWith({ dependsOn: undefined });
  });

  it("shows More options button for process type", () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    expect(screen.getByRole("button", { name: /more options/i })).toBeInTheDocument();
  });

  it("does not show More options button for database type", () => {
    render(<ComponentRowEditor {...makeProps({ component: dbComp, isExpanded: true })} />);
    expect(screen.queryByRole("button", { name: /more options/i })).not.toBeInTheDocument();
  });

  it("reveals Setup command and Working directory when More options opened", async () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    await userEvent.click(screen.getByRole("button", { name: /more options/i }));
    expect(screen.getByLabelText(/setup command/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/working directory/i)).toBeInTheDocument();
  });

  it("hides extra fields when More options toggled closed", async () => {
    render(<ComponentRowEditor {...makeProps({ isExpanded: true })} />);
    const moreBtn = screen.getByRole("button", { name: /more options/i });
    await userEvent.click(moreBtn);
    await userEvent.click(moreBtn);
    expect(screen.queryByLabelText(/setup command/i)).not.toBeInTheDocument();
  });

  it("calls onUpdate with setup when setup command changed", async () => {
    const onUpdate = vi.fn();
    render(<ComponentRowEditor {...makeProps({ isExpanded: true, onUpdate })} />);
    await userEvent.click(screen.getByRole("button", { name: /more options/i }));
    await userEvent.type(screen.getByLabelText(/setup command/i), "n");
    expect(onUpdate).toHaveBeenCalledWith({ setup: "n" });
  });

  it("calls onRequestRemove from Remove component button in expanded panel", async () => {
    const onRequestRemove = vi.fn();
    render(<ComponentRowEditor {...makeProps({ isExpanded: true, onRequestRemove })} />);
    await userEvent.click(screen.getByRole("button", { name: /remove component/i }));
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
  });
});
