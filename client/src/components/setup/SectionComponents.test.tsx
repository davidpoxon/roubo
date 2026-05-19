// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionComponents from "./SectionComponents";
import type { ComponentConfig, PortConfig } from "@roubo/shared";

vi.mock("./ComponentEditor", () => ({
  default: ({
    component,
    onChange,
  }: {
    component: ComponentConfig;
    onChange: (c: ComponentConfig) => void;
  }) => (
    <div data-testid="component-editor" data-type={component.type}>
      <button
        data-testid="trigger-change"
        onClick={() => onChange({ ...component, command: "updated" })}
      >
        change
      </button>
    </div>
  ),
}));
vi.mock("../Select", () => ({
  default: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={placeholder ?? "select"}
    >
      <option value="">Select</option>
    </select>
  ),
}));

const baseProps = {
  portNames: ["frontend"],
  ports: { frontend: { base: 3000 } } as Record<string, PortConfig>,
  projectName: "my-project",
  scanResult: undefined,
  portConflicts: [],
  onCheckConflicts: vi.fn(),
  maxBenches: 3,
  envFileKeys: [],
};

const serverComponent: ComponentConfig = {
  type: "process",
  command: "npm start",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("SectionComponents", () => {
  describe("overview (currentSubStep = null)", () => {
    it("shows add button when no components (Database tab active)", () => {
      const dispatch = vi.fn();
      render(
        <SectionComponents
          components={{}}
          dispatch={dispatch}
          {...baseProps}
          currentSubStep={null}
        />,
      );
      expect(screen.getByRole("button", { name: /add database/i })).toBeInTheDocument();
    });

    it("dispatches ADD_COMPONENT when Add Database button is clicked", async () => {
      const dispatch = vi.fn();
      render(
        <SectionComponents
          components={{}}
          dispatch={dispatch}
          {...baseProps}
          currentSubStep={null}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /add database/i }));
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "ADD_COMPONENT" }));
    });

    it("shows the Process tab when switching to it", async () => {
      render(
        <SectionComponents
          components={{}}
          dispatch={vi.fn()}
          {...baseProps}
          currentSubStep={null}
        />,
      );
      await userEvent.click(screen.getByRole("tab", { name: /process/i }));
      expect(screen.getByRole("button", { name: /add process/i })).toBeInTheDocument();
    });

    it("renders overview cards for each component", () => {
      render(
        <SectionComponents
          components={{ server: serverComponent }}
          dispatch={vi.fn()}
          {...baseProps}
          currentSubStep={null}
        />,
      );
      expect(screen.getByText("server")).toBeInTheDocument();
    });

    it("clicking an overview card dispatches SET_SUB_STEP with the component key", async () => {
      const dispatch = vi.fn();
      render(
        <SectionComponents
          components={{ server: serverComponent }}
          dispatch={dispatch}
          {...baseProps}
          currentSubStep={null}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /server/i }));
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SUB_STEP",
        payload: "server",
      });
    });

    it("renders compose group when two database components share a compose file", () => {
      const db1: ComponentConfig = {
        type: "database",
        docker: { composeFile: "docker-compose.yml", service: "db" },
      };
      const db2: ComponentConfig = {
        type: "database",
        docker: { composeFile: "docker-compose.yml", service: "cache" },
      };
      render(
        <SectionComponents
          components={{ db1, db2 }}
          dispatch={vi.fn()}
          {...baseProps}
          currentSubStep={null}
        />,
      );
      expect(screen.getByText(/docker compose/i)).toBeInTheDocument();
    });
  });

  describe("single editor (currentSubStep set)", () => {
    it("renders a ComponentEditor for the active component", () => {
      render(
        <SectionComponents
          components={{ server: serverComponent }}
          dispatch={vi.fn()}
          {...baseProps}
          currentSubStep="server"
        />,
      );
      expect(screen.getByTestId("component-editor")).toBeInTheDocument();
    });

    it("renders standalone database component editor", () => {
      const db: ComponentConfig = { type: "database" };
      render(
        <SectionComponents
          components={{ db }}
          dispatch={vi.fn()}
          {...baseProps}
          currentSubStep="db"
        />,
      );
      expect(screen.getByTestId("component-editor")).toBeInTheDocument();
    });

    it("dispatches REMOVE_COMPONENT when delete button clicked", async () => {
      const dispatch = vi.fn();
      render(
        <SectionComponents
          components={{ server: serverComponent }}
          dispatch={dispatch}
          {...baseProps}
          currentSubStep="server"
        />,
      );
      const iconButtons = screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
      await userEvent.click(iconButtons[iconButtons.length - 1]);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "REMOVE_COMPONENT" }));
    });

    it("dispatches RENAME_COMPONENT when component name is committed", async () => {
      const dispatch = vi.fn();
      render(
        <SectionComponents
          components={{ server: serverComponent }}
          dispatch={dispatch}
          {...baseProps}
          currentSubStep="server"
        />,
      );
      const nameInput = screen.getByLabelText("Component name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "api");
      await userEvent.tab();
      expect(dispatch).toHaveBeenCalledWith({
        type: "RENAME_COMPONENT",
        payload: { oldKey: "server", newKey: "api" },
      });
    });

    it("reverts component name on Escape", async () => {
      render(
        <SectionComponents
          components={{ server: serverComponent }}
          dispatch={vi.fn()}
          {...baseProps}
          currentSubStep="server"
        />,
      );
      const nameInput = screen.getByLabelText("Component name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "temporary");
      await userEvent.keyboard("{Escape}");
      expect(nameInput).toHaveValue("server");
    });

    it("dispatches UPDATE_COMPONENT when ComponentEditor onChange is triggered", async () => {
      const dispatch = vi.fn();
      render(
        <SectionComponents
          components={{ server: serverComponent }}
          dispatch={dispatch}
          {...baseProps}
          currentSubStep="server"
        />,
      );
      await userEvent.click(screen.getByTestId("trigger-change"));
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_COMPONENT" }));
    });
  });
});
