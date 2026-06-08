import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginContract } from "../plugin.js";
import { installHostHarness, StubResponse, type HostHarness } from "./helpers/host-stub.js";
import { _resetCacheForTests } from "../state-store.js";

describe("end-to-end (TC-048 Test connection round-trip)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    _resetCacheForTests();
    harness = installHostHarness(createPluginContract());
    harness.credentials.set("pat", "test-token");
  });
  afterEach(() => {
    harness.dispose();
    _resetCacheForTests();
  });

  it("validateConfig + getCurrentUser succeed against a healthy /myself", async () => {
    harness.fetchStub.on("/rest/api/2/myself", () => ({
      accountId: "alice",
      displayName: "Anna Smith",
    }));

    const validation = await harness.hostConnection.sendRequest<{ ok: boolean }>("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });
    expect(validation).toEqual({ ok: true });

    const me = await harness.hostConnection.sendRequest<{
      externalId: string;
      displayName: string;
    }>("getCurrentUser", {});
    expect(me).toEqual({ externalId: "alice", displayName: "Anna Smith" });
  });

  it("validateConfig returns a structured error for an invalid instance URL", async () => {
    const result = await harness.hostConnection.sendRequest<{
      ok: boolean;
      errors?: Array<{ field?: string; message: string }>;
    }>("validateConfig", { config: { instance: "" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatchObject({ field: "instance" });
  });

  it("validateConfig propagates a 401 from /myself", async () => {
    harness.credentials.set("pat", "bad");
    harness.fetchStub.on("/rest/api/2/myself", () => new StubResponse(401, ""));
    const result = await harness.hostConnection.sendRequest<{
      ok: boolean;
      errors?: Array<{ message: string }>;
    }>("validateConfig", { config: { instance: "https://jira.acme.example" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toContain("401");
  });

  it("listIssues sends JQL with 'updated >=' and persists the watermark (TC-030)", async () => {
    // Bootstrap the in-process config cache via validateConfig.
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });

    // Seed an existing watermark so the next poll filters incrementally.
    harness.credentials.set("state", JSON.stringify({ "filter:456": "2026-04-01T00:00:00Z" }));

    let capturedJql = "";
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      const body = JSON.parse(init.body ?? "{}");
      capturedJql = body.jql ?? "";
      return {
        issues: [
          {
            key: "PROJ-1",
            fields: { summary: "later", status: { name: "Open" }, updated: "2026-04-05T00:00:00Z" },
          },
        ],
        total: 1,
      };
    });

    const result = await harness.hostConnection.sendRequest<{
      items: Array<{ externalId: string }>;
      nextCursor: string | null;
    }>("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [{ kind: "filter", externalId: "456" }],
    });

    expect(capturedJql).toContain('updated >= "2026-04-01T00:00:00Z"');
    expect(result.items.map((i) => i.externalId)).toEqual(["PROJ-1"]);
    expect(harness.credentials.get("state")).toContain("2026-04-05T00:00:00Z");
  });

  it("setActiveConfig primes the plugin so listIssues works without a prior validateConfig", async () => {
    const result = await harness.hostConnection.sendRequest<{ ok: boolean }>("setActiveConfig", {
      config: { instance: "https://jira.acme.example" },
    });
    expect(result).toEqual({ ok: true });

    let capturedJql = "";
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      capturedJql = JSON.parse(init.body ?? "{}").jql ?? "";
      return { issues: [], total: 0 };
    });

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [{ kind: "epic", externalId: "PROJ-100" }],
    });

    expect(capturedJql).toContain('"Epic Link" = "PROJ-100"');
  });

  it("setActiveConfig carries link-type overrides from the host's flat payload into normalized issues", async () => {
    // Regression: `buildPluginConfig` on the host flattens
    // IntegrationConfig.advanced.* onto the top level of the setActiveConfig
    // payload, so the plugin must parse the flat shape. If link-type names
    // are read from a nested `advanced.*` wrapper they silently fall back to
    // the "blocks" / "is blocked by" defaults and renamed Jira instances
    // produce empty blocks/blockedBy arrays on normalized issues.
    const result = await harness.hostConnection.sendRequest<{ ok: boolean }>("setActiveConfig", {
      config: {
        instance: "https://jira.acme.example",
        blocksLinkTypeName: "depends on",
        isBlockedByLinkTypeName: "is depended on by",
      },
    });
    expect(result).toEqual({ ok: true });

    harness.fetchStub.on("/rest/api/2/search", () => ({
      issues: [
        {
          key: "PROJ-1",
          fields: {
            summary: "renamed-link parent",
            status: { name: "Open" },
            updated: "2026-04-05T00:00:00Z",
            issuelinks: [
              {
                type: { name: "depends on" },
                outwardIssue: { key: "PROJ-2" },
              },
            ],
          },
        },
      ],
      total: 1,
    }));

    const listResult = await harness.hostConnection.sendRequest<{
      items: Array<{ externalId: string; blocks: string[]; blockedBy: string[] }>;
    }>("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [{ kind: "filter", externalId: "456" }],
    });

    expect(listResult.items[0]).toMatchObject({
      externalId: "PROJ-1",
      blocks: ["PROJ-2"],
      blockedBy: [],
    });
  });

  it("setActiveConfig returns a structured error for an invalid instance URL", async () => {
    const result = await harness.hostConnection.sendRequest<{
      ok: boolean;
      errors?: Array<{ field?: string; message: string }>;
    }>("setActiveConfig", { config: { instance: "not a url" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatchObject({ field: "instance" });
  });

  it("listIssues silently ignores ConfiguredSource entries whose kind isn't Jira-native", async () => {
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });

    let capturedJql = "";
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      capturedJql = JSON.parse(init.body ?? "{}").jql ?? "";
      return { issues: [], total: 0 };
    });

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [
        { kind: "filter", externalId: "456" },
        { kind: "repo", externalId: "foo/bar" }, // not a Jira kind; dropped.
      ],
    });

    expect(capturedJql).toContain("filter = 456");
    expect(capturedJql).not.toContain("foo/bar");
  });

  it("listIssues keeps the watermark stable across paged calls and only advances on the final page", async () => {
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });

    const originalWatermark = "2026-04-01T00:00:00Z";
    harness.credentials.set("state", JSON.stringify({ "filter:456": originalWatermark }));

    const capturedJql: string[] = [];
    const page1 = {
      issues: [
        {
          key: "PROJ-1",
          fields: { summary: "p1", status: { name: "Open" }, updated: "2026-04-05T00:00:00Z" },
        },
      ],
      total: 2,
    };
    const page2 = {
      issues: [
        {
          key: "PROJ-2",
          fields: { summary: "p2", status: { name: "Open" }, updated: "2026-04-06T00:00:00Z" },
        },
      ],
      total: 2,
    };
    let call = 0;
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      const body = JSON.parse(init.body ?? "{}");
      capturedJql.push(body.jql ?? "");
      call += 1;
      return call === 1 ? page1 : page2;
    });

    const r1 = await harness.hostConnection.sendRequest<{
      items: Array<{ externalId: string }>;
      nextCursor: string | null;
    }>("listIssues", {
      cursor: null,
      pageSize: 1,
      sources: [{ kind: "filter", externalId: "456" }],
    });
    expect(r1.nextCursor).toBe("1");
    // Watermark must NOT advance after page 1.
    expect(harness.credentials.get("state")).toContain(originalWatermark);

    const r2 = await harness.hostConnection.sendRequest<{
      items: Array<{ externalId: string }>;
      nextCursor: string | null;
    }>("listIssues", {
      cursor: r1.nextCursor,
      pageSize: 1,
      sources: [{ kind: "filter", externalId: "456" }],
    });
    expect(r2.nextCursor).toBeNull();
    // Both pages must have queried with the same JQL (original watermark).
    expect(capturedJql).toHaveLength(2);
    expect(capturedJql[0]).toBe(capturedJql[1]);
    expect(capturedJql[0]).toContain(`updated >= "${originalWatermark}"`);
    // Watermark advances to the highest seen across both pages.
    expect(harness.credentials.get("state")).toContain("2026-04-06T00:00:00Z");
  });

  /** Prime the in-process config cache so source-bound calls have a context. */
  async function primeConfig(): Promise<void> {
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });
  }

  function captureSearchJql(box: { jql: string }): void {
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      box.jql = JSON.parse(init.body ?? "{}").jql ?? "";
      return { issues: [], total: 0 };
    });
  }

  it("listIssues resolves a board source to its active sprint by default (TC-004)", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => ({
      values: [{ id: 99, state: "active" }],
    }));
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [{ kind: "board", externalId: "board:482", boardMode: "active-sprint" }],
    });

    expect(box.jql).toContain("(sprint in openSprints() AND filter = 10231)");
  });

  it("listIssues widens a board source to the whole board (TC-031)", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [{ kind: "board", externalId: "board:482", boardMode: "whole-board" }],
    });

    expect(box.jql).toContain("(filter = 10231)");
    expect(box.jql).not.toContain("openSprints");
  });

  it("listIssues scopes 'assigned to me' in-project to the configured projects (TC-007)", async () => {
    await primeConfig();
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [
        { kind: "project", externalId: "PLAT" },
        { kind: "project", externalId: "PAY" },
        { kind: "mine", externalId: "mine", mineScope: "in-project" },
      ],
    });

    expect(box.jql).toContain('(assignee = currentUser() AND project in ("PLAT", "PAY"))');
  });

  it("listIssues matches 'assigned to me' anywhere when mineScope is anywhere (TC-007)", async () => {
    await primeConfig();
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [{ kind: "mine", externalId: "mine", mineScope: "anywhere" }],
    });

    expect(box.jql).toContain("(assignee = currentUser())");
    expect(box.jql).not.toContain("project in");
  });

  it("listIssues builds a de-duplicated OR union across mixed source kinds (TC-008)", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => ({
      values: [{ id: 99, state: "active" }],
    }));
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [
        { kind: "board", externalId: "board:482", boardMode: "active-sprint" },
        { kind: "filter", externalId: "555" },
      ],
    });

    // A single OR group (Jira de-duplicates the union), and exactly one each.
    expect(box.jql).toContain("((sprint in openSprints() AND filter = 10231) OR filter = 555)");
  });

  it("demotes a project to scope-only when a board scoped to it is also picked", async () => {
    // Sources OR-union, so a blanket `project = PLAT` would swallow the board's
    // sprint. The project becomes scope-only and emits no clause, so the board
    // actually narrows the cut list.
    await primeConfig();
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => ({
      values: [{ id: 99, state: "active" }],
    }));
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [
        { kind: "project", externalId: "PLAT" },
        { kind: "board", externalId: "board:482", boardMode: "active-sprint", project: "PLAT" },
      ],
    });

    expect(box.jql).toContain("((sprint in openSprints() AND filter = 10231))");
    expect(box.jql).not.toContain("project = ");
  });

  it("demotes every in-scope project when 'assigned to me' is scoped in-project", async () => {
    await primeConfig();
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [
        { kind: "project", externalId: "PLAT" },
        { kind: "mine", externalId: "mine", mineScope: "in-project" },
      ],
    });

    expect(box.jql).toContain('((assignee = currentUser() AND project in ("PLAT")))');
    expect(box.jql).not.toContain("project = ");
  });

  it("keeps a project as a full source when no narrower source is scoped to it (cross-project union)", async () => {
    // PLAT is narrowed by its board; PAY has no narrower source, so it stays a
    // full `project = "PAY"` source and the two union.
    await primeConfig();
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => ({
      values: [{ id: 99, state: "active" }],
    }));
    const box = { jql: "" };
    captureSearchJql(box);

    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [
        { kind: "project", externalId: "PLAT" },
        { kind: "board", externalId: "board:482", boardMode: "active-sprint", project: "PLAT" },
        { kind: "project", externalId: "PAY" },
      ],
    });

    expect(box.jql).toContain("(sprint in openSprints() AND filter = 10231)");
    expect(box.jql).toContain('project = "PAY"');
    expect(box.jql).not.toContain('project = "PLAT"');
  });

  it("listIssues preserves the watermark across paged board polls and advances only on the last page (TC-014)", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => ({
      values: [{ id: 99, state: "active" }],
    }));

    const originalWatermark = "2026-04-01T00:00:00Z";
    // The watermark is keyed on board identity + mode, not the resolved sprint.
    harness.credentials.set(
      "state",
      JSON.stringify({ "board:board:482:active-sprint": originalWatermark }),
    );

    const capturedJql: string[] = [];
    let call = 0;
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      capturedJql.push(JSON.parse(init.body ?? "{}").jql ?? "");
      call += 1;
      return {
        issues: [
          {
            key: `PROJ-${call}`,
            fields: {
              summary: `p${call}`,
              status: { name: "Open" },
              updated: `2026-04-0${call + 4}T00:00:00Z`,
            },
          },
        ],
        total: 2,
      };
    });

    const board = { kind: "board", externalId: "board:482", boardMode: "active-sprint" };
    const r1 = await harness.hostConnection.sendRequest<{ nextCursor: string | null }>(
      "listIssues",
      { cursor: null, pageSize: 1, sources: [board] },
    );
    expect(r1.nextCursor).toBe("1");
    expect(capturedJql[0]).toContain(`updated >= "${originalWatermark}"`);
    // Watermark must not advance until pagination is exhausted.
    expect(harness.credentials.get("state")).toContain(originalWatermark);

    const r2 = await harness.hostConnection.sendRequest<{ nextCursor: string | null }>(
      "listIssues",
      { cursor: r1.nextCursor, pageSize: 1, sources: [board] },
    );
    expect(r2.nextCursor).toBeNull();
    expect(capturedJql[0]).toBe(capturedJql[1]);
    expect(harness.credentials.get("state")).toContain("2026-04-06T00:00:00Z");
  });

  it("listIssues resets the watermark once when the configured source set changes (TC-041)", async () => {
    await primeConfig();
    harness.fetchStub.on("/rest/agile/1.0/board/482/configuration", () => ({
      filter: { id: 10231 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board/482/sprint", () => ({
      values: [{ id: 99, state: "active" }],
    }));

    // A watermark exists for a board-only set.
    harness.credentials.set(
      "state",
      JSON.stringify({ "board:board:482:active-sprint": "2026-04-01T00:00:00Z" }),
    );

    const capturedJql: string[] = [];
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      capturedJql.push(JSON.parse(init.body ?? "{}").jql ?? "");
      return { issues: [], total: 0 };
    });

    // Adding a filter source changes the union's cache key, so this poll has no
    // stored watermark and re-fetches in full (no `updated >=`).
    await harness.hostConnection.sendRequest("listIssues", {
      cursor: null,
      pageSize: 50,
      sources: [
        { kind: "board", externalId: "board:482", boardMode: "active-sprint" },
        { kind: "filter", externalId: "555" },
      ],
    });
    expect(capturedJql[0]).not.toContain("updated >=");
  });

  it("logs getSourceOptions failures to the plugin log stream, then re-throws (#468)", async () => {
    // Without this the host turns the rejection into a generic 502 and the
    // dropdown only shows "Could not load results", with nothing recorded to
    // diagnose from. The category and Jira status must be logged; the PAT and
    // the user's raw search term must not (NFR-003).
    await harness.hostConnection.sendRequest("setActiveConfig", {
      config: { instance: "https://jira.acme.example" },
    });

    const errorLogs: unknown[] = [];
    // Replace the harness no-op so we can inspect what the plugin logged.
    harness.hostConnection.onNotification("host.logger.error", (p) => errorLogs.push(p));

    harness.fetchStub.on("/rest/api/2/project", () =>
      StubResponse.jiraError(404, "No project could be found with key 'search'."),
    );

    await expect(
      harness.hostConnection.sendRequest("getSourceOptions", {
        category: "project",
        search: "secret-term",
      }),
    ).rejects.toBeDefined();

    const serialized = JSON.stringify(errorLogs);
    expect(serialized).toContain("getSourceOptions failed");
    expect(serialized).toContain("project");
    expect(serialized).toContain("404");
    // Nothing sensitive leaks: no PAT, no raw search term.
    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain("secret-term");
  });
});
