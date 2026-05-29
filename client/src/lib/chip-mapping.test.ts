import { describe, it, expect } from "vitest";
import { Bug, CheckSquare, KeyRound, Package, Shield, Sparkles, Tag, Wrench } from "lucide-react";
import type { NormalizedIssue } from "@roubo/shared";
import {
  alertSeverityTooltip,
  issueTypeChip,
  securityCategoryFor,
  shortIssueRef,
  statusTone,
  truncateChips,
  type ChipItem,
} from "./chip-mapping";

describe("statusTone", () => {
  it.each([
    ["open", false, "open"],
    ["Open", false, "open"],
    ["Todo", false, "open"],
    ["ready", false, "open"],
    ["in progress", false, "in-progress"],
    ["In-Progress", false, "in-progress"],
    ["doing", false, "in-progress"],
    ["done", false, "done"],
    ["Closed", false, "done"],
    ["merged", false, "done"],
    ["mystery", false, "neutral"],
  ])("maps %p (blocked=%p) to %p", (state, isBlocked, expected) => {
    expect(statusTone(state, isBlocked)).toBe(expected);
  });

  it("returns 'blocked' when isBlocked is true regardless of currentState", () => {
    expect(statusTone("open", true)).toBe("blocked");
    expect(statusTone("done", true)).toBe("blocked");
    expect(statusTone("", true)).toBe("blocked");
  });
});

describe("issueTypeChip", () => {
  it("returns null for empty or null type", () => {
    expect(issueTypeChip(null)).toBeNull();
    expect(issueTypeChip(undefined)).toBeNull();
    expect(issueTypeChip("")).toBeNull();
    expect(issueTypeChip("   ")).toBeNull();
  });

  it.each([
    ["bug", Bug],
    ["Bug", Bug],
    ["feature", Sparkles],
    ["enhancement", Sparkles],
    ["chore", Wrench],
    ["task", CheckSquare],
  ])(
    "maps known non-alert type %p to its icon and preserves the raw label",
    (input, expectedIcon) => {
      const chip = issueTypeChip(input);
      expect(chip).not.toBeNull();
      expect(chip?.icon).toBe(expectedIcon);
      expect(chip?.label).toBe(input.trim());
    },
  );

  it.each([
    ["security-code-scanning", Shield, "CodeQL"],
    ["security-secret-scanning", KeyRound, "Secret scanning"],
    ["security-dependabot", Package, "Dependabot"],
    ["security_code_scanning", Shield, "CodeQL"],
    ["Security Secret Scanning", KeyRound, "Secret scanning"],
  ])(
    "maps alert issueType %p to the friendly chip (%p, %p)",
    (input, expectedIcon, expectedLabel) => {
      const chip = issueTypeChip(input);
      expect(chip).not.toBeNull();
      expect(chip?.icon).toBe(expectedIcon);
      expect(chip?.label).toBe(expectedLabel);
    },
  );

  it("falls back to Tag icon for unknown types", () => {
    const chip = issueTypeChip("Unknown");
    expect(chip?.icon).toBe(Tag);
    expect(chip?.label).toBe("Unknown");
  });
});

describe("securityCategoryFor", () => {
  it("returns null for empty or null type", () => {
    expect(securityCategoryFor(null)).toBeNull();
    expect(securityCategoryFor(undefined)).toBeNull();
    expect(securityCategoryFor("")).toBeNull();
    expect(securityCategoryFor("   ")).toBeNull();
  });

  it.each([
    ["security-code-scanning", "codeql"],
    ["security-secret-scanning", "secret-scanning"],
    ["security-dependabot", "dependabot"],
    ["security_code_scanning", "codeql"],
    ["Security Secret Scanning", "secret-scanning"],
    ["  security-dependabot  ", "dependabot"],
  ] as const)("maps %p to %p", (input, expected) => {
    expect(securityCategoryFor(input)).toBe(expected);
  });

  it.each(["bug", "feature", "enhancement", "chore", "task", "unknown"])(
    "returns null for non-security type %p",
    (input) => {
      expect(securityCategoryFor(input)).toBeNull();
    },
  );
});

describe("alertSeverityTooltip", () => {
  function alertIssue(issueType: NormalizedIssue["issueType"], raw: unknown): NormalizedIssue {
    return {
      integrationId: "github-com:test",
      externalId: "owner/repo#code-scanning-1",
      externalUrl: "https://example.test",
      title: "fixture",
      body: null,
      issueType,
      currentState: "open",
      allowedTransitions: [],
      assignees: [],
      labels: [],
      blocks: [],
      blockedBy: [],
      updatedAt: "2026-01-01T00:00:00Z",
      raw,
    };
  }

  it("prefers security_severity_level for code-scanning alerts", () => {
    const issue = alertIssue("security-code-scanning", {
      rule: { security_severity_level: "high", severity: "error" },
    });
    expect(alertSeverityTooltip(issue)).toBe("Severity: High");
  });

  it("falls back to rule.severity when security_severity_level is missing", () => {
    const issue = alertIssue("security-code-scanning", {
      rule: { severity: "warning" },
    });
    expect(alertSeverityTooltip(issue)).toBe("Severity: Warning");
  });

  it("reads security_advisory.severity for dependabot alerts", () => {
    const issue = alertIssue("security-dependabot", {
      security_advisory: { severity: "critical" },
    });
    expect(alertSeverityTooltip(issue)).toBe("Severity: Critical");
  });

  it("uses secret_type_display_name for secret-scanning alerts (no severity field)", () => {
    const issue = alertIssue("security-secret-scanning", {
      secret_type_display_name: "AWS access key",
    });
    expect(alertSeverityTooltip(issue)).toBe("AWS access key");
  });

  it("returns null for non-alert issues", () => {
    const issue = alertIssue("bug", { rule: { severity: "warning" } });
    expect(alertSeverityTooltip(issue)).toBeNull();
  });

  it("returns null when raw is missing or malformed", () => {
    expect(alertSeverityTooltip(alertIssue("security-code-scanning", null))).toBeNull();
    expect(alertSeverityTooltip(alertIssue("security-code-scanning", "not-an-object"))).toBeNull();
    expect(alertSeverityTooltip(alertIssue("security-code-scanning", { rule: null }))).toBeNull();
    expect(
      alertSeverityTooltip(alertIssue("security-code-scanning", { rule: { severity: "   " } })),
    ).toBeNull();
    expect(alertSeverityTooltip(alertIssue("security-dependabot", {}))).toBeNull();
    expect(alertSeverityTooltip(alertIssue("security-secret-scanning", {}))).toBeNull();
  });
});

describe("truncateChips", () => {
  function chip(category: ChipItem["category"], key: string): ChipItem {
    return { category, key, label: key };
  }

  it("returns all items when count is within max", () => {
    const items = [chip("status", "s"), chip("label", "l1"), chip("label", "l2")];
    expect(truncateChips(items, 6)).toEqual({ visible: items, overflowCount: 0 });
  });

  it("drops labels first when overflowing", () => {
    const items: ChipItem[] = [
      chip("status", "s"),
      chip("issue-type", "t"),
      chip("label", "l1"),
      chip("label", "l2"),
      chip("label", "l3"),
      chip("label", "l4"),
      chip("metadata", "m1"),
    ];
    const result = truncateChips(items, 6);
    expect(result.visible).toHaveLength(5);
    expect(result.overflowCount).toBe(2);
    expect(result.visible.map((c) => c.key)).toEqual(["s", "t", "l1", "l2", "m1"]);
  });

  it("drops metadata after labels when still overflowing", () => {
    const items: ChipItem[] = [
      chip("status", "s"),
      chip("issue-type", "t"),
      chip("metadata", "m1"),
      chip("metadata", "m2"),
      chip("metadata", "m3"),
      chip("metadata", "m4"),
      chip("metadata", "m5"),
    ];
    const result = truncateChips(items, 6);
    expect(result.visible).toHaveLength(5);
    expect(result.overflowCount).toBe(2);
    expect(result.visible.filter((c) => c.category === "metadata")).toHaveLength(3);
    expect(result.visible[0].category).toBe("status");
    expect(result.visible[1].category).toBe("issue-type");
  });

  it("never drops status", () => {
    const items: ChipItem[] = [
      chip("status", "s"),
      ...Array.from({ length: 20 }, (_, i) => chip("label", `l${i}`)),
    ];
    const result = truncateChips(items, 6);
    expect(result.visible.find((c) => c.category === "status")).toBeDefined();
    expect(result.overflowCount).toBeGreaterThan(0);
  });

  it("reserves a slot for the overflow chip in the count budget", () => {
    const items: ChipItem[] = Array.from({ length: 10 }, (_, i) => chip("label", `l${i}`));
    items.unshift(chip("status", "s"));
    const result = truncateChips(items, 6);
    expect(result.visible.length + 1).toBeLessThanOrEqual(6);
    expect(result.overflowCount).toBe(11 - result.visible.length);
  });
});

describe("shortIssueRef", () => {
  it.each([
    ["davidpoxon/roubo#76", "#76"],
    ["foo/bar#42", "#42"],
    ["davidpoxon/roubo#code-scanning-106", "#code-scanning-106"],
    ["#42", "#42"],
  ])("strips the owner/repo prefix from %s", (input, expected) => {
    expect(shortIssueRef(input)).toBe(expected);
  });

  it("returns the input unchanged when there is no '#'", () => {
    expect(shortIssueRef("42")).toBe("42");
  });
});
