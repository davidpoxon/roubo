import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSourceCandidates } from "../methods/list-source-candidates.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

describe("listSourceCandidates", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("returns repos and projects for the current user", async () => {
    // GET /user/repos
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse([
        { name: "bar", full_name: "foo/bar", description: "A repo" },
        { name: "qux", full_name: "foo/qux", description: null },
      ]),
    );
    // GET /user
    mocks.mockOctokit.request.mockResolvedValueOnce(
      okResponse({ id: 1, login: "foo", name: "Foo User" }),
    );
    // organization projectsV2 query succeeds
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      organization: { projectsV2: { nodes: [{ number: 7, title: "Roadmap" }] } },
    });

    const candidates = await listSourceCandidates();
    expect(candidates).toEqual([
      {
        category: "Repository",
        externalId: "foo/bar",
        displayName: "foo/bar",
        description: "A repo",
      },
      { category: "Repository", externalId: "foo/qux", displayName: "foo/qux" },
      {
        category: "Project",
        externalId: "foo/#7",
        displayName: "Roadmap (#7)",
        description: "GitHub Project v2 owned by foo",
      },
    ]);
  });

  it("returns repos even if project listing fails", async () => {
    mocks.mockOctokit.request
      .mockResolvedValueOnce(okResponse([{ name: "bar", full_name: "foo/bar" }]))
      .mockResolvedValueOnce(okResponse({ id: 1, login: "foo" }));
    // organization + user queries both fail
    mocks.mockOctokit.graphql
      .mockRejectedValueOnce(new Error("org not found"))
      .mockRejectedValueOnce(new Error("user not found"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const candidates = await listSourceCandidates();
    warnSpy.mockRestore();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].externalId).toBe("foo/bar");
  });
});
