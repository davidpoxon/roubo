// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import type { Note } from "@roubo/shared/testbench-contracts";
import { renderHookWithProviders } from "../test/renderWithProviders";
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
