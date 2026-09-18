// @vitest-environment jsdom
import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import type { AgentChoiceProbeState } from "@roubo/shared";
import ConfigSchemaForm from "./ConfigSchemaForm";
import { expectNoAxeFindings } from "../test/axe";

// APCC-TC-022: each of the three choice-probe states meets the accessibility
// bar with no serious or critical violation (APCC-NFR-005).

const properties = {
  label: { type: "string", title: "Label" },
};

const STATES: { name: string; probe: AgentChoiceProbeState; model: Record<string, unknown> }[] = [
  { name: "loading", probe: { state: "loading" }, model: { type: "string", title: "Model" } },
  {
    name: "resolved",
    probe: { state: "resolved" },
    model: {
      type: "string",
      title: "Model",
      description: "The model a session runs on.",
      oneOf: [{ const: "gpt-5", title: "GPT-5" }],
    },
  },
  {
    name: "failed",
    probe: { state: "failed", cause: "probe-error", reason: "exited with code 1: Not signed in" },
    model: { type: "string", title: "Model", description: "The model a session runs on." },
  },
];

describe("ConfigSchemaForm: axe-core a11y across the choice-probe states (APCC-TC-022)", () => {
  for (const { name, probe, model } of STATES) {
    it(`has no axe violations in the ${name} state`, async () => {
      const { container } = render(
        <ConfigSchemaForm
          schema={{ type: "object", properties: { model, ...properties } }}
          values={{}}
          onChange={() => {}}
          probes={{ model: probe }}
        />,
      );
      const results = await axe(container);
      expectNoAxeFindings(results);
    });
  }
});
