import { describe, expect, it } from "vitest";
import { buildIssueListJql } from "../jql.js";

describe("buildIssueListJql (TC-030)", () => {
  it("includes 'updated >= <iso>' when a watermark is provided", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "456" }],
      lastPollIso: "2026-04-01T00:00:00Z",
    });
    expect(jql).toContain('updated >= "2026-04-01T00:00:00Z"');
  });

  it("omits the updated clause on the first poll (lastPollIso === null)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "456" }],
      lastPollIso: null,
    });
    expect(jql).not.toContain("updated >=");
  });

  it("orders by updated ASC so the highest-`updated` is the last item", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "456" }],
      lastPollIso: null,
    });
    expect(jql.endsWith("ORDER BY updated ASC")).toBe(true);
  });

  it("joins multiple sources with OR", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "filter", externalId: "456" },
        { kind: "epic", externalId: "PROJ-99" },
      ],
      lastPollIso: null,
    });
    expect(jql).toContain('(filter = 456 OR "Epic Link" = "PROJ-99")');
  });

  it("quotes non-numeric filter ids defensively", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "my-saved" }],
      lastPollIso: null,
    });
    expect(jql).toContain('filter = "my-saved"');
  });

  it("emits a bare ORDER BY when nothing constrains the search", () => {
    expect(buildIssueListJql({ sources: [], lastPollIso: null })).toBe("ORDER BY updated ASC");
  });

  it("escapes both backslashes and double quotes in quoted identifiers", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "epic", externalId: 'PROJ\\"99' }],
      lastPollIso: null,
    });
    // The backslash and the quote must both be escaped so the literal stays closed.
    expect(jql).toContain('"Epic Link" = "PROJ\\\\\\"99"');
  });
});
