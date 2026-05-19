// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useGitHubProjects } from "./useGitHubProjects";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useGitHubProjects", () => {
  it("does not fetch when projectId is undefined", () => {
    const { result } = renderHookWithProviders(() => useGitHubProjects(undefined));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchProjectGitHubProjects).not.toHaveBeenCalled();
  });

  it("fetches when projectId is provided", async () => {
    const projects = [{ number: 1, title: "My Project" }];
    mockedApi.fetchProjectGitHubProjects.mockResolvedValue(projects as never);
    const { result } = renderHookWithProviders(() => useGitHubProjects("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchProjectGitHubProjects).toHaveBeenCalledWith("p1");
    expect(result.current.data).toEqual(projects);
  });

  it("does not retry on failure", async () => {
    mockedApi.fetchProjectGitHubProjects.mockRejectedValue(new Error("Network error") as never);
    const { result } = renderHookWithProviders(() => useGitHubProjects("p1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApi.fetchProjectGitHubProjects).toHaveBeenCalledTimes(1);
  });
});
