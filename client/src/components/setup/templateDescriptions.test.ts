import { describe, it, expect } from "vitest";
import type { PortConfig } from "@roubo/shared";
import {
  getTemplateVariables,
  getGroupedVariables,
  validateTemplateVariables,
  getBenchExamples,
  type TemplateVariableContext,
} from "./templateDescriptions";

function makeContext(overrides?: Partial<TemplateVariableContext>): TemplateVariableContext {
  return {
    portNames: ["web", "api"],
    ports: {
      web: { base: 3000 },
      api: { base: 5000 },
    },
    componentNames: ["web", "api"],
    components: {
      web: { type: "process", command: "npm run dev" },
      api: {
        type: "process",
        command: "dotnet run --project src/Api/Api.csproj",
        connection: { template: "http://localhost:{{ports.api}}" },
      },
    },
    projectName: "my-project",
    ...overrides,
  };
}

describe("getTemplateVariables", () => {
  it("returns port entries for each port name", () => {
    const ctx = makeContext();
    const vars = getTemplateVariables(ctx);
    const portVars = vars.filter((v) => v.category === "ports");
    expect(portVars).toHaveLength(2);
    expect(portVars[0].syntax).toBe("{{ports.web}}");
    expect(portVars[0].example).toBe("3000");
    expect(portVars[0].formula).toBe("base + (bench - 1)");
    expect(portVars[1].syntax).toBe("{{ports.api}}");
    expect(portVars[1].example).toBe("5000");
  });

  it("returns path entry for workspace", () => {
    const ctx = makeContext();
    const vars = getTemplateVariables(ctx);
    const pathVars = vars.filter((v) => v.category === "paths");
    expect(pathVars).toHaveLength(1);
    expect(pathVars[0].syntax).toBe("{{workspace}}");
    expect(pathVars[0].description).toContain("workspace");
    expect(pathVars[0].example).toContain("my-project");
  });

  it("returns component entries for each component name", () => {
    const ctx = makeContext();
    const vars = getTemplateVariables(ctx);
    const componentVars = vars.filter((v) => v.category === "components");
    expect(componentVars).toHaveLength(2);
    expect(componentVars[0].syntax).toBe("{{components.web.connection}}");
    expect(componentVars[0].example).toBe("Not configured");
    expect(componentVars[1].syntax).toBe("{{components.api.connection}}");
    // The api service has a connection template that resolves ports
    expect(componentVars[1].example).toBe("http://localhost:5000");
  });

  it("returns url entries for each port name", () => {
    const ctx = makeContext();
    const vars = getTemplateVariables(ctx);
    const urlVars = vars.filter((v) => v.category === "urls");
    expect(urlVars).toHaveLength(2);
    expect(urlVars[0].syntax).toBe("{{urls.web}}");
    expect(urlVars[0].example).toBe("http://localhost:3000");
    expect(urlVars[1].syntax).toBe("{{urls.api}}");
    expect(urlVars[1].example).toBe("http://localhost:5000");
  });

  it("uses https in url example when port has https: true", () => {
    const ctx = makeContext({
      ports: {
        web: { base: 3000, https: true },
        api: { base: 5000 },
      },
    });
    const vars = getTemplateVariables(ctx);
    const urlVars = vars.filter((v) => v.category === "urls");
    expect(urlVars[0].example).toBe("https://localhost:3000");
    expect(urlVars[0].description).toContain("https");
    expect(urlVars[1].example).toBe("http://localhost:5000");
  });

  it("shows dash for port example when port has no base", () => {
    const ctx = makeContext({
      portNames: ["db"],
      ports: {} as Record<string, PortConfig>,
    });
    const vars = getTemplateVariables(ctx);
    const portVars = vars.filter((v) => v.category === "ports");
    expect(portVars[0].example).toBe("\u2013");
  });
});

describe("getGroupedVariables", () => {
  it("groups by category in correct order (ports, urls, paths, components)", () => {
    const ctx = makeContext();
    const groups = getGroupedVariables(ctx);
    expect(groups.length).toBe(4);
    expect(groups[0].category).toBe("ports");
    expect(groups[0].label).toBe("Ports");
    expect(groups[1].category).toBe("urls");
    expect(groups[1].label).toBe("URLs");
    expect(groups[2].category).toBe("paths");
    expect(groups[2].label).toBe("Paths");
    expect(groups[3].category).toBe("components");
    expect(groups[3].label).toBe("Components");
  });

  it("omits empty categories", () => {
    const ctx = makeContext({ portNames: [], componentNames: [] });
    const groups = getGroupedVariables(ctx);
    // Only paths should remain (workspace is always present)
    expect(groups.length).toBe(1);
    expect(groups[0].category).toBe("paths");
  });
});

describe("validateTemplateVariables", () => {
  it("passes workspace as valid", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("cd {{workspace}} && npm start", ctx);
    expect(result).toEqual([]);
  });

  it("passes valid port references", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("http://localhost:{{ports.web}}", ctx);
    expect(result).toEqual([]);
  });

  it("passes valid component references", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("{{components.api.connection}}", ctx);
    expect(result).toEqual([]);
  });

  it("passes valid url references", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("{{urls.web}}", ctx);
    expect(result).toEqual([]);
  });

  it("returns invalid tokens for unknown url references", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("{{urls.unknown}}", ctx);
    expect(result).toContain("{{urls.unknown}}");
  });

  it("returns invalid tokens for unknown variables", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("{{ports.unknown}} and {{foo.bar}}", ctx);
    expect(result).toContain("{{ports.unknown}}");
    expect(result).toContain("{{foo.bar}}");
  });

  it("deduplicates invalid tokens", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("{{bad}} {{bad}} {{bad}}", ctx);
    expect(result).toEqual(["{{bad}}"]);
  });

  it("returns empty for empty string", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("", ctx);
    expect(result).toEqual([]);
  });

  it("returns invalid for malformed component references", () => {
    const ctx = makeContext();
    const result = validateTemplateVariables("{{components.api}}", ctx);
    expect(result).toContain("{{components.api}}");
  });
});

describe("getBenchExamples", () => {
  it("computes base + (bench - 1) values", () => {
    const ctx = makeContext();
    const examples = getBenchExamples(ctx, [1, 2, 3]);
    expect(examples).toHaveLength(2);

    const webExample = examples.find((e) => e.name === "web");
    if (!webExample) throw new Error("expected web example");
    expect(webExample.syntax).toBe("{{ports.web}}");
    expect(webExample.values).toEqual([3000, 3001, 3002]);

    const apiExample = examples.find((e) => e.name === "api");
    if (!apiExample) throw new Error("expected api example");
    expect(apiExample.syntax).toBe("{{ports.api}}");
    expect(apiExample.values).toEqual([5000, 5001, 5002]);
  });

  it("uses 0 as base when port is not defined", () => {
    const ctx = makeContext({
      portNames: ["db"],
      ports: {} as Record<string, PortConfig>,
    });
    const examples = getBenchExamples(ctx, [1, 2]);
    expect(examples[0].values).toEqual([0, 1]);
  });
});
