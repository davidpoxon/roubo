import { describe, it, expect } from "vitest";
import { enumOptionsFor } from "./agent-params";

// Which control the two override surfaces render for Model, Effort and Mode
// (AP-TC-025 S002-O01, AP-TC-029 S002, issue #690), tested apart from the JSX
// because the answer is a property of the manifest's schema rather than of
// either form.

/** The spelling every shipping agent manifest uses: a titled `oneOf` of consts. */
const CLAUDE_CODE = {
  configSchema: {
    type: "object",
    properties: {
      model: {
        title: "Model",
        type: "string",
        oneOf: [
          { const: "default", title: "Account default" },
          { const: "opus", title: "Opus" },
          { const: "sonnet", title: "Sonnet" },
        ],
      },
      extraArgs: { title: "Additional CLI arguments", type: "string" },
    },
  },
};

/** The other legal spelling, which has no per-choice titles to render. */
const BARE_ENUM = {
  configSchema: { type: "object", properties: { mode: { enum: ["plan", "auto"] } } },
};

describe("enumOptionsFor", () => {
  // The bug #690 fixed: this helper read `enum` only, so every shipping agent
  // fell through to a free-text field while the AI Agents card rendered the
  // very same key as a select.
  it("reads the oneOf spelling, labelling each option with its title", () => {
    expect(enumOptionsFor(CLAUDE_CODE, "model")).toEqual([
      { key: "default", value: "default", label: "Account default" },
      { key: "opus", value: "opus", label: "Opus" },
      { key: "sonnet", value: "sonnet", label: "Sonnet" },
    ]);
  });

  it("reads the bare enum spelling, labelling each option with its value", () => {
    expect(enumOptionsFor(BARE_ENUM, "mode")).toEqual([
      { key: "plan", value: "plan", label: "plan" },
      { key: "auto", value: "auto", label: "auto" },
    ]);
  });

  it("leaves an open-ended property to free text", () => {
    expect(enumOptionsFor(CLAUDE_CODE, "extraArgs")).toBeUndefined();
  });

  it("leaves a key the agent does not declare, and an absent agent, to free text", () => {
    expect(enumOptionsFor(CLAUDE_CODE, "effort")).toBeUndefined();
    expect(enumOptionsFor(undefined, "model")).toBeUndefined();
  });

  // Both surfaces hold their draft as strings, so a non-string option could not
  // round-trip through the control. A key offering none reads as free text
  // rather than as a select with nothing in it.
  it("drops non-string options and falls back to free text when none remain", () => {
    const agent = {
      configSchema: {
        properties: { retries: { enum: [1, 2, 3] }, model: { enum: ["opus", 7] } },
      },
    };
    expect(enumOptionsFor(agent, "retries")).toBeUndefined();
    expect(enumOptionsFor(agent, "model")).toEqual([{ key: "opus", value: "opus", label: "opus" }]);
  });
});
