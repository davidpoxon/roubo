import { describe, it, expect } from "vitest";
import { buildResolutionTrace } from "./launch-overrides-trace";

// The layering the per-launch dialog renders (AP-TC-030, AP-TC-036, issue #518),
// tested apart from the JSX so the resolution order is asserted directly rather
// than read off rendered text.

/** AP-TC-030's preconditions, verbatim. */
const AP_TC_030 = {
  appDefaults: { model: "opus", effort: "high", mode: "plan" },
  projectOverrides: { model: "sonnet" },
  presetParams: { effort: "max" },
  perLaunch: { mode: "auto" },
};

describe("buildResolutionTrace", () => {
  it("resolves app defaults, then project, then preset, then per-launch (AP-TC-030)", () => {
    const trace = buildResolutionTrace(AP_TC_030);

    expect(trace.effective).toEqual({
      model: "sonnet", // project over app
      effort: "max", // preset over project/app
      mode: "auto", // per-launch over everything below
    });
  });

  it("lists every contributing layer with the per-launch layer last (AP-TC-036 S001-O01)", () => {
    const trace = buildResolutionTrace(AP_TC_030);

    expect(trace.layers.map((layer) => layer.id)).toEqual([
      "app",
      "project",
      "preset",
      "perLaunch",
    ]);
    expect(trace.layers.map((layer) => layer.label)).toEqual([
      "app default",
      "project",
      "preset",
      "this launch",
    ]);
  });

  it("marks a value superseded only when a higher layer sets the same key", () => {
    const trace = buildResolutionTrace(AP_TC_030);
    const superseded = (layerId: string, key: string) =>
      trace.layers.find((layer) => layer.id === layerId)?.entries.find((entry) => entry.key === key)
        ?.superseded;

    // Every app default is beaten by some layer above it.
    expect(superseded("app", "model")).toBe(true);
    expect(superseded("app", "effort")).toBe(true);
    expect(superseded("app", "mode")).toBe(true);
    // The project's model survives: nothing above it touches model.
    expect(superseded("project", "model")).toBe(false);
    expect(superseded("preset", "effort")).toBe(false);
    // The top layer can never be superseded.
    expect(superseded("perLaunch", "mode")).toBe(false);
  });

  it("resolves an untouched per-launch field from the layers beneath it (AP-TC-036 S001-O03)", () => {
    const trace = buildResolutionTrace({
      appDefaults: { model: "opus", mode: "plan" },
      projectOverrides: { model: "sonnet" },
      presetParams: { mode: "plan" },
      perLaunch: { mode: "auto", effort: "xhigh" },
    });

    // Per-launch beats preset/project/app on the fields it sets...
    expect(trace.effective.mode).toBe("auto");
    expect(trace.effective.effort).toBe("xhigh");
    // ...and model still resolves from the project layer, untouched.
    expect(trace.effective.model).toBe("sonnet");
    const project = trace.layers.find((layer) => layer.id === "project");
    expect(project?.entries).toEqual([{ key: "model", value: "sonnet", superseded: false }]);
  });

  it("always shows the app and this-launch layers, even contributing nothing", () => {
    const trace = buildResolutionTrace({
      appDefaults: {},
      projectOverrides: {},
      perLaunch: {},
    });

    expect(trace.layers.map((layer) => layer.id)).toEqual(["app", "perLaunch"]);
    expect(trace.layers.every((layer) => layer.entries.length === 0)).toBe(true);
    expect(trace.effective).toEqual({});
  });

  it("omits the project and preset layers when neither contributes", () => {
    const trace = buildResolutionTrace({
      appDefaults: { model: "opus" },
      projectOverrides: {},
      presetParams: {},
      perLaunch: { mode: "auto" },
    });

    expect(trace.layers.map((layer) => layer.id)).toEqual(["app", "perLaunch"]);
  });

  it("skips non-scalar and empty values rather than rendering them", () => {
    const trace = buildResolutionTrace({
      appDefaults: { model: "opus", rules: { allow: ["Bash"] }, tags: ["x"], blank: "" },
      projectOverrides: {},
      perLaunch: { retries: 2, verbose: true },
    });

    const app = trace.layers.find((layer) => layer.id === "app");
    expect(app?.entries.map((entry) => entry.key)).toEqual(["model"]);
    // Numbers and booleans are scalars and do render.
    expect(trace.effective).toEqual({ model: "opus", retries: "2", verbose: "true" });
  });
});
