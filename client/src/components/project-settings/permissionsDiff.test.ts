import { describe, it, expect } from "vitest";
import { ruleKey, permissionsDiff, mergeWithSelection } from "./permissionsDiff";
import type { PermissionRule } from "./permissionTypes";

const allow = (pattern: string): PermissionRule => ({ type: "allow", pattern });
const deny = (pattern: string): PermissionRule => ({ type: "deny", pattern });
const ask = (pattern: string): PermissionRule => ({ type: "ask", pattern });

describe("ruleKey", () => {
  it("returns type:pattern string", () => {
    expect(ruleKey(allow("Bash(*)"))).toBe("allow:Bash(*)");
    expect(ruleKey(deny("Read(**)"))).toBe("deny:Read(**)");
    expect(ruleKey(ask("Edit(.env*)"))).toBe("ask:Edit(.env*)");
  });
});

describe("permissionsDiff", () => {
  it("returns empty newRules when source is a subset of current", () => {
    const source = [allow("Bash(*)")];
    const current = [allow("Bash(*)"), deny("Bash(rm:*)")];
    expect(permissionsDiff(source, current).newRules).toEqual([]);
  });

  it("returns all source rules when current is empty", () => {
    const source = [allow("Bash(*)"), deny("Bash(rm:*)")];
    expect(permissionsDiff(source, []).newRules).toEqual(source);
  });

  it("returns only rules not already in current", () => {
    const source = [allow("Bash(*)"), allow("Read(**)")];
    const current = [allow("Bash(*)")];
    expect(permissionsDiff(source, current).newRules).toEqual([allow("Read(**)")]);
  });

  it("treats rules with same pattern but different type as distinct", () => {
    const source = [allow("Bash(*)")];
    const current = [deny("Bash(*)")];
    // allow:Bash(*) is NOT in current (only deny:Bash(*) is)
    expect(permissionsDiff(source, current).newRules).toEqual([allow("Bash(*)")]);
  });

  it("returns empty newRules when source and current are both empty", () => {
    expect(permissionsDiff([], []).newRules).toEqual([]);
  });

  it("preserves rule order from source", () => {
    const source = [allow("C"), allow("A"), deny("B")];
    const current = [allow("A")];
    expect(permissionsDiff(source, current).newRules).toEqual([allow("C"), deny("B")]);
  });
});

describe("mergeWithSelection", () => {
  it("includes only selected new rules in merged result", () => {
    const current = [allow("Bash(*)")];
    const newRules = [allow("Read(**)")];
    const selectedKeys = new Set(["allow:Read(**)"] as string[]);
    const { merged } = mergeWithSelection(current, newRules, selectedKeys);
    expect(merged).toEqual([allow("Bash(*)"), allow("Read(**)")]);
  });

  it("does not include unselected new rules", () => {
    const current = [allow("Bash(*)")];
    const newRules = [allow("Read(**)")];
    const { merged } = mergeWithSelection(current, newRules, new Set());
    expect(merged).toEqual([allow("Bash(*)")]);
  });

  it("returns addedKeys containing only selected new rules", () => {
    const current = [allow("Bash(*)")];
    const newRules = [allow("Read(**)")];
    const selectedKeys = new Set(["allow:Read(**)"] as string[]);
    const { addedKeys } = mergeWithSelection(current, newRules, selectedKeys);
    expect(addedKeys).toEqual(new Set(["allow:Read(**)"]));
  });

  it("addedKeys is empty when nothing is selected", () => {
    const current = [allow("Bash(*)")];
    const newRules = [allow("Read(**)")];
    const { addedKeys } = mergeWithSelection(current, newRules, new Set());
    expect(addedKeys.size).toBe(0);
  });

  it("does not duplicate a rule that already exists in current", () => {
    const current = [allow("Bash(*)")];
    const newRules = [allow("Bash(*)")]; // already present: shouldn't happen in practice but handle defensively
    const selectedKeys = new Set(["allow:Bash(*)"] as string[]);
    const { merged } = mergeWithSelection(current, newRules, selectedKeys);
    const allowBash = merged.filter((r) => r.type === "allow" && r.pattern === "Bash(*)");
    expect(allowBash).toHaveLength(1);
  });

  it("preserves current rule order with new rules appended", () => {
    const current = [allow("A"), deny("B")];
    const newRules = [allow("C"), allow("D")];
    const selectedKeys = new Set(["allow:C", "allow:D"] as string[]);
    const { merged } = mergeWithSelection(current, newRules, selectedKeys);
    expect(merged).toEqual([allow("A"), deny("B"), allow("C"), allow("D")]);
  });
});
