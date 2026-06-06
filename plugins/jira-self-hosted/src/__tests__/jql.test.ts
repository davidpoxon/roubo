import { describe, expect, it } from "vitest";
import { assertProjectKey, buildIssueListJql, jqlSearchTerm } from "../jql.js";

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

describe("jqlSearchTerm (NFR-003 injection hardening)", () => {
  it("returns a quoted literal for a plain term", () => {
    expect(jqlSearchTerm("platform")).toBe('"platform"');
  });

  it("escapes embedded quotes so a crafted term cannot break out of the literal", () => {
    expect(jqlSearchTerm('a" OR x')).toBe('"a\\" OR x"');
  });

  it("neutralizes JQL wildcard / operator hazards to spaces", () => {
    expect(jqlSearchTerm("a~*?b")).toBe('"a b"');
  });

  it("collapses to an empty quoted literal when only hazards are supplied", () => {
    expect(jqlSearchTerm("~*?")).toBe('""');
  });

  it("bounds the term length", () => {
    const inner = jqlSearchTerm("a".repeat(500)).slice(1, -1);
    expect(inner.length).toBe(100);
  });
});

describe("assertProjectKey", () => {
  it("returns a valid project key unchanged", () => {
    expect(assertProjectKey("PLAT")).toBe("PLAT");
    expect(assertProjectKey("PAY_2")).toBe("PAY_2");
  });

  it("rejects lowercase, hyphenated, single-char, or empty keys", () => {
    expect(() => assertProjectKey("plat")).toThrow(/Invalid Jira project key/);
    expect(() => assertProjectKey("bad-key")).toThrow(/Invalid Jira project key/);
    expect(() => assertProjectKey("X")).toThrow(/Invalid Jira project key/);
    expect(() => assertProjectKey("")).toThrow(/Invalid Jira project key/);
  });
});
