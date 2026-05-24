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
});
