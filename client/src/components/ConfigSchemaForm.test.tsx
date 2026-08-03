// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { PluginPermissions } from "@roubo/shared";
import ConfigSchemaForm from "./ConfigSchemaForm";
import { passwordFieldKeys } from "./config-schema-utils";

function inputIn(testId: string): HTMLInputElement {
  const wrapper = screen.getByTestId(testId);
  const input = wrapper.querySelector("input");
  if (!input) throw new Error(`No <input> inside ${testId}`);
  return input as HTMLInputElement;
}

function triggerIn(testId: string): HTMLButtonElement {
  const wrapper = screen.getByTestId(testId);
  const button = wrapper.querySelector("button");
  if (!button) throw new Error(`No <button> inside ${testId}`);
  return button as HTMLButtonElement;
}

/**
 * The value a select is actually SHOWING. `config-field-*` also contains
 * react-aria's hidden native <select>, which carries every option in the schema,
 * so asserting text content over the whole container matches any option label
 * whether or not it is the selected one. This reads the selection itself.
 */
function selectedValueIn(testId: string): string {
  const wrapper = screen.getByTestId(testId);
  const select = wrapper.querySelector<HTMLSelectElement>(
    '[data-testid="hidden-select-container"] select',
  );
  if (!select) throw new Error(`No hidden <select> inside ${testId}`);
  return select.value;
}

const permissions: PluginPermissions = {
  network: { hosts: [] },
  credentials: {
    slots: [{ slot: "token", scope: "read", description: "PAT used for API calls" }],
  },
  filesystem: { paths: [] },
  processes: false,
};

const schema = {
  type: "object",
  properties: {
    instance: { type: "string", title: "Instance URL", description: "Base URL of the instance" },
    token: { type: "string", format: "password", title: "Personal access token" },
    allowSelfSignedTls: { type: "boolean", title: "Allow self-signed TLS" },
    pageSize: { type: "integer", title: "Page size", default: 50 },
  },
};

function Harness({
  initial = {} as Record<string, unknown>,
}: {
  initial?: Record<string, unknown>;
}) {
  const [values, setValues] = useState(initial);
  return (
    <ConfigSchemaForm
      schema={schema}
      permissions={permissions}
      values={values}
      onChange={setValues}
    />
  );
}

describe("ConfigSchemaForm", () => {
  it("renders a labelled TextField for type:string fields", () => {
    render(<Harness />);
    expect(screen.getByText("Instance URL")).toBeInTheDocument();
    expect(screen.getByText("Base URL of the instance")).toBeInTheDocument();
  });

  it("renders a password input for format:password fields and uses the credential slot description", () => {
    render(<Harness />);
    expect(inputIn("config-field-token")).toHaveAttribute("type", "password");
    expect(screen.getByText("PAT used for API calls")).toBeInTheDocument();
  });

  it("renders a Checkbox for type:boolean fields", () => {
    render(<Harness />);
    expect(screen.getByText("Allow self-signed TLS")).toBeInTheDocument();
  });

  it("renders a number input for integer fields and respects the default value", () => {
    render(<Harness />);
    const input = inputIn("config-field-pageSize");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveValue(50);
  });

  it("falls back to a title-cased key when no `title` is set", () => {
    render(
      <ConfigSchemaForm
        schema={{ properties: { issueTypeMap: { type: "string" } } }}
        values={{}}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Issue Type Map")).toBeInTheDocument();
  });

  it("calls onChange with the updated map when a text field changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ConfigSchemaForm
        schema={{ properties: { instance: { type: "string", title: "Instance URL" } } }}
        values={{ instance: "" }}
        onChange={onChange}
      />,
    );
    await user.type(inputIn("config-field-instance"), "x");
    expect(onChange).toHaveBeenLastCalledWith({ instance: "x" });
  });

  it("renders a managed-field caption for complex JSON Schema shapes", () => {
    render(
      <ConfigSchemaForm
        schema={{ properties: { weird: { type: "array" } as unknown } }}
        values={{}}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByText(/managed per project and configured automatically/),
    ).toBeInTheDocument();
  });

  it("renders a managed-field caption for a typeless oneOf union and no text input", () => {
    render(
      <ConfigSchemaForm
        schema={{ properties: { weird: { oneOf: [{ type: "string" }, { type: "object" }] } } }}
        values={{}}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByText(/managed per project and configured automatically/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("config-field-weird")).not.toBeInTheDocument();
  });

  it("renders an enum property as a select of its allowed values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ConfigSchemaForm
        schema={{
          properties: { model: { type: "string", title: "Model", enum: ["sonnet", "opus"] } },
        }}
        values={{ model: "sonnet" }}
        onChange={onChange}
      />,
    );

    expect(selectedValueIn("config-field-model")).toBe("sonnet");
    await user.click(triggerIn("config-field-model"));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "sonnet",
      "opus",
    ]);

    await user.click(screen.getByRole("option", { name: "opus" }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "opus" });
  });

  it("renders a oneOf of consts as a select and preserves each const's own type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ConfigSchemaForm
        schema={{
          properties: {
            retries: {
              title: "Retries",
              oneOf: [
                { const: 1, title: "Once" },
                { const: 3, title: "Three times" },
              ],
            },
          },
        }}
        values={{}}
        onChange={onChange}
      />,
    );

    await user.click(triggerIn("config-field-retries"));
    await user.click(await screen.findByRole("option", { name: "Three times" }));
    expect(onChange).toHaveBeenLastCalledWith({ retries: 3 });
  });

  it("renders a per-field error message when one is supplied", () => {
    render(
      <ConfigSchemaForm
        schema={{ properties: { model: { type: "string", title: "Model", enum: ["sonnet"] } } }}
        values={{ model: "sonnet" }}
        onChange={() => {}}
        errors={{ model: "Must be one of: sonnet" }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Must be one of: sonnet");
  });

  it("emits an empty list for passwordFieldKeys when the schema is missing", () => {
    expect(passwordFieldKeys(undefined)).toEqual([]);
  });

  it("emits the field keys whose definitions are format:password", () => {
    expect(passwordFieldKeys(schema)).toEqual(["token"]);
  });
});
