import { describe, it, expect } from "vitest";
import { getJigVariableGroups } from "./jigVariables";

describe("getJigVariableGroups", () => {
  it("returns exactly 4 groups in order: issue, bench, project, config", () => {
    const groups = getJigVariableGroups("global");
    expect(groups.map((g) => g.category)).toEqual(["issue", "bench", "project", "config"]);
  });

  it("includes the expected variables in each group", () => {
    const groups = getJigVariableGroups("global");
    const byCategory = Object.fromEntries(
      groups.map((g) => [g.category, g.items.map((v) => v.syntax)]),
    );

    expect(byCategory["issue"]).toContain("{{issueNumber}}");
    expect(byCategory["issue"]).toContain("{{issueTitle}}");
    expect(byCategory["issue"]).toContain("{{issueBody}}");
    expect(byCategory["issue"]).toContain("{{issueUrl}}");
    expect(byCategory["issue"]).toContain("{{comments}}");

    expect(byCategory["bench"]).toContain("{{bench.id}}");
    expect(byCategory["bench"]).toContain("{{bench.branch}}");

    expect(byCategory["project"]).toContain("{{project.name}}");

    expect(byCategory["config"]).toContain("{{workspace}}");
  });

  it("does not include deprecated aliases", () => {
    const groups = getJigVariableGroups("global");
    const allSyntax = groups.flatMap((g) => g.items.map((v) => v.syntax));
    expect(allSyntax).not.toContain("{{slot.branch}}");
    expect(allSyntax).not.toContain("{{slot.id}}");
    expect(allSyntax).not.toContain("{{app.name}}");
    expect(allSyntax).not.toContain("{{user.email}}");
  });

  it("adds config footnote at global scope", () => {
    const groups = getJigVariableGroups("global");
    const configGroup = groups.find((g) => g.category === "config");
    expect(configGroup).toBeDefined();
    expect(configGroup?.footnote).toBeTruthy();
  });

  it("omits config footnote at project scope", () => {
    const groups = getJigVariableGroups("project");
    const configGroup = groups.find((g) => g.category === "config");
    expect(configGroup).toBeDefined();
    expect(configGroup?.footnote).toBeUndefined();
  });
});
