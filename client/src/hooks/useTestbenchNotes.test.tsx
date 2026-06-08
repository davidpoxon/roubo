// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import type { Note } from "@roubo/shared/testbench-contracts";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { testbenchPlanQueryKey } from "./useTestbenchPlan";
import { useAppendNote } from "./useTestbenchNotes";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, appendNote: vi.fn() };
});
import * as api from "../lib/api";
import { ApiError } from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useAppendNote", () => {
  it("posts to the case notes route and surfaces the stamped Note", async () => {
    const note: Note = {
      id: "n1",
      text: "hello",
      author: { name: "Ada", email: "ada@example.com" },
      timestamp: "2026-06-08T10:00:00.000Z",
      statusAtWrite: "in_progress",
    };
    mockedApi.appendNote.mockResolvedValue(note);

    const { result } = renderHookWithProviders(() => useAppendNote());
    result.current.mutate({ projectId: "p1", benchId: 2, caseId: "TC-001", text: "hello" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.appendNote).toHaveBeenCalledWith("p1", 2, "TC-001", "hello");
    expect(result.current.data).toEqual(note);
  });

  it("invalidates the testbench plan query so the notes rail refetches the appended note", async () => {
    // The case-detail notes rail reads `result.notes` from the single testbench
    // plan query (plan + per-case results), the same key the mark/override
    // mutations invalidate. Appending a note must invalidate that exact key, or
    // the rail never re-renders with the new note.
    const note: Note = {
      id: "n1",
      text: "broken redirect",
      author: { name: "Ada", email: "ada@example.com" },
      timestamp: "2026-06-08T10:00:00.000Z",
      statusAtWrite: "failed",
    };
    mockedApi.appendNote.mockResolvedValue(note);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useAppendNote(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 2, caseId: "TC-B", text: "broken redirect" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: testbenchPlanQueryKey("p1", 2) });
  });

  it("surfaces the 400 rejection as an error", async () => {
    mockedApi.appendNote.mockRejectedValue(
      new ApiError("Note text must not be empty", 400, undefined, {}),
    );

    const { result } = renderHookWithProviders(() => useAppendNote());
    result.current.mutate({ projectId: "p1", benchId: 2, caseId: "TC-001", text: "   " });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(400);
  });
});
