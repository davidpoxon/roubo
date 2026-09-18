import { describe, it, expect } from "vitest";
import type { ChoiceProbes } from "@roubo/shared";
import type { ProbeResult } from "./agent-probe-runner.js";
import type { ProbeChoice } from "./probe-parse-registry.js";
import { materializeChoices } from "./choice-materializer.js";

const PROBES: ChoiceProbes = {
  model: { command: "agent", args: ["models"], parse: "dash-line-pairs" },
};

const CHOICES: ProbeChoice[] = [
  { value: "gpt-5", label: "GPT-5" },
  { value: "sonnet-4", label: "Claude Sonnet 4" },
];

function schema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      model: { type: "string", title: "Model", description: "Which model" },
      effort: {
        type: "string",
        title: "Effort",
        oneOf: [
          { const: "low", title: "Low" },
          { const: "high", title: "High" },
        ],
      },
    },
  };
}

function ok(value: ProbeChoice[]): ProbeResult<ProbeChoice[]> {
  return { status: "ok", value, at: 1 };
}

function reader(outcomes: Record<string, ProbeResult<ProbeChoice[]> | undefined>) {
  return (field: string) => outcomes[field];
}

describe("materializeChoices (#852)", () => {
  it("serves resolved choices as oneOf const/title branches, id as const and label as title (APCC-TC-002)", () => {
    const { configSchema } = materializeChoices(schema(), PROBES, reader({ model: ok(CHOICES) }));
    const model = (configSchema?.properties as Record<string, Record<string, unknown>>).model;

    expect(model.oneOf).toEqual([
      { const: "gpt-5", title: "GPT-5" },
      { const: "sonnet-4", title: "Claude Sonnet 4" },
    ]);
  });

  it("keeps every other key on the probed property", () => {
    const { configSchema } = materializeChoices(schema(), PROBES, reader({ model: ok(CHOICES) }));
    const model = (configSchema?.properties as Record<string, Record<string, unknown>>).model;

    expect(model).toMatchObject({ type: "string", title: "Model", description: "Which model" });
  });

  it("gives a probed field the same property shape as a static oneOf field, with no probe marker (APCC-TC-003)", () => {
    const { configSchema } = materializeChoices(schema(), PROBES, reader({ model: ok(CHOICES) }));
    const props = configSchema?.properties as Record<string, Record<string, unknown>>;

    expect(Object.keys(props.model).sort()).toEqual(
      Object.keys(props.effort).concat("description").sort(),
    );
    for (const branch of props.model.oneOf as Record<string, unknown>[]) {
      expect(Object.keys(branch).sort()).toEqual(["const", "title"]);
    }
    expect(JSON.stringify(props.model)).not.toMatch(/probe/i);
  });

  it("leaves a static field untouched", () => {
    const { configSchema } = materializeChoices(schema(), PROBES, reader({ model: ok(CHOICES) }));
    expect((configSchema?.properties as Record<string, unknown>).effort).toEqual(
      (schema().properties as Record<string, unknown>).effort,
    );
  });

  it("never mutates the manifest's schema in place", () => {
    const original = schema();
    const snapshot = structuredClone(original);

    const { configSchema } = materializeChoices(original, PROBES, reader({ model: ok(CHOICES) }));

    expect(original).toEqual(snapshot);
    expect(configSchema).not.toBe(original);
  });

  it("reports loading and leaves the declared property as is before any outcome exists", () => {
    const { configSchema, choiceProbes } = materializeChoices(schema(), PROBES, reader({}));

    expect(choiceProbes).toEqual({ model: { state: "loading" } });
    expect(configSchema).toEqual(schema());
  });

  it("reports resolved once the probe succeeded", () => {
    const { choiceProbes } = materializeChoices(schema(), PROBES, reader({ model: ok(CHOICES) }));
    expect(choiceProbes).toEqual({ model: { state: "resolved" } });
  });

  it("reports a failure with its cause and reason, and serves no probed choices", () => {
    const { configSchema, choiceProbes } = materializeChoices(
      schema(),
      PROBES,
      reader({
        model: { status: "failed", cause: "timeout", reason: "`agent models` timed out", at: 1 },
      }),
    );

    expect(choiceProbes).toEqual({
      model: { state: "failed", cause: "timeout", reason: "`agent models` timed out" },
    });
    expect(configSchema).toEqual(schema());
  });

  it("ignores a probed field the schema has no property for, but still reports its state", () => {
    const probes: ChoiceProbes = { ...PROBES, ghost: PROBES.model };
    const { configSchema, choiceProbes } = materializeChoices(
      schema(),
      probes,
      reader({ model: ok(CHOICES), ghost: ok(CHOICES) }),
    );

    expect(configSchema?.properties).not.toHaveProperty("ghost");
    expect(choiceProbes).toEqual({ model: { state: "resolved" }, ghost: { state: "resolved" } });
  });

  it("returns the schema as is and no state map when the manifest declares no choice probes", () => {
    const original = schema();
    const result = materializeChoices(original, undefined, reader({}));

    expect(result).toEqual({ configSchema: original });
    expect(result).not.toHaveProperty("choiceProbes");
    expect(result.configSchema).toBe(original);
  });
});
