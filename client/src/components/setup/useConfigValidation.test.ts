// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useConfigValidation } from "./useConfigValidation";
import type { RouboConfig } from "@roubo/shared";

const validConfig: RouboConfig = {
  project: {
    name: "my-app",
    displayName: "My App",
    repo: "org/repo",
  },
  layout: { type: "single-repo" },
  components: { api: { plugin: { id: "process" }, config: { command: "npm start" } } },
  ports: { api: { base: 3000 } },
  benches: { max: 5 },
};

describe("useConfigValidation", () => {
  it("returns isClean=true and empty fieldErrors for a valid config", () => {
    const { result } = renderHook(() => useConfigValidation(validConfig));
    expect(result.current.isClean).toBe(true);
    expect(result.current.fieldErrors).toEqual({});
  });

  it("returns isClean=false and fieldErrors for an empty config", () => {
    const { result } = renderHook(() => useConfigValidation({}));
    expect(result.current.isClean).toBe(false);
    expect(Object.keys(result.current.fieldErrors).length).toBeGreaterThan(0);
  });

  it("reports error for invalid project.name (uppercase)", () => {
    const config = {
      ...validConfig,
      project: { ...validConfig.project, name: "MyApp" },
    };
    const { result } = renderHook(() => useConfigValidation(config));
    expect(result.current.isClean).toBe(false);
    expect(result.current.fieldErrors["project.name"]).toBeTruthy();
  });

  it("reports error for benches.max out of range", () => {
    const config = { ...validConfig, benches: { max: 200 } };
    const { result } = renderHook(() => useConfigValidation(config));
    expect(result.current.isClean).toBe(false);
    expect(result.current.fieldErrors["benches.max"]).toBeTruthy();
  });

  it("returns only errors for the missing/invalid fields in a partial config", () => {
    const config = {
      project: {
        name: "my-app",
        displayName: "My App",
        repo: "org/repo",
      },
      layout: { type: "single-repo" },
      components: { api: { plugin: { id: "process" }, config: { command: "npm start" } } },
      ports: { api: { base: 3000 } },
      // benches omitted
    };
    const { result } = renderHook(() => useConfigValidation(config as Partial<RouboConfig>));
    expect(result.current.isClean).toBe(false);
    expect(
      result.current.fieldErrors["benches.max"] || result.current.fieldErrors["benches"],
    ).toBeTruthy();
    // project fields should not have errors
    expect(result.current.fieldErrors["project.name"]).toBeUndefined();
  });

  it("uses dotted keys for nested errors (e.g. components.api.plugin)", () => {
    const config = {
      ...validConfig,
      components: { api: { config: { command: "npm start" } } }, // missing plugin reference
    };
    const { result } = renderHook(() => useConfigValidation(config as Partial<RouboConfig>));
    expect(result.current.isClean).toBe(false);
    expect(result.current.fieldErrors["components.api.plugin"]).toBeTruthy();
  });
});
