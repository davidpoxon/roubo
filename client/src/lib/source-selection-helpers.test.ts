import { describe, expect, it } from "vitest";
import {
  applyIdSelection,
  entryFlag,
  entryId,
  idsFor,
  setEntryFlag,
  setFlagForEntry,
} from "./source-selection-helpers";

describe("source-selection-helpers", () => {
  describe("entryId / entryFlag", () => {
    it("treats a primitive string entry as its own externalId with all flags false", () => {
      expect(entryId("foo/bar")).toBe("foo/bar");
      expect(entryFlag("foo/bar", "includeCodeQLAlerts")).toBe(false);
      expect(entryFlag("foo/bar", "includeSecretScanningAlerts")).toBe(false);
      expect(entryFlag("foo/bar", "includeDependabotAlerts")).toBe(false);
    });

    it("reads the externalId and flags from an object entry", () => {
      const entry = { externalId: "foo/bar", includeCodeQLAlerts: true };
      expect(entryId(entry)).toBe("foo/bar");
      expect(entryFlag(entry, "includeCodeQLAlerts")).toBe(true);
      expect(entryFlag(entry, "includeSecretScanningAlerts")).toBe(false);
    });
  });

  describe("setEntryFlag (collapse on default)", () => {
    it("expands a string entry to object form when the first flag turns on", () => {
      const next = setEntryFlag("foo/bar", "includeCodeQLAlerts", true);
      expect(next).toEqual({ externalId: "foo/bar", includeCodeQLAlerts: true });
    });

    it("returns the string entry unchanged when turning a flag off that is already off", () => {
      expect(setEntryFlag("foo/bar", "includeCodeQLAlerts", false)).toBe("foo/bar");
    });

    it("collapses to a string when the last flag turns off", () => {
      const next = setEntryFlag(
        { externalId: "foo/bar", includeCodeQLAlerts: true },
        "includeCodeQLAlerts",
        false,
      );
      expect(next).toBe("foo/bar");
    });

    it("keeps the object form when at least one flag is still on", () => {
      const next = setEntryFlag(
        {
          externalId: "foo/bar",
          includeCodeQLAlerts: true,
          includeDependabotAlerts: true,
        },
        "includeCodeQLAlerts",
        false,
      );
      expect(next).toEqual({ externalId: "foo/bar", includeDependabotAlerts: true });
    });
  });

  describe("applyIdSelection", () => {
    it("removes entries dropped from the new id set", () => {
      const value = { items: ["a", "b", "c"] };
      const next = applyIdSelection(value, "items", new Set(["a", "c"]));
      expect(idsFor(next, "items")).toEqual(["a", "c"]);
    });

    it("preserves per-entry flags on entries that remain selected", () => {
      const value = {
        items: [{ externalId: "a", includeCodeQLAlerts: true }, "b"],
      };
      const next = applyIdSelection(value, "items", new Set(["a"]));
      expect(next.items).toEqual([{ externalId: "a", includeCodeQLAlerts: true }]);
    });

    it("appends new entries as primitive strings", () => {
      const value = { items: [{ externalId: "a", includeCodeQLAlerts: true }] };
      const next = applyIdSelection(value, "items", new Set(["a", "c"]));
      expect(next.items).toEqual([{ externalId: "a", includeCodeQLAlerts: true }, "c"]);
    });

    it("removes the whole category when nothing remains selected", () => {
      const value = { items: ["a"], other: ["x"] };
      const next = applyIdSelection(value, "items", new Set());
      expect(next).toEqual({ other: ["x"] });
    });
  });

  describe("setFlagForEntry", () => {
    it("targets the matching externalId only", () => {
      const value = { items: ["a", "b"] };
      const next = setFlagForEntry(value, "items", "b", "includeDependabotAlerts", true);
      expect(next.items).toEqual(["a", { externalId: "b", includeDependabotAlerts: true }]);
    });

    it("returns the value unchanged when the externalId is not selected", () => {
      const value = { items: ["a"] };
      const next = setFlagForEntry(value, "items", "missing", "includeCodeQLAlerts", true);
      expect(next).toBe(value);
    });
  });
});
