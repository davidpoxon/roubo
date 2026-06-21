import { describe, it, expect } from "vitest";
import { partitionUnblockedFirst } from "./cut-list-order";
import type { NormalizedIssue } from "@roubo/shared";

function issue(externalId: string, blockedBy: string[] = []): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://example.com/${externalId}`,
    title: `Issue ${externalId}`,
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy,
    updatedAt: "2024-01-01T00:00:00Z",
    raw: {},
  };
}

describe("partitionUnblockedFirst", () => {
  it("places unblocked items before blocked items", () => {
    const result = partitionUnblockedFirst([issue("b", ["x"]), issue("a", [])]);
    expect(result.map((i) => i.externalId)).toEqual(["a", "b"]);
  });

  it("preserves input order within each partition (stable)", () => {
    // Interleaved input: blocked, unblocked, blocked, unblocked. Both unblocked
    // items keep their relative order, then both blocked items keep theirs.
    const result = partitionUnblockedFirst([
      issue("b1", ["x"]),
      issue("u1", []),
      issue("b2", ["y"]),
      issue("u2", []),
    ]);
    expect(result.map((i) => i.externalId)).toEqual(["u1", "u2", "b1", "b2"]);
  });

  it("returns all items when none are blocked, order unchanged", () => {
    const result = partitionUnblockedFirst([issue("a", []), issue("b", []), issue("c", [])]);
    expect(result.map((i) => i.externalId)).toEqual(["a", "b", "c"]);
  });

  it("returns all items when all are blocked, order unchanged", () => {
    const result = partitionUnblockedFirst([issue("a", ["x"]), issue("b", ["y"])]);
    expect(result.map((i) => i.externalId)).toEqual(["a", "b"]);
  });

  it("returns an empty array for empty input", () => {
    expect(partitionUnblockedFirst([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [issue("b", ["x"]), issue("a", [])];
    const snapshot = input.map((i) => i.externalId);
    partitionUnblockedFirst(input);
    expect(input.map((i) => i.externalId)).toEqual(snapshot);
  });
});
