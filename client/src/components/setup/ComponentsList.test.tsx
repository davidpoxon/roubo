// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ComponentsList from "./ComponentsList";
import type { ComponentConfig, Bench } from "@roubo/shared";
import * as useBenchesModule from "../../hooks/useBenches";

vi.mock("../../hooks/useBenches", () => ({
  useProjectBenches: vi.fn(() => ({ data: [] as Bench[] })),
}));

const processComp: ComponentConfig = {
  type: "process",
  command: "npm run dev",
};
const dbComp: ComponentConfig = {
  type: "database",
  docker: { composeFile: "docker-compose.yml", service: "postgres" },
};

const baseProps = {
  components: {} as Record<string, ComponentConfig>,
  ports: {} as Record<string, { base: number }>,
  maxBenches: 3,
  portConflicts: [] as Array<{
    port: string;
    base: number;
    conflictsWith: {
      projectId: string;
      projectName: string;
      port: string;
      range: [number, number];
    };
  }>,
  projectId: "proj-1",
};

function mockBenches(benches: Partial<Bench>[]) {
  vi.mocked(useBenchesModule.useProjectBenches).mockReturnValue({
    data: benches,
  } as unknown as ReturnType<typeof useBenchesModule.useProjectBenches>);
}

describe("ComponentsList", () => {
  it("shows empty state when no components", () => {
    render(<ComponentsList {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByText(/no components configured/i)).toBeInTheDocument();
  });

  it("renders a row for each component", () => {
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp, postgres: dbComp }}
        ports={{ api: { base: 3000 }, postgres: { base: 5432 } }}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("api")).toBeInTheDocument();
    expect(screen.getByDisplayValue("postgres")).toBeInTheDocument();
  });

  it("shows Add component button", () => {
    render(<ComponentsList {...baseProps} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add component/i })).toBeInTheDocument();
  });

  it("dispatches ADD_COMPONENT and ADD_PORT when Add component clicked", async () => {
    const dispatch = vi.fn();
    render(<ComponentsList {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /add component/i }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "ADD_COMPONENT" }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "ADD_PORT" }));
  });

  it("new component defaults to process type", async () => {
    const dispatch = vi.fn();
    render(<ComponentsList {...baseProps} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /add component/i }));
    const addCall = dispatch.mock.calls.find(([a]) => a?.type === "ADD_COMPONENT")?.[0];
    expect(addCall?.payload.component.type).toBe("process");
  });

  it("allocates a unique key when 'component' already exists", async () => {
    const dispatch = vi.fn();
    render(
      <ComponentsList
        {...baseProps}
        components={{ component: processComp }}
        ports={{ component: { base: 3000 } }}
        dispatch={dispatch}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add component/i }));
    const addCall = dispatch.mock.calls.find(([a]) => a?.type === "ADD_COMPONENT")?.[0];
    expect(addCall?.payload.key).toBe("component-2");
  });

  it("dispatches RENAME_COMPONENT when name committed via blur", async () => {
    const dispatch = vi.fn();
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp }}
        ports={{ api: { base: 3000 } }}
        dispatch={dispatch}
      />,
    );
    const nameInput = screen.getByDisplayValue("api");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "backend");
    await userEvent.tab();
    expect(dispatch).toHaveBeenCalledWith({
      type: "RENAME_COMPONENT",
      payload: { oldKey: "api", newKey: "backend" },
    });
  });

  it("does not dispatch RENAME_COMPONENT when new name conflicts with existing", async () => {
    const dispatch = vi.fn();
    render(
      <ComponentsList
        {...baseProps}
        components={{
          api: processComp,
          web: { type: "process", command: "" },
        }}
        ports={{ api: { base: 3000 }, web: { base: 3100 } }}
        dispatch={dispatch}
      />,
    );
    const [nameInput] = screen.getAllByLabelText(/component name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "web");
    await userEvent.tab();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "RENAME_COMPONENT" }),
    );
  });

  it("shows rename error when duplicate name entered", async () => {
    render(
      <ComponentsList
        {...baseProps}
        components={{
          api: processComp,
          web: { type: "process", command: "" },
        }}
        ports={{ api: { base: 3000 }, web: { base: 3100 } }}
        dispatch={vi.fn()}
      />,
    );
    const [nameInput] = screen.getAllByLabelText(/component name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "web");
    await userEvent.tab();
    expect(screen.getByText(/name already in use/i)).toBeInTheDocument();
  });

  it("opens remove dialog with simple confirm when no bench refs", async () => {
    mockBenches([]);
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp }}
        ports={{ api: { base: 3000 } }}
        dispatch={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove api/i }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/remove "api"\?/i);
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
  });

  it("dispatches REMOVE_COMPONENT when remove confirmed (no refs)", async () => {
    mockBenches([]);
    const dispatch = vi.fn();
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp }}
        ports={{ api: { base: 3000 } }}
        dispatch={dispatch}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove api/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "REMOVE_COMPONENT",
      payload: "api",
    });
  });

  it("shows in-use dialog with bench list when component referenced by benches", async () => {
    mockBenches([
      {
        id: 2,
        branch: "feat/auth",
        projectId: "proj-1",
        components: { api: { status: "running" } },
      } as unknown as Bench,
    ]);
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp }}
        ports={{ api: { base: 3000 } }}
        dispatch={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove api/i }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/"api" is in use/i);
    expect(screen.getByText(/bench #2/)).toBeInTheDocument();
    expect(screen.getByText(/feat\/auth/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove anyway/i })).toBeInTheDocument();
  });

  it("dispatches REMOVE_COMPONENT when Remove anyway confirmed", async () => {
    mockBenches([
      {
        id: 2,
        branch: "feat/auth",
        projectId: "proj-1",
        components: { api: { status: "running" } },
      } as unknown as Bench,
    ]);
    const dispatch = vi.fn();
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp }}
        ports={{ api: { base: 3000 } }}
        dispatch={dispatch}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove api/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove anyway/i }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "REMOVE_COMPONENT",
      payload: "api",
    });
  });

  it("does not dispatch REMOVE_COMPONENT when dialog cancelled", async () => {
    mockBenches([]);
    const dispatch = vi.fn();
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp }}
        ports={{ api: { base: 3000 } }}
        dispatch={dispatch}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove api/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "REMOVE_COMPONENT" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows port conflict label on the conflicting row", () => {
    render(
      <ComponentsList
        {...baseProps}
        components={{ api: processComp }}
        ports={{ api: { base: 3000 } }}
        portConflicts={[
          {
            port: "api",
            base: 3000,
            conflictsWith: {
              projectId: "other",
              projectName: "other-project",
              port: "api",
              range: [3000, 3002],
            },
          },
        ]}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByText(/conflicts with other-project/i)).toBeInTheDocument();
  });
});
