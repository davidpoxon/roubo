import { describe, it, expect } from "vitest";
import { Bug, CheckSquare, KeyRound, Package, Shield, Sparkles, Tag, Wrench } from "lucide-react";
import { issueTypeChip, statusTone, truncateChips, type ChipItem } from "./chip-mapping";

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
    ["CodeQL", Shield],
    ["secret-scanning", KeyRound],
    ["secret_scanning", KeyRound],
    ["Secret Scanning", KeyRound],
    ["dependabot", Package],
  ])("maps %p to the expected icon", (input, expectedIcon) => {
    const chip = issueTypeChip(input);
    expect(chip).not.toBeNull();
    expect(chip?.icon).toBe(expectedIcon);
    expect(chip?.label).toBe(input.trim());
  });

  it("falls back to Tag icon for unknown types", () => {
    const chip = issueTypeChip("Unknown");
    expect(chip?.icon).toBe(Tag);
    expect(chip?.label).toBe("Unknown");
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
