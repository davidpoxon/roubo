// @vitest-environment jsdom
//
// #420 TC-019/TC-021/TC-022/TC-024: marking an observation and setting/clearing
// a status override PUT to the #416 routes and reconcile with the authoritative
// CaseResult, applying an optimistic cache update (< 150ms perceived) and a later
// invalidation so the source-of-truth refetch reconciles. A later mark never
// clears an existing override (server-enforced precedence).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import type { CaseResult, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";
import { testbenchPlanQueryKey, type TestbenchPlanData } from "./useTestbenchPlan";
import { useMarkObservation, useSetStatusOverride } from "./useTestbenchMarks";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, markObservation: vi.fn(), setStatusOverride: vi.fn() };
});
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const PROJECT = "p1";
const BENCH = 2;
const CASE = "TC-001";

const PLAN: TestCasesPlan = {
  $schema: "x",
  schemaVersion: "1.0.0",
  specSlug: "demo",
  cases: [
    {
      id: CASE,
      title: "A case",
      area: "test-area",
      level: 1,
      type: "functional",
      priority: "P0",
      steps: [
        {
          id: "s1",
          instruction: "Do a thing",
          observations: [
            { id: "o1", expected: "first" },
            { id: "o2", expected: "second" },
          ],
        },
      ],
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
    },
  ],
};

function seedPlanData(overrides: Partial<CaseResult> = {}): TestbenchPlanData {
  return {
    plan: PLAN,
    results: {
      caseResults: {
        [CASE]: {
          observationMarks: {},
          derivedStatus: "not_started",
          notes: [],
          ...overrides,
        },
      },
      updatedAt: "2026-06-08T10:00:00.000Z",
    },
    stale: false,
    planHash: "h",
    recovered: false,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useMarkObservation", () => {
  it("PUTs the mark and optimistically derives in_progress before the server responds", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey(PROJECT, BENCH), seedPlanData());
    // Never resolves during the assertion window, so we observe the optimistic state.
    let resolve!: (r: CaseResult) => void;
    mockedApi.markObservation.mockReturnValue(
      new Promise<CaseResult>((r) => {
        resolve = r;
      }),
    );

    const { result } = renderHookWithProviders(() => useMarkObservation(), { queryClient });
    result.current.mutate({
      projectId: PROJECT,
      benchId: BENCH,
      caseId: CASE,
      observationId: "o1",
      result: "pass",
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<TestbenchPlanData>(
        testbenchPlanQueryKey(PROJECT, BENCH),
      );
      expect(cached?.results?.caseResults[CASE].observationMarks.o1?.result).toBe("pass");
      // One of two observations marked => in_progress, derived optimistically.
      expect(cached?.results?.caseResults[CASE].derivedStatus).toBe("in_progress");
    });

    expect(mockedApi.markObservation).toHaveBeenCalledWith(PROJECT, BENCH, CASE, "o1", "pass");
    resolve({ observationMarks: {}, derivedStatus: "in_progress", notes: [] });
  });

  it("does not clear an existing override when a later mark arrives", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      testbenchPlanQueryKey(PROJECT, BENCH),
      seedPlanData({
        statusOverride: {
          status: "blocked",
          author: { name: "Ada", email: "a@e.com" },
          timestamp: "2026-06-08T10:00:00.000Z",
        },
      }),
    );
    mockedApi.markObservation.mockReturnValue(new Promise<CaseResult>(() => {}));

    const { result } = renderHookWithProviders(() => useMarkObservation(), { queryClient });
    result.current.mutate({
      projectId: PROJECT,
      benchId: BENCH,
      caseId: CASE,
      observationId: "o1",
      result: "fail",
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<TestbenchPlanData>(
        testbenchPlanQueryKey(PROJECT, BENCH),
      );
      expect(cached?.results?.caseResults[CASE].observationMarks.o1?.result).toBe("fail");
    });
    const cached = queryClient.getQueryData<TestbenchPlanData>(
      testbenchPlanQueryKey(PROJECT, BENCH),
    );
    // The override survives the mark (precedence over later marks).
    expect(cached?.results?.caseResults[CASE].statusOverride?.status).toBe("blocked");
  });

  it("rolls the cache back if the PUT fails", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey(PROJECT, BENCH), seedPlanData());
    mockedApi.markObservation.mockRejectedValue(new Error("boom"));

    const { result } = renderHookWithProviders(() => useMarkObservation(), { queryClient });
    result.current.mutate({
      projectId: PROJECT,
      benchId: BENCH,
      caseId: CASE,
      observationId: "o1",
      result: "pass",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = queryClient.getQueryData<TestbenchPlanData>(
      testbenchPlanQueryKey(PROJECT, BENCH),
    );
    // Rolled back to the empty marks snapshot.
    expect(cached?.results?.caseResults[CASE].observationMarks.o1).toBeUndefined();
  });
});

describe("useSetStatusOverride", () => {
  it("optimistically records an override distinctly from the derived status", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey(PROJECT, BENCH), seedPlanData());
    mockedApi.setStatusOverride.mockReturnValue(new Promise<CaseResult>(() => {}));

    const { result } = renderHookWithProviders(() => useSetStatusOverride(), { queryClient });
    result.current.mutate({
      projectId: PROJECT,
      benchId: BENCH,
      caseId: CASE,
      override: "blocked",
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<TestbenchPlanData>(
        testbenchPlanQueryKey(PROJECT, BENCH),
      );
      expect(cached?.results?.caseResults[CASE].statusOverride?.status).toBe("blocked");
      // derivedStatus is untouched: the override is recorded distinctly.
      expect(cached?.results?.caseResults[CASE].derivedStatus).toBe("not_started");
    });
    expect(mockedApi.setStatusOverride).toHaveBeenCalledWith(PROJECT, BENCH, CASE, "blocked");
  });

  it("optimistically clears the override when passed null", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      testbenchPlanQueryKey(PROJECT, BENCH),
      seedPlanData({
        statusOverride: {
          status: "blocked",
          author: { name: "Ada", email: "a@e.com" },
          timestamp: "2026-06-08T10:00:00.000Z",
        },
      }),
    );
    mockedApi.setStatusOverride.mockReturnValue(new Promise<CaseResult>(() => {}));

    const { result } = renderHookWithProviders(() => useSetStatusOverride(), { queryClient });
    result.current.mutate({ projectId: PROJECT, benchId: BENCH, caseId: CASE, override: null });

    await waitFor(() => {
      const cached = queryClient.getQueryData<TestbenchPlanData>(
        testbenchPlanQueryKey(PROJECT, BENCH),
      );
      expect(cached?.results?.caseResults[CASE].statusOverride).toBeUndefined();
    });
  });
});
