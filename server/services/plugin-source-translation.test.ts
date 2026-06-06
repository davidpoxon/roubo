import { describe, expect, it, vi } from "vitest";
import { translateSources } from "./plugin-source-translation.js";

describe("translateSources", () => {
  it("flattens a Repository selection into kind: 'repo' entries", () => {
    const result = translateSources({ Repository: ["foo/bar", "foo/baz"] });
    expect(result).toEqual([
      { kind: "repo", externalId: "foo/bar" },
      { kind: "repo", externalId: "foo/baz" },
    ]);
  });

  it("flattens a Project selection into kind: 'project' entries", () => {
    const result = translateSources({ Project: ["foo/#1", "foo/#2"] });
    expect(result).toEqual([
      { kind: "project", externalId: "foo/#1" },
      { kind: "project", externalId: "foo/#2" },
    ]);
  });

  it("combines multiple categories preserving insertion order", () => {
    const result = translateSources({
      Repository: ["foo/bar"],
      Project: ["foo/#1"],
    });
    expect(result).toEqual([
      { kind: "repo", externalId: "foo/bar" },
      { kind: "project", externalId: "foo/#1" },
    ]);
  });

  it("returns an empty array for null / undefined", () => {
    expect(translateSources(null)).toEqual([]);
    expect(translateSources(undefined)).toEqual([]);
  });

  it("returns an empty array when no categories are present", () => {
    expect(translateSources({})).toEqual([]);
  });

  it("drops unknown categories and reports them via the callback", () => {
    const onUnknownCategory = vi.fn();
    const result = translateSources(
      { Repository: ["foo/bar"], "Made-Up": ["x"] },
      { onUnknownCategory },
    );
    expect(result).toEqual([{ kind: "repo", externalId: "foo/bar" }]);
    expect(onUnknownCategory).toHaveBeenCalledWith("Made-Up", ["x"]);
  });

  it("skips empty externalId strings", () => {
    const result = translateSources({ Repository: ["foo/bar", ""] });
    expect(result).toEqual([{ kind: "repo", externalId: "foo/bar" }]);
  });

  it("preserves per-source alert booleans on object-form entries (WU-030)", () => {
    const result = translateSources({
      Repository: [
        {
          externalId: "foo/bar",
          includeCodeQLAlerts: true,
          includeSecretScanningAlerts: false,
          includeDependabotAlerts: true,
        },
        "foo/baz",
      ],
    });
    expect(result).toEqual([
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: false,
        includeDependabotAlerts: true,
      },
      { kind: "repo", externalId: "foo/baz" },
    ]);
  });

  it("maps the new Jira singular source categories into plugin-internal kinds (WU-006)", () => {
    const result = translateSources({
      project: ["PLAT"],
      board: ["board:482"],
      filter: ["456"],
      epic: ["PLAT-1187"],
      mine: [{ externalId: "mine", mineScope: "in-project", project: "PLAT" }],
    });
    expect(result).toEqual([
      { kind: "project", externalId: "PLAT" },
      { kind: "board", externalId: "board:482" },
      { kind: "filter", externalId: "456" },
      { kind: "epic", externalId: "PLAT-1187" },
      { kind: "mine", externalId: "mine" },
    ]);
  });

  it("drops legacy old-shape Jira categories rather than silently honoring them (WU-006 clean break)", () => {
    const onUnknownCategory = vi.fn();
    const result = translateSources(
      { boards: ["789"], epics: ["PROJ-100"], filters: ["456"] },
      { onUnknownCategory },
    );
    expect(result).toEqual([]);
    expect(onUnknownCategory).toHaveBeenCalledWith("boards", ["789"]);
    expect(onUnknownCategory).toHaveBeenCalledWith("epics", ["PROJ-100"]);
    expect(onUnknownCategory).toHaveBeenCalledWith("filters", ["456"]);
  });

  it("omits absent alert booleans rather than emitting undefined fields", () => {
    const result = translateSources({
      Repository: [{ externalId: "foo/bar", includeCodeQLAlerts: true }],
    });
    expect(result[0]).toEqual({
      kind: "repo",
      externalId: "foo/bar",
      includeCodeQLAlerts: true,
    });
    expect(Object.keys(result[0])).not.toContain("includeSecretScanningAlerts");
    expect(Object.keys(result[0])).not.toContain("includeDependabotAlerts");
  });
});
