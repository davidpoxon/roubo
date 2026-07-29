// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useTerminalSessions, useCreateTerminal, useDestroyTerminal } from "./useTerminal";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useTerminalSessions", () => {
  it("fetches terminal sessions for project and bench", async () => {
    const sessions = [{ id: "sess-1", command: "bash" }];
    mockedApi.fetchTerminals.mockResolvedValue(sessions as never);
    const { result } = renderHookWithProviders(() => useTerminalSessions("p1", 1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchTerminals).toHaveBeenCalledWith("p1", 1);
    expect(result.current.data).toEqual(sessions);
  });
});

describe("useCreateTerminal", () => {
  it("calls createTerminal and invalidates sessions query", async () => {
    const session = { id: "sess-new" };
    mockedApi.createTerminal.mockResolvedValue(session as never);
    mockedApi.fetchTerminals.mockResolvedValue([] as never);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useCreateTerminal(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 1 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.createTerminal).toHaveBeenCalledWith("p1", 1, undefined, undefined, {});
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["terminals", "p1", 1] });
  });

  it("passes command to createTerminal", async () => {
    mockedApi.createTerminal.mockResolvedValue({ id: "sess-2" } as never);
    const { result } = renderHookWithProviders(() => useCreateTerminal());
    result.current.mutate({ projectId: "p2", benchId: 3, command: "npm run dev" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.createTerminal).toHaveBeenCalledWith("p2", 3, "npm run dev", undefined, {});
  });

  it("passes jigId to createTerminal", async () => {
    mockedApi.createTerminal.mockResolvedValue({ id: "sess-3" } as never);
    const { result } = renderHookWithProviders(() => useCreateTerminal());
    result.current.mutate({ projectId: "p3", benchId: 2, command: "claude", jigId: "push" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.createTerminal).toHaveBeenCalledWith("p3", 2, "claude", "push", {});
  });

  it("forwards agentPluginId and presetOverrides to the agent launch path", async () => {
    mockedApi.createTerminal.mockResolvedValue({ id: "sess-4" } as never);
    const { result } = renderHookWithProviders(() => useCreateTerminal());
    result.current.mutate({
      projectId: "p4",
      benchId: 5,
      jigId: "feature-dev",
      agentPluginId: "claude-code",
      presetOverrides: { mode: "plan" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.createTerminal).toHaveBeenCalledWith("p4", 5, undefined, "feature-dev", {
      agentPluginId: "claude-code",
      presetOverrides: { mode: "plan" },
    });
  });
});

describe("useDestroyTerminal", () => {
  it("calls destroyTerminal and invalidates sessions query", async () => {
    mockedApi.destroyTerminal.mockResolvedValue(undefined as never);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useDestroyTerminal(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 1, sessionId: "sess-1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.destroyTerminal).toHaveBeenCalledWith("p1", 1, "sess-1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["terminals", "p1", 1] });
  });
});
