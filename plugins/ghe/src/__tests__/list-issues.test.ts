import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveConfig } from "../active-config.js";
import { listIssues } from "../methods/list-issues.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

describe("listIssues", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("throws a clear error if validateConfig has not been called", async () => {
    await expect(listIssues({ cursor: null, pageSize: 50 })).rejects.toThrow(
      /No active configuration/,
    );
  });

  it("queries the configured repo source and enriches with blocking relationships", async () => {
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });

    const rawIssues = [
      {
        number: 10,
        title: "first",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "https://github.com/foo/bar/issues/10",
      },
      {
        number: 11,
        title: "second",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "https://github.com/foo/bar/issues/11",
      },
    ];

    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(rawIssues));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_10: {
          blockedBy: {
            nodes: [{ number: 11, title: "second", state: "OPEN" }],
          },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        issue_11: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });

    const result = await listIssues({ cursor: null, pageSize: 50 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0].externalId).toBe("foo/bar#10");
    expect(result.items[0].blockedBy).toEqual(["foo/bar#11"]);
    expect(result.items[0].blocks).toEqual([]);
    expect(result.items[1].externalId).toBe("foo/bar#11");
    expect(result.nextCursor).toBeNull();
  });

  it("returns a next cursor when the page is full", async () => {
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });

    const fullPage = Array.from({ length: 2 }, (_, i) => ({
      number: i + 1,
      title: `t${i}`,
      body: null,
      state: "open",
      labels: [],
      created_at: "x",
      updated_at: "x",
      comments: 0,
      html_url: "u",
    }));
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(fullPage));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_1: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        issue_2: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });

    const result = await listIssues({ cursor: null, pageSize: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe("2");
  });

  it("passes labels filter through to the GitHub request", async () => {
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });

    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    await listIssues({ cursor: null, pageSize: 5, filters: { labels: ["bug", "p1"] } });

    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params.labels).toBe("bug,p1");
  });

  it("reports hasNextPage when the unfiltered API response is a full page, even if PRs were filtered out", async () => {
    // Regression: `/repos/{owner}/{repo}/issues` returns issues and PRs
    // interleaved. Computing hasNextPage from the post-filter item count
    // would short-circuit pagination as soon as a page contained any PR.
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });

    const mixedFullPage = [
      {
        number: 1,
        title: "issue",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "u",
      },
      {
        number: 2,
        title: "pr",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "u",
        pull_request: { url: "https://api.github.com/repos/foo/bar/pulls/2" },
      },
    ];
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(mixedFullPage));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_1: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });

    const result = await listIssues({ cursor: null, pageSize: 2 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("issue");
    expect(result.nextCursor).toBe("2");
  });

  it("uses search API when filters.search is set", async () => {
    setActiveConfig({
      instance: "https://ghe.example.com",
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });

    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ items: [] }));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    await listIssues({ cursor: null, pageSize: 5, filters: { search: "label:bug" } });

    const route = mocks.mockOctokit.request.mock.calls[0][0] as string;
    expect(route).toBe("GET /search/issues");
    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params.q).toContain("repo:foo/bar");
    expect(params.q).toContain("is:issue is:open");
    expect(params.q).toContain("label:bug");
  });
});
