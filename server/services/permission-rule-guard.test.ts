import { describe, it, expect } from "vitest";
import {
  assertSafeRules,
  describeUnsafeRule,
  filterSafeRules,
  isSafeRule,
  PermissionRuleError,
} from "./permission-rule-guard.js";

// AP-TC-081 / AP-NFR-001: a rule may not name a path outside the bench
// workspace. The guard is deliberately vocabulary-free, so these cases are all
// about path shape, never about what Read/Bash/mcp mean.

describe("permission rule guard: safe patterns pass through", () => {
  it.each([
    "Bash(*)",
    "Bash(npm run *)",
    "Bash(rm -rf *)",
    "Bash(npm test:*)",
    "Read(**)",
    "Read(./**)",
    "Edit(**/*.ts)",
    "Edit(.env*)",
    "WebFetch(domain:*)",
    "mcp__*",
    "mcp__server__tool",
    "tool:Bash",
    "WebSearch",
  ])("accepts %s", (rule) => {
    expect(isSafeRule(rule)).toBe(true);
    expect(describeUnsafeRule(rule)).toBeUndefined();
  });
});

describe("permission rule guard: path-escaping patterns are rejected", () => {
  it.each([
    "Read(../../../../etc/**)",
    "Read(../secrets)",
    "Edit(src/../../other-project/**)",
    "Bash(cd ..)",
  ])("rejects the traversal pattern %s", (rule) => {
    expect(isSafeRule(rule)).toBe(false);
    expect(describeUnsafeRule(rule)).toMatch(/path segment/);
  });

  it.each([
    "Read(/etc/**)",
    "Read(~/.ssh/**)",
    "Edit(/var/log/**)",
    "/absolute/from/the/start",
    "Bash(cat /etc/passwd)",
    "Read(C:\\Windows\\**)",
  ])("rejects the absolute-root pattern %s", (rule) => {
    expect(isSafeRule(rule)).toBe(false);
    expect(describeUnsafeRule(rule)).toMatch(/absolute or home-rooted path/);
  });
});

describe("assertSafeRules", () => {
  it("names the offending rule and its group", () => {
    let thrown: unknown;
    try {
      assertSafeRules({ allow: ["Bash(*)"], deny: ["Read(../../etc/**)"], ask: [] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PermissionRuleError);
    expect((thrown as PermissionRuleError).rule).toBe("Read(../../etc/**)");
    expect((thrown as Error).message).toContain('"deny"');
  });

  it("passes a wholly safe set, including undefined groups", () => {
    expect(() => assertSafeRules({ allow: ["Bash(*)"], deny: undefined })).not.toThrow();
  });
});

describe("filterSafeRules", () => {
  it("drops escaping rules from a stored set without touching the rest (AP-TC-081 S002)", () => {
    const filtered = filterSafeRules({
      allow: ["Bash(*)", "Read(../../etc/**)"],
      deny: ["Read(/etc/shadow)"],
      ask: ["Edit(.env*)"],
    });

    expect(filtered).toEqual({
      allow: ["Bash(*)"],
      deny: [],
      ask: ["Edit(.env*)"],
    });
  });

  it("leaves an absent ask group absent rather than materialising it", () => {
    expect(filterSafeRules({ allow: [], deny: [] })).toEqual({ allow: [], deny: [] });
  });

  it("preserves keys it does not own, such as the posture", () => {
    expect(filterSafeRules({ allow: [], deny: [], posture: "guarded" as const })).toEqual({
      allow: [],
      deny: [],
      posture: "guarded",
    });
  });
});
