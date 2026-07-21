import { describe, it, expect } from "vitest";
import { gateTrackerExternalId, repoFullNameFromUrl } from "./gate-external-id.js";
import type { Tracker } from "@roubo/shared/work-units-contract";

function tracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    system: "github",
    ref: "1033",
    url: "https://github.com/owner/repo/issues/1033",
    blocked_by_refs: [],
    ...overrides,
  };
}

describe("gateTrackerExternalId", () => {
  it("qualifies a bare github ref with owner/repo parsed from the url (issue #1006)", () => {
    expect(gateTrackerExternalId(tracker())).toBe("owner/repo#1033");
  });

  it("qualifies a bare ghe ref against a GHE host url", () => {
    expect(
      gateTrackerExternalId(
        tracker({ system: "ghe", ref: "7", url: "https://ghe.example.com/owner/repo/issues/7" }),
      ),
    ).toBe("owner/repo#7");
  });

  it("passes an already-qualified ref through unchanged (idempotent)", () => {
    // A pre-qualified fixture never touches the url, so a stub url is fine.
    expect(gateTrackerExternalId(tracker({ ref: "owner/repo#460", url: "https://x" }))).toBe(
      "owner/repo#460",
    );
  });

  it("passes an already-qualified alert ref through unchanged", () => {
    expect(
      gateTrackerExternalId(tracker({ ref: "owner/repo#code-scanning-5", url: "https://x" })),
    ).toBe("owner/repo#code-scanning-5");
  });

  it("passes a Jira issue key through unchanged (the key is the externalId)", () => {
    expect(
      gateTrackerExternalId(
        tracker({ system: "jira", ref: "PROJ-42", url: "https://jira.example.com/browse/PROJ-42" }),
      ),
    ).toBe("PROJ-42");
  });

  it("throws for a bare github ref whose url cannot be parsed into an owner/repo", () => {
    expect(() => gateTrackerExternalId(tracker({ url: "https://x" }))).toThrow(/owner\/repo/);
    expect(() => gateTrackerExternalId(tracker({ url: "not-a-url" }))).toThrow(/owner\/repo/);
  });
});

describe("repoFullNameFromUrl", () => {
  it("takes the first two path segments (github.com and GHE host alike)", () => {
    expect(repoFullNameFromUrl("https://github.com/owner/repo/issues/1033")).toBe("owner/repo");
    expect(repoFullNameFromUrl("https://ghe.example.com/o/r/issues/7")).toBe("o/r");
  });

  it("returns null for an unparseable url or one with fewer than two path segments", () => {
    expect(repoFullNameFromUrl("not-a-url")).toBeNull();
    expect(repoFullNameFromUrl("https://x")).toBeNull();
    expect(repoFullNameFromUrl("https://github.com/owner")).toBeNull();
  });
});
