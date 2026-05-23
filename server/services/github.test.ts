import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequest = vi.fn();
const mockGraphql = vi.fn();

const mockOctokit = {
  request: mockRequest,
  graphql: mockGraphql,
};

vi.mock("octokit", () => ({
  Octokit: class MockOctokit {
    request = mockOctokit.request;
    graphql = mockOctokit.graphql;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  mockRequest.mockReset();
  mockGraphql.mockReset();
});

async function loadModule() {
  return await import("./github.js");
}

// ── fetchIssues ──

describe("fetchIssues", () => {
  it("returns mapped issues from GitHub API", async () => {
    mockRequest.mockResolvedValue({
      data: [
        {
          number: 1,
          title: "Test issue",
          body: "Issue body",
          state: "open",
          labels: [{ name: "bug" }],
          assignee: { login: "user1" },
          milestone: { title: "v1.0" },
          created_at: "2026-01-01",
          updated_at: "2026-01-02",
          comments: 3,
          html_url: "https://github.com/org/repo/issues/1",
        },
      ],
      headers: {},
      status: 200,
    });

    const { fetchIssues } = await loadModule();
    const issues = await fetchIssues("org/repo");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 1,
      title: "Test issue",
      body: "Issue body",
      state: "open",
      labels: ["bug"],
      assignee: "user1",
      milestone: "v1.0",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
      commentsCount: 3,
      htmlUrl: "https://github.com/org/repo/issues/1",
    });
  });

  it("filters out pull requests", async () => {
    mockRequest.mockResolvedValue({
      data: [
        { number: 1, title: "Issue", labels: [], created_at: "", updated_at: "", html_url: "" },
        {
          number: 2,
          title: "PR",
          pull_request: {},
          labels: [],
          created_at: "",
          updated_at: "",
          html_url: "",
        },
      ],
      headers: {},
      status: 200,
    });

    const { fetchIssues } = await loadModule();
    const issues = await fetchIssues("org/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it("uses search API when search option provided", async () => {
    mockRequest.mockResolvedValue({
      data: {
        items: [
          { number: 5, title: "Found", labels: [], created_at: "", updated_at: "", html_url: "" },
        ],
      },
      headers: {},
      status: 200,
    });

    const { fetchIssues } = await loadModule();
    const issues = await fetchIssues("org/repo", { search: "bug fix" });

    expect(issues).toHaveLength(1);
    expect(mockRequest).toHaveBeenCalledWith(
      "GET /search/issues",
      expect.objectContaining({
        q: "repo:org/repo is:issue is:open bug fix",
      }),
    );
  });

  it("passes labels to API", async () => {
    mockRequest.mockResolvedValue({ data: [], headers: {}, status: 200 });

    const { fetchIssues } = await loadModule();
    await fetchIssues("org/repo", { labels: "bug,feature" });

    expect(mockRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues",
      expect.objectContaining({
        labels: "bug,feature",
      }),
    );
  });
});

// ── fetchIssueDetail ──

describe("fetchIssueDetail", () => {
  it("returns a single issue", async () => {
    mockRequest.mockResolvedValue({
      data: {
        number: 1,
        title: "Detail",
        body: "Full body",
        state: "open",
        labels: [],
        created_at: "",
        updated_at: "",
        html_url: "",
      },
      headers: {},
      status: 200,
    });

    const { fetchIssueDetail } = await loadModule();
    const issue = await fetchIssueDetail("org/repo", 1);
    expect(issue.title).toBe("Detail");
    expect(issue.body).toBe("Full body");
  });
});

// ── fetchIssueComments ──

describe("fetchIssueComments", () => {
  it("returns mapped comments", async () => {
    mockRequest.mockResolvedValue({
      data: [
        { id: 100, body: "Comment text", user: { login: "commenter" }, created_at: "2026-01-01" },
      ],
      headers: {},
      status: 200,
    });

    const { fetchIssueComments } = await loadModule();
    const comments = await fetchIssueComments("org/repo", 1);

    expect(comments).toEqual([
      {
        id: 100,
        body: "Comment text",
        user: "commenter",
        createdAt: "2026-01-01",
      },
    ]);
  });
});

// ── fetchLabels ──

describe("fetchLabels", () => {
  it("returns label names", async () => {
    mockRequest.mockResolvedValue({
      data: [{ name: "bug" }, { name: "enhancement" }],
      headers: {},
      status: 200,
    });

    const { fetchLabels } = await loadModule();
    const labels = await fetchLabels("org/repo");
    expect(labels).toEqual(["bug", "enhancement"]);
  });
});

// ── fetchProjects ──

describe("fetchProjects", () => {
  it("returns projects from organization query", async () => {
    mockGraphql.mockResolvedValue({
      organization: {
        projectsV2: {
          nodes: [
            { number: 1, title: "Project Alpha" },
            { number: 2, title: "Project Beta" },
          ],
        },
      },
    });

    const { fetchProjects } = await loadModule();
    const projects = await fetchProjects("org/repo");

    expect(projects).toEqual([
      { number: 1, title: "Project Alpha" },
      { number: 2, title: "Project Beta" },
    ]);
  });

  it("falls back to user query when organization query fails", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("Not an organization")).mockResolvedValueOnce({
      user: {
        projectsV2: {
          nodes: [{ number: 3, title: "Personal Project" }],
        },
      },
    });

    const { fetchProjects } = await loadModule();
    const projects = await fetchProjects("user/repo");

    expect(projects).toEqual([{ number: 3, title: "Personal Project" }]);
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("throws a classified GitHubError when both queries fail", async () => {
    mockGraphql
      .mockRejectedValueOnce(new Error("Not an organization"))
      .mockRejectedValueOnce(new Error("Not a user"));

    const { fetchProjects } = await loadModule();
    await expect(fetchProjects("unknown/repo")).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("throws ORG_APPROVAL_REQUIRED when org access is denied", async () => {
    mockGraphql
      .mockRejectedValueOnce(new Error("Resource not accessible by integration"))
      .mockRejectedValueOnce(new Error("Not a user"));

    const { fetchProjects } = await loadModule();
    await expect(fetchProjects("myorg/repo")).rejects.toMatchObject({
      code: "ORG_APPROVAL_REQUIRED",
    });
  });

  it("throws NOT_CONNECTED when GitHub is not connected", async () => {
    const { ServiceError } = await import("./service-error.js");
    mockGraphql.mockRejectedValue(
      new ServiceError(401, "GitHub is not connected. Connect your GitHub account in Settings."),
    );
    const { fetchProjects } = await loadModule();
    await expect(fetchProjects("org/repo")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      statusCode: 401,
    });
  });
});

// ── fetchProjectItems ──

describe("fetchProjectItems", () => {
  function makeProjectItemsResponse(nodes: unknown[], title = "Sprint 1") {
    return {
      organization: {
        projectV2: {
          title,
          items: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  }

  function makeIssueNode(overrides: Record<string, unknown> = {}) {
    return {
      content: {
        __typename: "Issue",
        number: 42,
        title: "Fix login bug",
        body: "The login form is broken",
        state: "open",
        labels: { nodes: [{ name: "bug" }] },
        assignees: { nodes: [{ login: "dev1" }] },
        milestone: { title: "v1.0" },
        issueType: { name: "Bug" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        comments: { totalCount: 3 },
        url: "https://github.com/org/repo/issues/42",
        ...((overrides.content as object) ?? {}),
      },
      fieldValueByName:
        overrides.fieldValueByName !== undefined ? overrides.fieldValueByName : { name: "Todo" },
    };
  }

  it("fetches items from organization project", async () => {
    mockGraphql.mockResolvedValueOnce(makeProjectItemsResponse([makeIssueNode()]));

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);

    expect(result.projectTitle).toBe("Sprint 1");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].issue.number).toBe(42);
    expect(result.items[0].issue.title).toBe("Fix login bug");
    expect(result.items[0].issue.labels).toEqual(["bug"]);
    expect(result.items[0].issue.assignee).toBe("dev1");
    expect(result.items[0].issue.milestone).toBe("v1.0");
    expect(result.items[0].issue.type).toBe("Bug");
    expect(result.items[0].status).toBe("Todo");
  });

  it("maps milestone and type as undefined when absent", async () => {
    const node = makeIssueNode({ content: { milestone: null, issueType: null } });
    mockGraphql.mockResolvedValueOnce(makeProjectItemsResponse([node]));

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);

    expect(result.items[0].issue.milestone).toBeUndefined();
    expect(result.items[0].issue.type).toBeUndefined();
  });

  it("falls back to user query when organization fails", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("org not found")).mockResolvedValueOnce({
      user: {
        projectV2: {
          title: "Personal",
          items: {
            nodes: [makeIssueNode()],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(result.projectTitle).toBe("Personal");
    expect(result.items).toHaveLength(1);
  });

  it("throws a classified GitHubError when both org and user queries fail", async () => {
    mockGraphql
      .mockRejectedValueOnce(new Error("Could not resolve to an Organization with the login"))
      .mockRejectedValueOnce(new Error("Could not resolve to a User with the login"));

    const { fetchProjectItems } = await loadModule();
    await expect(fetchProjectItems("org/repo", 1)).rejects.toMatchObject({
      code: "OWNER_NOT_FOUND",
    });
  });

  it("throws NOT_CONNECTED when GitHub token is missing", async () => {
    const { ServiceError } = await import("./service-error.js");
    mockGraphql.mockRejectedValue(
      new ServiceError(401, "GitHub is not connected. Connect your GitHub account in Settings."),
    );
    const { fetchProjectItems } = await loadModule();
    await expect(fetchProjectItems("org/repo", 1)).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      statusCode: 401,
    });
  });

  it("throws ORG_APPROVAL_REQUIRED when GitHub org access is denied", async () => {
    mockGraphql
      .mockRejectedValueOnce(new Error("Resource not accessible by integration"))
      .mockRejectedValueOnce(new Error("not a user"));
    const { fetchProjectItems } = await loadModule();
    await expect(fetchProjectItems("org/repo", 1)).rejects.toMatchObject({
      code: "ORG_APPROVAL_REQUIRED",
    });
  });

  it("filters out non-Issue items (PRs, drafts, nulls)", async () => {
    const prNode = {
      content: { __typename: "PullRequest", number: 10, title: "PR" },
      fieldValueByName: null,
    };
    const draftNode = {
      content: { __typename: "DraftIssue", title: "Draft" },
      fieldValueByName: null,
    };
    const nullNode = { content: null, fieldValueByName: null };

    mockGraphql.mockResolvedValueOnce(
      makeProjectItemsResponse([makeIssueNode(), prNode, draftNode, nullNode]),
    );

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].issue.number).toBe(42);
  });

  it("filters out closed issues", async () => {
    const closedNode = makeIssueNode({ content: { state: "CLOSED", number: 99, title: "Closed" } });

    mockGraphql.mockResolvedValueOnce(makeProjectItemsResponse([makeIssueNode(), closedNode]));

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].issue.number).toBe(42);
  });

  it("normalizes uppercase state from GraphQL API", async () => {
    const node = makeIssueNode({ content: { state: "OPEN" } });

    mockGraphql.mockResolvedValueOnce(makeProjectItemsResponse([node]));

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].issue.state).toBe("open");
  });

  it("filters items without number (PRs have number via inline fragment but DraftIssues may not)", async () => {
    const noNumberNode = {
      content: { title: "Some draft", state: "OPEN" },
      fieldValueByName: null,
    };

    mockGraphql.mockResolvedValueOnce(makeProjectItemsResponse([makeIssueNode(), noNumberNode]));

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);
    expect(result.items).toHaveLength(1);
  });

  it("handles null fieldValueByName", async () => {
    mockGraphql.mockResolvedValueOnce(
      makeProjectItemsResponse([makeIssueNode({ fieldValueByName: null })]),
    );

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);
    expect(result.items[0].status).toBeUndefined();
  });

  it("paginates through multiple pages of project items", async () => {
    const node1 = makeIssueNode({ content: { number: 1, title: "Issue 1" } });
    const node2 = makeIssueNode({ content: { number: 2, title: "Issue 2" } });

    mockGraphql
      .mockResolvedValueOnce({
        organization: {
          projectV2: {
            title: "Sprint 1",
            items: {
              nodes: [node1],
              pageInfo: { hasNextPage: true, endCursor: "cursor1" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        organization: {
          projectV2: {
            title: "Sprint 1",
            items: {
              nodes: [node2],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });

    const { fetchProjectItems } = await loadModule();
    const result = await fetchProjectItems("org/repo", 1);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].issue.number).toBe(1);
    expect(result.items[1].issue.number).toBe(2);
  });

  it("stops pagination after 10 pages", async () => {
    const node = makeIssueNode();

    // Always return hasNextPage: true
    mockGraphql.mockImplementation(() =>
      Promise.resolve({
        organization: {
          projectV2: {
            title: "Sprint 1",
            items: {
              nodes: [node],
              pageInfo: { hasNextPage: true, endCursor: "cursor-next" },
            },
          },
        },
      }),
    );

    const { fetchProjectItems } = await loadModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fetchProjectItems("org/repo", 1);

    expect(mockGraphql).toHaveBeenCalledTimes(10);
    expect(result.items.length).toBeLessThanOrEqual(10);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("hit pagination limit"));
    warnSpy.mockRestore();
  });
});

// ── error handling ──

describe("error handling", () => {
  it("throws when no token is available", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("GITHUB_TOKEN", "");

    const { fetchIssues } = await loadModule();

    await expect(fetchIssues("org/repo")).rejects.toThrow("GitHub is not connected");
  });

  it("throws for invalid repo name", async () => {
    const { fetchIssueDetail } = await loadModule();
    await expect(fetchIssueDetail("invalid", 1)).rejects.toThrow("Invalid repo name");
  });
});

// ── resetOctokit ──

describe("resetOctokit", () => {
  it("clears the issue cache so the next call re-fetches", async () => {
    mockRequest.mockResolvedValue({ data: [], headers: {}, status: 200 });

    const { fetchIssues, resetOctokit } = await loadModule();

    await fetchIssues("org/repo");
    expect(mockRequest).toHaveBeenCalledTimes(1);

    // Second call hits cache — no additional API call
    await fetchIssues("org/repo");
    expect(mockRequest).toHaveBeenCalledTimes(1);

    resetOctokit();

    // After reset, cache is cleared and API is called again
    await fetchIssues("org/repo");
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("clears the issueTypes cache so the next call re-fetches", async () => {
    mockGraphql.mockResolvedValue({
      repository: {
        issueTypes: {
          nodes: [{ id: "it-1", name: "Bug", isEnabled: true }],
          pageInfo: { hasNextPage: false },
        },
      },
    });

    const { fetchIssueTypes, resetOctokit } = await loadModule();

    await fetchIssueTypes("org/repo");
    expect(mockGraphql).toHaveBeenCalledTimes(1);

    await fetchIssueTypes("org/repo");
    expect(mockGraphql).toHaveBeenCalledTimes(1);

    resetOctokit();

    await fetchIssueTypes("org/repo");
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("reads token from the github-com plugin keychain slot when GITHUB_TOKEN is unset", async () => {
    vi.unstubAllEnvs();
    vi.doMock("./state.js", () => ({
      loadSettings: () => ({ theme: "dark" }),
    }));
    vi.doMock("./credential-store.js", () => ({
      get: vi.fn(async () => "oauth-token"),
      set: vi.fn(),
      deleteSlot: vi.fn(),
    }));

    mockRequest.mockResolvedValue({ data: [], headers: {}, status: 200 });

    const mod = await loadModule();
    await mod.refreshAuth();
    expect(mod.getGithubToken()).toBe("oauth-token");

    await mod.fetchIssues("org/repo");
    expect(mockRequest).toHaveBeenCalled();
  });
});

// ── fetchBlockingRelationships ──

describe("fetchBlockingRelationships", () => {
  function makeBlockingResponse(
    issueMap: Record<
      number,
      { nodes: unknown[]; blockingNodes?: unknown[]; hasNextPage?: boolean }
    >,
  ) {
    const repository: Record<string, unknown> = {};
    for (const [num, data] of Object.entries(issueMap)) {
      repository[`issue_${num}`] = {
        blockedBy: { nodes: data.nodes },
        blocking: {
          nodes: data.blockingNodes ?? [],
          pageInfo: { hasNextPage: data.hasNextPage ?? false },
        },
      };
    }
    return { repository };
  }

  it("returns empty record when no issue numbers given", async () => {
    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", []);
    expect(result).toEqual({ blockedBy: {}, blockingCount: {} });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("returns direct open blockers", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        42: { nodes: [{ number: 10, title: "Blocker", state: "OPEN", blockedBy: { nodes: [] } }] },
      }),
    );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [42]);

    expect(result.blockedBy[42]).toEqual([{ number: 10, title: "Blocker" }]);
  });

  it("ignores closed blockers", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        42: {
          nodes: [
            { number: 10, title: "Closed blocker", state: "CLOSED", blockedBy: { nodes: [] } },
            { number: 11, title: "Open blocker", state: "OPEN", blockedBy: { nodes: [] } },
          ],
        },
      }),
    );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [42]);

    expect(result.blockedBy[42]).toEqual([{ number: 11, title: "Open blocker" }]);
  });

  it("resolves transitive blockers up to 3 levels", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        1: {
          nodes: [
            {
              number: 2,
              title: "Level 1",
              state: "OPEN",
              blockedBy: {
                nodes: [
                  {
                    number: 3,
                    title: "Level 2",
                    state: "OPEN",
                    blockedBy: {
                      nodes: [{ number: 4, title: "Level 3", state: "OPEN" }],
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [1]);

    expect(result.blockedBy[1]).toEqual([
      { number: 2, title: "Level 1" },
      { number: 3, title: "Level 2" },
      { number: 4, title: "Level 3" },
    ]);
  });

  it("caps transitive resolution at 3 levels deep", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        1: {
          nodes: [
            {
              number: 2,
              title: "Level 1",
              state: "OPEN",
              blockedBy: {
                nodes: [
                  {
                    number: 3,
                    title: "Level 2",
                    state: "OPEN",
                    blockedBy: {
                      nodes: [
                        {
                          number: 4,
                          title: "Level 3",
                          state: "OPEN",
                          // Level 4 — should not be followed even if present
                          blockedBy: { nodes: [{ number: 5, title: "Level 4", state: "OPEN" }] },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [1]);

    // Level 4 (issue 5) must not appear
    const numbers = result.blockedBy[1].map((b) => b.number);
    expect(numbers).toContain(2);
    expect(numbers).toContain(3);
    expect(numbers).toContain(4);
    expect(numbers).not.toContain(5);
  });

  it("deduplicates blockers that appear in multiple paths", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        1: {
          nodes: [
            { number: 10, title: "Shared", state: "OPEN", blockedBy: { nodes: [] } },
            { number: 10, title: "Shared duplicate", state: "OPEN", blockedBy: { nodes: [] } },
          ],
        },
      }),
    );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [1]);

    expect(result.blockedBy[1]).toHaveLength(1);
    expect(result.blockedBy[1][0].number).toBe(10);
  });

  it("returns blocking count of open issues this issue blocks", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        5: {
          nodes: [],
          blockingNodes: [{ state: "OPEN" }, { state: "OPEN" }, { state: "CLOSED" }],
        },
      }),
    );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [5]);

    expect(result.blockingCount[5]).toBe(2);
  });

  it("returns blockingCount of 0 when blocking list is empty", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        7: { nodes: [] },
      }),
    );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [7]);

    expect(result.blockingCount[7]).toBe(0);
  });

  it("warns when an issue blocks more than 100 issues (hasNextPage)", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        42: { nodes: [], blockingNodes: [{ state: "OPEN" }], hasNextPage: true },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [42]);

    expect(result.blockingCount[42]).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("issue #42 blocks more than 100 issues"),
    );
    warnSpy.mockRestore();
  });

  it("caches results and avoids a second GraphQL call", async () => {
    mockGraphql.mockResolvedValue(
      makeBlockingResponse({
        42: { nodes: [] },
      }),
    );

    const { fetchBlockingRelationships, resetOctokit: reset } = await loadModule();
    await fetchBlockingRelationships("org/repo", [42]);
    await fetchBlockingRelationships("org/repo", [42]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    reset();
  });

  it("returns empty results and does not throw when GraphQL fails", async () => {
    mockGraphql.mockRejectedValue(new Error("Field blockedBy does not exist"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [42]);

    expect(result.blockedBy[42]).toEqual([]);
    expect(result.blockingCount[42]).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[github] fetchBlockingRelationships failed"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array for issues with no repository entry", async () => {
    mockGraphql.mockResolvedValue({
      repository: { issue_42: null },
    });

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", [42]);

    expect(result.blockedBy[42]).toEqual([]);
    expect(result.blockingCount[42]).toBe(0);
  });

  it("issues >20 are split across two GraphQL calls and results are merged", async () => {
    // 21 issues — first batch of 20, second batch of 1
    const allNumbers = Array.from({ length: 21 }, (_, i) => i + 1);
    const batch1 = allNumbers.slice(0, 20);

    mockGraphql
      .mockResolvedValueOnce(
        makeBlockingResponse(
          Object.fromEntries(batch1.map((n) => [n, { nodes: [] }])) as Record<
            number,
            { nodes: unknown[] }
          >,
        ),
      )
      .mockResolvedValueOnce(
        makeBlockingResponse({
          21: {
            nodes: [{ number: 99, title: "Blocker", state: "OPEN", blockedBy: { nodes: [] } }],
          },
        }),
      );

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", allNumbers);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    for (const n of batch1) expect(result.blockedBy[n]).toEqual([]);
    expect(result.blockedBy[21]).toEqual([{ number: 99, title: "Blocker" }]);
    for (const n of batch1) expect(result.blockingCount[n]).toBe(0);
    expect(result.blockingCount[21]).toBe(0);
  });

  it("keeps results from successful batches when a later batch fails", async () => {
    const allNumbers = Array.from({ length: 21 }, (_, i) => i + 1);
    const batch1 = allNumbers.slice(0, 20);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockGraphql
      .mockResolvedValueOnce(
        makeBlockingResponse(
          Object.fromEntries(batch1.map((n) => [n, { nodes: [] }])) as Record<
            number,
            { nodes: unknown[] }
          >,
        ),
      )
      .mockRejectedValueOnce(new Error("rate limited"));

    const { fetchBlockingRelationships } = await loadModule();
    const result = await fetchBlockingRelationships("org/repo", allNumbers);

    for (const n of batch1) expect(result.blockedBy[n]).toEqual([]);
    expect(result.blockedBy[21]).toEqual([]);
    for (const n of batch1) expect(result.blockingCount[n]).toBe(0);
    expect(result.blockingCount[21]).toBe(0);
    warnSpy.mockRestore();
  });
});

// ── githubRequest backoff ──

describe("githubRequest backoff", () => {
  it("retries on 429 with retry-after header and succeeds on second attempt", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const err429 = { status: 429, response: { headers: { "retry-after": "2" } } };
    mockRequest
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({ data: [{ name: "bug" }], headers: {}, status: 200 });

    const labels = await fetchLabels("org/repo");
    expect(labels).toEqual(["bug"]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(2000);
  });

  it("retries on 403 with x-ratelimit-remaining 0 using reset time", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const resetEpoch = Math.floor(Date.now() / 1000) + 5; // 5 seconds from now
    const err403 = {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpoch),
        },
      },
    };
    mockRequest
      .mockRejectedValueOnce(err403)
      .mockResolvedValueOnce({ data: [{ name: "feat" }], headers: {}, status: 200 });

    const labels = await fetchLabels("org/repo");
    expect(labels).toEqual(["feat"]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    // Sleep should be roughly 5000ms (between 0 and MAX_BACKOFF_MS)
    const sleepArg = mockSleep.mock.calls[0][0] as number;
    expect(sleepArg).toBeGreaterThanOrEqual(0);
    expect(sleepArg).toBeLessThanOrEqual(60_000);
  });

  it("retries on 403 secondary rate limit message", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const errSecondary = {
      status: 403,
      message: "You have exceeded a secondary rate limit",
      response: { headers: { "retry-after": "3" } },
    };
    mockRequest
      .mockRejectedValueOnce(errSecondary)
      .mockResolvedValueOnce({ data: [], headers: {}, status: 200 });

    await fetchLabels("org/repo");
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(3000);
  });

  it("does not retry non-rate-limit errors", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const err500 = Object.assign(new Error("Internal server error"), {
      status: 500,
      response: { headers: {} },
    });
    mockRequest.mockRejectedValue(err500);

    await expect(fetchLabels("org/repo")).rejects.toThrow("Internal server error");
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("gives up after MAX_RETRIES and propagates the error", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const err429 = { status: 429, response: { headers: { "retry-after": "1" } } };
    mockRequest.mockRejectedValue(err429);

    await expect(fetchLabels("org/repo")).rejects.toMatchObject({ status: 429 });
    expect(mockRequest).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(mockSleep).toHaveBeenCalledTimes(3);
  });

  it("caps sleep at MAX_BACKOFF_MS when reset time is far in the future", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const farFutureReset = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const err403 = {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(farFutureReset),
        },
      },
    };
    mockRequest
      .mockRejectedValueOnce(err403)
      .mockResolvedValueOnce({ data: [], headers: {}, status: 200 });

    await fetchLabels("org/repo");
    expect(mockSleep).toHaveBeenCalledWith(60_000);
  });

  it("429 with no retry-after header falls back to exponential backoff", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const err429 = { status: 429, response: { headers: {} } };
    mockRequest
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({ data: [{ name: "bug" }], headers: {}, status: 200 });

    const labels = await fetchLabels("org/repo");
    expect(labels).toEqual(["bug"]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    const sleepArg = mockSleep.mock.calls[0][0] as number;
    expect(sleepArg).toBeGreaterThanOrEqual(0);
    expect(sleepArg).toBeLessThanOrEqual(60_000);
  });

  it("403 primary rate limit with no x-ratelimit-reset falls back to exponential backoff", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchLabels, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const err403 = {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0" } },
    };
    mockRequest
      .mockRejectedValueOnce(err403)
      .mockResolvedValueOnce({ data: [{ name: "feat" }], headers: {}, status: 200 });

    const labels = await fetchLabels("org/repo");
    expect(labels).toEqual(["feat"]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    const sleepArg = mockSleep.mock.calls[0][0] as number;
    expect(sleepArg).toBeGreaterThanOrEqual(0);
    expect(sleepArg).toBeLessThanOrEqual(60_000);
  });

  it("graphql path retries on 403 secondary rate limit", async () => {
    const mockSleep = vi.fn().mockResolvedValue(undefined);
    const { fetchProjects, __setSleepForTests } = await loadModule();
    __setSleepForTests(mockSleep);

    const errSecondary = {
      status: 403,
      message: "secondary rate limit exceeded",
      response: { headers: {} },
    };
    mockGraphql.mockRejectedValueOnce(errSecondary).mockResolvedValueOnce({
      organization: { projectsV2: { nodes: [{ number: 1, title: "P1" }] } },
    });

    const projects = await fetchProjects("org/repo");
    expect(projects).toEqual([{ number: 1, title: "P1" }]);
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });
});

// ── githubRequest ETag ──

describe("githubRequest etag", () => {
  // fetchLabels has no TTL cache, making it ideal for ETag tests:
  // both calls always reach githubRequest without being short-circuited.

  it("stores etag on 200 and sends If-None-Match on the next call", async () => {
    const { fetchLabels } = await loadModule();

    mockRequest
      .mockResolvedValueOnce({ data: [{ name: "bug" }], headers: { etag: 'W/"v1"' }, status: 200 })
      .mockResolvedValueOnce({ data: [{ name: "bug" }], headers: { etag: 'W/"v1"' }, status: 200 });

    await fetchLabels("org/repo");
    await fetchLabels("org/repo");

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/labels",
      expect.objectContaining({ headers: expect.objectContaining({ "if-none-match": 'W/"v1"' }) }),
    );
  });

  it("first call does not send If-None-Match (no cached etag yet)", async () => {
    const { fetchLabels } = await loadModule();

    mockRequest.mockResolvedValueOnce({ data: [], headers: {}, status: 200 });

    await fetchLabels("org/repo");

    const firstCallHeaders = mockRequest.mock.calls[0][1].headers as Record<string, string>;
    expect(firstCallHeaders["if-none-match"]).toBeUndefined();
  });

  it("304 response thrown by Octokit returns notModified sentinel with cached data", async () => {
    const { fetchLabels } = await loadModule();

    // First call: 200 with etag — stores data in etag cache
    mockRequest.mockResolvedValueOnce({
      data: [{ name: "bug" }],
      headers: { etag: 'W/"v1"' },
      status: 200,
    });
    const labels1 = await fetchLabels("org/repo");
    expect(labels1).toEqual(["bug"]);

    // Second call: server signals 304 (thrown as error by Octokit)
    const err304 = { status: 304, response: { headers: {} } };
    mockRequest.mockRejectedValueOnce(err304);
    const labels2 = await fetchLabels("org/repo");
    expect(labels2).toEqual(["bug"]); // returns cached data transparently
  });

  it("304 response surfaced as normal response also returns cached data", async () => {
    const { fetchLabels } = await loadModule();

    mockRequest.mockResolvedValueOnce({
      data: [{ name: "feat" }],
      headers: { etag: 'W/"v2"' },
      status: 200,
    });
    await fetchLabels("org/repo");

    // Octokit plugin surfacing 304 as a normal resolved response
    mockRequest.mockResolvedValueOnce({ data: undefined, headers: {}, status: 304 });
    const labels = await fetchLabels("org/repo");
    expect(labels).toEqual(["feat"]);
  });

  it("different routes do not share etag entries", async () => {
    const { fetchLabels, fetchIssueDetail } = await loadModule();

    // Store etag for labels
    mockRequest.mockResolvedValueOnce({
      data: [{ name: "bug" }],
      headers: { etag: 'W/"labels-v1"' },
      status: 200,
    });
    await fetchLabels("org/repo");

    // Issue detail call — must not receive the labels etag
    mockRequest.mockResolvedValueOnce({
      data: {
        number: 1,
        title: "T",
        body: null,
        state: "open",
        labels: [],
        created_at: "",
        updated_at: "",
        html_url: "",
      },
      headers: { etag: 'W/"issue-v1"' },
      status: 200,
    });
    await fetchIssueDetail("org/repo", 1);

    const issueCallHeaders = mockRequest.mock.calls[1][1].headers as Record<string, string>;
    expect(issueCallHeaders["if-none-match"]).toBeUndefined();
  });

  it("resetOctokit clears etag store so next call omits If-None-Match", async () => {
    const { fetchLabels, resetOctokit } = await loadModule();

    mockRequest.mockResolvedValue({
      data: [{ name: "bug" }],
      headers: { etag: 'W/"v1"' },
      status: 200,
    });

    // First call — etag stored
    await fetchLabels("org/repo");

    resetOctokit();

    // Second call — etag store was cleared, no If-None-Match
    await fetchLabels("org/repo");

    const secondCallHeaders = mockRequest.mock.calls[1][1].headers as Record<string, string>;
    expect(secondCallHeaders["if-none-match"]).toBeUndefined();
  });

  it("etag store is pruned when over 200 entries", async () => {
    const { fetchIssueDetail } = await loadModule();

    // Fill the store with 200 entries (distinct issue numbers = distinct routes + params)
    for (let i = 1; i <= 200; i++) {
      mockRequest.mockResolvedValueOnce({
        data: {
          number: i,
          title: `Issue ${i}`,
          body: null,
          state: "open",
          labels: [],
          created_at: "",
          updated_at: "",
          html_url: "",
        },
        headers: { etag: `W/"v${i}"` },
        status: 200,
      });
      await fetchIssueDetail("org/repo", i);
    }

    // Add one more — should trigger pruning and evict the oldest entry
    mockRequest.mockResolvedValueOnce({
      data: {
        number: 201,
        title: "Issue 201",
        body: null,
        state: "open",
        labels: [],
        created_at: "",
        updated_at: "",
        html_url: "",
      },
      headers: { etag: 'W/"v201"' },
      status: 200,
    });
    await fetchIssueDetail("org/repo", 201);

    // Issue 1 should have been evicted — calling it again should not send If-None-Match
    mockRequest.mockResolvedValueOnce({
      data: {
        number: 1,
        title: "Issue 1",
        body: null,
        state: "open",
        labels: [],
        created_at: "",
        updated_at: "",
        html_url: "",
      },
      headers: {},
      status: 200,
    });
    await fetchIssueDetail("org/repo", 1);

    const lastCallHeaders = mockRequest.mock.calls[mockRequest.mock.calls.length - 1][1]
      .headers as Record<string, string>;
    expect(lastCallHeaders["if-none-match"]).toBeUndefined();
  });
});

describe("fetchLinkedPullRequests", () => {
  it("returns linked PRs from cross-reference events", async () => {
    const { fetchLinkedPullRequests } = await loadModule();
    mockGraphql.mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            nodes: [
              {
                source: {
                  number: 99,
                  repository: { nameWithOwner: "org/repo" },
                },
              },
              {
                source: {
                  number: 12,
                  repository: { nameWithOwner: "org/other" },
                },
              },
            ],
          },
        },
      },
    });

    const result = await fetchLinkedPullRequests("org/repo", 42);

    expect(result).toEqual([
      { repoFullName: "org/repo", number: 99 },
      { repoFullName: "org/other", number: 12 },
    ]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("linkedPullRequests"),
      expect.objectContaining({ owner: "org", repo: "repo", issueNumber: 42 }),
    );
  });

  it("returns empty array when no cross-references exist", async () => {
    const { fetchLinkedPullRequests } = await loadModule();
    mockGraphql.mockResolvedValue({
      repository: {
        issue: {
          timelineItems: { nodes: [] },
        },
      },
    });

    const result = await fetchLinkedPullRequests("org/repo", 42);

    expect(result).toEqual([]);
  });

  it("returns empty array on GraphQL failure", async () => {
    const { fetchLinkedPullRequests } = await loadModule();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGraphql.mockRejectedValue(new Error("GraphQL error"));

    const result = await fetchLinkedPullRequests("org/repo", 42);

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[github] fetchLinkedPullRequests failed, returning empty results:",
      "GraphQL error",
    );
    warnSpy.mockRestore();
  });

  it("filters out nodes with no source PR data", async () => {
    const { fetchLinkedPullRequests } = await loadModule();
    mockGraphql.mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            nodes: [
              // Node with a valid PR source
              { source: { number: 7, repository: { nameWithOwner: "org/repo" } } },
              // Node with no number (non-PR cross-reference)
              { source: { repository: { nameWithOwner: "org/repo" } } },
              // Node with no source at all
              {},
              // Node with no repository
              { source: { number: 9 } },
            ],
          },
        },
      },
    });

    const result = await fetchLinkedPullRequests("org/repo", 10);

    expect(result).toEqual([{ repoFullName: "org/repo", number: 7 }]);
  });

  it("deduplicates PR references", async () => {
    const { fetchLinkedPullRequests } = await loadModule();
    mockGraphql.mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            nodes: [
              { source: { number: 5, repository: { nameWithOwner: "org/repo" } } },
              { source: { number: 5, repository: { nameWithOwner: "org/repo" } } },
            ],
          },
        },
      },
    });

    const result = await fetchLinkedPullRequests("org/repo", 1);

    expect(result).toEqual([{ repoFullName: "org/repo", number: 5 }]);
  });
});

// ── fetchOpenPullRequestByBranch ──

describe("fetchOpenPullRequestByBranch", () => {
  const rawPR = {
    number: 42,
    title: "feat: checkout v2",
    state: "open",
    merged: false,
    html_url: "https://github.com/acme/api/pull/42",
    updated_at: "2026-04-10T12:00:00Z",
  };

  it("returns the first open PR when one is found", async () => {
    mockRequest.mockResolvedValue({ data: [rawPR], headers: {}, status: 200 });

    const { fetchOpenPullRequestByBranch } = await loadModule();
    const result = await fetchOpenPullRequestByBranch("acme/api", "feat/checkout-v2");

    expect(result.notModified).toBe(false);
    expect(result.pr).toEqual({
      number: 42,
      title: "feat: checkout v2",
      state: "open",
      merged: false,
      url: "https://github.com/acme/api/pull/42",
      updatedAt: "2026-04-10T12:00:00Z",
    });
    expect(mockRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls",
      expect.objectContaining({
        owner: "acme",
        repo: "api",
        head: "acme:feat/checkout-v2",
        state: "open",
        per_page: 1,
      }),
    );
  });

  it("returns pr: null when no open PRs match the branch", async () => {
    mockRequest.mockResolvedValue({ data: [], headers: {}, status: 200 });

    const { fetchOpenPullRequestByBranch } = await loadModule();
    const result = await fetchOpenPullRequestByBranch("acme/api", "feat/no-pr");

    expect(result.notModified).toBe(false);
    expect(result.pr).toBeNull();
  });

  it("returns notModified: true with cached PR on 304 (ETag hit)", async () => {
    const { fetchOpenPullRequestByBranch } = await loadModule();

    // First call: 200 with etag
    mockRequest.mockResolvedValueOnce({ data: [rawPR], headers: { etag: 'W/"abc"' }, status: 200 });
    await fetchOpenPullRequestByBranch("acme/api", "feat/checkout-v2");

    // Second call: server returns 304 (thrown by Octokit)
    const err304 = { status: 304, response: { headers: {} } };
    mockRequest.mockRejectedValueOnce(err304);

    const result = await fetchOpenPullRequestByBranch("acme/api", "feat/checkout-v2");

    expect(result.notModified).toBe(true);
    expect(result.pr).toMatchObject({ number: 42 });
  });

  it("returns notModified: true with pr: null when 304 and no prior PR was cached", async () => {
    const { fetchOpenPullRequestByBranch } = await loadModule();

    // First call: 200 empty result, etag stored
    mockRequest.mockResolvedValueOnce({ data: [], headers: { etag: 'W/"empty"' }, status: 200 });
    await fetchOpenPullRequestByBranch("acme/api", "feat/no-pr");

    // Second call: 304
    const err304 = { status: 304, response: { headers: {} } };
    mockRequest.mockRejectedValueOnce(err304);

    const result = await fetchOpenPullRequestByBranch("acme/api", "feat/no-pr");

    expect(result.notModified).toBe(true);
    expect(result.pr).toBeNull();
  });
});

// ── fetchPullRequestDetail ──

describe("fetchPullRequestDetail", () => {
  it("returns mapped PR including merged state", async () => {
    mockRequest.mockResolvedValue({
      data: {
        number: 42,
        title: "feat: checkout v2",
        state: "closed",
        merged: true,
        html_url: "https://github.com/acme/api/pull/42",
        updated_at: "2026-04-11T08:00:00Z",
      },
      headers: {},
      status: 200,
    });

    const { fetchPullRequestDetail } = await loadModule();
    const result = await fetchPullRequestDetail("acme/api", 42);

    expect(result).toEqual({
      number: 42,
      title: "feat: checkout v2",
      state: "closed",
      merged: true,
      url: "https://github.com/acme/api/pull/42",
      updatedAt: "2026-04-11T08:00:00Z",
    });
    expect(mockRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ owner: "acme", repo: "api", pull_number: 42 }),
    );
  });
});

// ── fetchIssueTypes ──

describe("fetchIssueTypes", () => {
  function makeResponse(
    nodes: Array<{
      id: string;
      name: string;
      description?: string;
      color?: string;
      isEnabled?: boolean;
    }>,
    hasNextPage = false,
  ) {
    return {
      repository: {
        issueTypes: {
          nodes: nodes.map((n) => ({ isEnabled: true, ...n })),
          pageInfo: { hasNextPage },
        },
      },
    };
  }

  it("returns configured types from repository", async () => {
    mockGraphql.mockResolvedValueOnce(
      makeResponse([
        { id: "it-1", name: "Bug", color: "#d73a4a" },
        { id: "it-2", name: "Feature", color: "#0075ca", description: "New feature request" },
      ]),
    );

    const { fetchIssueTypes } = await loadModule();
    const result = await fetchIssueTypes("org/repo");

    expect(result.configured).toBe(true);
    expect(result.types).toHaveLength(2);
    expect(result.types[0]).toEqual({ id: "it-1", name: "Bug", color: "#d73a4a" });
    expect(result.types[1]).toEqual({
      id: "it-2",
      name: "Feature",
      color: "#0075ca",
      description: "New feature request",
    });
  });

  it("omits description and color properties when absent", async () => {
    mockGraphql.mockResolvedValueOnce(makeResponse([{ id: "it-1", name: "Bug" }]));

    const { fetchIssueTypes } = await loadModule();
    const result = await fetchIssueTypes("org/repo");

    expect(result.types[0]).toEqual({ id: "it-1", name: "Bug" });
    expect(result.types[0]).not.toHaveProperty("description");
    expect(result.types[0]).not.toHaveProperty("color");
  });

  it("filters out disabled issue types", async () => {
    mockGraphql.mockResolvedValueOnce(
      makeResponse([
        { id: "it-1", name: "Bug", isEnabled: true },
        { id: "it-2", name: "Archived", isEnabled: false },
        { id: "it-3", name: "Feature", isEnabled: true },
      ]),
    );

    const { fetchIssueTypes } = await loadModule();
    const result = await fetchIssueTypes("org/repo");

    expect(result.configured).toBe(true);
    expect(result.types).toHaveLength(2);
    expect(result.types.map((t) => t.name)).toEqual(["Bug", "Feature"]);
  });

  it("returns none-defined when nodes list is empty", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: { issueTypes: { nodes: [], pageInfo: { hasNextPage: false } } },
    });

    const { fetchIssueTypes } = await loadModule();
    const result = await fetchIssueTypes("org/repo");

    expect(result.configured).toBe(false);
    expect(result.reason).toBe("none-defined");
    expect(result.types).toEqual([]);
  });

  it("returns none-defined when all nodes are disabled", async () => {
    mockGraphql.mockResolvedValueOnce(
      makeResponse([{ id: "it-1", name: "Archived", isEnabled: false }]),
    );

    const { fetchIssueTypes } = await loadModule();
    const result = await fetchIssueTypes("org/repo");

    expect(result.configured).toBe(false);
    expect(result.reason).toBe("none-defined");
  });

  it("returns none-defined when issueTypes is null", async () => {
    mockGraphql.mockResolvedValueOnce({ repository: { issueTypes: null } });

    const { fetchIssueTypes } = await loadModule();
    const result = await fetchIssueTypes("org/repo");

    expect(result.configured).toBe(false);
    expect(result.reason).toBe("none-defined");
  });

  it("logs a warning when hasNextPage is true", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGraphql.mockResolvedValueOnce(makeResponse([{ id: "it-1", name: "Bug" }], true));

    const { fetchIssueTypes } = await loadModule();
    await fetchIssueTypes("org/repo");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("more than 50 issue types"));
    warnSpy.mockRestore();
  });

  it("throws classified error when query fails", async () => {
    mockGraphql.mockRejectedValueOnce({ status: 401, message: "Bad credentials" });

    const { fetchIssueTypes } = await loadModule();
    await expect(fetchIssueTypes("org/repo")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });

  it("throws when auth is not configured", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("GITHUB_TOKEN", "");

    const { fetchIssueTypes } = await loadModule();
    await expect(fetchIssueTypes("org/repo")).rejects.toThrow("GitHub is not connected");
  });

  it("caches results and avoids a second GraphQL call", async () => {
    mockGraphql.mockResolvedValue(makeResponse([{ id: "it-1", name: "Bug" }]));

    const { fetchIssueTypes } = await loadModule();
    const first = await fetchIssueTypes("org/repo");
    const second = await fetchIssueTypes("org/repo");

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("bypasses cache when issueTypesCacheTtlSeconds is 0", async () => {
    vi.doMock("./state.js", () => ({
      getRouboDir: () => "/mock/.roubo",
      loadSettings: () => ({ theme: "dark", github: { issueTypesCacheTtlSeconds: 0 } }),
    }));
    vi.stubEnv("GITHUB_TOKEN", "test-token");

    mockGraphql.mockResolvedValue(makeResponse([{ id: "it-1", name: "Bug" }]));

    const { fetchIssueTypes } = await loadModule();
    await fetchIssueTypes("org/repo");
    await fetchIssueTypes("org/repo");

    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });
});

// ── fetchIssueType ──

describe("fetchIssueType", () => {
  it("returns the issue type name when present", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: { issue: { issueType: { name: "Bug" } } },
    });

    const { fetchIssueType } = await loadModule();
    const result = await fetchIssueType("org/repo", 42);

    expect(result).toBe("Bug");
    expect(mockGraphql).toHaveBeenCalledOnce();
  });

  it("returns null when issue has no issueType set", async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: { issue: { issueType: null } },
    });

    const { fetchIssueType } = await loadModule();
    const result = await fetchIssueType("org/repo", 42);

    expect(result).toBeNull();
  });

  it("returns null when issue is not found", async () => {
    mockGraphql.mockResolvedValueOnce({ repository: { issue: null } });

    const { fetchIssueType } = await loadModule();
    const result = await fetchIssueType("org/repo", 99);

    expect(result).toBeNull();
  });

  it("returns null (does not throw) on network errors", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("Network failure"));
    // Logging the failed fetch IS the observable behavior. Mock to keep
    // test output clean and assert the warn fired.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { fetchIssueType } = await loadModule();
    const result = await fetchIssueType("org/repo", 42);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[github] Failed to fetch issue type for #42:"),
      expect.any(Error),
    );
  });
});
