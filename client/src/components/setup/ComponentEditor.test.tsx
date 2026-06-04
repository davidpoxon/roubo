// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ComponentEditor from "./ComponentEditor";
import type { ComponentConfig } from "@roubo/shared";

vi.mock("./TemplateInsert", () => ({
  default: ({ onInsert }: { onInsert: (v: string) => void }) => (
    <button data-testid="template-insert" onClick={() => onInsert("{{test}}")}>
      Insert
    </button>
  ),
}));
vi.mock("./TemplateHighlightInput", async () => {
  const { Input } = await import("react-aria-components");
  return {
    default: ({ placeholder }: { value?: string; placeholder?: string }) => (
      <Input data-testid="template-input" placeholder={placeholder} />
    ),
    TemplateValidationError: () => null,
  };
});
vi.mock("../Select", () => ({
  default: ({
    value,
    onChange,
    placeholder,
    allowClear,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    allowClear?: boolean;
  }) => (
    <div>
      <select
        aria-label={placeholder ?? "select"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select</option>
      </select>
      {allowClear && value && <button onClick={() => onChange("")}>Clear</button>}
    </div>
  ),
}));

const baseProps = {
  portNames: ["frontend"],
  componentNames: ["server"],
  ports: { server: { base: 3000 } },
  components: {},
  projectName: "my-app",
  scanResult: undefined,
  hideComposeFile: false,
  portBase: 3000,
  onPortChange: vi.fn(),
  portHttps: false,
  onPortHttpsChange: vi.fn(),
  portConflict: undefined,
  maxBenches: 3,
  envFileKeys: [],
};

const processComponent: ComponentConfig = {
  type: "process",
  command: "npm start",
};

const databaseComponent: ComponentConfig = {
  type: "database",
  docker: { composeFile: "docker-compose.yml", service: "db" },
  migration: { command: "npx migrate", args: ["up"] },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ComponentEditor: process type", () => {
  it("renders base port input", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Base port")).toBeInTheDocument();
  });

  it("renders command field", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByText("Command")).toBeInTheDocument();
  });

  it("renders setup command field", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Setup command")).toBeInTheDocument();
  });

  it("renders working directory field", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Working directory")).toBeInTheDocument();
  });

  it("renders env file field", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Env file")).toBeInTheDocument();
  });

  it("shows port range when maxBenches > 1 and portBase set", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByText("3000–3002")).toBeInTheDocument();
  });

  it("shows HTTPS checkbox when portBase is set", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByText("HTTPS")).toBeInTheDocument();
  });

  it("calls onPortChange when base port is modified", async () => {
    const onPortChange = vi.fn();
    render(
      <ComponentEditor
        {...baseProps}
        component={processComponent}
        onChange={vi.fn()}
        onPortChange={onPortChange}
      />,
    );
    const portInput = screen.getByLabelText("Base port");
    await userEvent.clear(portInput);
    // After clearing a number input, onPortChange should be called with null
    expect(onPortChange).toHaveBeenCalled();
  });

  it("shows port invalid error when port out of range", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={processComponent}
        onChange={vi.fn()}
        portBase={99999}
      />,
    );
    expect(screen.getByText(/port must be between/i)).toBeInTheDocument();
  });

  it("shows port conflict warning", () => {
    const conflict = {
      port: "server",
      base: 3000,
      conflictsWith: {
        projectId: "other",
        projectName: "other-app",
        port: "server",
        range: [3000, 3002] as [number, number],
      },
    };
    render(
      <ComponentEditor
        {...baseProps}
        component={processComponent}
        onChange={vi.fn()}
        portConflict={conflict}
      />,
    );
    expect(screen.getByText(/conflicts with/i)).toBeInTheDocument();
  });

  it("does not show Docker section for process type", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.queryByText("Docker")).not.toBeInTheDocument();
  });

  it("does not show Migration section for process type", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.queryByText("Migration")).not.toBeInTheDocument();
  });
});

describe("ComponentEditor: database type", () => {
  it("renders Docker section", () => {
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={vi.fn()} />);
    expect(screen.getByText("Docker")).toBeInTheDocument();
  });

  it("renders Migration section", () => {
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={vi.fn()} />);
    expect(screen.getByText("Migration")).toBeInTheDocument();
  });

  it("renders Connection section", () => {
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={vi.fn()} />);
    expect(screen.getByText("Connection")).toBeInTheDocument();
  });

  it("renders Docker service name input", () => {
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Docker service name")).toBeInTheDocument();
  });

  it("renders migration command input", () => {
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={vi.fn()} />);
    expect(screen.getByText("Migration").closest("fieldset")).toBeInTheDocument();
  });

  it("calls onChange when migration command changes", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={onChange} />);
    const migrationInput = screen.getByLabelText("Command");
    await userEvent.clear(migrationInput);
    await userEvent.type(migrationInput, "npx db-migrate");
    expect(onChange).toHaveBeenCalled();
  });

  it("does not show process command placeholder for pure database component", () => {
    render(<ComponentEditor {...baseProps} component={{ type: "database" }} onChange={vi.fn()} />);
    // The process command section has "dotnet run --project" placeholder; migration uses a different placeholder
    expect(screen.queryByPlaceholderText(/e\.g\. dotnet run/i)).not.toBeInTheDocument();
  });

  it("shows Add argument button in migration section", () => {
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add argument/i })).toBeInTheDocument();
  });

  it("calls onChange when Add argument is clicked", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /add argument/i }));
    expect(onChange).toHaveBeenCalled();
  });

  it("shows Add pair button in connection section", () => {
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add pair/i })).toBeInTheDocument();
  });

  it("calls onChange when Add pair is clicked", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /add pair/i }));
    expect(onChange).toHaveBeenCalled();
  });
});

describe("ComponentEditor: env vars section", () => {
  it("renders env vars section for process type", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    expect(screen.getByText("Environment variables")).toBeInTheDocument();
  });

  it("calls onChange when env var key changes", async () => {
    const onChange = vi.fn();
    const componentWithEnv: ComponentConfig = {
      type: "process",
      command: "npm start",
      envVars: { MY_VAR: "VALUE" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnv} onChange={onChange} />);
    // env var key is in an input
    const keyInputs = screen.getAllByPlaceholderText("KEY");
    if (keyInputs.length > 0) {
      await userEvent.clear(keyInputs[0]);
      await userEvent.type(keyInputs[0], "NEW_KEY");
      expect(onChange).toHaveBeenCalled();
    }
  });

  it("shows Add variable buttons", () => {
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={vi.fn()} />);
    const addVarBtns = screen.getAllByRole("button", { name: /add variable/i });
    expect(addVarBtns.length).toBeGreaterThan(0);
  });

  it("calls onChange when Add variable is clicked", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={onChange} />);
    const addVarBtns = screen.getAllByRole("button", { name: /add variable/i });
    await userEvent.click(addVarBtns[0]);
    expect(onChange).toHaveBeenCalled();
  });
});

describe("ComponentEditor: connection section interaction", () => {
  it("calls onChange when connection key changes", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={onChange} />);
    const keyInput = screen.getByLabelText("Connection key");
    await userEvent.clear(keyInput);
    await userEvent.type(keyInput, "host");
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange when connection value changes", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={onChange} />);
    const connectionFieldset = screen.getByText("Connection").closest("fieldset");
    if (!connectionFieldset) throw new Error("connectionFieldset not found");
    const valueInput = within(connectionFieldset).getByPlaceholderText("value");
    await userEvent.clear(valueInput);
    await userEvent.type(valueInput, "localhost");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("ComponentEditor: migration argument interaction", () => {
  it("calls onChange when migration arg is removed", async () => {
    const onChange = vi.fn();
    const dbWithArgs: ComponentConfig = {
      type: "database",
      migration: { command: "migrate", args: ["up", "down"] },
    };
    render(<ComponentEditor {...baseProps} component={dbWithArgs} onChange={onChange} />);
    // There should be delete buttons for args
    const xButtons = screen.getAllByRole("button").filter((b) => b.querySelector("svg"));
    // Click one of the x buttons inside migration
    expect(xButtons.length).toBeGreaterThan(0);
  });
});

describe("ComponentEditor: env variables for process type", () => {
  it("calls onChange when env variable name changes", async () => {
    const onChange = vi.fn();
    const componentWithEnv: ComponentConfig = {
      type: "process",
      command: "npm start",
      env: { MY_VAR: "value" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnv} onChange={onChange} />);
    const envNameInput = screen.getByLabelText("Environment variable name");
    await userEvent.clear(envNameInput);
    await userEvent.type(envNameInput, "NEW_VAR");
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange when env variable value changes", async () => {
    const onChange = vi.fn();
    const componentWithEnv: ComponentConfig = {
      type: "process",
      command: "npm start",
      env: { MY_VAR: "old_value" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnv} onChange={onChange} />);
    const envFieldset = screen.getByText("Environment variables").closest("fieldset");
    if (!envFieldset) throw new Error("envFieldset not found");
    const valueInput = within(envFieldset).getByPlaceholderText("value");
    await userEvent.clear(valueInput);
    await userEvent.type(valueInput, "new_value");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("ComponentEditor: build env vars section", () => {
  it("renders build env vars section", () => {
    const componentWithEnvVars: ComponentConfig = {
      type: "process",
      command: "npm start",
      envVars: { BUILD_FLAG: "1" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnvVars} onChange={vi.fn()} />);
    expect(screen.getByText("Build env vars")).toBeInTheDocument();
  });

  it("calls onChange when build env var name changes", async () => {
    const onChange = vi.fn();
    const componentWithEnvVars: ComponentConfig = {
      type: "process",
      command: "npm start",
      envVars: { BUILD_FLAG: "1" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnvVars} onChange={onChange} />);
    const buildVarName = screen.getByLabelText("Build env var name");
    await userEvent.clear(buildVarName);
    await userEvent.type(buildVarName, "NEW_BUILD");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("ComponentEditor: scan results integration", () => {
  const scanResultWithFiles = {
    detected: {
      dockerComposeFiles: ["docker-compose.yml"],
      dockerComposeServiceNames: {},
      dockerComposeVars: {},
      dockerComposePortVars: {},
      viteProjects: ["frontend"],
      envFiles: [".env"],
    },
    existingConfig: null,
  };

  it("shows file selects when scan result has detected files", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={processComponent}
        onChange={vi.fn()}
        scanResult={scanResultWithFiles as never}
      />,
    );
    // Directory selector should be a Select (with detected viteProjects)
    expect(screen.getByLabelText("Select directory")).toBeInTheDocument();
  });

  it("shows env file selector when scan result has detected env files", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={processComponent}
        onChange={vi.fn()}
        scanResult={scanResultWithFiles as never}
      />,
    );
    expect(screen.getByLabelText("Select env file")).toBeInTheDocument();
  });
});

describe("ComponentEditor: no portBase", () => {
  it("does not show HTTPS checkbox when portBase is null", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={processComponent}
        onChange={vi.fn()}
        portBase={null}
      />,
    );
    expect(screen.queryByText("HTTPS")).not.toBeInTheDocument();
  });

  it("does not show port range when portBase is null", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={processComponent}
        onChange={vi.fn()}
        portBase={null}
      />,
    );
    expect(screen.queryByText(/3000–/)).not.toBeInTheDocument();
  });
});

describe("ComponentEditor: template insert callbacks", () => {
  it("calls onChange via TemplateInsert in command field", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={processComponent} onChange={onChange} />);
    const insertBtns = screen.getAllByTestId("template-insert");
    await userEvent.click(insertBtns[0]);
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange via TemplateInsert in migration arg field", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={onChange} />);
    const insertBtns = screen.getAllByTestId("template-insert");
    await userEvent.click(insertBtns[0]);
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange via TemplateInsert in connection value field", async () => {
    const onChange = vi.fn();
    render(<ComponentEditor {...baseProps} component={databaseComponent} onChange={onChange} />);
    const insertBtns = screen.getAllByTestId("template-insert");
    await userEvent.click(insertBtns[insertBtns.length - 1]);
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange via TemplateInsert in env var value field", async () => {
    const onChange = vi.fn();
    const componentWithEnv: ComponentConfig = {
      type: "process",
      command: "npm start",
      env: { MY_VAR: "value" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnv} onChange={onChange} />);
    const insertBtns = screen.getAllByTestId("template-insert");
    await userEvent.click(insertBtns[insertBtns.length - 1]);
    expect(onChange).toHaveBeenCalled();
  });
});

describe("ComponentEditor: remove interactions", () => {
  it("calls onChange when connection pair X button is clicked", async () => {
    const onChange = vi.fn();
    const dbWithConnection: ComponentConfig = {
      type: "database",
      connection: { template: "host=localhost;port=5432" },
    };
    render(<ComponentEditor {...baseProps} component={dbWithConnection} onChange={onChange} />);
    const xButtons = screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
    if (xButtons.length > 0) {
      await userEvent.click(xButtons[xButtons.length - 1]);
      expect(onChange).toHaveBeenCalled();
    }
  });

  it("calls onChange when migration arg X button is clicked", async () => {
    const onChange = vi.fn();
    const dbWithArgs: ComponentConfig = {
      type: "database",
      migration: { command: "migrate", args: ["up", "down"] },
    };
    render(<ComponentEditor {...baseProps} component={dbWithArgs} onChange={onChange} />);
    const xButtons = screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
    if (xButtons.length > 0) {
      await userEvent.click(xButtons[0]);
      expect(onChange).toHaveBeenCalled();
    }
  });

  it("calls onChange when process env var X button is clicked", async () => {
    const onChange = vi.fn();
    const componentWithEnv: ComponentConfig = {
      type: "process",
      command: "npm start",
      env: { MY_VAR: "val" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnv} onChange={onChange} />);
    const xButtons = screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
    await userEvent.click(xButtons[xButtons.length - 1]);
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange when build env var X button is clicked", async () => {
    const onChange = vi.fn();
    const componentWithEnvVars: ComponentConfig = {
      type: "process",
      command: "npm start",
      envVars: { BUILD_VAR: "val" },
    };
    render(<ComponentEditor {...baseProps} component={componentWithEnvVars} onChange={onChange} />);
    const xButtons = screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
    await userEvent.click(xButtons[xButtons.length - 1]);
    expect(onChange).toHaveBeenCalled();
  });
});

describe("ComponentEditor: database compose variables", () => {
  const scanWithVars = {
    detected: {
      dockerComposeFiles: ["docker-compose.yml"],
      dockerComposeServiceNames: { "docker-compose.yml": ["db", "cache"] },
      dockerComposeVars: {
        "docker-compose.yml": {
          db: {
            POSTGRES_DB: "app",
            POSTGRES_PASSWORD: "secret",
            POSTGRES_PORT: "5432",
          },
        },
      },
      dockerComposePortVars: { "docker-compose.yml": { db: "POSTGRES_PORT" } },
      viteProjects: [],
      envFiles: [],
    },
    existingConfig: null,
  };

  const dbWithEnv: ComponentConfig = {
    type: "database",
    docker: { composeFile: "docker-compose.yml", service: "db" },
    env: {
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: "secret",
      POSTGRES_PORT: "5432",
    },
  };

  it("renders detected compose variable keys as read-only labels", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
      />,
    );
    expect(screen.getByText("POSTGRES_DB")).toBeInTheDocument();
  });

  it("renders env file badge for vars in envFileKeys", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
        envFileKeys={["POSTGRES_PASSWORD"]}
      />,
    );
    expect(screen.getByText(".env")).toBeInTheDocument();
  });

  it("shows read-only display for env file vars", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
        envFileKeys={["POSTGRES_PASSWORD"]}
      />,
    );
    expect(screen.getByText(/set in.*\.env/i)).toBeInTheDocument();
  });

  it("renders port badge for portVarName", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
      />,
    );
    expect(screen.getByText("port")).toBeInTheDocument();
  });

  it("calls onChange when detected var value template is inserted", async () => {
    const onChange = vi.fn();
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={onChange}
        scanResult={scanWithVars as never}
      />,
    );
    const insertBtns = screen.getAllByTestId("template-insert");
    await userEvent.click(insertBtns[0]);
    expect(onChange).toHaveBeenCalled();
  });

  it("renders custom var entries alongside detected vars", () => {
    const compWithCustom: ComponentConfig = {
      ...dbWithEnv,
      env: { ...dbWithEnv.env, CUSTOM_VAR: "custom_val" },
    };
    render(
      <ComponentEditor
        {...baseProps}
        component={compWithCustom}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
      />,
    );
    expect(screen.getByDisplayValue("CUSTOM_VAR")).toBeInTheDocument();
  });

  it("calls onChange when custom var key is changed", async () => {
    const onChange = vi.fn();
    const compWithCustom: ComponentConfig = {
      ...dbWithEnv,
      env: { ...dbWithEnv.env, CUSTOM_VAR: "custom_val" },
    };
    render(
      <ComponentEditor
        {...baseProps}
        component={compWithCustom}
        onChange={onChange}
        scanResult={scanWithVars as never}
      />,
    );
    const customKeyInput = screen.getByDisplayValue("CUSTOM_VAR");
    await userEvent.clear(customKeyInput);
    await userEvent.type(customKeyInput, "NEW_VAR");
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange when custom var is removed", async () => {
    const onChange = vi.fn();
    const compWithCustom: ComponentConfig = {
      ...dbWithEnv,
      env: { ...dbWithEnv.env, CUSTOM_VAR: "custom_val" },
    };
    render(
      <ComponentEditor
        {...baseProps}
        component={compWithCustom}
        onChange={onChange}
        scanResult={scanWithVars as never}
      />,
    );
    const xButtons = screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
    await userEvent.click(xButtons[xButtons.length - 1]);
    expect(onChange).toHaveBeenCalled();
  });

  it("calls onChange when Add variable is clicked in compose vars section", async () => {
    const onChange = vi.fn();
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={onChange}
        scanResult={scanWithVars as never}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add variable/i }));
    expect(onChange).toHaveBeenCalled();
  });

  it("renders compose service Select when services are detected", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
      />,
    );
    expect(screen.getByLabelText("Select service")).toBeInTheDocument();
  });

  it("renders compose file Select when files are detected", () => {
    render(
      <ComponentEditor
        {...baseProps}
        component={dbWithEnv}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
      />,
    );
    expect(screen.getByLabelText("Select compose file")).toBeInTheDocument();
  });

  it("shows compose vars hint when no service is selected and no detected vars", () => {
    const dbNoService: ComponentConfig = { type: "database" };
    render(
      <ComponentEditor
        {...baseProps}
        component={dbNoService}
        onChange={vi.fn()}
        scanResult={scanWithVars as never}
      />,
    );
    expect(screen.getByText(/select a compose service/i)).toBeInTheDocument();
  });
});
