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

  it("emits an empty list for passwordFieldKeys when the schema is missing", () => {
    expect(passwordFieldKeys(undefined)).toEqual([]);
  });

  it("emits the field keys whose definitions are format:password", () => {
    expect(passwordFieldKeys(schema)).toEqual(["token"]);
  });
});
