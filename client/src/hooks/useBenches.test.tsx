// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import {
  useAllBenches,
  useProjectBenches,
  useBenchDetail,
  useCreateBench,
  useTeardownBench,
  useStartBench,
  useStopBench,
  useStartComponent,
  useStopComponent,
  useSyncBenchWorkUnits,
} from "./useBenches";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useAllBenches", () => {
  it("calls fetchAllBenches and returns data", async () => {
    const benches = [{ id: 1, projectId: "p1", branch: "main" }];
    mockedApi.fetchAllBenches.mockResolvedValue(benches as never);
    const { result } = renderHookWithProviders(() => useAllBenches());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchAllBenches).toHaveBeenCalled();
    expect(result.current.data).toEqual(benches);
  });
});

describe("useProjectBenches", () => {
  it("calls fetchBenches when projectId is provided", async () => {
    const benches = [{ id: 1, projectId: "p1", branch: "main" }];
    mockedApi.fetchBenches.mockResolvedValue(benches as never);
    const { result } = renderHookWithProviders(() => useProjectBenches("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchBenches).toHaveBeenCalledWith("p1");
  });

  it("calls fetchAllBenches when projectId is undefined", async () => {
    const benches = [{ id: 1, projectId: "p1" }];
    mockedApi.fetchAllBenches.mockResolvedValue(benches as never);
    const { result } = renderHookWithProviders(() => useProjectBenches(undefined));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchAllBenches).toHaveBeenCalled();
    expect(mockedApi.fetchBenches).not.toHaveBeenCalled();
  });
});

describe("useBenchDetail", () => {
  it("calls fetchBench with projectId and benchId", async () => {
    const bench = { id: 2, projectId: "p1", branch: "dev" };
    mockedApi.fetchBench.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useBenchDetail("p1", 2));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchBench).toHaveBeenCalledWith("p1", 2);
    expect(result.current.data).toEqual(bench);
  });
});

describe("useCreateBench", () => {
  it("calls createBench with projectId and branch", async () => {
    const bench = { id: 1, projectId: "p1", branch: "feat" };
    mockedApi.createBench.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useCreateBench());
    result.current.mutate({ projectId: "p1", branch: "feat" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.createBench).toHaveBeenCalledWith("p1", "feat", undefined, undefined);
  });

  it("calls createBench with issueNumber for combined flow", async () => {
    const response = { status: "success", bench: { id: 1 }, terminalSessionId: "term-1" };
    mockedApi.createBench.mockResolvedValue(response as never);
    const { result } = renderHookWithProviders(() => useCreateBench());
    result.current.mutate({ projectId: "p1", issueNumber: 42 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.createBench).toHaveBeenCalledWith("p1", undefined, 42, undefined);
  });

  it("calls createBench with branchConflictResolution", async () => {
    const response = { status: "success", bench: { id: 1 }, terminalSessionId: "term-1" };
    mockedApi.createBench.mockResolvedValue(response as never);
    const { result } = renderHookWithProviders(() => useCreateBench());
    result.current.mutate({ projectId: "p1", issueNumber: 42, branchConflictResolution: "resume" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.createBench).toHaveBeenCalledWith("p1", undefined, 42, "resume");
  });

  it("handles branchConflict response from createBench", async () => {
    const conflictResponse = {
      status: "conflict",
      branchConflict: { branchExists: true, worktreeExists: false, branchName: "issue-42-fix" },
    };
    mockedApi.createBench.mockResolvedValue(conflictResponse as never);
    const { result } = renderHookWithProviders(() => useCreateBench());
    result.current.mutate({ projectId: "p1", issueNumber: 42 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(conflictResponse);
  });
});

describe("useTeardownBench", () => {
  it("calls teardownBench with projectId, benchId, and removeWorkspace", async () => {
    const bench = { id: 3, projectId: "p1", status: "stopping", teardownSteps: [] };
    mockedApi.teardownBench.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useTeardownBench());
    result.current.mutate({ projectId: "p1", benchId: 3, removeWorkspace: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.teardownBench).toHaveBeenCalledWith("p1", 3, false, undefined);
  });

  it("passes force=true through to teardownBench when specified", async () => {
    const bench = { id: 3, projectId: "p1", status: "stopping", teardownSteps: [] };
    mockedApi.teardownBench.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useTeardownBench());
    result.current.mutate({ projectId: "p1", benchId: 3, removeWorkspace: true, force: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.teardownBench).toHaveBeenCalledWith("p1", 3, true, true);
  });
});

describe("useStartBench", () => {
  it("calls startBench with projectId and benchId", async () => {
    const bench = { id: 1, projectId: "p1", status: "running" };
    mockedApi.startBench.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useStartBench());
    result.current.mutate({ projectId: "p1", benchId: 1 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.startBench).toHaveBeenCalledWith("p1", 1);
  });
});

describe("useStopBench", () => {
  it("calls stopBench with projectId and benchId", async () => {
    const bench = { id: 1, projectId: "p1", status: "inactive" };
    mockedApi.stopBench.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useStopBench());
    result.current.mutate({ projectId: "p1", benchId: 1 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.stopBench).toHaveBeenCalledWith("p1", 1);
  });
});

describe("useStartComponent", () => {
  it("calls startComponent with projectId, benchId, and component", async () => {
    const bench = { id: 1, projectId: "p1", status: "running" };
    mockedApi.startComponent.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useStartComponent());
    result.current.mutate({ projectId: "p1", benchId: 1, component: "backend" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.startComponent).toHaveBeenCalledWith("p1", 1, "backend");
  });
});

describe("useStopComponent", () => {
  it("calls stopComponent with projectId, benchId, and component", async () => {
    const bench = { id: 1, projectId: "p1", status: "stopped" };
    mockedApi.stopComponent.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useStopComponent());
    result.current.mutate({ projectId: "p1", benchId: 1, component: "backend" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.stopComponent).toHaveBeenCalledWith("p1", 1, "backend");
  });
});

describe("useSyncBenchWorkUnits", () => {
  it("calls syncBenchWorkUnits with projectId and benchId", async () => {
    const bench = { id: 1, projectId: "p1", workUnits: [] };
    mockedApi.syncBenchWorkUnits.mockResolvedValue(bench as never);
    const { result } = renderHookWithProviders(() => useSyncBenchWorkUnits());
    result.current.mutate({ projectId: "p1", benchId: 1 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.syncBenchWorkUnits).toHaveBeenCalledWith("p1", 1);
  });
});
