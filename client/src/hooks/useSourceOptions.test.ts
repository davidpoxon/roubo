// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";
import type { SourceOptionsResult } from "@roubo/shared";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useSourceOptions } from "./useSourceOptions";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const PAGE: SourceOptionsResult = {
  items: [{ externalId: "board:482", label: "PLAT Scrum Board", sublabel: "PLAT · board #482" }],
  nextCursor: null,
};

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSourceOptions", () => {
  it("exposes null durationMs before any page resolves", () => {
    mockedApi.fetchSourceOptions.mockReturnValue(new Promise(() => {}));
    const { result } = renderHookWithProviders(() =>
      useSourceOptions({ projectId: "p1", category: "board", search: "scrum" }),
    );
    expect(result.current.durationMs).toBeNull();
  });

  it("exposes the measured round-trip latency of the resolved page (#432)", async () => {
    // Drive a controlled clock that only advances while the fetch is in flight,
    // so the measured delta is deterministic regardless of other `now()` reads.
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    mockedApi.fetchSourceOptions.mockImplementation(async () => {
      clock += 141.6;
      return PAGE;
    });

    const { result } = renderHookWithProviders(() =>
      useSourceOptions({ projectId: "p1", category: "board", search: "scrum" }),
    );

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.durationMs).toBe(142);
  });
});
