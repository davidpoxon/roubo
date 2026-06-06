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

  it("builds a project clause (TC-008)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
    });
    expect(jql).toContain('(project = "PLAT")');
  });

  it("emits a board source's pre-resolved clause verbatim (TC-004)", () => {
    const jql = buildIssueListJql({
      sources: [
        {
          kind: "board",
          externalId: "board:482",
          boardMode: "active-sprint",
          resolvedClause: "(sprint in openSprints() AND filter = 10231)",
        },
      ],
      lastPollIso: null,
    });
    expect(jql).toContain("(sprint in openSprints() AND filter = 10231)");
  });

  it("drops an unresolved board clause from the union", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "project", externalId: "PLAT" },
        { kind: "board", externalId: "board:482", boardMode: "active-sprint", resolvedClause: "" },
      ],
      lastPollIso: null,
    });
    // No dangling `( OR ...)`; only the project clause survives.
    expect(jql).toBe('(project = "PLAT") ORDER BY updated ASC');
  });

  it("scopes 'assigned to me' to the in-scope projects in in-project mode (TC-007)", () => {
    const jql = buildIssueListJql({
      sources: [
        {
          kind: "mine",
          externalId: "mine",
          mineScope: "in-project",
          scopeProjectKeys: ["PLAT", "PAY"],
        },
      ],
      lastPollIso: null,
    });
    expect(jql).toContain('(assignee = currentUser() AND project in ("PLAT", "PAY"))');
  });

  it("matches 'assigned to me' anywhere when mineScope is anywhere (TC-007)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "mine", externalId: "mine", mineScope: "anywhere" }],
      lastPollIso: null,
    });
    expect(jql).toContain("(assignee = currentUser())");
    expect(jql).not.toContain("project in");
  });

  it("falls back to currentUser() when in-project mode has no scoped projects", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "mine", externalId: "mine", mineScope: "in-project", scopeProjectKeys: [] },
      ],
      lastPollIso: null,
    });
    expect(jql).toContain("(assignee = currentUser())");
    expect(jql).not.toContain("project in");
  });

  it("joins mixed-kind sources into a single de-duplicated OR union (TC-008)", () => {
    const jql = buildIssueListJql({
      sources: [
        { kind: "project", externalId: "PLAT" },
        {
          kind: "board",
          externalId: "board:482",
          boardMode: "active-sprint",
          resolvedClause: "(sprint in openSprints() AND filter = 10231)",
        },
        { kind: "filter", externalId: "555" },
      ],
      lastPollIso: "2026-04-01T00:00:00Z",
    });
    expect(jql).toBe(
      '(project = "PLAT" OR (sprint in openSprints() AND filter = 10231) OR filter = 555) ' +
        'AND updated >= "2026-04-01T00:00:00Z" ORDER BY updated ASC',
    );
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

describe("buildIssueListJql status exclusion (FR-009/FR-010)", () => {
  it("ANDs a statusCategory exclusion clause across the whole union (TC-009)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
      excludedStatusCategories: ["Done"],
    });
    expect(jql).toBe('(project = "PLAT") AND statusCategory not in ("Done") ORDER BY updated ASC');
  });

  it("places the exclusion clause before the watermark and ORDER BY (TC-009)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "filter", externalId: "555" }],
      lastPollIso: "2026-04-01T00:00:00Z",
      excludedStatusCategories: ["Done"],
    });
    expect(jql).toBe(
      '(filter = 555) AND statusCategory not in ("Done") ' +
        'AND updated >= "2026-04-01T00:00:00Z" ORDER BY updated ASC',
    );
  });

  it("emits no exclusion clause when the category list is empty (TC-009)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
      excludedStatusCategories: [],
    });
    expect(jql).not.toContain("statusCategory");
    expect(jql).not.toContain("status not in");
  });

  it("excludes multiple categories, category-based not name-based (TC-010)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
      excludedStatusCategories: ["Done", "In Progress"],
    });
    expect(jql).toContain('statusCategory not in ("Done", "In Progress")');
    expect(jql).not.toContain("status not in");
  });

  it("ignores the status-name list on the supported path (names are fallback-only)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed", "Resolved"],
    });
    expect(jql).toContain('statusCategory not in ("Done")');
    expect(jql).not.toContain("status not in");
  });

  it("falls back to status-name enumeration when statusCategory is unsupported (TC-037)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed", "Done", "Resolved"],
      statusCategorySupported: false,
    });
    expect(jql).toBe(
      '(project = "PLAT") AND status not in ("Closed", "Done", "Resolved") ORDER BY updated ASC',
    );
  });

  it("emits no clause on the fallback path when no status names are configured (TC-037)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
      excludedStatusCategories: ["Done"],
      excludedStatuses: [],
      statusCategorySupported: false,
    });
    expect(jql).not.toContain("statusCategory");
    expect(jql).not.toContain("status not in");
  });

  it("escapes status names so a crafted category cannot inject a clause (NFR-003)", () => {
    const jql = buildIssueListJql({
      sources: [{ kind: "project", externalId: "PLAT" }],
      lastPollIso: null,
      excludedStatusCategories: ['Done") OR (1=1'],
    });
    expect(jql).toContain('statusCategory not in ("Done\\") OR (1=1")');
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
