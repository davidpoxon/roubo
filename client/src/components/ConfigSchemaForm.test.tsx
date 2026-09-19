// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { AgentChoiceProbeState, PluginPermissions } from "@roubo/shared";
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

  it("renders the select placeholder in the text-secondary token for both themes (#887)", () => {
    render(
      <ConfigSchemaForm
        schema={{
          properties: { model: { type: "string", title: "Model", enum: ["sonnet", "opus"] } },
        }}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    const placeholder = screen.getByText("Select an item").closest("[data-placeholder]");
    expect(placeholder).not.toBeNull();
    // The semantic token switches shade under .dark, so no dark: pair is needed.
    expect(placeholder?.className).toContain("data-[placeholder]:text-text-secondary");
    expect(placeholder?.className).not.toContain("text-stone-");
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

  // #852: the server merges a probed field's resolved choices into the schema as
  // oneOf const/title branches. Rendered here beside a static oneOf field, the
  // two must be indistinguishable (APCC-TC-003) and the probed one must save the
  // choice id, not its label (APCC-TC-002).
  it("renders a materialized probed field exactly like a static oneOf field and saves the id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ConfigSchemaForm
        schema={{
          properties: {
            // As served by GET /api/agents once the model probe resolved.
            model: {
              type: "string",
              title: "Model",
              oneOf: [
                { const: "gpt-5", title: "GPT-5" },
                { const: "sonnet-4", title: "Sonnet 4" },
              ],
            },
            // A plain static choice list.
            effort: {
              type: "string",
              title: "Effort",
              oneOf: [
                { const: "low", title: "Low" },
                { const: "high", title: "High" },
              ],
            },
          },
        }}
        values={{}}
        onChange={onChange}
      />,
    );

    const probed = screen.getByTestId("config-field-model");
    const staticField = screen.getByTestId("config-field-effort");
    const attrNames = (el: Element) => el.getAttributeNames().sort();
    expect(probed.tagName).toBe(staticField.tagName);
    expect(probed.className).toBe(staticField.className);
    expect(attrNames(probed)).toEqual(attrNames(staticField));
    expect(attrNames(triggerIn("config-field-model"))).toEqual(
      attrNames(triggerIn("config-field-effort")),
    );
    expect(probed.outerHTML).not.toMatch(/probe/i);

    await user.click(triggerIn("config-field-model"));
    await user.click(await screen.findByRole("option", { name: "Sonnet 4" }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "sonnet-4" });
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

describe("ConfigSchemaForm: choice-probe states (#853)", () => {
  const probedSchema = {
    type: "object",
    properties: {
      model: { type: "string", title: "Model" },
      label: { type: "string", title: "Label" },
    },
  };
  const resolvedSchema = {
    type: "object",
    properties: {
      model: {
        type: "string",
        title: "Model",
        oneOf: [
          { const: "gpt-5", title: "GPT-5" },
          { const: "sonnet-4", title: "Sonnet 4" },
        ],
      },
      label: { type: "string", title: "Label" },
    },
  };

  function ProbeHarness({
    probe,
    probedFieldSchema = probedSchema,
    initial = {},
  }: {
    probe: AgentChoiceProbeState;
    probedFieldSchema?: Record<string, unknown>;
    initial?: Record<string, unknown>;
  }) {
    const [values, setValues] = useState(initial);
    return (
      <ConfigSchemaForm
        schema={probedFieldSchema}
        values={values}
        onChange={setValues}
        probes={{ model: probe }}
      />
    );
  }

  it("reports loading on the probed field while every other field still accepts input (APCC-TC-018)", async () => {
    const user = userEvent.setup();
    render(<ProbeHarness probe={{ state: "loading" }} />);

    const field = screen.getByTestId("config-field-model");
    expect(field).toHaveAttribute("data-probe-state", "loading");
    expect(screen.getByTestId("config-field-model-probe-status")).toHaveTextContent(
      "Reading the available choices",
    );
    expect(field.querySelector("input")).toBeNull();

    const other = inputIn("config-field-label");
    await user.type(other, "hello");
    expect(other).toHaveValue("hello");
  });

  it("renders the probed choices through the ordinary select once resolved", async () => {
    const user = userEvent.setup();
    render(<ProbeHarness probe={{ state: "resolved" }} probedFieldSchema={resolvedSchema} />);

    expect(screen.queryByTestId("config-field-model-probe-status")).toBeNull();
    await user.click(triggerIn("config-field-model"));
    await user.click(await screen.findByRole("option", { name: "Sonnet 4" }));
    expect(selectedValueIn("config-field-model")).toBe("sonnet-4");
  });

  it("empties a failed field, offers no free-text entry, and states the cause and the remedy (APCC-TC-016)", () => {
    render(
      <ProbeHarness
        probe={{ state: "failed", cause: "command-not-found", reason: "not on PATH" }}
        initial={{ model: "gpt-5" }}
      />,
    );

    const field = screen.getByTestId("config-field-model");
    expect(field).toHaveAttribute("data-probe-state", "failed");
    expect(field.querySelector("input")).toBeNull();
    expect(field).not.toHaveTextContent("gpt-5");

    const status = screen.getByTestId("config-field-model-probe-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("the CLI command was not found");
    expect(status).toHaveTextContent("add its folder to your PATH");
    expect(status).toHaveTextContent("account default");
  });

  it("reads a CLI-reported sign-in failure differently from a missing command (APCC-TC-016)", () => {
    const { unmount } = render(
      <ProbeHarness probe={{ state: "failed", cause: "command-not-found", reason: "missing" }} />,
    );
    const notFound = screen.getByTestId("config-field-model-probe-status").textContent;
    unmount();

    render(
      <ProbeHarness
        probe={{
          state: "failed",
          cause: "probe-error",
          reason: "`/usr/local/bin/tool models` exited with code 1: Not signed in. Run login first",
        }}
      />,
    );
    const status = screen.getByTestId("config-field-model-probe-status");
    expect(status).toHaveTextContent("Could not read the choices: Not signed in. Run login first.");
    expect(status).not.toHaveTextContent("/usr/local/bin/tool");
    expect(status.textContent).not.toBe(notFound);
  });

  it("names the timeout and the empty listing as their own causes", () => {
    const { unmount } = render(
      <ProbeHarness probe={{ state: "failed", cause: "timeout", reason: "killed" }} />,
    );
    expect(screen.getByTestId("config-field-model-probe-status")).toHaveTextContent(
      "did not answer within 5 seconds",
    );
    unmount();

    render(<ProbeHarness probe={{ state: "failed", cause: "parse-error", reason: "none" }} />);
    expect(screen.getByTestId("config-field-model-probe-status")).toHaveTextContent(
      "the CLI listed no choices",
    );
  });

  it("exposes the failure text to assistive technology through the field's description", () => {
    render(<ProbeHarness probe={{ state: "failed", cause: "timeout" }} />);
    const control = screen.getByRole("button", { name: /Model/ });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAccessibleDescription(/did not answer within 5 seconds/);
  });

  it("keeps the same status region across the loading-to-failed change so it is announced", () => {
    const { rerender } = render(
      <ConfigSchemaForm
        schema={probedSchema}
        values={{}}
        onChange={() => {}}
        probes={{ model: { state: "loading" } }}
      />,
    );
    const before = screen.getByTestId("config-field-model-probe-status");
    rerender(
      <ConfigSchemaForm
        schema={probedSchema}
        values={{}}
        onChange={() => {}}
        probes={{ model: { state: "failed", cause: "timeout" } }}
      />,
    );
    expect(screen.getByTestId("config-field-model-probe-status")).toBe(before);
  });

  it("keeps every field reachable by keyboard alone in each state (APCC-TC-023)", async () => {
    for (const probe of [
      { state: "loading" },
      { state: "failed", cause: "probe-error", reason: "exited with code 1: Not signed in" },
    ] as AgentChoiceProbeState[]) {
      const user = userEvent.setup();
      const { unmount } = render(<ProbeHarness probe={probe} />);
      await user.tab();
      expect(screen.getByRole("button", { name: /Model/ })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("listbox")).toBeNull();
      await user.tab();
      expect(inputIn("config-field-label")).toHaveFocus();
      await user.keyboard("typed");
      expect(inputIn("config-field-label")).toHaveValue("typed");
      unmount();
    }

    const user = userEvent.setup();
    render(<ProbeHarness probe={{ state: "resolved" }} probedFieldSchema={resolvedSchema} />);
    await user.tab();
    expect(triggerIn("config-field-model")).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(selectedValueIn("config-field-model")).toBe("sonnet-4");
  });
});
